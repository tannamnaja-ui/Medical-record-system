// DB Type radio
document.querySelectorAll('input[name="dbType"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.db-type-card').forEach(c => c.classList.remove('selected'));
    radio.closest('.db-type-card').classList.add('selected');
    document.getElementById('port').value = radio.value === 'postgresql' ? '5432' : '3306';
  });
});

// Toggle password visibility
function togglePwd() {
  const pwd = document.getElementById('password');
  const icon = document.getElementById('eyeIcon');
  if (pwd.type === 'password') {
    pwd.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    pwd.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

function getFormData() {
  return {
    dbType: document.querySelector('input[name="dbType"]:checked').value,
    host: document.getElementById('host').value.trim(),
    port: document.getElementById('port').value.trim(),
    database: document.getElementById('database').value.trim(),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
  };
}

function showAlert(type, msg) {
  const box = document.getElementById('alertBox');
  box.className = `alert alert-${type}`;
  box.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'danger' ? 'times-circle' : 'info-circle'} me-2"></i>${msg}`;
  box.classList.remove('d-none');
  setTimeout(() => box.classList.add('d-none'), 6000);
}

function setLoading(btn, loading) {
  if (loading) {
    btn.disabled = true;
    btn.dataset.orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กรุณารอ...';
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.orig;
  }
}

async function testConn() {
  const btn = document.getElementById('btnTest');
  setLoading(btn, true);
  try {
    const res = await fetch('/api/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getFormData()),
    });
    const data = await res.json();
    showAlert(data.success ? 'success' : 'danger', data.message);
  } catch (e) {
    showAlert('danger', 'เชื่อมต่อ server ไม่ได้: ' + e.message);
  }
  setLoading(btn, false);
}

async function saveConn() {
  const btn = document.getElementById('btnSave');
  setLoading(btn, true);
  try {
    const res = await fetch('/api/config/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getFormData()),
    });
    const data = await res.json();
    showAlert(data.success ? 'success' : 'danger', data.message);
    if (data.success) {
      document.getElementById('statusDot').className = 'status-dot connected me-1';
      document.getElementById('statusText').textContent = 'เชื่อมต่อแล้ว';
    }
  } catch (e) {
    showAlert('danger', 'เกิดข้อผิดพลาด: ' + e.message);
  }
  setLoading(btn, false);
}

// Load saved config on init
async function init() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();

    if (cfg.dbType) {
      document.querySelector(`input[name="dbType"][value="${cfg.dbType}"]`).checked = true;
      document.querySelectorAll('.db-type-card').forEach(c => c.classList.remove('selected'));
      document.getElementById(`card_${cfg.dbType}`).classList.add('selected');
    }
    if (cfg.host) document.getElementById('host').value = cfg.host;
    if (cfg.port) document.getElementById('port').value = cfg.port;
    if (cfg.database) document.getElementById('database').value = cfg.database;
    if (cfg.username) document.getElementById('username').value = cfg.username;

    if (cfg.connected) {
      document.getElementById('statusDot').className = 'status-dot connected me-1';
      document.getElementById('statusText').textContent = 'เชื่อมต่อแล้ว';
    }
  } catch (e) {}
}

init();

// ตรวจสอบตาราง log
async function checkLogTable() {
  const btn    = document.getElementById('btnCreateLogTable');
  const status = document.getElementById('logTableStatus');
  if (!btn || !status) return;
  try {
    const res  = await fetch('/api/db/check-log-table');
    const data = await res.json();
    // restore innerHTML เสมอ
    btn.innerHTML = '<i class="fas fa-table"></i> เพิ่มตาราง log';
    if (data.exists) {
      btn.disabled = true;
      btn.style.background = '#9ca3af';
      btn.style.cursor = 'not-allowed';
      status.textContent = '✓ มีตาราง ipt_chart_location_logapp ในฐานข้อมูลแล้ว';
      status.style.color = '#16a34a';
    } else {
      btn.disabled = false;
      btn.style.background = '#ea580c';
      btn.style.cursor = 'pointer';
      status.textContent = '⚠ ยังไม่มีตาราง ipt_chart_location_logapp';
      status.style.color = '#ea580c';
    }
  } catch (_) {
    status.textContent = 'ไม่สามารถตรวจสอบได้';
  }
}

async function createLogTable() {
  const btn    = document.getElementById('btnCreateLogTable');
  const status = document.getElementById('logTableStatus');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังสร้าง...';
  try {
    const res  = await fetch('/api/db/create-log-table', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showAlert('success', data.message);
      checkLogTable(); // refresh สถานะ
    } else {
      showAlert('danger', data.message);
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-table me-1"></i>เพิ่มตาราง log';
    }
  } catch (e) {
    showAlert('danger', 'เกิดข้อผิดพลาด: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-table me-1"></i>เพิ่มตาราง log';
  }
}

// ─── ipt_chart_success_app ────────────────────────────────────────────────────
async function checkSuccessTable() {
  const btn    = document.getElementById('btnCreateSuccessTable');
  const status = document.getElementById('successTableStatus');
  if (!btn || !status) return;
  try {
    const res  = await fetch('/api/db/check-success-table');
    const data = await res.json();
    btn.innerHTML = '<i class="fas fa-table"></i> เพิ่มตาราง success';
    if (data.exists) {
      btn.disabled = true;
      btn.style.background = '#9ca3af';
      btn.style.cursor = 'not-allowed';
      status.textContent = '✓ มีตาราง ipt_chart_success_app ในฐานข้อมูลแล้ว';
      status.style.color = '#16a34a';
    } else {
      btn.disabled = false;
      btn.style.background = '#ea580c';
      btn.style.cursor = 'pointer';
      status.textContent = '⚠ ยังไม่มีตาราง ipt_chart_success_app';
      status.style.color = '#ea580c';
    }
  } catch (_) { if (status) status.textContent = 'ไม่สามารถตรวจสอบได้'; }
}

async function createSuccessTable() {
  const btn    = document.getElementById('btnCreateSuccessTable');
  const status = document.getElementById('successTableStatus');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>กำลังสร้าง...';
  try {
    const res  = await fetch('/api/db/create-success-table', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showAlert('success', data.message);
      checkSuccessTable();
    } else {
      showAlert('danger', data.message);
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-table me-1"></i>เพิ่มตาราง success';
    }
  } catch (e) {
    showAlert('danger', 'เกิดข้อผิดพลาด: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-table me-1"></i>เพิ่มตาราง success';
  }
}

// เรียก checkLogTable เมื่อ page โหลด (หลัง init)
setTimeout(checkLogTable, 500);
setTimeout(checkSuccessTable, 700);
