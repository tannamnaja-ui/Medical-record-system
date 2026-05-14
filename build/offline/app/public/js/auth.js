// Shared auth utilities – included in every protected page

const TOKEN_KEY = 'icd10_token';
const USER_KEY  = 'icd10_user';

function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
function getUser()  { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); }

function setSession(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

// Check auth with server; redirect to login if not authenticated
async function requireAuth() {
  const token = getToken();
  if (!token) { window.location.href = '/login.html'; return null; }
  try {
    const res = await apiFetch('/api/auth/me', { timeout: 10000 });
    const data = await res.json();
    if (!data.success) { clearSession(); window.location.href = '/login.html'; return null; }
    return data.user;
  } catch (e) {
    clearSession();
    window.location.href = '/login.html';
    return null;
  }
}

// Authenticated fetch – auto-attaches token; redirects on 401
async function apiFetch(url, options = {}) {
  const token = getToken();
  options.headers = { ...(options.headers || {}), 'X-Auth-Token': token || '' };
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    options.body = JSON.stringify(options.body);
    options.headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeoutMs = options.timeout || 15000;
  options.signal = controller.signal;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, options);
    if (res.status === 401) {
      clearSession();
      window.location.href = '/login.html';
      throw new Error('กรุณาเข้าสู่ระบบ');
    }
    return res;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Logout
async function logout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  clearSession();
  window.location.href = '/login.html';
}

// Render user info into navbar element (id="navUser")
function renderNavUser() {
  const user = getUser();
  const el = document.getElementById('navUser');
  if (el && user) {
    el.innerHTML = `
      <span class="me-2"><i class="fas fa-user-circle me-1"></i>${user.officer_name || user.officer_login_name}</span>
      <button class="btn btn-sm btn-outline-light" onclick="logout()">
        <i class="fas fa-sign-out-alt me-1"></i>ออกจากระบบ
      </button>`;
  }
}
