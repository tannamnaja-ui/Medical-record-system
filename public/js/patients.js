let allPatients  = [];
let lastRendered = [];
let sortTimeDir  = null; // null | 'asc' | 'desc'

// Guard + init
(async () => {
  const user = await requireAuth();
  if (!user) return;
  renderNavUser();
  const _d = new Date();
  const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  dateFrom.value = today;
  dateTo.value   = today;

  try {
    const res  = await apiFetch('/api/hospital');
    const data = await res.json();
    if (data.hospitalname) {
      document.getElementById('hospitalName').textContent = '— ' + data.hospitalname;
    }
  } catch (_) {}
})();

const dateFrom = document.getElementById('dateFrom');
const dateTo   = document.getElementById('dateTo');

dateFrom.addEventListener('keydown', e => { if (e.key === 'Enter') loadPatients(); });
dateTo.addEventListener('keydown',   e => { if (e.key === 'Enter') loadPatients(); });
document.getElementById('searchInput').addEventListener('input', applyFilters);

function showLoading(show) {
  document.getElementById('loadingOverlay').classList.toggle('d-none', !show);
}

function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateDashboard(patients) {
  const hnSet      = new Set(patients.map(p => p.hn));
  const diagSet    = new Set(patients.filter(p => p.dx_text_list && String(p.dx_text_list).trim() !== '').map(p => p.hn));
  const hasIcdSet  = new Set(patients.filter(p => p.pdx && String(p.pdx).trim() !== '').map(p => p.hn));
  const noIcdSet   = new Set(patients.filter(p => !p.pdx || String(p.pdx).trim() === '').map(p => p.hn));

  document.getElementById('d-total').textContent    = hnSet.size.toLocaleString();
  document.getElementById('d-diagtext').textContent = diagSet.size.toLocaleString();
  document.getElementById('d-has-icd').textContent  = hasIcdSet.size.toLocaleString();
  document.getElementById('d-no-icd').textContent   = noIcdSet.size.toLocaleString();
}

function diagTextDot(val) {
  if (!val || String(val).trim() === '') {
    return '<span class="dot-red" style="font-size:22px;" title="ยังไม่มี DiagText">&#9679;</span>';
  }
  return '<span class="dot-green" style="font-size:22px;" title="' + escHtml(String(val)) + '">&#9679;</span>';
}

async function loadPatients() {
  const from = dateFrom.value;
  const to   = dateTo.value   || from;
  console.log('[loadPatients] dateFrom.value=', from, 'dateTo.value=', dateTo.value, '-> from=', from, 'to=', to);
  if (!from) return;

  showLoading(true);
  document.getElementById('searchInput').value = '';
  document.getElementById('rowCount').textContent = '';

  try {
    const url = `/api/patients?dateFrom=${from}&dateTo=${to}`;
    console.log('[loadPatients] fetch URL:', url);
    const res  = await apiFetch(url);
    const data = await res.json();

    if (!data.success) { showError(data.message); return; }

    allPatients = data.data || [];
    populateFilters(allPatients);
    updateDashboard(allPatients);
    applyFilters();
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showError('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    showLoading(false);
  }
}

function showError(msg) {
  document.getElementById('patientBody').innerHTML = `
    <tr><td colspan="14" class="text-center text-danger py-4">
      <i class="fas fa-exclamation-triangle me-2"></i>${escHtml(msg)}
    </td></tr>`;
}

function populateFilters(patients) {
  const fill = (datalistId, values) => {
    const dl = document.getElementById(datalistId);
    if (!dl) return;
    const uniq = [...new Set(values.filter(v => v && String(v).trim()))].sort((a, b) =>
      String(a).localeCompare(String(b), 'th')
    );
    dl.innerHTML = uniq.map(v => `<option value="${escHtml(String(v))}">`).join('');
  };
  fill('listSpclty', patients.map(p => p.spclty));
  fill('listDep',    patients.map(p => p.department));
}

function toggleSortTime() {
  if (sortTimeDir === null || sortTimeDir === 'desc') sortTimeDir = 'asc';
  else sortTimeDir = 'desc';

  const icon = document.getElementById('sort-icon-time');
  if (icon) {
    icon.className = sortTimeDir === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
  }
  applyFilters();
}

function applyFilters() {
  const q      = document.getElementById('searchInput').value.toLowerCase().trim();
  const spclty = document.getElementById('filterSpclty').value.toLowerCase().trim();
  const dep    = document.getElementById('filterDep').value.toLowerCase().trim();
  const hn     = document.getElementById('filterHN').value.toLowerCase().trim();
  const noIcd     = document.getElementById('chkNoIcd').checked;
  const hasIcd    = document.getElementById('chkHasIcd').checked;
  const hasDxText = document.getElementById('chkHasDxText').checked;

  let filtered = allPatients.filter(p => {
    if (q && !(
      (p.ptname        || '').toLowerCase().includes(q) ||
      (p.hn            || '').toString().toLowerCase().includes(q) ||
      (p.pdx           || '').toLowerCase().includes(q) ||
      (p.dx_text_list  || '').toLowerCase().includes(q)
    )) return false;

    if (spclty && !(p.spclty     || '').toLowerCase().includes(spclty)) return false;
    if (dep    && !(p.department || '').toLowerCase().includes(dep))    return false;
    if (hn     && !(p.hn         || '').toString().toLowerCase().includes(hn)) return false;

    const hasPdx   = p.pdx && String(p.pdx).trim() !== '';
    const hasDxTxt = p.dx_text_list && String(p.dx_text_list).trim() !== '';
    if (noIcd     && hasPdx)   return false;
    if (hasIcd    && !hasPdx)  return false;
    if (hasDxText && !hasDxTxt) return false;

    return true;
  });

  if (sortTimeDir) {
    filtered = [...filtered].sort((a, b) => {
      const ta = (a.vsttime || '').toString();
      const tb = (b.vsttime || '').toString();
      return sortTimeDir === 'asc' ? ta.localeCompare(tb) : tb.localeCompare(ta);
    });
  }

  renderTable(filtered);
}

function clearFilters() {
  document.getElementById('searchInput').value  = '';
  document.getElementById('filterSpclty').value = '';
  document.getElementById('filterDep').value    = '';
  document.getElementById('filterHN').value     = '';
  document.getElementById('chkNoIcd').checked     = false;
  document.getElementById('chkHasIcd').checked    = false;
  document.getElementById('chkHasDxText').checked = false;
  applyFilters();
}

function ovstostClass(val) {
  if (!val) return '';
  const v = val.toLowerCase();
  if (v.includes('admit') || v.includes('ผู้ป่วยใน')) return 'status-admit';
  if (v.includes('ตรวจแล้ว')) return 'status-done';
  return '';
}

function renderTable(rows) {
  lastRendered = rows;
  const tbody = document.getElementById('patientBody');
  document.getElementById('rowCount').textContent = `พบ ${rows.length} ราย`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="14" class="text-center text-muted py-5">
      <i class="fas fa-inbox fa-2x mb-2 d-block"></i>ไม่พบข้อมูล</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((p, i) => {
    const time    = escHtml((p.vsttime || '').toString().substring(0, 5));
    const rowDate = escHtml(p.vstdate ? String(p.vstdate).substring(0, 10) : dateFrom.value);
    return `
    <tr onclick="goToDiagnosis('${escHtml(p.vn)}', '${rowDate}')" title="คลิกเพื่อลงวินิจฉัย">
      <td class="text-muted">${i + 1}</td>
      <td>${escHtml(p.vstdate ? String(p.vstdate).substring(0, 10) : '–')}</td>
      <td class="col-time">${time || '–'}</td>
      <td><small>${escHtml(p.ovstist || '–')}</small></td>
      <td><small class="${ovstostClass(p.ovstost)}">${escHtml(p.ovstost || '–')}</small></td>
      <td class="col-vn">${escHtml(p.hn || '–')}</td>
      <td class="fw-semibold">${escHtml(p.ptname || '–')}</td>
      <td class="col-age"><small>${escHtml(p.age || '–')}</small></td>
      <td>${p.pdx
        ? `<span class="badge badge-pdx">${escHtml(p.pdx)}</span>`
        : `<span class="no-dx">–</span>`}</td>
      <td><small>${escHtml(p.doctor || '–')}</small></td>
      <td class="text-center">${diagTextDot(p.dx_text_list)}</td>
      <td><small>${escHtml(p.spclty || '–')}</small></td>
      <td><small>${escHtml(p.department || '–')}</small></td>
      <td><small>${escHtml(p.pttype || '–')}</small></td>
    </tr>`;
  }).join('');
}

function goToDiagnosis(vn, date) {
  const p = allPatients.find(row => String(row.vn) === String(vn));
  if (p) sessionStorage.setItem('selected_patient', JSON.stringify(p));
  window.location.href = `/diagnosis.html?vn=${encodeURIComponent(vn)}&date=${encodeURIComponent(date)}`;
}

function exportExcel() {
  if (!lastRendered.length) {
    alert('ไม่มีข้อมูลสำหรับส่งออก');
    return;
  }

  const headers = [
    'วันที่มา', 'เวลามา', 'การมา', 'สถานะปัจจุบัน', 'HN',
    'ชื่อ - สกุล', 'อายุ', 'PDX', 'แพทย์ผู้ตรวจ', 'DiagText', 'แผนก', 'ห้องตรวจ'
  ];

  const dataRows = lastRendered.map(p => [
    p.vstdate    ? String(p.vstdate).substring(0, 10) : '',
    (p.vsttime   || '').toString().substring(0, 5),
    p.ovstist    || '',
    p.ovstost    || '',
    p.hn         || '',
    p.ptname     || '',
    p.age        || '',
    p.pdx        || '',
    p.doctor     || '',
    p.dx_text_list || '',
    p.spclty     || '',
    p.department || '',
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);

  // ปรับความกว้าง column อัตโนมัติ
  ws['!cols'] = headers.map((h, i) => {
    const max = Math.max(h.length, ...dataRows.map(r => (r[i] || '').toString().length));
    return { wch: Math.min(max + 2, 50) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ผู้ป่วย');

  const from = dateFrom.value || '';
  const to   = dateTo.value   || from;
  const suffix = (to && to !== from) ? `_${from}_to_${to}` : `_${from}`;
  XLSX.writeFile(wb, `patients${suffix}.xlsx`);
}
