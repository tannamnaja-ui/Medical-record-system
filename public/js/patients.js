let allPatients = [];

// Guard + init
(async () => {
  const user = await requireAuth();
  if (!user) return;
  renderNavUser();
  dateInput.value = new Date().toISOString().split('T')[0];

  // โหลดชื่อโรงพยาบาล
  try {
    const res  = await apiFetch('/api/hospital');
    const data = await res.json();
    if (data.hospitalname) {
      document.getElementById('hospitalName').textContent = '— ' + data.hospitalname;
    }
  } catch (_) {}
})();

const dateInput = document.getElementById('dateInput');

dateInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadPatients(); });
document.getElementById('searchInput').addEventListener('input', applyFilters);

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('d-none', !show);
}

function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ageStr(y, m, d) {
  const parts = [];
  if (y) parts.push(`${y}ปี`);
  if (m) parts.push(`${m}ด`);
  if (!y && !m && d) parts.push(`${d}ว`);
  return parts.join('') || '–';
}

async function loadPatients() {
  const date = dateInput.value;
  if (!date) return;

  showLoading(true);
  document.getElementById('searchInput').value = '';
  document.getElementById('rowCount').textContent = '';

  try {
    const res  = await apiFetch(`/api/patients?date=${date}`);
    const data = await res.json();

    if (!data.success) { showError(data.message); return; }

    allPatients = data.data || [];
    populateFilters(allPatients);
    renderTable(allPatients);
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showError('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    showLoading(false);
  }
}

function showError(msg) {
  document.getElementById('patientBody').innerHTML = `
    <tr><td colspan="16" class="text-center text-danger py-4">
      <i class="fas fa-exclamation-triangle me-2"></i>${escHtml(msg)}
    </td></tr>`;
}

function populateFilters(patients) {
  const fill = (datalistId, values) => {
    const dl = document.getElementById(datalistId);
    const uniq = [...new Set(values.filter(v => v && String(v).trim()))].sort((a, b) =>
      String(a).localeCompare(String(b), 'th')
    );
    dl.innerHTML = uniq.map(v => `<option value="${escHtml(String(v))}">`).join('');
  };
  fill('listSpclty', patients.map(p => p.spclty_name));
  fill('listDep',    patients.map(p => p.main_dep));
  fill('listPttype', patients.map(p => p.pttype_name));
}

function applyFilters() {
  const q      = document.getElementById('searchInput').value.toLowerCase().trim();
  const spclty = document.getElementById('filterSpclty').value.toLowerCase().trim();
  const dep    = document.getElementById('filterDep').value.toLowerCase().trim();
  const pttype = document.getElementById('filterPttype').value.toLowerCase().trim();
  const hn     = document.getElementById('filterHN').value.toLowerCase().trim();
  const noIcd     = document.getElementById('chkNoIcd').checked;
  const hasIcd    = document.getElementById('chkHasIcd').checked;
  const hasDxText = document.getElementById('chkHasDxText').checked;

  const filtered = allPatients.filter(p => {
    // ค้นหาทั่วไป
    if (q && !(
      (p.ptname   || '').toLowerCase().includes(q) ||
      (p.vn       || '').toLowerCase().includes(q) ||
      (p.pdx      || '').toLowerCase().includes(q) ||
      (p.pdx_name || '').toLowerCase().includes(q)
    )) return false;

    // filter แผนก (partial match)
    if (spclty && !(p.spclty_name || '').toLowerCase().includes(spclty)) return false;
    // filter ห้องตรวจ (partial match)
    if (dep    && !(p.main_dep    || '').toLowerCase().includes(dep))    return false;
    // filter สิทธิ์ (partial match)
    if (pttype && !(p.pttype_name || '').toLowerCase().includes(pttype)) return false;
    // filter HN
    if (hn     && !(p.hn          || '').toString().toLowerCase().includes(hn)) return false;

    const hasPdx    = p.pdx && String(p.pdx).trim() !== '';
    const hasDxTxt  = p.dx_text_list && String(p.dx_text_list).trim() !== '';
    // checkbox: ยังไม่ลง ICD10
    if (noIcd     && hasPdx)   return false;
    // checkbox: ลง ICD10 แล้ว
    if (hasIcd    && !hasPdx)  return false;
    // checkbox: มี diag text (dx_text_list <> '' and not null)
    if (hasDxText && !hasDxTxt) return false;

    return true;
  });
  renderTable(filtered);
}

function clearFilters() {
  document.getElementById('searchInput').value  = '';
  document.getElementById('filterSpclty').value = '';
  document.getElementById('filterDep').value    = '';
  document.getElementById('filterPttype').value = '';
  document.getElementById('filterHN').value     = '';
  document.getElementById('chkNoIcd').checked     = false;
  document.getElementById('chkHasIcd').checked    = false;
  document.getElementById('chkHasDxText').checked = false;
  renderTable(allPatients);
}

function renderTable(rows) {
  const tbody = document.getElementById('patientBody');
  document.getElementById('rowCount').textContent = `พบ ${rows.length} ราย`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="text-center text-muted py-5">
      <i class="fas fa-inbox fa-2x mb-2 d-block"></i>ไม่พบข้อมูล</td></tr>`;
    return;
  }

  const date = dateInput.value;
  tbody.innerHTML = rows.map((p, i) => {
    const bp  = (p.bps && p.bpd) ? `${p.bps}/${p.bpd}` : '–';
    const age = ageStr(p.age_y, p.age_m, p.age_d);
    return `
    <tr onclick="goToDiagnosis('${escHtml(p.vn)}', '${date}')" title="คลิกเพื่อลงวินิจฉัย">
      <td class="text-muted">${i + 1}</td>
      <td class="col-vn">${escHtml(p.vn)}</td>
      <td class="col-time">${escHtml((p.vsttime || '').substring(0, 5))}</td>
      <td class="col-vn">${escHtml(p.hn || '–')}</td>
      <td class="fw-semibold">${escHtml(p.ptname)}</td>
      <td>${escHtml(p.department_name || p.main_dep || '–')}</td>
      <td><small>${escHtml(p.pttype_name || '–')}</small></td>
      <td>${p.pdx
        ? `<span class="badge badge-pdx">${escHtml(p.pdx)}</span>`
        : `<span class="no-dx">–</span>`}</td>
      <td><small>${escHtml(p.pdx_name || '–')}</small></td>
      <td><small class="text-muted">${escHtml(p.dx_text_list || '–')}</small></td>
      <td><small>${escHtml(p.doctor_list_text || '–')}</small></td>
      <td class="col-age"><small>${age}</small></td>
      <td><small>${bp}</small></td>
      <td><small>${p.temperature ? p.temperature + '°' : '–'}</small></td>
      <td><small>${p.bw ? p.bw + ' kg' : '–'}</small></td>
      <td><small>${p.bmi || '–'}</small></td>
    </tr>`;
  }).join('');
}

function goToDiagnosis(vn, date) {
  window.location.href = `/diagnosis.html?vn=${encodeURIComponent(vn)}&date=${encodeURIComponent(date)}`;
}
