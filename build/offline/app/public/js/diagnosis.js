const urlParams = new URLSearchParams(window.location.search);
const vn   = urlParams.get('vn');
const date = urlParams.get('date') || (() => { const _d = new Date(); return `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`; })();

let patientData   = null;
let diagnoses     = [];
let selectedIcd10 = null;
let icdSearchTimer = null;
let allDoctors    = [];
let doctorSearchTimer = null;
let diagTypes     = [];
const INITIAL_LOAD_TIMEOUT_MS = 10000;

// ─── ICD9CM State ─────────────────────────────────────────────────────────────
let procedures     = [];   // รายการ icd9cm ที่เพิ่มแล้ว
let selectedIcd9   = null; // icd9cm ที่เลือกอยู่ในช่อง input
let icd9SearchTimer = null;
let operTypes      = [];

// ─── Auth guard ───────────────────────────────────────────────────────────────
(async () => {
  const user = await requireAuth();
  if (!user) return;
  renderNavUser();
  document.getElementById('vnDisplay').textContent = `VN: ${vn}`;

  if (!vn) {
    document.getElementById('patientInfo').innerHTML =
      '<div class="text-danger"><i class="fas fa-exclamation-triangle me-2"></i>ไม่พบ VN ใน URL</div>';
    return;
  }
  // แสดงชื่อผู้ login ในช่องยืนยัน
  const u = getUser();
  if (u) {
    const nameEl = document.getElementById('confirmerName');
    if (nameEl) nameEl.textContent = u.officer_name || u.officer_login_name || '–';
  }

  showLoading(true);
  try {
    await loadPatient();
  } catch (error) {
    console.error('Patient load failed', error);
  } finally {
    showLoading(false);
  }

  await Promise.all([loadDiagTypes(), loadDiagnoses()]);
  applyDiagTypeDefault();
  loadDoctors();
  loadDoctor();
  loadOperTypes();
  loadIcd9cm();
  loadOvstDoctor();
})();

// ─── Utils ────────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return (str || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

function toArabicDigits(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0E50-\u0E59\u0660-\u0669\u06F0-\u06F90-9]/g, d => {
    const thai = '๐๑๒๓๔๕๖๗๘๙';
    const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
    const persianIndic = '۰۱۲۳۴۵۶۷۸۹';
    if (thai.includes(d)) return String(thai.indexOf(d));
    if (arabicIndic.includes(d)) return String(arabicIndic.indexOf(d));
    if (persianIndic.includes(d)) return String(persianIndic.indexOf(d));
    return d;
  });
}

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('d-none', !show);
}

function showAlert(type, msg, stay = false) {
  const icons = { success: 'check-circle', danger: 'times-circle', warning: 'exclamation-triangle', info: 'info-circle' };
  const box = document.getElementById('alertBox');
  box.className = `alert alert-${type}`;
  box.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'} me-2"></i>${msg}`;
  box.classList.remove('d-none');
  if (!stay) setTimeout(() => box.classList.add('d-none'), 5000);
}

const diagTypeLabels = { 1: 'การวินิจฉัยหลัก', 2: 'โรคร่วม', 3: 'ภาวะแทรกซ้อน', 4: 'อื่นๆ', 5: 'สาเหตุภายนอก' };

async function loadDiagTypes() {
  try {
    const res = await apiFetch('/api/diagtypes', { timeout: INITIAL_LOAD_TIMEOUT_MS });
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      diagTypes = data.data.map(d => ({
        code: String(d.code).trim(),
        label: String(d.name),  // server ส่ง concat(diagtype,'-',name) มาแล้ว
      }));
    }
  } catch (_) {
    diagTypes = [];
  }
  // ไม่เรียก populateDiagTypeOptions ที่นี่ — รอ applyDiagTypeDefault() หลัง diagnoses โหลดเสร็จ
}

function getDefaultDiagType() {
  // ยังไม่เคยลง → diagtype=1, เคยลงแล้ว (มีใน list หรือใน DB) → diagtype=4
  const target = diagnoses.length === 0 ? '1' : '4';
  const found  = diagTypes.some(t => t.code === target);
  return found ? target : (diagTypes[0]?.code ?? '');
}

function populateDiagTypeOptions(selectedCode) {
  const el = document.getElementById('diagType');
  if (!el) return;

  if (!diagTypes.length) {
    el.innerHTML = '<option value="">ไม่พบประเภทวินิจฉัย</option>';
    el.disabled = true;
    return;
  }

  // ใช้ selected attribute โดยตรง — น่าเชื่อถือกว่า el.value = ...
  el.innerHTML = diagTypes.map(t =>
    `<option value="${escAttr(t.code)}"${t.code === selectedCode ? ' selected' : ''}>${escHtml(t.label)}</option>`
  ).join('');
  el.disabled = false;
}

function applyDiagTypeDefault() {
  populateDiagTypeOptions(getDefaultDiagType());
}

// ─── Patient Info ─────────────────────────────────────────────────────────────

async function loadPatient() {
  // ลองอ่านจาก sessionStorage ที่ patients.html บันทึกไว้ก่อน
  try {
    const raw = sessionStorage.getItem('selected_patient');
    if (raw) {
      const p = JSON.parse(raw);
      if (String(p.vn) === String(vn)) {
        patientData = {
          ...p,
          spclty_name: p.spclty_name || p.spclty || '',
          spclty_code: p.spclty_code || '',
          main_dep:    p.main_dep    || p.department || '',
          pttype_name: p.pttype_name || '',
          pttypeno:    p.pttypeno    || '',
          doctor_list_text: p.doctor_list_text || '',
          cc: (p.cc === 'ไม่ได้ลง CC' ? '' : p.cc) || '',
          pe: (p.pe === 'ไม่ได้ลง PE' ? '' : p.pe) || '',
        };
        renderPatientInfo();
        loadDoctorDiagnosis();
        renderDoctorListText();
        return;
      }
    }
  } catch (_) {}

  // Fallback: ดึงจาก API
  try {
    const res  = await apiFetch(`/api/patient/${vn}`, { timeout: INITIAL_LOAD_TIMEOUT_MS });
    const data = await res.json();
    if (!data.success || !data.data) {
      document.getElementById('patientInfo').innerHTML =
        `<div class="text-danger"><i class="fas fa-exclamation-triangle me-2"></i>ไม่พบข้อมูลผู้ป่วย (VN: ${escHtml(vn)})</div>`;
      return;
    }
    patientData = data.data;
    renderPatientInfo();
    loadDoctorDiagnosis();
    renderDoctorListText();
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ')
      document.getElementById('patientInfo').innerHTML = `<div class="text-danger">เกิดข้อผิดพลาด: ${escHtml(e.message)}</div>`;
  }
}

function getTextValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function formatThaiDate(dateStr) {
  if (!dateStr) return '–';
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const s = String(dateStr).substring(0, 10).split('-');
  if (s.length !== 3) return String(dateStr).substring(0, 10);
  return `${parseInt(s[2],10)} ${months[parseInt(s[1],10)-1]} ${parseInt(s[0],10)+543}`;
}

function renderPatientInfo() {
  const p = patientData;

  const age    = (p.age || '').trim() || '–';
  const spclty = [p.spclty_code, p.spclty_name].filter(Boolean).join(' ') || '–';
  const pttype = [p.pttypeno, p.pttype].filter(Boolean).join(' ') || '–';
  const doctor = (p.doctor || '').replace(/^-\(\)$/, '').trim() || '–';
  const timeStr = String(p.vsttime || '').substring(0, 8) || '–';
  const cc      = p.cc  && p.cc.trim()  ? p.cc  : '–';
  const pe      = p.pe  && p.pe.trim()  ? p.pe  : '–';

  const td  = 'style="padding:3px 20px 3px 0;white-space:nowrap;vertical-align:top;"';
  const tdw = 'style="padding:3px 20px 3px 0;vertical-align:top;"';
  const lbl = 'class="fw-bold"';

  document.getElementById('patientInfo').innerHTML = `
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td ${td}><span ${lbl}>HN:</span> <span class="info-value">${escHtml(p.hn||'–')}</span></td>
        <td ${tdw}><span ${lbl}>ชื่อ-สกุล:</span> <span class="info-value">${escHtml(p.ptname||'–')}</span></td>
        <td ${td}><span ${lbl}>อายุ:</span> <span class="info-value">${escHtml(age)}</span></td>
        <td ${tdw}><span ${lbl}>แผนก:</span> <span class="info-value">${escHtml(spclty)}</span></td>
        <td ${tdw}><span ${lbl}>ห้องตรวจ:</span> <span class="info-value">${escHtml(p.main_dep||'–')}</span></td>
      </tr>
      <tr>
        <td ${td}><span ${lbl}>วันที่ตรวจ:</span> <span class="info-value">${escHtml(formatThaiDate(p.vstdate))}</span></td>
        <td ${td}><span ${lbl}>เวลา:</span> <span class="info-value">${escHtml(timeStr)}</span></td>
        <td colspan="2" ${tdw}><span ${lbl}>แพทย์:</span> <span class="info-value">${escHtml(doctor)}</span></td>
        <td ${tdw}><span ${lbl}>สิทธิการรักษา:</span> <span class="info-value">${escHtml(pttype)}</span></td>
      </tr>
      <tr>
        <td colspan="5" style="padding:3px 0;vertical-align:top;"><span ${lbl}>CC:</span> <span class="info-value">${escHtml(cc)}</span></td>
      </tr>
      <tr>
        <td colspan="5" style="padding:3px 0;vertical-align:top;"><span ${lbl}>PE:</span> <span class="info-value">${escHtml(pe)}</span></td>
      </tr>
    </table>`;
}

async function loadDoctorDiagnosis() {
  try {
    const res = await apiFetch(`/api/doctor-diagnosis/${vn}`);
    const data = await res.json();
    const el = document.getElementById('dxTextDisplay');
    if (!el) return;
    
    if (!data.success || !data.data || data.data.length === 0) {
      el.innerHTML = `<div class="text-center text-muted py-4">
        <i class="fas fa-list-alt fa-2x mb-2 d-block"></i>
        ไม่มีข้อมูลวินิจฉัยจากแพทย์
      </div>`;
      return;
    }
    
    const rows = data.data;
    el.innerHTML = rows.map((row, idx) => {
      const diagText = toArabicDigits(escHtml(row.diag_text || '–'));
      const doctorName = toArabicDigits(escHtml(row.doctor_name || '–'));
      const diagDateTime = row.diag_datetime 
        ? toArabicDigits(String(row.diag_datetime).substring(0, 19).replace('T', ' '))
        : '–';
      
      return `<div style="border-bottom:2px solid #999;color:#334155;padding:0 !important;margin:0 !important;">
        <div style="line-height:1;margin:0 !important;padding:0 !important;"><strong style="color:#1d4ed8;margin:0;padding:0;">วินิจฉัย:</strong> ${diagText}</div>
        <div style="line-height:1;margin:0 !important;padding:0 !important;"><strong style="margin:0;padding:0;">แพทย์:</strong> ${doctorName}</div>
        <div style="line-height:1;margin:0 !important;padding:0 !important;"><strong style="margin:0;padding:0;">วันที่:</strong> ${diagDateTime}</div>
      </div>`;
    }).join('');
  } catch (e) {
    const el = document.getElementById('dxTextDisplay');
    if (el) {
      el.innerHTML = `<div class="text-danger">เกิดข้อผิดพลาด: ${escHtml(e.message)}</div>`;
    }
  }
}

function renderDoctorListText() {
  const txt = getTextValue(patientData?.doctor_list_text);
  const section = document.getElementById('doctorListTextSection');
  const el      = document.getElementById('doctorListTextDisplay');
  if (!section || !el) return;
  if (txt) {
    el.textContent = txt;
    section.classList.remove('d-none');
  } else {
    section.classList.add('d-none');
  }
}

// ─── ICD10 Search ─────────────────────────────────────────────────────────────

const icdSearch   = document.getElementById('icdSearch');
const icdDropdown = document.getElementById('icdDropdown');
const icdNameField = document.getElementById('icdNameField');
const btnAdd      = document.getElementById('btnAdd');

icdSearch.addEventListener('input', () => {
  // กรองเฉพาะ ASCII (ภาษาอังกฤษ + ตัวเลข) ออก ไม่ให้พิมพ์ภาษาไทย
  const ascii = icdSearch.value.replace(/[^\x00-\x7F]/g, '');
  if (ascii !== icdSearch.value) icdSearch.value = ascii;

  selectedIcd10 = null;
  icdNameField.value = '';
  btnAdd.disabled = true;

  clearTimeout(icdSearchTimer);
  const q = icdSearch.value.trim();
  if (q.length < 2) { icdDropdown.style.display = 'none'; return; }
  icdSearchTimer = setTimeout(() => searchIcd10(q), 250);
});

icdSearch.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedIcd10) {
      addDiagnosis(); // จะ clear + refocus อัตโนมัติ
    }
    return;
  }
  if (e.key === 'Escape') icdDropdown.style.display = 'none';
});

document.addEventListener('click', e => {
  if (!e.target.closest('.icd-input-wrapper')) icdDropdown.style.display = 'none';
});

async function searchIcd10(q) {
  try {
    const res  = await apiFetch(`/api/icd10/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.success || !data.data.length) {
      icdDropdown.innerHTML = '<div class="icd-dropdown-item text-muted">ไม่พบรหัส ICD10</div>';
      icdDropdown.style.display = 'block';
      return;
    }

    // auto-select เมื่อพิมพ์รหัสตรงกันพอดี
    const qUp = q.toUpperCase();
    const exact = data.data.find(item => item.code.toUpperCase() === qUp);
    if (exact) {
      selectIcd10(exact.code, exact.name);
      if (data.data.length === 1) { icdDropdown.style.display = 'none'; return; }
    }

    icdDropdown.innerHTML = data.data.map(item => {
      const isExact = item.code.toUpperCase() === qUp;
      return `
      <div class="icd-dropdown-item${isExact ? ' bg-light fw-bold' : ''}"
           onclick="selectIcd10('${escHtml(item.code)}','${escAttr(item.name)}')">
        <span class="icd-code-badge">${escHtml(item.code)}</span>
        <div class="icd-name-text">${escHtml(item.name)}</div>
      </div>`;
    }).join('');
    icdDropdown.style.display = 'block';
  } catch (_) {}
}

function selectIcd10(code, name) {
  selectedIcd10 = { code, name };
  icdSearch.value = code;
  icdNameField.value = name;
  icdDropdown.style.display = 'none';
  btnAdd.disabled = false;
}

// ─── Diagnosis List ───────────────────────────────────────────────────────────

async function loadDiagnoses() {
  try {
    const res  = await apiFetch(`/api/diagnosis/${vn}`, { timeout: INITIAL_LOAD_TIMEOUT_MS });
    const data = await res.json();
    if (data.success && data.data.length) {
      diagnoses = data.data.map(d => ({
        icd10: d.icd10,
        icd10_name: d.icd10_name || '',
        diagtype: d.diagtype != null ? String(d.diagtype).trim() : '',
      }));
      // pre-check checkbox ถ้า confirm='Y' ในข้อมูลเดิม
      const wasConfirmed = data.data.some(d => String(d.confirm).trim().toUpperCase() === 'Y');
      const chk = document.getElementById('chkConfirm');
      if (chk && wasConfirmed) chk.checked = true;
    }
  } catch (_) {}
  // เรียก renderDxList เสมอ เพื่อตั้งค่า diagType ให้ถูกต้อง
  renderDxList();
}

function addDiagnosis() {
  if (!selectedIcd10) return;
  const code = selectedIcd10.code;

  if (diagnoses.find(d => d.icd10 === code)) {
    showAlert('warning', `รหัส ${code} มีอยู่ในรายการแล้ว`);
    icdSearch.select();
    return;
  }

  // diagtype=1 เฉพาะ icd10 แรกเท่านั้น, ถัดไปทุกตัวเป็น 4
  const diagtype = diagnoses.length === 0 ? '1' : '4';

  diagnoses.push({ icd10: code, icd10_name: selectedIcd10.name, diagtype });
  renderDxList();
  applyDiagTypeDefault(); // อัปเดต dropdown ให้แสดง default ถัดไปถูกต้อง

  icdSearch.value = '';
  icdNameField.value = '';
  selectedIcd10 = null;
  btnAdd.disabled = true;
  icdDropdown.style.display = 'none';
  icdSearch.focus();
}

function removeDiagnosis(idx) {
  diagnoses.splice(idx, 1);
  renderDxList();
}

function changeDiagType(idx, val) {
  diagnoses[idx].diagtype = parseInt(val);
}

function renderDxList() {
  const el = document.getElementById('dxList');
  document.getElementById('dxCount').textContent = `${diagnoses.length} รายการ`;

  // ไม่ reset diagType ที่นี่ — ให้ผู้ใช้เลือกเองได้หลัง initial load

  if (!diagnoses.length) {
    el.innerHTML = `<div class="empty-dx">
      <i class="fas fa-notes-medical fa-2x mb-2 d-block text-muted"></i>ยังไม่มีรายการวินิจฉัย
    </div>`;
    return;
  }

  el.innerHTML = diagnoses.map((d, i) => `
    <div class="dx-list-item">
      <div class="me-1 text-muted fw-bold" style="min-width:24px;">${toArabicDigits(i + 1)}.</div>
      <div class="flex-fill">
        <span class="icd-code-badge fs-6">${escHtml(toArabicDigits(d.icd10))}</span>
        <span class="ms-2">${escHtml(toArabicDigits(d.icd10_name))}</span>
      </div>
      <div style="min-width:220px;">
        <select class="form-select form-select-sm" onchange="changeDiagType(${i}, this.value)">
          ${((diagTypes.length ? diagTypes : Object.keys(diagTypeLabels).map(k => ({ code: k, label: `${k} – ${diagTypeLabels[k]}`}))).map(t => `
            <option value="${escAttr(t.code)}" ${String(d.diagtype).trim() === String(t.code).trim() ? 'selected' : ''}>${escHtml(t.label)}</option>
          `)).join('')}
        </select>
      </div>
      <button class="btn btn-sm btn-outline-danger ms-2" onclick="removeDiagnosis(${i})">
        <i class="fas fa-trash"></i>
      </button>
    </div>`).join('');
}

// ─── Doctor Search ────────────────────────────────────────────────────────────

function onDoctorSearch() {
  const q  = document.getElementById('doctorSearch').value.trim();
  const dd = document.getElementById('doctorDropdown');

  document.getElementById('doctorCode').value = '';
  document.getElementById('doctorSelected').textContent = '';

  if (!q) { dd.style.display = 'none'; return; }

  clearTimeout(doctorSearchTimer);
  doctorSearchTimer = setTimeout(async () => {
    try {
      const res  = await apiFetch(`/api/doctors/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const list = data.data || [];

      if (!list.length) {
        dd.innerHTML = '<div style="padding:8px 14px;color:#94a3b8;font-size:18px;">ไม่พบแพทย์</div>';
      } else {
        dd.innerHTML = list.map(d => `
          <div onclick="selectDoctor('${escAttr(d.code)}','${escAttr(d.doctor_name)}')"
            style="padding:6px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;"
            onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''">
            <span style="font-weight:700;color:#1d4ed8;">${escHtml(d.code)}</span>
            <span class="mx-1">–</span>${escHtml(d.name)}
            ${d.licenseno ? `<span style="color:#64748b;"> (${escHtml(d.licenseno)})</span>` : ''}
          </div>`).join('');
      }
      dd.style.display = 'block';
    } catch (_) {}
  }, 200);
}

function selectDoctor(code, name) {
  document.getElementById('doctorSearch').value = name;
  document.getElementById('doctorCode').value   = code;
  document.getElementById('doctorSelected').textContent = '✓ ' + name;
  document.getElementById('doctorDropdown').style.display = 'none';
}

document.addEventListener('click', e => {
  if (!e.target.closest('#doctorSearch') && !e.target.closest('#doctorDropdown'))
    document.getElementById('doctorDropdown').style.display = 'none';
});

async function loadDoctor() {
  try {
    const res  = await apiFetch(`/api/doctor/${vn}?date=${date}`);
    const data = await res.json();
    if (data.success && data.data) {
      const d = data.data;
      document.getElementById('defaultDoctorName').textContent = d.doctor_name || d.name || '–';
      // pre-select ในช่องค้นหา
      if (d.code) {
        const found = allDoctors.find(doc => doc.code === d.code);
        const displayName = found ? found.doctor_name : (d.doctor_name || `${d.code}-${d.name || ''}(${d.licenseno || ''})`);
        selectDoctor(d.code, displayName);
      }
    }
  } catch (_) {}
}

async function loadDoctors() {
  try {
    const res  = await apiFetch('/api/doctors');
    const data = await res.json();
    if (data.success) {
      allDoctors = data.data;
    }
  } catch (_) {}
}

// ─── ICD9CM ───────────────────────────────────────────────────────────────────

async function loadOperTypes() {
  try {
    const res  = await apiFetch('/api/oper-types');
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      operTypes = data.data;
    }
  } catch (_) {}
  const el = document.getElementById('icd9OperType');
  if (!el) return;
  if (!operTypes.length) {
    el.innerHTML = '<option value="">ไม่พบข้อมูล oper type</option>';
    return;
  }
  el.innerHTML = '<option value="">-- เลือก oper type --</option>' +
    operTypes.map(t => `<option value="${escAttr(String(t.name))}">${escHtml(t.name)}</option>`).join('');
}

async function loadIcd9cm() {
  try {
    const res  = await apiFetch(`/api/icd9cm/${vn}`);
    const data = await res.json();
    if (data.success && data.data.length) {
      procedures = data.data.map(r => ({
        icd9cm:         r.icd9cm,
        icd9cm_name:    r.icd9cm_name || '',
        oper_type:      r.oper_type   || '',
        oper_type_name: r.oper_type_name || '',
        ext_code:       r.ext_code    || '',
        doctor_raw:     r.doctor_raw  || '',
      }));
    }
  } catch (_) {}
  renderIcd9List();
}

async function loadOvstDoctor() {
  try {
    const res  = await apiFetch(`/api/ovst-doctor/${vn}`);
    const data = await res.json();
    if (data.success && data.data) {
      const rawEl  = document.getElementById('icd9DoctorRaw');
      const nameEl = document.getElementById('icd9DoctorName');
      if (rawEl)  rawEl.value  = data.data.doctor_raw  || '';
      if (nameEl && !nameEl.value) nameEl.value = data.data.doctor_name || '';
    }
  } catch (_) {}
}

let icd9DoctorSearchTimer = null;

function onIcd9DoctorSearch() {
  const q  = (document.getElementById('icd9DoctorName').value || '').trim();
  const dd = document.getElementById('icd9DoctorDropdown');
  if (!dd) return;
  if (q.length < 1) { dd.style.display = 'none'; return; }
  clearTimeout(icd9DoctorSearchTimer);
  icd9DoctorSearchTimer = setTimeout(async () => {
    try {
      const res  = await apiFetch(`/api/doctors/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const list = data.data || [];
      if (!list.length) {
        dd.innerHTML = '<div style="padding:8px 14px;color:#94a3b8;">ไม่พบแพทย์</div>';
      } else {
        dd.innerHTML = list.map(d => `
          <div onclick="selectIcd9Doctor('${escAttr(d.name)}')"
            style="padding:6px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;"
            onmouseover="this.style.background='#dbeafe'" onmouseout="this.style.background=''">
            <span style="font-weight:700;color:#1d4ed8;">${escHtml(d.code)}</span>
            <span class="mx-1">–</span>${escHtml(d.name)}
          </div>`).join('');
      }
      dd.style.display = 'block';
    } catch (_) {}
  }, 200);
}

function selectIcd9Doctor(name) {
  const nameEl = document.getElementById('icd9DoctorName');
  const dd     = document.getElementById('icd9DoctorDropdown');
  if (nameEl) nameEl.value = name;
  if (dd) dd.style.display = 'none';
}

document.addEventListener('click', e => {
  const dd = document.getElementById('icd9DoctorDropdown');
  if (dd && !e.target.closest('#icd9DoctorName') && !e.target.closest('#icd9DoctorDropdown'))
    dd.style.display = 'none';
});

const icd9Search   = document.getElementById('icd9Search');
const icd9Dropdown = document.getElementById('icd9Dropdown');

if (icd9Search) {
  icd9Search.addEventListener('input', () => {
    const ascii = icd9Search.value.replace(/[^\x00-\x7F]/g, '');
    if (ascii !== icd9Search.value) icd9Search.value = ascii;

    selectedIcd9 = null;
    const nameEl = document.getElementById('icd9NameField');
    if (nameEl) nameEl.value = '';

    clearTimeout(icd9SearchTimer);
    const q = icd9Search.value.trim();
    if (q.length < 2) { if (icd9Dropdown) icd9Dropdown.style.display = 'none'; return; }
    icd9SearchTimer = setTimeout(() => searchIcd9(q), 250);
  });

  icd9Search.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (selectedIcd9) addIcd9(); return; }
    if (e.key === 'Escape' && icd9Dropdown) icd9Dropdown.style.display = 'none';
  });
}

document.addEventListener('click', e => {
  if (icd9Dropdown && !e.target.closest('#icd9Search') && !e.target.closest('#icd9Dropdown'))
    icd9Dropdown.style.display = 'none';
});

async function searchIcd9(q) {
  try {
    const res  = await apiFetch(`/api/icd9cm/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.success || !data.data.length) {
      icd9Dropdown.innerHTML = '<div style="padding:8px 14px;color:#94a3b8;">ไม่พบรหัส ICD9CM</div>';
      icd9Dropdown.style.display = 'block';
      return;
    }
    const qUp = q.toUpperCase();
    const exact = data.data.find(item => item.code.toUpperCase() === qUp);
    if (exact) selectIcd9(exact.code, exact.name);

    icd9Dropdown.innerHTML = data.data.map(item => {
      const isExact = item.code.toUpperCase() === qUp;
      return `<div onclick="selectIcd9('${escAttr(item.code)}','${escAttr(item.name)}')"
        style="padding:6px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;${isExact ? 'background:#eff6ff;font-weight:700;' : ''}"
        onmouseover="this.style.background='#dbeafe'" onmouseout="this.style.background='${isExact ? '#eff6ff' : ''}'">
        <span class="icd-code-badge">${escHtml(item.code)}</span>
        <span class="ms-2">${escHtml(item.name)}</span>
      </div>`;
    }).join('');
    icd9Dropdown.style.display = 'block';
  } catch (_) {}
}

function selectIcd9(code, name) {
  selectedIcd9 = { code, name };
  icd9Search.value = code;
  document.getElementById('icd9NameField').value = name;
  icd9Dropdown.style.display = 'none';
}

function addIcd9() {
  if (!selectedIcd9) { showAlert('warning', 'กรุณาเลือกรหัส ICD9CM ก่อน'); return; }
  const code = selectedIcd9.code;
  if (procedures.find(p => p.icd9cm === code)) {
    showAlert('warning', `รหัส ${code} มีอยู่ในรายการแล้ว`);
    if (icd9Search) icd9Search.select();
    return;
  }

  const operTypeEl  = document.getElementById('icd9OperType');
  const selOper     = operTypeEl ? operTypeEl.value : '';
  const selOperName = selOper ? (operTypeEl.options[operTypeEl.selectedIndex]?.text || '') : '';
  const extCode     = (document.getElementById('icd9ExtCode')?.value || '').trim();
  const doctorRaw   = (document.getElementById('icd9DoctorRaw')?.value || '').trim();

  procedures.push({
    icd9cm:         code,
    icd9cm_name:    selectedIcd9.name,
    oper_type:      selOper,
    oper_type_name: selOperName,
    ext_code:       extCode,
    doctor_raw:     doctorRaw,
  });
  renderIcd9List();

  if (icd9Search) icd9Search.value = '';
  const nameEl = document.getElementById('icd9NameField');
  if (nameEl) nameEl.value = '';
  const extEl = document.getElementById('icd9ExtCode');
  if (extEl) extEl.value = '';
  selectedIcd9 = null;
  if (icd9Search) icd9Search.focus();
}

function removeIcd9(idx) {
  procedures.splice(idx, 1);
  renderIcd9List();
}

function renderIcd9List() {
  const el = document.getElementById('icd9List');
  document.getElementById('icd9Count').textContent = `${procedures.length} รายการ`;

  if (!procedures.length) {
    el.innerHTML = `<div class="empty-dx">
      <i class="fas fa-procedures fa-2x mb-2 d-block text-muted"></i>ยังไม่มีรายการหัตถการ
    </div>`;
    return;
  }

  el.innerHTML = procedures.map((p, i) => `
    <div class="dx-list-item">
      <div class="me-1 text-muted fw-bold" style="min-width:24px;">${toArabicDigits(i + 1)}.</div>
      <div class="flex-fill">
        <span class="icd-code-badge fs-6">${escHtml(p.icd9cm)}</span>
        <span class="ms-2">${escHtml(p.icd9cm_name)}</span>
        ${p.oper_type_name ? `<span class="ms-2 badge" style="background:#dcfce7;color:#000;border:1px solid #86efac;">${escHtml(p.oper_type_name)}</span>` : ''}
        ${p.ext_code ? `<span class="ms-2 text-muted" style="font-size:0.85em;">ext: ${escHtml(p.ext_code)}</span>` : ''}
        ${p.doctor_raw ? `<span class="ms-2 text-muted" style="font-size:0.85em;">รหัสแพทย์: ${escHtml(p.doctor_raw)}</span>` : ''}
      </div>
      <button class="btn btn-sm btn-outline-danger ms-2" onclick="removeIcd9(${i})">
        <i class="fas fa-trash"></i>
      </button>
    </div>`).join('');
}

// ─── Confirm Checkbox ────────────────────────────────────────────────────────

function onConfirmChange() { /* checkbox ยังใช้ส่งค่า confirm='Y' แต่ไม่ lock ปุ่ม */ }

// ─── Save ─────────────────────────────────────────────────────────────────────

async function saveDiagnosis() {
  if (!patientData) { showAlert('danger', 'ไม่พบข้อมูลผู้ป่วย'); return; }
  if (!diagnoses.length) { showAlert('warning', 'กรุณาเพิ่มรายการวินิจฉัยก่อน'); return; }

  const doctor_code = document.getElementById('doctorCode').value;
  const confirmed   = document.getElementById('chkConfirm').checked;
  showLoading(true);
  try {
    const res  = await apiFetch('/api/diagnosis', {
      method: 'POST',
      body: { vn, diagnoses, doctor_code, confirmed, procedures },
    });
    const data = await res.json();
    if (data.success) {
      window.location.href = '/patients.html';
    } else {
      showAlert('danger', data.message, true);
    }
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showAlert('danger', 'เกิดข้อผิดพลาด: ' + e.message);
  }
  showLoading(false);
}
