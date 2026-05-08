// If already logged in, go straight to index
(async () => {
  const token = getToken();
  if (token) {
    try {
      const res = await fetch('/api/auth/me', { headers: { 'X-Auth-Token': token } });
      const data = await res.json();
      if (data.success) { window.location.href = '/index.html'; return; }
    } catch (_) {}
  }
  checkDbStatus();
  loadDepartments();
})();

// โหลดห้องทำงานจาก kskdepartment
async function loadDepartments() {
  try {
    const res  = await fetch('/api/kskdepartments');
    const data = await res.json();
    if (data.success && data.data.length) {
      const sel = document.getElementById('roomSelect');
      data.data.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name; opt.textContent = d.name;
        sel.appendChild(opt);
      });
      // restore ค่าที่จำไว้
      const saved = localStorage.getItem('icd10_room');
      if (saved) {
        sel.value = saved;
        document.getElementById('rememberRoom').checked = true;
      }
    }
  } catch (_) {}
}

// Check DB connection status
async function checkDbStatus() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    const dot  = document.getElementById('dbDot');
    const text = document.getElementById('dbStatusText');
    if (data.connected) {
      dot.className  = 'dot dot-ok';
      text.textContent = `เชื่อมต่อฐานข้อมูลแล้ว (${data.dbType || ''} · ${data.host || ''})`;
    } else {
      dot.className  = 'dot dot-err';
      text.textContent = 'ยังไม่ได้เชื่อมต่อฐานข้อมูล – กรุณากด ตั้งค่าฐานข้อมูล';
    }
  } catch (_) {}
}

// Toggle password visibility
function togglePwd() {
  const pwd  = document.getElementById('password');
  const icon = document.getElementById('eyeIcon');
  const show = pwd.type === 'password';
  pwd.type   = show ? 'text' : 'password';
  icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
}

// Enter key submits form
['username', 'password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

function showAlert(type, msg) {
  const box = document.getElementById('alertBox');
  const icon = { danger: 'times-circle', warning: 'exclamation-triangle', success: 'check-circle' }[type] || 'info-circle';
  box.className = `alert alert-${type}`;
  box.innerHTML = `<i class="fas fa-${icon} me-2"></i>${msg}`;
  box.classList.remove('d-none');
}

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const room     = document.getElementById('roomSelect').value;
  const remember = document.getElementById('rememberRoom').checked;
  const btn      = document.getElementById('btnLogin');

  if (!username || !password) {
    showAlert('warning', 'กรุณาใส่ชื่อผู้ใช้และรหัสผ่าน');
    return;
  }

  // จำห้องหรือล้างออก
  if (remember && room) localStorage.setItem('icd10_room', room);
  else localStorage.removeItem('icd10_room');

  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>กำลังตรวจสอบ...';

  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, room }),
    });
    const data = await res.json();

    if (data.success) {
      setSession(data.token, { officer_login_name: username, officer_name: data.officer_name, room: data.room || room });
      window.location.href = '/index.html';
    } else {
      showAlert('danger', data.message || 'เข้าสู่ระบบไม่สำเร็จ');
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-sign-in-alt me-2"></i>เข้าสู่ระบบ';
    }
  } catch (e) {
    showAlert('danger', 'เกิดข้อผิดพลาด: ' + e.message);
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-sign-in-alt me-2"></i>เข้าสู่ระบบ';
  }
}
