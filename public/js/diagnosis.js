const urlParams = new URLSearchParams(window.location.search);
const vn   = urlParams.get('vn');
const date = urlParams.get('date') || new Date().toISOString().split('T')[0];

let patientData   = null;
let diagnoses     = [];
let selectedIcd10 = null;
let icdSearchTimer = null;
let allDoctors    = [];
let doctorSearchTimer = null;

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
  await Promise.all([loadPatient(), loadDiagnoses(), loadDoctors(), loadDoctor()]);
  showLoading(false);
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

// ─── Patient Info ─────────────────────────────────────────────────────────────

async function loadPatient() {
  try {
    const res  = await apiFetch(`/api/patient/${vn}?date=${date}`);
    const data = await res.json();
    if (!data.success || !data.data) {
      document.getElementById('patientInfo').innerHTML =
        `<div class="text-danger"><i class="fas fa-exclamation-triangle me-2"></i>ไม่พบข้อมูลผู้ป่วย</div>`;
      return;
    }
    patientData = data.data;
    renderPatientInfo();
    renderDxTextList();
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ')
      document.getElementById('patientInfo').innerHTML = `<div class="text-danger">เกิดข้อผิดพลาด: ${e.message}</div>`;
  }
}

function renderPatientInfo() {
  const p = patientData;
  document.getElementById('patientInfo').innerHTML = `
    <div class="row g-1">
      <div class="col-6 col-md-3">
        <div class="info-label">ชื่อ-สกุล</div>
        <div class="info-value large">${escHtml(p.ptname)}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">HN</div>
        <div class="info-value">${escHtml(p.hn)}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">เลขบัตร (CID)</div>
        <div class="info-value">${escHtml(p.cid || '–')}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">วันที่ตรวจ</div>
        <div class="info-value">${escHtml(String(p.vstdate||'').substring(0,10))} ${escHtml(String(p.vsttime||'').substring(0,5))}</div>
      </div>
      <div class="col-6 col-md-3">
        <div class="info-label">ห้องแรกที่ส่งตรวจ</div>
        <div class="info-value">${escHtml(p.main_dep || '–')}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">สิทธิ์การรักษา</div>
        <div class="info-value">${escHtml(p.pttype_name || '–')}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">Specialty</div>
        <div class="info-value">${escHtml(p.spclty_name || '–')}</div>
      </div>
      <div class="col-6 col-md-3">
        <div class="info-label">PDX</div>
        <div class="info-value">
          ${p.pdx
            ? `<span style="background:#dbeafe;color:#1d4ed8;font-family:monospace;padding:1px 5px;border-radius:3px;">${escHtml(p.pdx)}</span>
               <span class="ms-1 text-muted">${escHtml(p.pdx_name || '')}</span>`
            : '<span class="text-muted">–</span>'}
        </div>
      </div>
    </div>`;
}

function renderDxTextList() {
  const txt = (patientData && patientData.dx_text_list) ? patientData.dx_text_list.trim() : '';
  const section = document.getElementById('dxTextSection');
  const el      = document.getElementById('dxTextDisplay');
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
    const res  = await apiFetch(`/api/diagnosis/${vn}`);
    const data = await res.json();
    if (data.success && data.data.length) {
      diagnoses = data.data.map(d => ({
        icd10: d.icd10,
        icd10_name: d.icd10_name || '',
        diagtype: parseInt(d.diagtype) || 2,
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
  const code     = selectedIcd10.code;
  const diagtype = parseInt(document.getElementById('diagType').value);

  if (diagnoses.find(d => d.icd10 === code)) {
    showAlert('warning', `รหัส ${code} มีอยู่ในรายการแล้ว`);
    icdSearch.select();
    return;
  }
  diagnoses.push({ icd10: code, icd10_name: selectedIcd10.name, diagtype });
  renderDxList();

  // clear และ refocus เพื่อพิมพ์รหัสถัดไปได้ทันที
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

  // auto-set diagType: 1 ถ้ายังไม่มีรายการ, 4 ถ้ามีแล้ว
  const diagTypeEl = document.getElementById('diagType');
  if (diagTypeEl) diagTypeEl.value = diagnoses.length === 0 ? '1' : '4';

  if (!diagnoses.length) {
    el.innerHTML = `<div class="empty-dx">
      <i class="fas fa-notes-medical fa-2x mb-2 d-block text-muted"></i>ยังไม่มีรายการวินิจฉัย
    </div>`;
    return;
  }

  el.innerHTML = diagnoses.map((d, i) => `
    <div class="dx-list-item">
      <div class="me-1 text-muted fw-bold" style="min-width:24px;">${i + 1}.</div>
      <div class="flex-fill">
        <span class="icd-code-badge fs-6">${escHtml(d.icd10)}</span>
        <span class="ms-2">${escHtml(d.icd10_name)}</span>
      </div>
      <div style="min-width:220px;">
        <select class="form-select form-select-sm" onchange="changeDiagType(${i}, this.value)">
          ${[1,2,3,4,5].map(t => `
            <option value="${t}" ${d.diagtype === t ? 'selected' : ''}>${t} – ${diagTypeLabels[t]}</option>
          `).join('')}
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
      body: { vn, diagnoses, doctor_code, confirmed },
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
