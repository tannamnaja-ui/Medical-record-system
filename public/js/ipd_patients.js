let allPatients = [];
const STATE_KEY = 'ipd_list_state';

function saveState() {
  const state = {
    dateFrom:       document.getElementById('dateFrom').value,
    dateTo:         document.getElementById('dateTo').value,
    ward:           document.getElementById('wardSelect').value,
    confirmedOnly:  document.getElementById('chkConfirmedDch').checked,
    searchInput:    document.getElementById('searchInput').value,
    chkNoIcd:       document.getElementById('chkNoIcd').checked,
    chkHasIcd:      document.getElementById('chkHasIcd').checked,
    chkHasDxText:   document.getElementById('chkHasDxText').checked,
    patients:       allPatients,
  };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function restoreState(state) {
  document.getElementById('dateFrom').value        = state.dateFrom  || '';
  document.getElementById('dateTo').value          = state.dateTo    || '';
  document.getElementById('chkConfirmedDch').checked = !!state.confirmedOnly;
  document.getElementById('searchInput').value     = state.searchInput || '';
  document.getElementById('chkNoIcd').checked      = !!state.chkNoIcd;
  document.getElementById('chkHasIcd').checked     = !!state.chkHasIcd;
  document.getElementById('chkHasDxText').checked  = !!state.chkHasDxText;
  allPatients = state.patients || [];
  // restore ward หลัง loadWards() โหลดเสร็จ (ทำใน loadWards)
  return state.ward;
}

(async () => {
  const user = await requireAuth();
  if (!user) return;
  renderNavUser();

  const saved = sessionStorage.getItem(STATE_KEY);
  if (saved) {
    try {
      const state = JSON.parse(saved);
      const savedWard = restoreState(state);
      await Promise.all([loadWards(savedWard), loadHospitalName()]);
      updateWardLabel();

      if (state.chkNoIcd) {
        // ติ๊ก "ยังไม่ลง ICD10" → reload ใหม่จาก server ทันที
        await loadPatients();
      } else {
        applyFilters(); // ใช้ data เดิมจาก cache
      }
      return;
    } catch (_) {}
  }

  // ไม่มี state เก่า — ตั้งค่าเริ่มต้น
  const today    = new Date().toISOString().split('T')[0];
  const firstDay = today.substring(0, 7) + '-01';
  document.getElementById('dateFrom').value = firstDay;
  document.getElementById('dateTo').value   = today;

  await Promise.all([loadWards(), loadHospitalName()]);
})();

document.getElementById('searchInput').addEventListener('input', applyFilters);

function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('d-none', !show);
}

async function loadHospitalName() {
  try {
    const res  = await apiFetch('/api/hospital');
    const data = await res.json();
    if (data.hospitalname)
      document.getElementById('hospitalName').textContent = '— ' + data.hospitalname;
  } catch (_) {}
}

async function loadWards(savedWard = null) {
  try {
    const res  = await apiFetch('/api/ipd/wards');
    const data = await res.json();
    if (data.success) {
      const sel = document.getElementById('wardSelect');
      data.data.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.ward;
        opt.textContent = `${w.ward} – ${w.name || ''}`;
        sel.appendChild(opt);
      });
      if (savedWard) sel.value = savedWard;
    }
  } catch (_) {}
}

function updateWardLabel() {
  const sel  = document.getElementById('wardSelect');
  const txt  = sel.options[sel.selectedIndex].text;
  const el   = document.getElementById('wardLabel');
  if (el) el.textContent = sel.value === 'ALL' ? 'ตึก : ทุกตึก' : `ตึก : ${txt}`;
}

async function loadPatients() {
  const dateFrom      = document.getElementById('dateFrom').value;
  const dateTo        = document.getElementById('dateTo').value;
  const ward          = document.getElementById('wardSelect').value;
  const confirmedOnly = document.getElementById('chkConfirmedDch').checked;
  if (!dateFrom || !dateTo) return;

  showLoading(true);
  document.getElementById('searchInput').value = '';
  document.getElementById('rowCount').textContent = '';
  updateWardLabel();

  try {
    const params = new URLSearchParams({ dateFrom, dateTo, ward, confirmedOnly });
    const res  = await apiFetch(`/api/ipd/patients?${params}`);
    const data = await res.json();
    if (!data.success) { showError(data.message); return; }
    allPatients = data.data || [];
    saveState();
    applyFilters();
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showError('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    showLoading(false);
  }
}

function showError(msg) {
  document.getElementById('ipdBody').innerHTML = `
    <tr><td colspan="13" class="text-center text-danger py-4">
      <i class="fas fa-exclamation-triangle me-2"></i>${escHtml(msg)}
    </td></tr>`;
}

function applyFilters() {
  const q         = document.getElementById('searchInput').value.toLowerCase().trim();
  const noIcd     = document.getElementById('chkNoIcd').checked;
  const hasIcd    = document.getElementById('chkHasIcd').checked;
  const hasDxText = document.getElementById('chkHasDxText').checked;

  const filtered = allPatients.filter(p => {
    if (q && !(
      (p.patient_name || '').toLowerCase().includes(q) ||
      (p.an           || '').toString().includes(q)   ||
      (p.hn           || '').toString().includes(q)   ||
      (p.icd10        || '').toLowerCase().includes(q)||
      (p.icdname      || '').toLowerCase().includes(q)
    )) return false;

    const hasIcdVal   = p.icd10 && String(p.icd10).trim() !== '';
    const hasDxTxtVal = p.diag_text_list && String(p.diag_text_list).trim() !== '';

    if (noIcd     && hasIcdVal)    return false;
    if (hasIcd    && !hasIcdVal)   return false;
    if (hasDxText && !hasDxTxtVal) return false;
    return true;
  });

  renderTable(filtered);
}

function clearFilters() {
  // ล้างตัวกรองทั้งหมด
  document.getElementById('searchInput').value      = '';
  document.getElementById('chkNoIcd').checked       = false;
  document.getElementById('chkHasIcd').checked      = false;
  document.getElementById('chkHasDxText').checked   = false;
  document.getElementById('chkConfirmedDch').checked = false;
  document.getElementById('wardSelect').value       = 'ALL';
  updateWardLabel();

  // ล้าง sessionStorage และตาราง
  sessionStorage.removeItem(STATE_KEY);
  allPatients = [];
  document.getElementById('rowCount').textContent = '';
  document.getElementById('ipdBody').innerHTML = `
    <tr><td colspan="13" class="text-center text-muted py-5">
      <i class="fas fa-calendar-alt fa-2x mb-2 d-block"></i>
      เลือกวันที่แล้วกดค้นหา
    </td></tr>`;
}

function renderTable(rows) {
  const tbody = document.getElementById('ipdBody');
  document.getElementById('rowCount').textContent = `พบ ${rows.length} ราย`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="text-center text-muted py-5">
      <i class="fas fa-inbox fa-2x mb-2 d-block"></i>ไม่พบข้อมูล</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((p, i) => {
    const icdBadge = p.icd10
      ? `<span class="badge-icd">${escHtml(p.icd10)}</span>`
      : `<span class="no-dx">–</span>`;
    const regdate = String(p.regdate || '').substring(0, 10);
    const dchdate = String(p.dchdate || '').substring(0, 10);
    return `
    <tr onclick="goToDiagnosis('${escHtml(p.an)}')" title="คลิกเพื่อลงวินิจฉัย">
      <td>${i + 1}</td>
      <td style="font-family:monospace;">${escHtml(p.an)}</td>
      <td style="font-family:monospace;">${escHtml(p.hn)}</td>
      <td class="fw-semibold">${escHtml(p.patient_name)}</td>
      <td>${regdate}</td>
      <td>${dchdate}</td>
      <td>${escHtml(p.spclty_ward_name || p.ward_name || '–')}</td>
      <td>${escHtml(p.pttype_name || '–')}</td>
      <td>${icdBadge}</td>
      <td>${escHtml(p.icdname ? p.icdname.split(' - ').slice(1).join(' - ') : '–')}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${escHtml(p.diag_text_list || '–')}</td>
      <td>${escHtml(p.dchtype_name || '–')}</td>
      <td>${escHtml(p.incharge_doctor_name || p.admdoctor_name || '–')}</td>
    </tr>`;
  }).join('');
}

function goToDiagnosis(an) {
  saveState(); // บันทึก state ก่อนออก
  window.location.href = `/ipd_diagnosis.html?an=${encodeURIComponent(an)}`;
}
