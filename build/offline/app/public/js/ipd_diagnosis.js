const urlParams = new URLSearchParams(window.location.search);
const an = urlParams.get('an');

let patientData   = null;
let diagnoses     = [];
let selectedIcd10 = null;
let icdSearchTimer = null;
let allDoctors    = [];
let doctorSearchTimer = null;

// ─── ICD9CM State ─────────────────────────────────────────────────────────────
let procedures      = [];   // รายการ icd9cm ที่เพิ่มแล้ว
let selectedIcd9    = null; // icd9cm ที่เลือกอยู่ในช่อง input
let icd9SearchTimer = null;
let operTypes       = [];

// ─── Auth guard ───────────────────────────────────────────────────────────────
(async () => {
  const user = await requireAuth();
  if (!user) return;
  renderNavUser();
  document.getElementById('anDisplay').textContent = `AN: ${an}`;

  if (!an) {
    document.getElementById('patientInfo').innerHTML =
      '<div class="text-danger"><i class="fas fa-exclamation-triangle me-2"></i>ไม่พบ AN ใน URL</div>';
    return;
  }
  const u = getUser();
  if (u) {
    const el = document.getElementById('confirmerName');
    if (el) el.textContent = u.officer_name || u.officer_login_name || '–';
  }

  showLoading(true);
  await Promise.all([loadPatient(), loadDiagnoses(), loadDoctors()]);
  loadOperTypes();
  loadIcd9cm();
  loadAdmitDoctor();
  showLoading(false);
})();

function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escAttr(str) {
  return (str || '').replace(/'/g,"&#39;").replace(/"/g,'&quot;');
}
function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('d-none', !show);
}
function showAlert(type, msg, stay = false) {
  const icons = { success:'check-circle', danger:'times-circle', warning:'exclamation-triangle' };
  const box = document.getElementById('alertBox');
  box.className = `alert alert-${type}`;
  box.innerHTML = `<i class="fas fa-${icons[type]||'info-circle'} me-2"></i>${msg}`;
  box.classList.remove('d-none');
  if (!stay) setTimeout(() => box.classList.add('d-none'), 5000);
}

const diagTypeLabels = { 1:'PDX (หลัก)', 2:'โรคร่วม', 3:'ภาวะแทรกซ้อน', 4:'อื่นๆ', 5:'สาเหตุภายนอก' };

// ─── Patient Info ─────────────────────────────────────────────────────────────
async function loadPatient() {
  try {
    const res  = await apiFetch(`/api/ipd/patient/${an}`);
    const data = await res.json();
    if (!data.success || !data.data) {
      document.getElementById('patientInfo').innerHTML =
        '<div class="text-danger"><i class="fas fa-exclamation-triangle me-2"></i>ไม่พบข้อมูลผู้ป่วย</div>';
      return;
    }
    patientData = data.data;
    renderPatientInfo();
    renderDxTextList();
    // pre-select แพทย์เจ้าของไข้จาก ipt
    if (patientData.incharge_doctor_code) {
      const code = patientData.incharge_doctor_code;
      const name = patientData.incharge_doctor_name || code;
      const lic  = patientData.incharge_doctor_licenseno || '';
      const displayName = `${code}-${name}(${lic})`;
      document.getElementById('defaultDoctorName').textContent = displayName;
      selectDoctor(code, displayName);
    }
  } catch (e) {
    document.getElementById('patientInfo').innerHTML =
      `<div class="text-danger">เกิดข้อผิดพลาด: ${e.message}</div>`;
  }
}


function renderPatientInfo() {
  const p       = patientData;
  const regdate = String(p.regdate||'').substring(0,10);
  const regtime = String(p.regtime||'').substring(0,8);
  const dchdate = String(p.dchdate||'').substring(0,10);
  const dchtime = String(p.dchtime||'').substring(0,8);
  const los     = (p.admdate != null && p.admdate !== '') ? p.admdate : '–';
  const doctor  = escHtml(p.incharge_doctor_name || p.admdoctor_name || '–');

  function field(label, value, bold) {
    return `<span class="pi-field${bold?' pi-bold':''}"><span class="pi-lbl">${label}:</span> <span class="pi-val">${value}</span></span>`;
  }

  document.getElementById('patientInfo').innerHTML = `
    <style>
      .pi-row { display:flex; flex-wrap:wrap; gap:6px 24px; align-items:baseline; margin-bottom:4px; }
      .pi-field { display:inline-flex; gap:4px; align-items:baseline; white-space:nowrap; }
      .pi-lbl { color:#555; font-weight:600; }
      .pi-val { color:#000; }
      .pi-bold .pi-val { font-weight:700; }
    </style>
    <div class="pi-row">
      ${field('ชื่อ-สกุล', escHtml(p.patient_name))}
      ${field('HN', escHtml(p.hn))}
      ${field('AN', escHtml(p.an))}
      ${field('อายุ', (p.age_y||'–') + ' ปี')}
    </div>
    <div class="pi-row">
      ${field('แพทย์เจ้าของไข้', doctor)}
      ${field('วันรับ', escHtml(regdate) + ' ' + escHtml(regtime))}
      ${field('วันจำหน่าย', escHtml(dchdate) || '–')}
      ${field('เวลาจำหน่าย', escHtml(dchtime) || '–')}
      ${field('จำนวนวันนอน', los, true)}
    </div>
    <div class="pi-row">
      ${field('ตึก/วอร์ด', escHtml(p.spclty_ward_name || p.ward_name || '–'))}
      ${field('สิทธิ์', escHtml(p.pttype_name || '–'))}
    </div>`;
}

function renderDxTextList() {
  const txt = (patientData && patientData.diag_text_list) ? patientData.diag_text_list.trim() : '';
  const section = document.getElementById('dxTextSection');
  const el      = document.getElementById('dxTextDisplay');
  if (!section || !el) return;
  if (txt) { el.textContent = txt; section.classList.remove('d-none'); }
  else      { section.classList.add('d-none'); }
}

// ─── ICD10 Search ─────────────────────────────────────────────────────────────
const icdSearch    = document.getElementById('icdSearch');
const icdDropdown  = document.getElementById('icdDropdown');
const icdNameField = document.getElementById('icdNameField');
const btnAdd       = document.getElementById('btnAdd');

icdSearch.addEventListener('input', () => {
  // กรองเฉพาะ ASCII ออก ไม่ให้พิมพ์ภาษาไทย
  const ascii = icdSearch.value.replace(/[^\x00-\x7F]/g, '');
  if (ascii !== icdSearch.value) icdSearch.value = ascii;

  selectedIcd10 = null; icdNameField.value = ''; btnAdd.disabled = true;
  clearTimeout(icdSearchTimer);
  const q = icdSearch.value.trim();
  if (q.length < 2) { icdDropdown.style.display = 'none'; return; }
  icdSearchTimer = setTimeout(() => searchIcd10(q), 250);
});

icdSearch.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); if (selectedIcd10) addDiagnosis(); return; }
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
      icdDropdown.style.display = 'block'; return;
    }
    const qUp  = q.toUpperCase();
    const exact = data.data.find(item => item.code.toUpperCase() === qUp);
    if (exact) { selectIcd10(exact.code, exact.name); if (data.data.length === 1) { icdDropdown.style.display = 'none'; return; } }
    icdDropdown.innerHTML = data.data.map(item => {
      const isExact = item.code.toUpperCase() === qUp;
      return `<div class="icd-dropdown-item${isExact?' bg-light fw-bold':''}"
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
  icdSearch.value = code; icdNameField.value = name;
  icdDropdown.style.display = 'none'; btnAdd.disabled = false;
}

// ─── Diagnosis List ───────────────────────────────────────────────────────────
async function loadDiagnoses() {
  try {
    const res  = await apiFetch(`/api/ipd/diagnosis/${an}`);
    const data = await res.json();
    if (data.success && data.data.length) {
      diagnoses = data.data.map(d => ({
        icd10: d.icd10, icd10_name: d.icd10_name || '',
        diagtype: parseInt(d.diagtype) || 2,
      }));
      // pre-check checkbox ถ้า dx_guid='Y'
      const confirmed = data.data.some(d => String(d.dx_guid).trim().toUpperCase() === 'Y');
      const chk = document.getElementById('chkConfirm');
      if (chk && confirmed) chk.checked = true;
    }
  } catch (_) {}
  renderDxList();
}

function addDiagnosis() {
  if (!selectedIcd10) return;
  const code     = selectedIcd10.code;
  const diagtype = parseInt(document.getElementById('diagType').value);
  if (diagnoses.find(d => d.icd10 === code)) {
    showAlert('warning', `รหัส ${code} มีอยู่ในรายการแล้ว`); icdSearch.select(); return;
  }
  diagnoses.push({ icd10: code, icd10_name: selectedIcd10.name, diagtype });
  renderDxList();
  icdSearch.value = ''; icdNameField.value = '';
  selectedIcd10 = null; btnAdd.disabled = true;
  icdDropdown.style.display = 'none'; icdSearch.focus();
}

function removeDiagnosis(idx) { diagnoses.splice(idx, 1); renderDxList(); }
function changeDiagType(idx, val) { diagnoses[idx].diagtype = parseInt(val); }

function renderDxList() {
  const el = document.getElementById('dxList');
  document.getElementById('dxCount').textContent = `${diagnoses.length} รายการ`;
  const diagTypeEl = document.getElementById('diagType');
  if (diagTypeEl) diagTypeEl.value = diagnoses.length === 0 ? '1' : '4';
  if (!diagnoses.length) {
    el.innerHTML = `<div class="empty-dx">
      <i class="fas fa-notes-medical fa-2x mb-2 d-block text-muted"></i>ยังไม่มีรายการวินิจฉัย</div>`;
    return;
  }
  el.innerHTML = diagnoses.map((d, i) => `
    <div class="dx-list-item">
      <div class="me-1 fw-bold" style="min-width:24px;">${i + 1}.</div>
      <div class="flex-fill">
        <span class="icd-code-badge">${escHtml(d.icd10)}</span>
        <span class="ms-2">${escHtml(d.icd10_name)}</span>
      </div>
      <div style="min-width:220px;">
        <select class="form-select form-select-sm" onchange="changeDiagType(${i}, this.value)">
          ${[1,2,3,4,5].map(t =>
            `<option value="${t}" ${d.diagtype===t?'selected':''}>${t} – ${diagTypeLabels[t]}</option>`
          ).join('')}
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
      dd.innerHTML = !list.length
        ? '<div style="padding:8px 14px;color:#94a3b8;">ไม่พบแพทย์</div>'
        : list.map(d => `
          <div onclick="selectDoctor('${escAttr(d.code)}','${escAttr(d.doctor_name)}')"
            style="padding:6px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;"
            onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''">
            <span style="font-weight:700;color:#1d4ed8;">${escHtml(d.code)}</span>
            <span class="mx-1">–</span>${escHtml(d.name)}
            ${d.licenseno ? `<span style="color:#64748b;"> (${escHtml(d.licenseno)})</span>` : ''}
          </div>`).join('');
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

async function loadDoctors() {
  try {
    const res  = await apiFetch('/api/doctors');
    const data = await res.json();
    if (data.success) allDoctors = data.data;
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
    const res  = await apiFetch(`/api/ipd/icd9cm/${an}`);
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

async function loadAdmitDoctor() {
  try {
    const res  = await apiFetch(`/api/ipd/admit-doctor/${an}`);
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
      <div class="me-1 text-muted fw-bold" style="min-width:24px;">${i + 1}.</div>
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

// ─── Confirm ──────────────────────────────────────────────────────────────────
function onConfirmChange() {}

// ─── Save ─────────────────────────────────────────────────────────────────────
async function saveDiagnosis() {
  if (!patientData) { showAlert('danger', 'ไม่พบข้อมูลผู้ป่วย'); return; }
  if (!diagnoses.length) { showAlert('warning', 'กรุณาเพิ่มรายการวินิจฉัยก่อน'); return; }

  const doctor_code = document.getElementById('doctorCode').value;
  const confirmed   = document.getElementById('chkConfirm').checked;
  showLoading(true);
  try {
    const res  = await apiFetch('/api/ipd/diagnosis', {
      method: 'POST',
      body: { an, diagnoses, doctor_code, confirmed, procedures },
    });
    const data = await res.json();
    if (data.success) {
      window.location.href = '/ipd_patients.html';
    } else {
      showAlert('danger', data.message, true);
    }
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showAlert('danger', 'เกิดข้อผิดพลาด: ' + e.message);
  }
  showLoading(false);
}
