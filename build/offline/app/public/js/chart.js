let allData = [];
let currentMode = 'not_received';
let borrowModal = null;
let logModal    = null;
let rentModal   = null;
let currentRow  = null;
let rentDoctorTimers = {};

(async () => {
  const user = await requireAuth();
  if (!user) return;
  renderNavUser();

  const _d = new Date();
  const today    = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  const firstDay = today.substring(0, 7) + '-01';
  document.getElementById('dateFrom').value = firstDay;
  document.getElementById('dateTo').value   = today;

  await Promise.all([loadWards(), loadHospitalName(), loadDepartments(), loadSummaryStatus(), loadUserRoom(),
                     loadRentReasons(), loadSpclty(), loadRentRooms()]);
  initSearchInput();
  document.getElementById('rowCount').textContent = '';
})();

function escHtml(s) {
  if (!s && s !== 0) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showLoading(v) {
  document.getElementById('loadingOverlay').classList.toggle('d-none', !v);
}

async function loadHospitalName() {
  try {
    const res  = await apiFetch('/api/hospital');
    const data = await res.json();
    if (data.hospitalname)
      document.getElementById('hospitalName').textContent = '— ' + data.hospitalname;
  } catch (_) {}
}

async function loadWards() {
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
    }
  } catch (_) {}
}

function setMenu(mode) {
  currentMode = mode;
  document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`menu_${mode}`).classList.add('active');

  const titles = {
    not_received: '<i class="fas fa-inbox me-2"></i>รับแฟ้มจาก ward — จำหน่ายแล้ว ยังไม่ได้รับแฟ้ม',
    borrowed:     '<i class="fas fa-exchange-alt me-2"></i>แสดงเฉพาะรายการที่รับ chart และถูกยืม chart เท่านั้น',
    all:          '<i class="fas fa-file-medical me-2"></i>สรุป chart — จำหน่ายแล้วทั้งหมด',
    overdue:      '<i class="fas fa-exclamation-triangle me-2" style="color:#dc2626;"></i>ติดตามแฟ้มที่เกินเวลา',
    due_return:   '<i class="fas fa-undo-alt me-2" style="color:#ea580c;"></i>chart ที่ต้องคืน — รายการที่ยังไม่ได้คืนและเกินกำหนด',
  };
  document.getElementById('contentTitle').innerHTML = titles[mode] || '';

  // แสดง filter + table ซ่อน placeholder
  document.getElementById('filterRow').style.display    = 'flex';
  document.getElementById('titleBar').style.display     = 'block';
  document.getElementById('tableWrapper').style.display = 'block';
  document.getElementById('placeholderMsg').style.display = 'none';

  // แสดง/ซ่อนปุ่ม Excel
  const btnExcel = document.getElementById('btnExcel');
  if (btnExcel) btnExcel.style.display = mode === 'borrowed' ? 'inline-block' : 'none';

  // dynamic UI สำหรับ borrowed mode
  const isBorrowed = mode === 'borrowed' || mode === 'due_return';
  document.getElementById('dateLabel').textContent = isBorrowed ? 'วันที่ยืม :' : 'วันจำหน่าย :';
  const lbl = document.getElementById('chkNotReceivedLabel');
  if (lbl) {
    if (mode === 'borrowed')       lbl.textContent = 'เฉพาะที่ยังไม่ได้คืน';
    else if (mode === 'due_return') lbl.textContent = 'เฉพาะที่ยังไม่ได้คืน';
    else if (mode === 'all')       lbl.textContent = 'แสดงเฉพาะที่ยังไม่สรุป chart';
    else                            lbl.textContent = 'แสดงเฉพาะที่ยังไม่ได้รับแฟ้ม';
  }
  const overdueRow = document.getElementById('chkOverdueRow');
  if (overdueRow) overdueRow.classList.toggle('d-none', !isBorrowed);
  const chkOverdue = document.getElementById('chkOverdue');
  if (!isBorrowed && chkOverdue) chkOverdue.checked = false;

  // แสดง/ซ่อน overdue days input (เมนู overdue เดิม)
  document.getElementById('overdueDaysRow').classList.toggle('d-none', mode !== 'overdue');

  // เปลี่ยน label checkbox ตามเมนู
  const chkLabel = document.querySelector('#chkNotReceived + span');
  if (chkLabel) {
    if (mode === 'not_received') {
      chkLabel.textContent = 'แสดงเฉพาะที่ยังไม่ได้รับแฟ้มจาก ward';
    } else if (mode === 'all') {
      chkLabel.textContent = 'แสดงเฉพาะที่ยังไม่สรุป chart';
    } else {
      chkLabel.textContent = 'แสดงเฉพาะจำหน่ายแล้ว';
    }
  }

  loadData();
}

async function loadData() {
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo   = document.getElementById('dateTo').value;
  const ward     = document.getElementById('wardSelect').value;
  const days     = document.getElementById('overdueDays').value || '7';
  if (!dateFrom || !dateTo) return;

  showLoading(true);
  document.getElementById('searchInput').value = '';
  const _anInp = document.getElementById('searchInputAN');
  if (_anInp) _anInp.value = '';
  document.getElementById('rowCount').textContent = '';

  try {
    let url, params;
    if (currentMode === 'not_received') {
      const notReceived = document.getElementById('chkNotReceived')?.checked || false;
      params = new URLSearchParams({ dateFrom, dateTo, ward, notReceived });
      url = `/api/chart/receive?${params}`;
    } else if (currentMode === 'all') {
      const notSummarized = document.getElementById('chkNotReceived')?.checked || false;
      params = new URLSearchParams({ dateFrom, dateTo, ward });
      if (notSummarized) params.append('notSummarized', 'true');
      url = `/api/chart/receive?${params}`;
    } else if (currentMode === 'borrowed') {
      const notReturn = document.getElementById('chkNotReceived')?.checked || false;
      params = new URLSearchParams({ dateFrom, dateTo, ward, notReturn });
      url = `/api/chart/borrowed-list?${params}`;
    } else if (currentMode === 'due_return') {
      // chart ที่ต้องคืน = date range เหมือน borrowed + due_date <= CURRENT_DATE
      params = new URLSearchParams({ dateFrom, dateTo, ward, dueOnly: true });
      url = `/api/chart/rent-list?${params}`;
    } else {
      params = new URLSearchParams({ mode: currentMode, dateFrom, dateTo, ward, days });
      url = `/api/chart/patients?${params}`;
    }
    const res  = await apiFetch(url);
    const data = await res.json();
    if (!data.success) {
      showError(data.message); return;
    }
    allData = data.data || [];
    applyFilter();
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showError(e.message);
  } finally {
    showLoading(false);
  }
}

function showError(msg) {
  document.getElementById('chartBody').innerHTML = `
    <tr><td colspan="12" class="text-center text-danger py-4">
      <i class="fas fa-exclamation-triangle me-2"></i>${escHtml(msg)}
    </td></tr>`;
}

// ─── Search Input Events ──────────────────────────────────────────────────────
let searchTimer   = null;
let searchTimerAN = null;

function initSearchInput() {
  // ช่องค้นหาเดิม → ค้นด้วย HN อย่างเดียว
  const inp = document.getElementById('searchInput');
  if (inp) {
    // oninput: debounce 300ms → ค้นจาก server ไม่สนใจวันที่
    inp.addEventListener('input', () => {
      const q = inp.value.trim();
      clearTimeout(searchTimer);
      if (!q) { applyFilter(); return; }
      searchTimer = setTimeout(() => fetchByHN(q), 300);
    });

    // Enter: fetch ทันที ไม่รอ debounce
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(searchTimer);
      const q = inp.value.trim();
      if (!q) { applyFilter(); return; }
      fetchByHN(q);
    });
  }

  // ช่องค้นหาใหม่ → ค้นด้วย AN
  const inpAN = document.getElementById('searchInputAN');
  if (inpAN) {
    inpAN.addEventListener('input', () => {
      const q = inpAN.value.trim();
      clearTimeout(searchTimerAN);
      if (!q) { applyFilter(); return; }
      searchTimerAN = setTimeout(() => fetchByAN(q), 300);
    });

    inpAN.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(searchTimerAN);
      const q = inpAN.value.trim();
      if (!q) { applyFilter(); return; }
      fetchByAN(q);
    });
  }
}

async function fetchByAN(q) {
  showLoading(true);
  try {
    const res  = await apiFetch(`/api/chart/find-an?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.success) { allData = data.data || []; renderTable(allData); }
    else showError(data.message);
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showError(e.message);
  } finally {
    showLoading(false);
  }
}

async function fetchByHN(q) {
  showLoading(true);
  try {
    const res  = await apiFetch(`/api/chart/find-hn?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.success) { allData = data.data || []; renderTable(allData); }
    else showError(data.message);
  } catch (e) {
    if (e.message !== 'กรุณาเข้าสู่ระบบ') showError(e.message);
  } finally {
    showLoading(false);
  }
}

function onSearch() {}        // ไม่ใช้แล้ว (ใช้ listener แทน)
function onSearchEnter() {}   // ไม่ใช้แล้ว

function applyFilter() {
  const q           = document.getElementById('searchInput').value.trim().toLowerCase();
  const qAn         = (document.getElementById('searchInputAN')?.value.trim() || '').toLowerCase();
  const notReceived = document.getElementById('chkNotReceived').checked;

  const filtered = allData.filter(p => {
    if (q   && !((p.hn || '').toString().toLowerCase().includes(q)))   return false;
    if (qAn && !((p.an || '').toString().toLowerCase().includes(qAn))) return false;
    if (currentMode === 'borrowed') {
      // สำหรับ borrowed: ใช้ checkin field จาก ipdrent
      if (notReceived && p.checkin !== 'N') return false;
    } else {
      // chart_received='Y' = รับแฟ้มแล้ว
      if (notReceived && p.chart_received === 'Y') return false;
    }
    return true;
  });
  renderTable(filtered);
}

// format datetime Bangkok UTC+7 → 'YYYY-MM-DD HH:MM:SS'
function fmtLogDT(v) {
  if (!v) return '–';
  const d = new Date(v);
  if (isNaN(d)) return String(v).substring(0, 19).replace('T', ' ');
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).substring(0, 19);
}

// ─── Global date formatter YYYY-MM-DD ────────────────────────────────────────
function fmtDate(v) {
  if (!v) return '–';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  const d = new Date(v);
  return isNaN(d) ? s.substring(0, 10) : d.toLocaleDateString('en-CA');
}

function renderTable(rows) {
  const tbody = document.getElementById('chartBody');
  document.getElementById('rowCount').textContent = `พบ ${rows.length} ราย`;

  if (currentMode === 'due_return') { renderBorrowedTable(rows); return; }

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="14" class="text-center text-muted py-5">
      <i class="fas fa-inbox fa-2x mb-2 d-block"></i>ไม่พบข้อมูล</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((p, i) => {
    const regdate  = fmtDate(p.regdate);
    const dchdate  = fmtDate(p.dchdate);
    const days     = p.days_since_dch != null ? p.days_since_dch : '–';
    const daysBadge = (days !== '–' && days > 7)
      ? `<span class="badge-overdue">${days} วัน</span>`
      : `<span class="badge-ok">${days} วัน</span>`;
    const chartDate = p.chart_receive_date
      ? String(p.chart_receive_date).substring(0, 10)
      : '<span style="color:#dc2626;">ยังไม่รับ</span>';

    const received  = String(p.chart_received).trim().toUpperCase() === 'Y';
    const trClass   = received ? 'received-row' : '';
    const trStyle   = received
      ? `cursor:pointer;background-color:#d1fae5!important;--bs-table-accent-bg:#d1fae5;`
      : `cursor:pointer;`;
    const clickable = (currentMode === 'not_received' || currentMode === 'borrowed')
      ? `onclick="openBorrowModal(${i})" title="คลิกเพื่อดูข้อมูล chart"`
      : '';
    return `<tr class="${trClass}" ${clickable} style="${trStyle}">
      <td>${i + 1}</td>
      <td style="font-family:monospace;">${escHtml(p.an)}</td>
      <td style="font-family:monospace;">${escHtml(p.hn)}</td>
      <td class="fw-semibold">${escHtml(p.patient_name)}</td>
      <td>${escHtml(p.chart_status_name || '–')}</td>
      <td>${regdate}</td>
      <td>${dchdate}</td>
      <td>${daysBadge}</td>
      <td>${escHtml(p.spclty_ward_name || p.ward_name || '–')}</td>
      <td>${escHtml(p.pttype_name || '–')}</td>
      <td>${escHtml(p.incharge_doctor_name || '–')}</td>
      <td>${chartDate}</td>
      <td>${escHtml(p.receiver_name || p.receiver_login || p.chart_receive_staff || '–')}</td>
      <td>${escHtml(p.comment || '–')}</td>
    </tr>`;
  }).join('');
}

function renderBorrowedTable(rows) {
  const tbody  = document.getElementById('chartBody');
  const thead  = document.querySelector('#chartTable thead tr');

  // อัปเดต header
  if (thead) thead.innerHTML = `
    <th>#</th><th>AN</th><th>HN</th><th>ชื่อ-สกุล</th><th>สถานะ chart</th>
    <th>วันรับ</th><th>วันจำหน่าย</th><th>ตึก/วอร์ด</th>
    <th>ผู้ยืม chart</th><th>วันที่ยืม</th><th>chart</th>
    <th>จำนวนวันที่ยืม</th><th>วันที่ต้องคืน</th>
    <th>สิทธิ์</th><th>แพทย์เจ้าของไข้</th>
    <th>รับแฟ้มวันที่</th><th>ผู้รับแฟ้ม</th>`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="text-center text-muted py-5">
      <i class="fas fa-inbox fa-2x mb-2 d-block"></i>ไม่พบข้อมูล</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const regdate      = fmtDate(r.regdate);
    const dchdate      = fmtDate(r.dchdate);
    const rentDate     = fmtDate(r.rent_date);
    const dueDate      = fmtDate(r.due_date);
    const chartReceive = r.chart_receive_date ? fmtDate(r.chart_receive_date) : '–';
    const overdue = r.is_overdue === 'Y';
    const dueDateCell = overdue
      ? `<span style="color:#dc2626;font-weight:700;">${dueDate}</span>`
      : escHtml(dueDate);
    const chartStatus = r.checkin === 'N'
      ? `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;">ยังไม่คืน</span>`
      : `<span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:4px;">คืนแล้ว</span>`;
    return `<tr>
      <td>${i+1}</td>
      <td style="font-family:monospace;">${escHtml(r.an)}</td>
      <td style="font-family:monospace;">${escHtml(r.hn)}</td>
      <td class="fw-semibold">${escHtml(r.patient_name||'–')}</td>
      <td>${escHtml(r.chart_status_name||'–')}</td>
      <td>${regdate}</td>
      <td>${dchdate}</td>
      <td>${escHtml(r.ward_name||'–')}</td>
      <td>${escHtml(r.rent_user_name||r.rent_user||'–')}</td>
      <td>${rentDate}</td>
      <td>${chartStatus}</td>
      <td style="text-align:center;">${r.days_rented ?? '–'}</td>
      <td>${dueDateCell}</td>
      <td>${escHtml(r.pttype_name||'–')}</td>
      <td>${escHtml(r.incharge_doctor_name||'–')}</td>
      <td>${chartReceive}</td>
      <td>${escHtml(r.chart_receiver_name||'–')}</td>
    </tr>`;
  }).join('');
}

// ─── User Room ────────────────────────────────────────────────────────────────
let userRoom = '';
async function loadUserRoom() {
  // ดึงจาก session ที่เก็บตอน login (ผ่าน /api/chart/user-room)
  try {
    const res  = await apiFetch('/api/chart/user-room');
    const data = await res.json();
    if (data.success && data.room) { userRoom = data.room; return; }
  } catch (_) {}
  // fallback: ดึงจาก localStorage
  userRoom = localStorage.getItem('icd10_room') || '';
}

// ─── Departments & Status ─────────────────────────────────────────────────────
async function loadDepartments() {
  try {
    const res  = await apiFetch('/api/chart/departments');
    const data = await res.json();
    const sel  = document.getElementById('mLocation');
    if (data.success) {
      data.data.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name; opt.textContent = d.name;
        sel.appendChild(opt);
      });
    }
  } catch (_) {}
}

async function loadSummaryStatus() {
  try {
    const res  = await apiFetch('/api/chart/summary-status');
    const data = await res.json();
    const sel  = document.getElementById('mStatus');
    if (data.success) {
      data.data.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.ipt_summary_status_id;
        opt.textContent = d.ipt_summary_status_name;
        sel.appendChild(opt);
      });
    }
  } catch (_) {}
}

// ─── Borrow Modal ─────────────────────────────────────────────────────────────
async function openBorrowModal(idx) {
  currentRow = allData[idx] || null;
  if (!currentRow) return;

  document.getElementById('mAn').textContent   = currentRow.an;
  document.getElementById('mName').textContent = currentRow.patient_name || '–';
  document.getElementById('mAlert').className  = 'alert d-none';

  // ตั้งชื่อผู้ login ใน checkbox ยืนยัน
  const cu = getUser();
  const nameEl = document.getElementById('summaryConfirmerName');
  if (nameEl && cu) nameEl.textContent = cu.officer_name || cu.officer_login_name || '–';
  const chkSummary = document.getElementById('chkSummaryConfirm');
  if (chkSummary) {
    chkSummary.checked = false;
    chkSummary.onchange = () => onSummaryConfirmChange();
  }

  // โหลดสถานะยืนยันเดิม (ถ้าเคยยืนยันแล้ว)
  try {
    const cs = await apiFetch(`/api/chart/confirm-status/${currentRow.an}`);
    const csData = await cs.json();
    if (chkSummary && csData.confirmed) chkSummary.checked = true;
  } catch (_) {}

  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
  document.getElementById('mDateIn').value   = today;
  document.getElementById('mRoom').value     = userRoom;
  document.getElementById('mLocation').value = '';
  document.getElementById('mStatus').value   = '';
  document.getElementById('mNote').value     = '';

  // โหลดข้อมูลเดิมจาก ipt_chart_location
  try {
    const res  = await apiFetch(`/api/chart/location/${currentRow.an}`);
    const data = await res.json();
    if (data.success) {
      const d = data.data;

      // ถ้ามีข้อมูลเดิม restore
      if (d) {
        const fmtDate = v => {
          if (!v) return '';
          const dt = new Date(v);
          return isNaN(dt) ? String(v).substring(0,10) : dt.toLocaleDateString('en-CA');
        };
        if (d.chart_date || d.date_in)
          document.getElementById('mDateIn').value = fmtDate(d.chart_date || d.date_in);
        // location: ใช้ location_name จาก JOIN หรือ location column
        const locName = d.location_name || d.location || '';
        if (locName) document.getElementById('mLocation').value = locName;
        // room: ใช้ room_name จาก JOIN หรือ room column
        const roomName = d.room_name || d.room || '';
        if (roomName) document.getElementById('mRoom').value = roomName;
        // status: ใช้ hos_guid (= ipt_summary_status_id) หรือ ipt_summary_status_id
        const sid = d.hos_guid || d.ipt_summary_status_id || '';
        if (sid) document.getElementById('mStatus').value = sid;
        if (d.chart_note || d.note)
          document.getElementById('mNote').value = d.chart_note || d.note || '';
      }

      // ถ้ายังไม่มี status ใน chart_location → ดูจาก ipt โดยตรง
      const iptStatus = data.ipt_status;
      if (iptStatus && iptStatus.ipt_summary_status_id) {
        if (!document.getElementById('mStatus').value)
          document.getElementById('mStatus').value = iptStatus.ipt_summary_status_id;
        // แสดงสถานะจาก ipt
        const iptStatusEl = document.getElementById('mIptStatus');
        if (iptStatusEl)
          iptStatusEl.textContent = `สถานะปัจจุบัน (ipt): ${iptStatus.ipt_summary_status_name || ''}`;
      }
    }
  } catch (_) {}

  // ตรวจสอบว่าถูกยืมอยู่หรือไม่ (ipdrent.checkin='N')
  const btnBorrow = document.getElementById('btnBorrow');
  const btnReturn = document.getElementById('btnReturnChart');
  try {
    const rs     = await apiFetch(`/api/chart/rent-status/${currentRow.an}`);
    const rsData = await rs.json();
    if (rsData.borrowed) {
      btnBorrow.style.background = '#16a34a';
      btnBorrow.innerHTML = '<i class="fas fa-check-circle me-2"></i>ถูกยืมแล้ว';
      if (btnReturn) btnReturn.classList.remove('d-none');
    } else {
      btnBorrow.style.background = '#dc2626';
      btnBorrow.innerHTML = '<i class="fas fa-file-import me-2"></i>ทำการยืมแฟ้ม';
      if (btnReturn) btnReturn.classList.add('d-none');
    }
  } catch (_) {
    btnBorrow.style.background = '#dc2626';
    btnBorrow.innerHTML = '<i class="fas fa-file-import me-2"></i>ทำการยืมแฟ้ม';
    if (btnReturn) btnReturn.classList.add('d-none');
  }

  if (!borrowModal) borrowModal = new bootstrap.Modal(document.getElementById('borrowModal'));
  borrowModal.show();
}

async function showLog() {
  if (!currentRow) return;
  const an = currentRow.an;
  document.getElementById('logModalAN').textContent = `AN: ${an}`;
  document.getElementById('logBody').innerHTML =
    '<tr><td colspan="7" class="text-center text-muted py-3">กำลังโหลด...</td></tr>';

  if (!logModal) logModal = new bootstrap.Modal(document.getElementById('logModal'));
  logModal.show();

  try {
    const res  = await apiFetch(`/api/chart/log/${an}`);
    const data = await res.json();
    const tbody = document.getElementById('logBody');
    if (!data.success || !data.data.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">ไม่มีประวัติ</td></tr>';
      return;
    }
    tbody.innerHTML = data.data.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td style="white-space:nowrap;">${escHtml(fmtLogDT(r.log_datetime))}</td>
        <td>${escHtml(String(r.chart_date||'').substring(0,10))}</td>
        <td>${escHtml(r.depcode||'–')}</td>
        <td>${escHtml(r.ipt_summary_status_name||'–')}</td>
        <td>${escHtml(r.chart_note||'–')}</td>
        <td>${escHtml(r.officer_name||r.staff||'–')}</td>
      </tr>`).join('');
  } catch (e) {
    document.getElementById('logBody').innerHTML =
      `<tr><td colspan="7" class="text-danger text-center">${escHtml(e.message)}</td></tr>`;
  }
}

// ─── Confirm Summary ──────────────────────────────────────────────────────────
async function onSummaryConfirmChange() {
  if (!currentRow) return;
  const chk = document.getElementById('chkSummaryConfirm');
  if (!chk || !chk.checked) return; // ไม่ได้ติ๊ก ไม่ทำอะไร

  try {
    const res  = await apiFetch('/api/chart/confirm-summary', {
      method: 'POST',
      body: {
        an:         currentRow.an,
        location:   document.getElementById('mLocation').value,
        room:       document.getElementById('mRoom').value,
        chart_note: document.getElementById('mNote').value,
        status_id:  document.getElementById('mStatus').value || null,
      },
    });
    const data = await res.json();
    const alertEl = document.getElementById('mAlert');
    if (data.success) {
      alertEl.className   = 'alert alert-success mt-3';
      alertEl.textContent = 'บันทึกยืนยันสรุป chart สำเร็จ';
      setTimeout(() => alertEl.classList.add('d-none'), 3000);
    } else {
      alertEl.className   = 'alert alert-warning mt-3';
      alertEl.textContent = data.message;
    }
  } catch (e) {
    console.log('[confirm-summary]', e.message);
  }
}

// ─── Rent Dropdowns ───────────────────────────────────────────────────────────
async function loadRentReasons() {
  try {
    const res  = await apiFetch('/api/chart/rent-reasons');
    const data = await res.json();
    const sel  = document.getElementById('rReason');
    if (sel && data.success) {
      data.data.forEach(d => { const o = document.createElement('option'); o.value = d.name; o.textContent = d.name; sel.appendChild(o); });
    }
  } catch (_) {}
}
async function loadSpclty() {
  try {
    const res  = await apiFetch('/api/chart/spclty');
    const data = await res.json();
    const sel  = document.getElementById('rSpclty');
    if (sel && data.success) {
      data.data.forEach(d => { const o = document.createElement('option'); o.value = d.spclty; o.textContent = d.name; sel.appendChild(o); });
    }
  } catch (_) {}
}
async function loadRentRooms() {
  try {
    const res  = await apiFetch('/api/kskdepartments');
    const data = await res.json();
    const dl   = document.getElementById('rRoomList');
    if (dl && data.success) {
      data.data.forEach(d => { const o = document.createElement('option'); o.value = d.name; dl.appendChild(o); });
    }
  } catch (_) {}
}

// ─── Rent Doctor Search ───────────────────────────────────────────────────────
function onRentDoctorSearch(inputId, dropId, codeId) {
  const q   = document.getElementById(inputId).value.trim();
  const dd  = document.getElementById(dropId);
  document.getElementById(codeId).value = '';
  if (!q) { dd.style.display = 'none'; return; }
  clearTimeout(rentDoctorTimers[inputId]);
  rentDoctorTimers[inputId] = setTimeout(async () => {
    try {
      const res  = await apiFetch(`/api/doctors/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const list = data.data || [];
      dd.innerHTML = !list.length
        ? '<div style="padding:8px 14px;color:#94a3b8;">ไม่พบ</div>'
        : list.map(d => `<div onclick="selectRentDoctor('${escHtml(d.code)}','${escHtml(d.name)}','${inputId}','${dropId}','${codeId}')"
            style="padding:6px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;"
            onmouseover="this.style.background='#fee2e2'" onmouseout="this.style.background=''">
            <b>${escHtml(d.code)}</b> – ${escHtml(d.name)}
          </div>`).join('');
      dd.style.display = 'block';
    } catch (_) {}
  }, 200);
}
function selectRentDoctor(code, name, inputId, dropId, codeId) {
  document.getElementById(inputId).value = name;
  document.getElementById(codeId).value  = code;
  document.getElementById(dropId).style.display = 'none';
}
function onRentRoomSearch() { /* datalist handles suggestions */ }

document.addEventListener('click', e => {
  ['rBorrowerDrop','rLenderDrop'].forEach(id => {
    const dd = document.getElementById(id);
    if (dd && !e.target.closest(`#${id}`) && !e.target.closest(`#${id.replace('Drop','')}`))
      dd.style.display = 'none';
  });
});

// ─── Open Rent Modal ──────────────────────────────────────────────────────────
async function returnChart() {
  if (!currentRow) return;
  const btn = document.getElementById('btnReturnChart');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังคืน...';
  try {
    const res  = await apiFetch('/api/chart/return', {
      method: 'POST', body: { an: currentRow.an },
    });
    const data = await res.json();
    const alertEl = document.getElementById('mAlert');
    if (data.success) {
      alertEl.className = 'alert alert-success mt-3';
      alertEl.textContent = 'คืน chart สำเร็จ';
      // อัปเดตปุ่ม
      document.getElementById('btnBorrow').style.background = '#dc2626';
      document.getElementById('btnBorrow').innerHTML = '<i class="fas fa-file-import me-2"></i>ทำการยืมแฟ้ม';
      btn.classList.add('d-none');
      setTimeout(() => { borrowModal.hide(); loadData(); }, 1200);
    } else {
      alertEl.className = 'alert alert-danger mt-3';
      alertEl.textContent = data.message;
    }
  } catch (e) {
    document.getElementById('mAlert').className = 'alert alert-danger mt-3';
    document.getElementById('mAlert').textContent = e.message;
  }
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-undo me-2"></i>คืน chart';
}

async function openRentModal() {
  if (!currentRow) return;
  const p    = currentRow;
  const today = new Date().toLocaleDateString('en-CA');
  const now   = new Date().toTimeString().substring(0,5);
  const due   = new Date(Date.now() + 7*24*60*60*1000).toLocaleDateString('en-CA');

  document.getElementById('rAn').textContent        = p.an;
  document.getElementById('rName').textContent      = p.patient_name || '–';
  document.getElementById('rAge').textContent       = `${p.age_y||''}ปี ${p.age_m||''}ด`;
  document.getElementById('rWard').textContent      = p.spclty_ward_name || p.ward_name || '–';
  document.getElementById('rChartDate').textContent = document.getElementById('mDateIn').value || today;
  document.getElementById('rDateRent').value = today;
  document.getElementById('rTimeRent').value = now;
  document.getElementById('rDueDate').value  = due;
  document.getElementById('rPhone').value    = '';
  document.getElementById('rRoom').value     = userRoom;
  document.getElementById('rNote').value     = '';
  document.getElementById('rBorrower').value = '';
  document.getElementById('rBorrowerCode').value = '';
  document.getElementById('rBorrowerDrop').style.display = 'none';

  // ตั้งค่าผู้ให้ยืม = user login
  const u = getUser();
  if (u) {
    document.getElementById('rLender').value = u.officer_name || u.officer_login_name || '';
    document.getElementById('rLenderCode').value = u.officer_login_name || '';
  }
  document.getElementById('rLenderDrop').style.display = 'none';
  document.getElementById('rAlert').className = 'alert d-none';

  if (!rentModal) rentModal = new bootstrap.Modal(document.getElementById('rentModal'));
  rentModal.show();
}

async function saveRent() {
  const btn     = document.getElementById('btnRentSave');
  const alertEl = document.getElementById('rAlert');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังบันทึก...';

  try {
    const p = currentRow;
    const body = {
      an:            p.an,
      hn:            p.hn,
      rent_date:     document.getElementById('rDateRent').value,
      rent_time:     document.getElementById('rTimeRent').value,
      room:          document.getElementById('rRoom').value,
      borrower_code: document.getElementById('rBorrowerCode').value || document.getElementById('rBorrower').value,
      reason_name:   document.getElementById('rReason').value,
      phone:         document.getElementById('rPhone').value,
      comment:       document.getElementById('rNote').value,
      lender_code:   document.getElementById('rLenderCode').value || document.getElementById('rLender').value,
      due_date:      document.getElementById('rDueDate').value,
    };

    const res  = await apiFetch('/api/chart/save-rent', { method: 'POST', body });
    const data = await res.json();

    if (data.success) {
      alertEl.className   = 'alert alert-success mt-3';
      alertEl.textContent = data.message;
      // อัปเดตปุ่มใน borrowModal ทันที ไม่ต้องปิดเข้าใหม่
      const btnBorrow = document.getElementById('btnBorrow');
      const btnReturn = document.getElementById('btnReturnChart');
      if (btnBorrow) {
        btnBorrow.style.background = '#16a34a';
        btnBorrow.innerHTML = '<i class="fas fa-check-circle me-2"></i>ถูกยืมแล้ว';
      }
      if (btnReturn) btnReturn.classList.remove('d-none');
      setTimeout(() => { rentModal.hide(); loadData(); }, 1500);
    } else {
      alertEl.className   = 'alert alert-danger mt-3';
      alertEl.textContent = data.message;
    }
  } catch (e) {
    alertEl.className   = 'alert alert-danger mt-3';
    alertEl.textContent = e.message;
  }
  btn.disabled  = false;
  btn.innerHTML = '<i class="fas fa-file-import me-2"></i>ยืนยันการยืมแฟ้ม';
}

async function saveBorrow(isBorrow = false) {
  if (!currentRow) return;
  // ถ้าเป็นยืมแฟ้ม → เปิด rent modal แทน
  if (isBorrow) { openRentModal(); return; }
  const btn1 = document.getElementById('btnBorrow');
  const btn2 = document.getElementById('btnSaveChart');
  btn1.disabled = btn2.disabled = true;
  try {
    const res  = await apiFetch('/api/chart/borrow', {
      method: 'POST',
      body: {
        an:        currentRow.an,
        date_in:   document.getElementById('mDateIn').value,
        location:  document.getElementById('mLocation').value,
        room:      document.getElementById('mRoom').value,
        status_id: document.getElementById('mStatus').value || null,
        note:      document.getElementById('mNote').value,
      },
    });
    const data = await res.json();
    const alertEl = document.getElementById('mAlert');
    if (data.success) {
      alertEl.className = 'alert alert-success mt-3';
      alertEl.textContent = isBorrow ? 'ทำการยืมแฟ้มสำเร็จ' : 'บันทึกข้อมูลสำเร็จ';
      setTimeout(() => { borrowModal.hide(); loadData(); }, 1200);
    } else {
      alertEl.className = 'alert alert-danger mt-3';
      alertEl.textContent = data.message;
    }
  } catch (e) {
    document.getElementById('mAlert').className = 'alert alert-danger mt-3';
    document.getElementById('mAlert').textContent = e.message;
  }
  btn1.disabled = btn2.disabled = false;
}

// ─── Export Excel (CSV) ───────────────────────────────────────────────────────
function exportExcel() {
  if (!allData.length) { alert('ไม่มีข้อมูลสำหรับส่งออก'); return; }

  const headers = ['AN','HN','ชื่อ-สกุล','วันรับ','วันจำหน่าย','ตึก/วอร์ด',
    'ผู้ยืม chart','วันที่ยืม','chart','จำนวนวันที่ยืม','วันที่ต้องคืน',
    'สิทธิ์','แพทย์เจ้าของไข้','รับแฟ้มวันที่','ผู้รับแฟ้ม'];

  const csv = [
    '﻿' + headers.join(','),
    ...allData.map(r => [
      r.an, r.hn,
      `"${(r.patient_name||'').replace(/"/g,'""')}"`,
      String(r.regdate||'').substring(0,10),
      String(r.dchdate||'').substring(0,10),
      `"${(r.ward_name||'').replace(/"/g,'""')}"`,
      `"${(r.rent_user_name||r.rent_user||'').replace(/"/g,'""')}"`,
      String(r.rent_date||'').substring(0,10),
      r.checkin==='N' ? 'ยังไม่คืน' : 'คืนแล้ว',
      r.days_rented ?? '',
      String(r.due_date||'').substring(0,10),
      `"${(r.pttype_name||'').replace(/"/g,'""')}"`,
      `"${(r.incharge_doctor_name||'').replace(/"/g,'""')}"`,
      r.chart_receive_date ? String(r.chart_receive_date).substring(0,10) : '',
      `"${(r.chart_receiver_name||'').replace(/"/g,'""')}"`,
    ].join(','))
  ].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `chart_rented_${new Date().toLocaleDateString('en-CA')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
