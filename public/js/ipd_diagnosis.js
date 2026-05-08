const urlParams = new URLSearchParams(window.location.search);
const an = urlParams.get('an');

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
  const p = patientData;
  const regdate = String(p.regdate||'').substring(0,10);
  const dchdate = String(p.dchdate||'').substring(0,10);
  document.getElementById('patientInfo').innerHTML = `
    <div class="row g-1">
      <div class="col-6 col-md-3">
        <div class="info-label">ชื่อ-สกุล</div>
        <div class="info-value large">${escHtml(p.patient_name)}</div>
      </div>
      <div class="col-6 col-md-1">
        <div class="info-label">HN</div>
        <div class="info-value">${escHtml(p.hn)}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">AN</div>
        <div class="info-value">${escHtml(p.an)}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">วันรับ</div>
        <div class="info-value">${escHtml(regdate)} ${escHtml(String(p.regtime||'').substring(0,5))}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">วันจำหน่าย</div>
        <div class="info-value">${escHtml(dchdate) || '–'}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">ตึก/วอร์ด</div>
        <div class="info-value">${escHtml(p.spclty_ward_name || p.ward_name || '–')}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">สิทธิ์</div>
        <div class="info-value">${escHtml(p.pttype_name || '–')}</div>
      </div>
      <div class="col-6 col-md-2">
        <div class="info-label">อายุ</div>
        <div class="info-value">${p.age_y||''}ปี ${p.age_m||''}ด</div>
      </div>
      <div class="col-6 col-md-3">
        <div class="info-label">แพทย์เจ้าของไข้</div>
        <div class="info-value">${escHtml(p.incharge_doctor_name || p.admdoctor_name || '–')}</div>
      </div>
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
      body: { an, diagnoses, doctor_code, confirmed },
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
