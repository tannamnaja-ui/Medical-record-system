const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

// pg: คืนค่า DATE/TIMESTAMP เป็น string ดิบ ไม่แปลงเป็น Date object (ป้องกัน timezone shift)
try {
  const pgTypes = require('pg').types;
  pgTypes.setTypeParser(1082, val => val); // DATE
  pgTypes.setTypeParser(1114, val => val); // TIMESTAMP
  pgTypes.setTypeParser(1184, val => val); // TIMESTAMPTZ
} catch (_) {}

const app = express();
app.use(express.json());

const CONFIG_FILE = path.join(__dirname, 'config.json');
let dbConn = null;

// ─── Session store (in-memory) ────────────────────────────────────────────────
// token -> { officer_login_name, officer_name, loginAt }
const sessions = new Map();

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function getAuthUser(req) {
  const token = req.headers['x-auth-token'];
  return token ? sessions.get(token) : null;
}

function requireAuth(req, res, next) {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
  req.user = user;
  next();
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function createConnection(config) {
  if (config.dbType === 'postgresql') {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: config.host,
      port: parseInt(config.port) || 5432,
      database: config.database,
      user: config.username,
      password: config.password,
      connectionTimeoutMillis: 8000,
    });
    await pool.query('SELECT 1');
    return { pool, type: 'postgresql' };
  } else if (config.dbType === 'mysql') {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: config.host,
      port: parseInt(config.port) || 3306,
      database: config.database,
      user: config.username,
      password: config.password,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 8000,
      dateStrings: true,
    });
    await pool.query('SELECT 1');
    return { pool, type: 'mysql' };
  }
  throw new Error('ประเภทฐานข้อมูลไม่ถูกต้อง');
}

async function dbQuery(sql, params = []) {
  if (!dbConn) throw new Error('ยังไม่ได้เชื่อมต่อฐานข้อมูล กรุณาตั้งค่าการเชื่อมต่อก่อน');

  let adaptedSQL = sql;
  if (dbConn.type === 'mysql') {
    adaptedSQL = adaptedSQL.replace(/AS VARCHAR\((\d+)\)/gi, 'AS CHAR($1)');
    adaptedSQL = adaptedSQL.replace(/string_agg\(([^,]+),\s*'([^']*)'\)/gi, "GROUP_CONCAT($1 SEPARATOR '$2')");
  }
  if (dbConn.type === 'postgresql') {
    // DATEDIFF(d1,d2) → (d1::date - d2::date)
    adaptedSQL = adaptedSQL.replace(/DATEDIFF\(([^,]+),\s*([^)]+)\)/gi, '($1::date - $2::date)');
    let i = 0;
    adaptedSQL = adaptedSQL.replace(/\?/g, () => `$${++i}`);
    const result = await dbConn.pool.query(adaptedSQL, params);
    return result.rows;
  } else {
    const [rows] = await dbConn.pool.query(adaptedSQL, params);
    return rows;
  }
}

// รัน query หลายคำสั่งใน transaction เดียว (commit ทั้งหมด หรือ rollback ทั้งหมดถ้ามีอันใดล้มเหลว)
// ป้องกันกรณี DELETE สำเร็จแล้วแต่ INSERT ถัดไปล้มเหลว ทำให้ข้อมูลหายไปจริง
async function withTransaction(fn) {
  if (!dbConn) throw new Error('ยังไม่ได้เชื่อมต่อฐานข้อมูล กรุณาตั้งค่าการเชื่อมต่อก่อน');

  if (dbConn.type === 'postgresql') {
    const client = await dbConn.pool.connect();
    const query = async (sql, params = []) => {
      let i = 0;
      const adapted = sql
        .replace(/DATEDIFF\(([^,]+),\s*([^)]+)\)/gi, '($1::date - $2::date)')
        .replace(/\?/g, () => `$${++i}`);
      const result = await client.query(adapted, params);
      return result.rows;
    };
    try {
      await client.query('BEGIN');
      const result = await fn(query);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  } else {
    const conn = await dbConn.pool.getConnection();
    const query = async (sql, params = []) => {
      const adaptedSQL = sql
        .replace(/AS VARCHAR\((\d+)\)/gi, 'AS CHAR($1)')
        .replace(/string_agg\(([^,]+),\s*'([^']*)'\)/gi, "GROUP_CONCAT($1 SEPARATOR '$2')");
      const [rows] = await conn.query(adaptedSQL, params);
      return rows;
    };
    try {
      await conn.beginTransaction();
      const result = await fn(query);
      await conn.commit();
      return result;
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      throw e;
    } finally {
      conn.release();
    }
  }
}

// Auto-connect on startup
(async () => {
  const cfg = loadConfig();
  if (cfg && cfg.dbType && cfg.host) {
    try {
      dbConn = await createConnection(cfg);
      console.log(`Auto-connected to ${cfg.dbType} at ${cfg.host}:${cfg.port || ''}`);
    } catch (e) {
      console.log('Auto-connect failed:', e.message);
    }
  }
})();

// ─── Auth Routes (public) ─────────────────────────────────────────────────────

// Detect auth columns in officer table (cached)
// Returns [{col, useMd5}, ...] — each entry is a column to try
let _authCols = null;
async function getAuthCols() {
  if (_authCols) return _authCols;
  try {
    // Filter by current schema to avoid cross-database column leakage
    let schemaFilter = '';
    if (dbConn.type === 'mysql')      schemaFilter = 'AND table_schema = DATABASE()';
    else if (dbConn.type === 'postgresql') schemaFilter = "AND table_schema = 'public'";

    const rows = await dbQuery(
      `SELECT column_name FROM information_schema.columns
       WHERE LOWER(table_name) = 'officer' ${schemaFilter}
       ORDER BY ordinal_position`,
      []
    );
    const cols = rows.map(r =>
      String(r.column_name || r.COLUMN_NAME || Object.values(r)[0] || '').toLowerCase()
    );
    console.log('[officer columns]', cols.join(', '));

    _authCols = [];
    // HOSxP-specific columns (highest priority)
    if (cols.includes('officer_login_password_md5'))
      _authCols.push({ col: 'officer_login_password_md5', useMd5: true });
    if (cols.includes('officer_login_password'))
      _authCols.push({ col: 'officer_login_password', useMd5: false });
    // Generic fallbacks
    const generic = [
      { name: 'password',          md5: false },
      { name: 'passwd',            md5: false },
      { name: 'officer_password',  md5: false },
      { name: 'pass',              md5: false },
    ];
    for (const g of generic) {
      if (cols.includes(g.name) && !_authCols.find(a => a.col === g.name))
        _authCols.push({ col: g.name, useMd5: g.md5 });
    }
    // Always include HOSxP columns as fallback even if not detected
    if (!_authCols.find(a => a.col === 'officer_login_password_md5'))
      _authCols.push({ col: 'officer_login_password_md5', useMd5: true });
    if (!_authCols.find(a => a.col === 'officer_login_password'))
      _authCols.push({ col: 'officer_login_password', useMd5: false });
    console.log('[auth cols]', _authCols.map(a => `${a.col}(md5=${a.useMd5})`).join(', '));
  } catch (e) {
    console.log('[getAuthCols error]', e.message);
    // HOSxP-specific fallback — never fall back to a generic 'password' column
    _authCols = [
      { col: 'officer_login_password_md5', useMd5: true },
      { col: 'officer_login_password',     useMd5: false },
      { col: 'password',                   useMd5: false },
    ];
  }
  return _authCols;
}

// favicon — ป้องกัน 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// GET debug: /api/debug/check?u=USERNAME&p=PASSWORD
app.get('/api/debug/check', async (req, res) => {
  const { u: username, p: password } = req.query;
  if (!dbConn) return res.json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล' });
  if (!username) return res.json({ error: 'ใส่ ?u=ชื่อผู้ใช้&p=รหัสผ่าน' });

  const hashedPwd = md5(password || '');

  try {
    // ดึงข้อมูล user ทุก column ที่เกี่ยวกับ password
    const rows = await dbQuery(
      `SELECT officer_login_name, officer_name,
              officer_login_password_md5, officer_login_password
       FROM officer WHERE LOWER(officer_login_name) = LOWER(?) LIMIT 1`,
      [username]
    );
    if (!rows.length) return res.json({ found: false, username });

    const u = rows[0];
    const storedMd5   = String(u.officer_login_password_md5 || '');
    const storedPlain = String(u.officer_login_password || '');
    res.json({
      found:              true,
      officer_login_name: u.officer_login_name,
      officer_name:       u.officer_name,
      input_password:     password,
      computed_md5:       hashedPwd,
      stored_md5_col:     storedMd5   || '(empty)',
      stored_plain_col:   storedPlain || '(empty)',
      md5_match:          storedMd5.toLowerCase() === hashedPwd.toLowerCase(),
      plain_match:        storedPlain === password,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.json({ success: false, message: 'กรุณาใส่ชื่อผู้ใช้และรหัสผ่าน' });
    }
    if (!dbConn) {
      return res.json({ success: false, message: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล กรุณาตั้งค่าฐานข้อมูลก่อน' });
    }

    // officer_login_password_md5 เก็บเป็น MD5 → hash รหัสผ่านที่พิมพ์แล้วเปรียบเทียบ
    const hashedPwd = md5(password);
    let rows = [];

    try {
      // LOWER() ทั้งสองฝั่งเพื่อ case-insensitive MD5 comparison
      rows = await dbQuery(
        `SELECT officer_login_name, officer_name FROM officer
         WHERE LOWER(officer_login_name) = LOWER(?)
           AND LOWER(officer_login_password_md5) = LOWER(?) LIMIT 1`,
        [username, hashedPwd]
      );
      console.log(`[login] "${username}" → ${rows.length} row(s)`);
    } catch (e) {
      console.log(`[login] error (with officer_name):`, e.message);
      // ลองใหม่โดยไม่ดึง officer_name เผื่อ column นั้นไม่มีในตาราง
      try {
        const r = await dbQuery(
          `SELECT officer_login_name FROM officer
           WHERE LOWER(officer_login_name) = LOWER(?)
             AND LOWER(officer_login_password_md5) = LOWER(?) LIMIT 1`,
          [username, hashedPwd]
        );
        rows = r.map(row => ({ ...row, officer_name: row.officer_login_name }));
        console.log(`[login] retry "${username}" → ${rows.length} row(s)`);
      } catch (e2) {
        console.log(`[login] retry error:`, e2.message);
      }
    }

    if (!rows || rows.length === 0) {
      console.log(`[login] failed for "${username}" (hashed: ${hashedPwd.substring(0,8)}...)`);
      return res.json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const user  = rows[0];
    const token = genToken();
    const { room } = req.body;
    sessions.set(token, {
      officer_login_name: user.officer_login_name,
      officer_name: user.officer_name,
      room: room || '',
      loginAt: new Date().toISOString(),
    });

    res.json({ success: true, token, officer_name: user.officer_name, room: room || '' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ success: false });
  res.json({ success: true, user });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// ─── Department (public) ──────────────────────────────────────────────────────
app.get('/api/kskdepartments', async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT depcode, department AS name FROM kskdepartment WHERE department_active='Y' ORDER BY department LIMIT 500`, []);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, data: [], message: e.message }); }
});

// ─── Config Routes (public – needed before login) ─────────────────────────────

app.get('/api/config', (req, res) => {
  const config = loadConfig() || {};
  res.json({ ...config, password: '', connected: !!dbConn });
});

// ตรวจสอบว่ามีตาราง ipt_chart_location_logapp ในฐานข้อมูลหรือยัง
app.get('/api/db/check-log-table', async (req, res) => {
  if (!dbConn) return res.json({ exists: false, connected: false });
  try {
    let rows = [];
    if (dbConn.type === 'postgresql') {
      rows = await dbQuery(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND LOWER(table_name) = 'ipt_chart_location_logapp'`, []);
    } else {
      rows = await dbQuery(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND LOWER(table_name) = 'ipt_chart_location_logapp'`, []);
    }
    res.json({ exists: rows.length > 0 });
  } catch (e) {
    res.json({ exists: false, message: e.message });
  }
});

// สร้างตาราง ipt_chart_location_logapp
app.post('/api/db/create-log-table', async (req, res) => {
  if (!dbConn) return res.json({ success: false, message: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล' });
  try {
    let sql = '';
    if (dbConn.type === 'postgresql') {
      sql = `CREATE TABLE IF NOT EXISTS ipt_chart_location_logapp (
        logapp_id SERIAL PRIMARY KEY,
        an VARCHAR(9),
        hospital_location_id CHAR(2),
        depcode VARCHAR(5),
        chart_note TEXT,
        log_datetime TIMESTAMP(6),
        chart_date DATE,
        ipt_summary_status_id INTEGER,
        staff VARCHAR(30)
      )`;
    } else {
      sql = `CREATE TABLE IF NOT EXISTS ipt_chart_location_logapp (
        logapp_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        an VARCHAR(9),
        hospital_location_id CHAR(2),
        depcode VARCHAR(5),
        chart_note TEXT,
        log_datetime DATETIME(6),
        chart_date DATE,
        ipt_summary_status_id INT,
        staff VARCHAR(30)
      )`;
    }
    await dbQuery(sql, []);

    // เพิ่ม UNIQUE B-Tree index บน logapp_id
    try {
      if (dbConn.type === 'postgresql') {
        await dbQuery(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_logapp_id ON ipt_chart_location_logapp USING BTREE (logapp_id)`,
          []
        );
      } else {
        await dbQuery(
          `CREATE UNIQUE INDEX idx_logapp_id ON ipt_chart_location_logapp (logapp_id) USING BTREE`,
          []
        );
      }
    } catch (_) { /* index อาจมีอยู่แล้วถ้าเป็น PK */ }
    res.json({ success: true, message: 'สร้างตาราง ipt_chart_location_logapp สำเร็จ' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// upsert ข้อมูลยืนยันสรุป chart → ipt_chart_success_app
app.post('/api/chart/confirm-summary', requireAuth, async (req, res) => {
  try {
    const { an, location, room, chart_note, status_id } = req.body;
    const staff  = req.user.officer_login_name || '';
    const logDT  = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).substring(0, 19);
    const today  = new Date().toLocaleDateString('en-CA');

    // lookup hospital_department.id จาก location name
    let hospitalLocationId = null;
    if (location) {
      try {
        const r = await dbQuery(`SELECT id FROM hospital_department WHERE name = ? LIMIT 1`, [location]);
        if (r.length) hospitalLocationId = r[0].id;
      } catch (_) {}
    }

    // lookup kskdepartment.depcode จาก room name
    let depcode = null;
    if (room) {
      try {
        const r = await dbQuery(`SELECT depcode FROM kskdepartment WHERE department = ? LIMIT 1`, [room]);
        if (r.length) depcode = r[0].depcode;
      } catch (_) {}
    }

    // DELETE เดิมก่อน (ถ้ามี) แล้ว INSERT ใหม่ (upsert)
    try { await dbQuery(`DELETE FROM ipt_chart_success_app WHERE an = ?`, [an]); } catch (_) {}

    try {
      await dbQuery(`
        INSERT INTO ipt_chart_success_app
          (success_id, success_ok, an, hospital_location_id, depcode,
           chart_note, log_datetime, success_date, ipt_summary_status_id, staff)
        VALUES (get_serialnumber('ipt_chart_success_app'), 'Y', ?, ?, ?,
                ?, ?, ?, ?, ?)`,
        [an, hospitalLocationId, depcode,
         chart_note || '', logDT, today, status_id || null, staff]);
    } catch (e1) {
      console.log('[confirm-summary] e1:', e1.message);
      await dbQuery(`
        INSERT INTO ipt_chart_success_app
          (success_ok, an, hospital_location_id, depcode,
           chart_note, log_datetime, success_date, ipt_summary_status_id, staff)
        VALUES ('Y', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [an, hospitalLocationId, depcode,
         chart_note || '', logDT, today, status_id || null, staff]);
    }
    res.json({ success: true, message: 'บันทึกยืนยันสรุป chart สำเร็จ' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ตรวจสอบว่ามี AN นี้ใน ipt_chart_success_app หรือไม่
app.get('/api/chart/confirm-status/:an', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT success_id FROM ipt_chart_success_app WHERE an = ? AND success_ok = 'Y' LIMIT 1`, [req.params.an]);
    res.json({ confirmed: rows.length > 0 });
  } catch (e) { res.json({ confirmed: false, message: e.message }); }
});

// ตรวจสอบว่ามีตาราง ipt_chart_success_app หรือยัง
app.get('/api/db/check-success-table', async (req, res) => {
  if (!dbConn) return res.json({ exists: false, connected: false });
  try {
    let rows = [];
    if (dbConn.type === 'postgresql') {
      rows = await dbQuery(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND LOWER(table_name) = 'ipt_chart_success_app'`, []);
    } else {
      rows = await dbQuery(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND LOWER(table_name) = 'ipt_chart_success_app'`, []);
    }
    res.json({ exists: rows.length > 0 });
  } catch (e) { res.json({ exists: false, message: e.message }); }
});

// สร้างตาราง ipt_chart_success_app
app.post('/api/db/create-success-table', async (req, res) => {
  if (!dbConn) return res.json({ success: false, message: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล' });
  try {
    let sql = '';
    if (dbConn.type === 'postgresql') {
      sql = `CREATE TABLE IF NOT EXISTS ipt_chart_success_app (
        success_id SERIAL PRIMARY KEY,
        success_ok CHAR(1),
        an VARCHAR(9),
        hospital_location_id CHAR(2),
        depcode VARCHAR(5),
        chart_note TEXT,
        log_datetime TIMESTAMP(6),
        success_date DATE,
        ipt_summary_status_id INTEGER,
        staff VARCHAR(30)
      )`;
    } else {
      sql = `CREATE TABLE IF NOT EXISTS ipt_chart_success_app (
        success_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        success_ok CHAR(1),
        an VARCHAR(9),
        hospital_location_id CHAR(2),
        depcode VARCHAR(5),
        chart_note TEXT,
        log_datetime DATETIME(6),
        success_date DATE,
        ipt_summary_status_id INT,
        staff VARCHAR(30)
      )`;
    }
    await dbQuery(sql, []);

    // UNIQUE B-Tree index บน success_id
    try {
      if (dbConn.type === 'postgresql') {
        await dbQuery(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_success_id ON ipt_chart_success_app USING BTREE (success_id)`, []);
      } else {
        await dbQuery(
          `CREATE UNIQUE INDEX idx_success_id ON ipt_chart_success_app (success_id) USING BTREE`, []);
      }
    } catch (_) {}

    // B-Tree index บน an
    try {
      if (dbConn.type === 'postgresql') {
        await dbQuery(
          `CREATE INDEX IF NOT EXISTS idx_success_an ON ipt_chart_success_app USING BTREE (an)`, []);
      } else {
        await dbQuery(
          `CREATE INDEX idx_success_an ON ipt_chart_success_app (an) USING BTREE`, []);
      }
    } catch (_) {}

    res.json({ success: true, message: 'สร้างตาราง ipt_chart_success_app สำเร็จ' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/config/test', async (req, res) => {
  try {
    const conn = await createConnection(req.body);
    try { await conn.pool.end(); } catch (_) {}
    res.json({ success: true, message: 'เชื่อมต่อสำเร็จ' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/api/config/save', async (req, res) => {
  try {
    const conn = await createConnection(req.body);
    if (dbConn) { try { await dbConn.pool.end(); } catch (_) {} }
    dbConn = conn;
    _authCols = null; // reset cache for new connection
    saveConfig(req.body);
    res.json({ success: true, message: 'บันทึกและเชื่อมต่อสำเร็จ' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ─── Protected Routes ─────────────────────────────────────────────────────────

// คืน chart → UPDATE ipdrent SET checkin='Y' WHERE an=? AND checkin='N'
app.post('/api/chart/return', requireAuth, async (req, res) => {
  try {
    const { an } = req.body;
    await dbQuery(`UPDATE ipdrent SET checkin = 'Y' WHERE an = ? AND checkin = 'N'`, [an]);
    res.json({ success: true, message: 'คืน chart สำเร็จ' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ตรวจสอบว่า AN ถูกยืมอยู่หรือไม่ (checkin='N')
app.get('/api/chart/rent-status/:an', requireAuth, async (req, res) => {
  try {
    const { an } = req.params;
    let borrowed = false;
    try {
      const rows = await dbQuery(
        `SELECT rent_id FROM ipdrent WHERE an = ? AND checkin = 'N' LIMIT 1`, [an]);
      borrowed = rows.length > 0;
    } catch (_) {}
    res.json({ success: true, borrowed });
  } catch (e) { res.json({ success: false, borrowed: false, message: e.message }); }
});

// บันทึกการยืมแฟ้ม → ipdrent
app.post('/api/chart/save-rent', requireAuth, async (req, res) => {
  try {
    const { an, hn, rent_date, rent_time, room, borrower_code,
            reason_name, phone, comment, lender_code, due_date } = req.body;

    // lookup rent_depcode จาก kskdepartment
    let rent_depcode = '';
    if (room) {
      try {
        const r = await dbQuery(`SELECT depcode FROM kskdepartment WHERE department = ? LIMIT 1`, [room]);
        if (r.length) rent_depcode = r[0].depcode || '';
      } catch (_) {}
    }

    // lookup rent_reason_id จาก rent_reason.name
    let rent_reason_id = null;
    if (reason_name) {
      try {
        const r = await dbQuery(`SELECT id FROM rent_reason WHERE name = ? LIMIT 1`, [reason_name]);
        if (r.length) rent_reason_id = r[0].id;
      } catch (_) {}
    }

    // rent_user = officer_login_name ของผู้ยืม (เทียบจาก doctor.code → officer หรือใช้ตรงๆ)
    let rent_user = borrower_code || '';

    // staff = officer_login_name ของผู้ให้ยืม
    const staff = lender_code || req.user.officer_login_name || '';

    // INSERT ลง ipdrent
    async function allocateRentId() {
      const rows = await dbQuery(`SELECT COALESCE(MAX(rent_id), 0) + 1 AS next_id FROM ipdrent`);
      return rows.length ? rows[0].next_id : 1;
    }

    let rentId = await allocateRentId();
    if (!rentId) throw new Error('ไม่สามารถสร้าง rent_id ได้');

    const insertRent = async () => {
      await dbQuery(`
        INSERT INTO ipdrent
          (rent_id, an, hn, rent_date, rent_time, rent_depcode,
           rent_user, rent_reason_id, phone, comment, staff,
           due_date, hos_guid, checkin)
        VALUES (?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, 'app', 'N')`,
        [rentId, an, hn, rent_date, rent_time, rent_depcode,
         rent_user, rent_reason_id, phone || '', comment || '', staff,
         due_date]);
    };

    const duplicateError = err => {
      const msg = String(err.message || '').toLowerCase();
      return msg.includes('duplicate key value') || msg.includes('duplicate entry') || msg.includes('unique constraint') || msg.includes('duplicate');
    };

    let attempt = 0;
    while (true) {
      try {
        attempt += 1;
        await insertRent();
        break;
      } catch (err) {
        if (duplicateError(err) && attempt < 5) {
          rentId = await allocateRentId();
          if (!rentId) throw new Error('ไม่สามารถสร้าง rent_id ใหม่ได้');
          continue;
        }
        throw err;
      }
    }

    res.json({ success: true, message: 'บันทึกการยืมแฟ้มสำเร็จ' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// แก้ไขรายการยืมแฟ้มที่มีอยู่แล้ว → UPDATE ipdrent (ไม่สร้างรายการใหม่)
app.post('/api/chart/update-rent', requireAuth, async (req, res) => {
  try {
    const { rent_id, rent_date, rent_time, room, borrower_code,
            reason_name, phone, comment, lender_code, due_date } = req.body;
    if (!rent_id) return res.json({ success: false, message: 'ไม่พบรายการยืมแฟ้มที่จะแก้ไข' });

    let rent_depcode = '';
    if (room) {
      try {
        const r = await dbQuery(`SELECT depcode FROM kskdepartment WHERE department = ? LIMIT 1`, [room]);
        if (r.length) rent_depcode = r[0].depcode || '';
      } catch (_) {}
    }

    let rent_reason_id = null;
    if (reason_name) {
      try {
        const r = await dbQuery(`SELECT id FROM rent_reason WHERE name = ? LIMIT 1`, [reason_name]);
        if (r.length) rent_reason_id = r[0].id;
      } catch (_) {}
    }

    const rent_user = borrower_code || '';
    const staff      = lender_code || req.user.officer_login_name || '';

    await dbQuery(`
      UPDATE ipdrent
         SET rent_date = ?, rent_time = ?, rent_depcode = ?,
             rent_user = ?, rent_reason_id = ?, phone = ?,
             comment = ?, staff = ?, due_date = ?
       WHERE rent_id = ?`,
      [rent_date, rent_time, rent_depcode, rent_user, rent_reason_id,
       phone || '', comment || '', staff, due_date, rent_id]);

    res.json({ success: true, message: 'บันทึกการแก้ไขข้อมูลยืมแฟ้มสำเร็จ' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// chart ที่ถูกยืม: เฉพาะ AN ใน ipdrent กรองตาม rent_date
app.get('/api/chart/borrowed-list', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, ward, notReturn } = req.query;
    const from = dateFrom || new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0];
    const to   = dateTo   || new Date().toISOString().split('T')[0];

    const notReturnFilter = notReturn === 'true' ? `AND r.checkin = 'N'` : '';
    const wardFilter      = ward && ward !== 'ALL' ? `AND ipt.ward = ?` : '';
    const params = [from, to];
    if (ward && ward !== 'ALL') params.push(ward);

    const rows = await dbQuery(`
      SELECT ipt.an, ipt.hn,
             TO_CHAR(ipt.regdate, 'YYYY-MM-DD') AS regdate, ipt.regtime,
             TO_CHAR(ipt.dchdate, 'YYYY-MM-DD') AS dchdate,
             TO_CHAR(r.rent_date, 'YYYY-MM-DD') AS rent_date, r.checkin, COALESCE(r.comment,'') AS comment,
             CAST(CONCAT(p.pname,p.fname,' ',p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(CONCAT(COALESCE(sp.name,''),' - ',COALESCE(w.name,'')) AS VARCHAR(250)) AS spclty_ward_name,
             w.name AS ward_name, ipt.ward,
             COALESCE(ptt.name,'') AS pttype_name,
             COALESCE(dct1.name,'') AS incharge_doctor_name,
             COALESCE(iss.ipt_summary_status_name,'') AS chart_status_name,
             CASE WHEN ipt.an IN (SELECT an FROM ipt_chart_location WHERE chart_date IS NOT NULL)
               THEN 'Y' ELSE 'N' END AS chart_received,
             NULL AS chart_receive_date, '' AS receiver_name,
             (CURRENT_DATE::DATE - TO_DATE(TO_CHAR(ipt.dchdate,'YYYY-MM-DD'),'YYYY-MM-DD')) AS days_since_dch
      FROM ipdrent r
        JOIN ipt             ON ipt.an     = r.an
        JOIN patient p        ON p.hn       = ipt.hn
        LEFT OUTER JOIN spclty sp ON sp.spclty = ipt.spclty
        LEFT OUTER JOIN ward w    ON w.ward    = ipt.ward
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt     ON ptt.pttype = ip1.pttype
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1    ON dct1.code = il1.doctor
        LEFT OUTER JOIN ipt_summary_status iss ON iss.ipt_summary_status_id = ipt.ipt_summary_status_id
      WHERE r.rent_date BETWEEN ? AND ?
        ${notReturnFilter}
        ${wardFilter}
      ORDER BY r.rent_date DESC LIMIT 2000`, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// รายการ chart ที่ถูกยืม จาก ipdrent
app.get('/api/chart/rent-list', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, ward, overdue, dueOnly } = req.query;
    const from = dateFrom || new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0];
    const to   = dateTo   || new Date().toISOString().split('T')[0];

    let whereClause, params;
    if (overdue === 'true') {
      // เกินกำหนด: ไม่สนใจวันที่ยืม ใช้ checkin='N' + due_date < CURRENT_DATE
      whereClause = `WHERE r.checkin = 'N' AND r.due_date < CURRENT_DATE`;
      params = [];
    } else if (dueOnly === 'true') {
      // chart ที่ต้องคืน: ใช้ date range เหมือน borrowed + due_date <= CURRENT_DATE
      whereClause = `WHERE r.rent_date BETWEEN ? AND ? AND r.due_date <= CURRENT_DATE`;
      params = [from, to];
    } else {
      whereClause = `WHERE r.rent_date BETWEEN ? AND ?`;
      params = [from, to];
    }

    const wardFilter = ward && ward !== 'ALL' ? `AND ipt.ward = ?` : '';
    if (ward && ward !== 'ALL') params.push(ward);

    const rows = await dbQuery(`
      SELECT r.rent_id, r.an, r.hn, r.rent_date, r.rent_time,
             r.rent_depcode, r.rent_user, r.phone, r.comment, r.staff,
             r.due_date, r.checkin,
             CAST(CONCAT(p.pname,p.fname,' ',p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(ipt.regdate AS DATE) AS regdate,
             CAST(ipt.dchdate AS DATE) AS dchdate,
             COALESCE(ipt.ward,'') AS ward,
             COALESCE(w.name,'') AS ward_name,
             COALESCE(rr.name,'') AS rent_reason_name,
             COALESCE(ptt.name,'') AS pttype_name,
             COALESCE(dct1.name,'') AS incharge_doctor_name,
             COALESCE(oborrow.officer_name, r.rent_user,'') AS rent_user_name,
             COALESCE(kd.department,'') AS rent_room_name,
             COALESCE(ostaff.officer_name, r.staff,'') AS lender_name,
             (CURRENT_DATE - CAST(r.rent_date AS DATE)) AS days_rented,
             CASE WHEN r.due_date < CURRENT_DATE AND r.checkin='N' THEN 'Y' ELSE 'N' END AS is_overdue,
             icl.chart_date AS chart_receive_date,
             COALESCE(o2.officer_name, icl.staff,'') AS chart_receiver_name
      FROM ipdrent r
        LEFT OUTER JOIN ipt           ON ipt.an          = r.an
        LEFT OUTER JOIN patient p     ON p.hn             = r.hn
        LEFT OUTER JOIN ward w        ON w.ward           = ipt.ward
        LEFT OUTER JOIN rent_reason rr ON rr.id           = r.rent_reason_id
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an          = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt    ON ptt.pttype        = ip1.pttype
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an     = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1   ON dct1.code         = il1.doctor
        LEFT OUTER JOIN officer oborrow  ON oborrow.officer_login_name = r.rent_user
        LEFT OUTER JOIN kskdepartment kd ON kd.depcode              = r.rent_depcode
        LEFT OUTER JOIN officer ostaff   ON ostaff.officer_login_name = r.staff
        LEFT OUTER JOIN ipt_chart_location icl ON icl.an  = r.an
        LEFT OUTER JOIN officer o2    ON o2.officer_login_name = icl.staff
      ${whereClause}
        AND r.checkin = 'N'
        ${wardFilter}
      ORDER BY r.rent_date DESC, r.rent_time DESC LIMIT 2000`, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ดึงรายละเอียดการยืมแฟ้มรายการเดียวตาม ipdrent.rent_id (primary key)
app.get('/api/chart/rent/:rentId', requireAuth, async (req, res) => {
  try {
    const { rentId } = req.params;
    const rows = await dbQuery(`
      SELECT r.rent_id, r.an, r.hn, r.rent_date, r.rent_time,
             r.rent_depcode, r.rent_user, r.phone, r.comment, r.staff,
             r.due_date, r.checkin,
             CAST(CONCAT(p.pname,p.fname,' ',p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(ipt.regdate AS DATE) AS regdate,
             CAST(ipt.dchdate AS DATE) AS dchdate,
             COALESCE(ipt.ward,'') AS ward,
             COALESCE(w.name,'') AS ward_name,
             COALESCE(rr.name,'') AS rent_reason_name,
             COALESCE(oborrow.officer_name, r.rent_user,'') AS rent_user_name,
             COALESCE(kd.department,'') AS rent_room_name,
             COALESCE(ostaff.officer_name, r.staff,'') AS lender_name
      FROM ipdrent r
        LEFT OUTER JOIN ipt              ON ipt.an = r.an
        LEFT OUTER JOIN patient p        ON p.hn   = r.hn
        LEFT OUTER JOIN ward w           ON w.ward = ipt.ward
        LEFT OUTER JOIN rent_reason rr   ON rr.id  = r.rent_reason_id
        LEFT OUTER JOIN officer oborrow  ON oborrow.officer_login_name = r.rent_user
        LEFT OUTER JOIN kskdepartment kd ON kd.depcode = r.rent_depcode
        LEFT OUTER JOIN officer ostaff   ON ostaff.officer_login_name = r.staff
      WHERE r.rent_id = ?
      LIMIT 1`, [rentId]);
    if (!rows.length) return res.json({ success: false, message: 'ไม่พบรายการยืมแฟ้ม' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ค้นหารายการยืมแฟ้มด้วย AN/HN (ไม่กรอง checkin เพื่อให้เจอทั้งที่ยังไม่คืนและคืนแล้ว)
app.get('/api/chart/rent-search', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });
    const qLike = `%${q}%`;
    const rows = await dbQuery(`
      SELECT r.rent_id, r.an, r.hn, r.rent_date, r.rent_time,
             r.rent_depcode, r.rent_user, r.phone, r.comment, r.staff,
             r.due_date, r.checkin,
             CAST(CONCAT(p.pname,p.fname,' ',p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(ipt.regdate AS DATE) AS regdate,
             CAST(ipt.dchdate AS DATE) AS dchdate,
             COALESCE(ipt.ward,'') AS ward,
             COALESCE(w.name,'') AS ward_name,
             COALESCE(rr.name,'') AS rent_reason_name,
             COALESCE(ptt.name,'') AS pttype_name,
             COALESCE(dct1.name,'') AS incharge_doctor_name,
             COALESCE(oborrow.officer_name, r.rent_user,'') AS rent_user_name,
             COALESCE(kd.department,'') AS rent_room_name,
             COALESCE(ostaff.officer_name, r.staff,'') AS lender_name,
             (CURRENT_DATE - CAST(r.rent_date AS DATE)) AS days_rented,
             CASE WHEN r.due_date < CURRENT_DATE AND r.checkin='N' THEN 'Y' ELSE 'N' END AS is_overdue,
             icl.chart_date AS chart_receive_date,
             COALESCE(o2.officer_name, icl.staff,'') AS chart_receiver_name
      FROM ipdrent r
        LEFT OUTER JOIN ipt           ON ipt.an          = r.an
        LEFT OUTER JOIN patient p     ON p.hn             = r.hn
        LEFT OUTER JOIN ward w        ON w.ward           = ipt.ward
        LEFT OUTER JOIN rent_reason rr ON rr.id           = r.rent_reason_id
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an          = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt    ON ptt.pttype        = ip1.pttype
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an     = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1   ON dct1.code         = il1.doctor
        LEFT OUTER JOIN officer oborrow  ON oborrow.officer_login_name = r.rent_user
        LEFT OUTER JOIN kskdepartment kd ON kd.depcode              = r.rent_depcode
        LEFT OUTER JOIN officer ostaff   ON ostaff.officer_login_name = r.staff
        LEFT OUTER JOIN ipt_chart_location icl ON icl.an  = r.an
        LEFT OUTER JOIN officer o2    ON o2.officer_login_name = icl.staff
      WHERE (r.an LIKE ? OR r.hn LIKE ?)
      ORDER BY r.rent_date DESC, r.rent_time DESC LIMIT 50`, [qLike, qLike]);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// เหตุผลการยืม
app.get('/api/chart/rent-reasons', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT name FROM rent_reason ORDER BY name LIMIT 200`, []);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, data: [], message: e.message }); }
});

// แผนก spclty
app.get('/api/chart/spclty', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT spclty, name FROM spclty ORDER BY name LIMIT 300`, []);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, data: [], message: e.message }); }
});

// ─── Chart Routes ─────────────────────────────────────────────────────────────

// ดึง departments สำหรับ location จาก hospital_department.name
app.get('/api/chart/departments', requireAuth, async (req, res) => {
  let rows = [];
  try {
    rows = await dbQuery(`SELECT name FROM hospital_department ORDER BY name LIMIT 500`, []);
  } catch (e) {
    console.log('[chart/departments] hospital_department error:', e.message);
    try {
      rows = await dbQuery(`SELECT department AS name FROM kskdepartment WHERE department_active='Y' ORDER BY department LIMIT 500`, []);
    } catch (__) {}
  }
  res.json({ success: true, data: rows });
});

// ดึงห้องทำงานของ user ปัจจุบัน (จาก session ที่เก็บตอน login)
app.get('/api/chart/user-room', requireAuth, (req, res) => {
  res.json({ success: true, room: req.user.room || '' });
});

// ดึง ipt_summary_status
app.get('/api/chart/summary-status', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT ipt_summary_status_id, ipt_summary_status_name FROM ipt_summary_status ORDER BY ipt_summary_status_id LIMIT 100`, []);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, data: [], message: e.message }); }
});

// ดึงข้อมูล ipt_chart_location + ipt status ของ AN
app.get('/api/chart/location/:an', requireAuth, async (req, res) => {
  try {
    const { an } = req.params;
    let chartLoc = null;
    try {
      const rows = await dbQuery(`
        SELECT l.*,
               hd.name AS location_name,
               k.department AS room_name,
               s.ipt_summary_status_name
        FROM ipt_chart_location l
          LEFT OUTER JOIN hospital_department hd ON hd.id::text = l.hospital_location_id::text
          LEFT OUTER JOIN kskdepartment k ON k.depcode = l.depcode
          LEFT OUTER JOIN ipt_summary_status s ON s.ipt_summary_status_id::text = l.hos_guid::text
        WHERE l.an = ?
        ORDER BY l.update_datetime DESC LIMIT 1`, [an]);
      chartLoc = rows[0] || null;
    } catch (_) {
      const rows = await dbQuery(`SELECT * FROM ipt_chart_location WHERE an = ? LIMIT 1`, [an]);
      chartLoc = rows[0] || null;
    }

    // ดึง ipt.ipt_summary_status_id ด้วย
    let iptStatus = null;
    try {
      const ir = await dbQuery(`
        SELECT ipt.ipt_summary_status_id, s.ipt_summary_status_name
        FROM ipt LEFT OUTER JOIN ipt_summary_status s
          ON s.ipt_summary_status_id = ipt.ipt_summary_status_id
        WHERE ipt.an = ? LIMIT 1`, [an]);
      iptStatus = ir[0] || null;
    } catch (_) {}

    res.json({ success: true, data: chartLoc, ipt_status: iptStatus });
  } catch (e) { res.json({ success: false, data: null, message: e.message }); }
});

// บันทึกการรับ chart (INSERT or UPDATE)
app.post('/api/chart/borrow', requireAuth, async (req, res) => {
  try {
    const { an, date_in, location, room, status_id, note } = req.body;
    const staff = req.user.officer_login_name || '';

    // lookup hospital_department.id จาก location name
    let hospitalLocationId = null;
    if (location) {
      try {
        const r = await dbQuery(`SELECT id FROM hospital_department WHERE name = ? LIMIT 1`, [location]);
        if (r.length) hospitalLocationId = r[0].id;
      } catch (_) {}
    }

    // lookup kskdepartment.depcode จาก room name
    let depcode = null;
    if (room) {
      try {
        const r = await dbQuery(`SELECT depcode FROM kskdepartment WHERE department = ? LIMIT 1`, [room]);
        if (r.length) depcode = r[0].depcode;
      } catch (_) {}
    }

    // DELETE + INSERT ด้วย fields ใหม่
    try { await dbQuery(`DELETE FROM ipt_chart_location WHERE an = ?`, [an]); } catch (_) {}
    try {
      await dbQuery(`
        INSERT INTO ipt_chart_location
          (an, hospital_location_id, depcode, chart_note, staff,
           update_datetime, chart_date, hos_guid_ext, hos_guid)
        VALUES (?, ?, ?, ?, ?, NOW(), ?, 'app', ?)`,
        [an, hospitalLocationId, depcode, note || '', staff, date_in, status_id || null]);
    } catch (e1) {
      console.log('[borrow] e1:', e1.message);
      try {
        await dbQuery(`
          INSERT INTO ipt_chart_location (an, chart_note, staff, update_datetime, chart_date, hos_guid_ext, hos_guid)
          VALUES (?, ?, ?, NOW(), ?, 'app', ?)`,
          [an, note || '', staff, date_in, status_id || null]);
      } catch (e2) {
        console.log('[borrow] e2:', e2.message);
        await dbQuery(`INSERT INTO ipt_chart_location (an, chart_date, staff) VALUES (?, ?, ?)`,
          [an, date_in, staff]);
      }
    }

    // อัปเดต ipt.ipt_summary_status_id
    if (status_id) {
      try { await dbQuery(`UPDATE ipt SET ipt_summary_status_id = ? WHERE an = ?`, [status_id, an]); }
      catch (_) {}
    }

    // บันทึก log → ipt_chart_location_logapp (Bangkok UTC+7)
    const logDT = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).substring(0, 19);
    try {
      await dbQuery(`
        INSERT INTO ipt_chart_location_logapp
          (logapp_id, an, hospital_location_id, depcode,
           chart_note, log_datetime, chart_date, ipt_summary_status_id, staff)
        VALUES (get_serialnumber('ipt_chart_location_logapp'), ?, ?, ?,
                ?, ?, ?, ?, ?)`,
        [an, hospitalLocationId, depcode || '',
         note || '', logDT, date_in, status_id || null, staff]);
    } catch (logErr1) {
      console.log('[chart logapp] e1:', logErr1.message);
      try {
        await dbQuery(`
          INSERT INTO ipt_chart_location_logapp
            (an, hospital_location_id, depcode,
             chart_note, log_datetime, chart_date, ipt_summary_status_id, staff)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [an, hospitalLocationId, depcode || '',
           note || '', logDT, date_in, status_id || null, staff]);
      } catch (logErr2) { console.log('[chart logapp] e2:', logErr2.message); }
    }

    // บันทึก log → ipt_chart_location_log (ตารางใหม่)
    try {
      await dbQuery(`
        INSERT INTO ipt_chart_location_log
          (ipt_cll_id, staff, log_datetime, hospital_location_id, an, depcode)
        VALUES (get_serialnumber('ipt_cll_id'), ?, NOW(), ?, ?, ?)`,
        [staff, hospitalLocationId, an, depcode || '']);
    } catch (e1) {
      console.log('[chart log2] e1:', e1.message);
      // fallback ไม่มี get_serialnumber
      try {
        await dbQuery(`
          INSERT INTO ipt_chart_location_log
            (staff, log_datetime, hospital_location_id, an, depcode)
          VALUES (?, NOW(), ?, ?, ?)`,
          [staff, hospitalLocationId, an, depcode || '']);
      } catch (e2) { console.log('[chart log2] e2:', e2.message); }
    }

    res.json({ success: true, message: 'บันทึกการรับ chart สำเร็จ' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ดึง log ของ AN นี้ทั้งหมด
app.get('/api/chart/log/:an', requireAuth, async (req, res) => {
  try {
    const { an } = req.params;
    const rows = await dbQuery(`
      SELECT l.logapp_id, l.an, l.depcode, l.chart_note,
             l.log_datetime, l.chart_date, l.ipt_summary_status_id,
             l.staff, o.officer_name,
             s.ipt_summary_status_name
      FROM ipt_chart_location_logapp l
        LEFT OUTER JOIN officer o ON o.officer_login_name = l.staff
        LEFT OUTER JOIN ipt_summary_status s ON s.ipt_summary_status_id = l.ipt_summary_status_id
      WHERE l.an = ?
      ORDER BY l.logapp_id DESC`, [an]);
    res.json({ success: true, data: rows });
  } catch (e) { res.json({ success: false, message: e.message, data: [] }); }
});

// ค้นหา AN โดยไม่กรองวันที่
app.get('/api/chart/find-an', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });
    const qLike = `%${q}%`;
    const rows = await dbQuery(`
      SELECT ipt.an, ipt.hn,
             TO_CHAR(ipt.regdate, 'YYYY-MM-DD') AS regdate, ipt.regtime,
             TO_CHAR(ipt.dchdate, 'YYYY-MM-DD') AS dchdate,
             CAST(CONCAT(p.pname,p.fname,' ',p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(CONCAT(COALESCE(spclty.name,''),' - ',COALESCE(w.name,'')) AS VARCHAR(250)) AS spclty_ward_name,
             w.name AS ward_name, ipt.ward,
             iptdiag.icd10,
             CAST(CONCAT(COALESCE(iptdiag.icd10,''),' - ',COALESCE(i1.name,'')) AS VARCHAR(250)) AS icdname,
             ptt.name AS pttype_name, dt.name AS admdoctor_name,
             dc1.name AS dchtype_name, aa.age_y, aa.age_m, aa.age_d,
             aa.diag_text_list, NULL AS chart_receive_date,
             CASE WHEN ipt.an IN (SELECT an FROM ipt_chart_location WHERE chart_date IS NOT NULL)
               THEN 'Y' ELSE 'N' END AS chart_received,
             COALESCE(iss.ipt_summary_status_name, '') AS chart_status_name,
             '' AS chart_receive_staff, '' AS receiver_name,
             dct1.name AS incharge_doctor_name,
             (CURRENT_DATE::DATE - TO_DATE(TO_CHAR(ipt.dchdate,'YYYY-MM-DD'),'YYYY-MM-DD')) AS days_since_dch
      FROM ipt
        LEFT OUTER JOIN patient p      ON p.hn       = ipt.hn
        LEFT OUTER JOIN spclty         ON spclty.spclty = ipt.spclty
        LEFT OUTER JOIN ward w         ON w.ward      = ipt.ward
        LEFT OUTER JOIN iptdiag        ON iptdiag.an  = ipt.an AND iptdiag.diagtype = '1'
        LEFT OUTER JOIN icd101 i1      ON i1.code     = SUBSTRING(iptdiag.icd10,1,3)
        LEFT OUTER JOIN an_stat aa     ON aa.an       = ipt.an
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an      = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt     ON ptt.pttype  = ip1.pttype
        LEFT OUTER JOIN doctor dt      ON dt.code     = ipt.admdoctor
        LEFT OUTER JOIN dchtype dc1    ON dc1.dchtype = ipt.dchtype
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1    ON dct1.code   = il1.doctor
        LEFT OUTER JOIN ipt_chart_location icl ON icl.an = ipt.an
        LEFT OUTER JOIN ipt_summary_status iss ON iss.ipt_summary_status_id = ipt.ipt_summary_status_id
      WHERE ipt.an LIKE ?
        AND ipt.confirm_discharge = 'Y'
      ORDER BY ipt.dchdate DESC LIMIT 50`,
      [qLike]);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/chart/find-hn', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });
    const qLike = `%${q}%`;
    const rows = await dbQuery(`
      SELECT ipt.an, ipt.hn,
             TO_CHAR(ipt.regdate, 'YYYY-MM-DD') AS regdate, ipt.regtime,
             TO_CHAR(ipt.dchdate, 'YYYY-MM-DD') AS dchdate,
             CAST(CONCAT(p.pname,p.fname,' ',p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(CONCAT(COALESCE(spclty.name,''),' - ',COALESCE(w.name,'')) AS VARCHAR(250)) AS spclty_ward_name,
             w.name AS ward_name, ipt.ward,
             iptdiag.icd10,
             CAST(CONCAT(COALESCE(iptdiag.icd10,''),' - ',COALESCE(i1.name,'')) AS VARCHAR(250)) AS icdname,
             ptt.name AS pttype_name, dt.name AS admdoctor_name,
             dc1.name AS dchtype_name, aa.age_y, aa.age_m, aa.age_d,
             aa.diag_text_list, NULL AS chart_receive_date,
             CASE WHEN ipt.an IN (SELECT an FROM ipt_chart_location WHERE chart_date IS NOT NULL)
               THEN 'Y' ELSE 'N' END AS chart_received,
             COALESCE(iss.ipt_summary_status_name, '') AS chart_status_name,
             '' AS chart_receive_staff, '' AS receiver_name,
             dct1.name AS incharge_doctor_name,
             (CURRENT_DATE::DATE - TO_DATE(TO_CHAR(ipt.dchdate,'YYYY-MM-DD'),'YYYY-MM-DD')) AS days_since_dch
      FROM ipt
        LEFT OUTER JOIN patient p      ON p.hn       = ipt.hn
        LEFT OUTER JOIN spclty         ON spclty.spclty = ipt.spclty
        LEFT OUTER JOIN ward w         ON w.ward      = ipt.ward
        LEFT OUTER JOIN iptdiag        ON iptdiag.an  = ipt.an AND iptdiag.diagtype = '1'
        LEFT OUTER JOIN icd101 i1      ON i1.code     = SUBSTRING(iptdiag.icd10,1,3)
        LEFT OUTER JOIN an_stat aa     ON aa.an       = ipt.an
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an      = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt     ON ptt.pttype  = ip1.pttype
        LEFT OUTER JOIN doctor dt      ON dt.code     = ipt.admdoctor
        LEFT OUTER JOIN dchtype dc1    ON dc1.dchtype = ipt.dchtype
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1    ON dct1.code   = il1.doctor
        LEFT OUTER JOIN ipt_chart_location icl ON icl.an = ipt.an
        LEFT OUTER JOIN ipt_summary_status iss ON iss.ipt_summary_status_id = ipt.ipt_summary_status_id
      WHERE ipt.hn LIKE ?
        AND ipt.confirm_discharge = 'Y'
      ORDER BY ipt.dchdate DESC LIMIT 50`,
      [qLike]);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

async function queryChartReceive({ from, to, ward, onlyReceived, notReceived, notSummarized }) {
  const wardFilter         = ward && ward !== 'ALL' ? `AND ipt.ward = ?` : '';
  const onlyReceivedFilter = onlyReceived === 'true'
    ? `AND ipt.an IN (SELECT an FROM ipt_chart_location WHERE chart_date IS NOT NULL)` : '';
  // ยังไม่ได้รับแฟ้ม: chart_date IS NULL หรือ ไม่มีใน ipt_chart_location เลย
  const notReceivedFilter  = notReceived === 'true'
    ? `AND (icl.chart_date IS NULL OR ipt.an NOT IN (SELECT an FROM ipt_chart_location))` : '';
  // ยังไม่สรุป: ไม่อยู่ใน ipt_chart_success_app
  const notSummarizedFilter = notSummarized === 'true'
    ? `AND ipt.an NOT IN (SELECT an FROM ipt_chart_success_app)` : '';
  // สรุปแล้ว: อยู่ใน ipt_chart_success_app
  const summarizedFilter = notSummarized === 'false' && onlyReceived !== 'true' && notReceived !== 'true'
    ? `AND ipt.an IN (SELECT an FROM ipt_chart_location WHERE chart_date IS NOT NULL)` : '';
  const params = [from, to];
  if (ward && ward !== 'ALL') params.push(ward);

  const sql = `
      SELECT ipt.an, ipt.hn,
             TO_CHAR(ipt.regdate, 'YYYY-MM-DD') AS regdate, ipt.regtime,
             TO_CHAR(ipt.dchdate, 'YYYY-MM-DD') AS dchdate,
             CAST(CONCAT(patient.pname,patient.fname,' ',patient.lname) AS VARCHAR(250)) AS patient_name,
             CAST(CONCAT(COALESCE(spclty.name,''),' - ',COALESCE(w.name,'')) AS VARCHAR(250)) AS spclty_ward_name,
             w.name AS ward_name, ipt.ward,
             iptdiag.icd10,
             CAST(CONCAT(COALESCE(iptdiag.icd10,''),' - ',COALESCE(i1.name,'')) AS VARCHAR(250)) AS icdname,
             ptt.name AS rtname, ptt.name AS pttype_name,
             dt.name AS admdoctor_name,
             dc1.name AS dchtype_name, dc2.name AS dchstts_name,
             aa.age_y, aa.age_m, aa.age_d,
             aa.diag_text_list, NULL AS chart_receive_date,
             CASE WHEN ipt.an IN (SELECT an FROM ipt_chart_location WHERE chart_date IS NOT NULL)
               THEN 'Y' ELSE 'N' END AS chart_received,
             COALESCE(iss.ipt_summary_status_name, '') AS chart_status_name,
             '' AS chart_receive_staff,
             '' AS receiver_name,
             dct1.name AS incharge_doctor_name,
             id1.confirm_final_summary, id1.confirm_audit_summary,
             iss.ipt_summary_status_name,
             it.ipt_coll_status_type_name,
             ss.status_name AS operation_status_name,
             drg.description AS drg_description,
             (CURRENT_DATE::DATE - TO_DATE(TO_CHAR(ipt.dchdate,'YYYY-MM-DD'),'YYYY-MM-DD')) AS days_since_dch
      FROM ipt
        LEFT OUTER JOIN spclty          ON spclty.spclty           = ipt.spclty
        LEFT OUTER JOIN iptadm          ON iptadm.an               = ipt.an
        LEFT OUTER JOIN patient         ON patient.hn              = ipt.hn
        LEFT OUTER JOIN doctor dt       ON dt.code                 = ipt.admdoctor
        LEFT OUTER JOIN iptdiag         ON iptdiag.an              = ipt.an AND iptdiag.diagtype = '1'
        LEFT OUTER JOIN icd101 i1       ON i1.code                 = SUBSTRING(iptdiag.icd10,1,3)
        LEFT OUTER JOIN an_stat aa      ON aa.an                   = ipt.an
        LEFT OUTER JOIN ward w          ON w.ward                  = ipt.ward
        LEFT OUTER JOIN dchtype dc1     ON dc1.dchtype             = ipt.dchtype
        LEFT OUTER JOIN dchstts dc2     ON dc2.dchstts             = ipt.dchstts
        LEFT OUTER JOIN ipt_finance_status fs ON fs.an             = ipt.an
        LEFT OUTER JOIN ipt_discharge id1     ON id1.an            = ipt.an
        LEFT OUTER JOIN ipt_pttype ip1  ON ip1.an                  = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt      ON ptt.pttype              = ip1.pttype
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an              = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1     ON dct1.code               = il1.doctor
        LEFT OUTER JOIN ipt_coll_stat ict     ON ict.an            = ipt.an
        LEFT OUTER JOIN ipt_coll_status_type it ON it.ipt_coll_status_type_id = ict.ipt_coll_status_type_id
        LEFT OUTER JOIN ipt_summary_status iss  ON iss.ipt_summary_status_id = ipt.ipt_summary_status_id
        LEFT OUTER JOIN drgmdc drg      ON drg.dg                  = ipt.drg
        LEFT OUTER JOIN operation_status ss ON ss.status_id        = ipt.operation_status_id
        LEFT OUTER JOIN ipt_chart_location icl ON icl.an           = ipt.an
      WHERE ipt.dchdate BETWEEN ? AND ?
        AND ipt.confirm_discharge = 'Y'
        ${onlyReceivedFilter}
        ${notReceivedFilter}
        ${notSummarizedFilter}
        ${summarizedFilter}
        ${wardFilter}
      ORDER BY ipt.regdate, ipt.regtime
      LIMIT 2000`;

  return dbQuery(sql, params);
}

app.get('/api/chart/receive', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, ward, onlyReceived, notReceived, notSummarized } = req.query;
    const from  = dateFrom || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const to    = dateTo   || new Date().toISOString().split('T')[0];
    const rows = await queryChartReceive({ from, to, ward, onlyReceived, notReceived, notSummarized });
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/chart/patients', requireAuth, async (req, res) => {
  try {
    const { mode, dateFrom, dateTo, ward, days } = req.query;
    const from = dateFrom || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const to   = dateTo   || new Date().toISOString().split('T')[0];

    if (mode === 'all') {
      const rows = await queryChartReceive({ from, to, ward, onlyReceived: 'false', notReceived: 'false' });
      return res.json({ success: true, data: rows });
    }

    let extraWhere = '';
    const params = [];

    if (mode === 'not_received') {
      // จำหน่ายแล้ว ยังไม่รับแฟ้ม
      extraWhere = `AND ipt.confirm_discharge = 'Y' AND 1=1`;
    } else if (mode === 'borrowed') {
      // รับแฟ้มแล้ว
      extraWhere = `AND 1=1`;
    } else if (mode === 'overdue') {
      // เกินกำหนด N วัน
      const n = parseInt(days) || 7;
      extraWhere = `AND ipt.confirm_discharge = 'Y' AND 1=1 AND CAST(ipt.dchdate AS DATE) < CURRENT_DATE - ${n}`;
    } else {
      // all — จำหน่ายแล้วทั้งหมด
      extraWhere = `AND ipt.confirm_discharge = 'Y'`;
    }

    if (ward && ward !== 'ALL') { extraWhere += ` AND ipt.ward = ?`; params.push(ward); }

    const sql = `
      SELECT ipt.an, ipt.hn, ipt.ward,
             CAST(ipt.regdate AS DATE) AS regdate, ipt.regtime,
             CAST(ipt.dchdate AS DATE) AS dchdate,
             CAST(CONCAT(p.pname, p.fname, ' ', p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(CONCAT(COALESCE(sp.name,''),' - ',COALESCE(w.name,'')) AS VARCHAR(250)) AS spclty_ward_name,
             w.name AS ward_name,
             ptt.name AS pttype_name,
             dct1.name AS incharge_doctor_name,
             icl.chart_date AS chart_receive_date,
             COALESCE(icl.staff,'') AS chart_receive_staff,
             '' AS receiver_login,
             COALESCE(o2.officer_name,'') AS receiver_name,
             aa.diag_text_list,
             (CURRENT_DATE::DATE - TO_DATE(TO_CHAR(ipt.dchdate,'YYYY-MM-DD'),'YYYY-MM-DD')) AS days_since_dch
      FROM ipt
        LEFT OUTER JOIN patient p      ON p.hn        = ipt.hn
        LEFT OUTER JOIN spclty sp      ON sp.spclty   = ipt.spclty
        LEFT OUTER JOIN ward w         ON w.ward       = ipt.ward
        LEFT OUTER JOIN an_stat aa     ON aa.an        = ipt.an
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an       = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt     ON ptt.pttype   = ip1.pttype
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an  = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1    ON dct1.code    = il1.doctor
        LEFT OUTER JOIN ipt_chart_location icl ON icl.an = ipt.an
        LEFT OUTER JOIN officer o2     ON o2.officer_login_name = icl.staff
      WHERE ipt.dchdate BETWEEN ? AND ?
        ${extraWhere}
      ORDER BY ipt.dchdate DESC, ipt.regdate DESC
      LIMIT 1000`;

    const rows = await dbQuery(sql, [from, to, ...params]);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ─── IPD Routes ───────────────────────────────────────────────────────────────

app.get('/api/ipd/wards', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT ward, name FROM ward ORDER BY name LIMIT 500`, []);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/ipd/patients', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, ward, confirmedOnly } = req.query;
    const from = dateFrom || new Date().toISOString().split('T')[0];
    const to   = dateTo   || new Date().toISOString().split('T')[0];

    // ถ้า confirmedOnly=true ใช้ filter confirm_discharge='Y'
    const dchFilter  = confirmedOnly === 'true' ? `AND ipt.confirm_discharge = 'Y'` : '';
    const wardFilter = ward && ward !== 'ALL'   ? `AND ipt.ward = ?` : '';
    const params     = ward && ward !== 'ALL'   ? [from, to, ward] : [from, to];

    const sql = `
      SELECT
        ipt.an, ipt.hn, ipt.regdate, ipt.regtime, ipt.dchdate, ipt.dchtime,
        ipt.ward, ipt.spclty, ipt.confirm_discharge,
        CAST(CONCAT(patient.pname, patient.fname, ' ', patient.lname) AS VARCHAR(250)) AS patient_name,
        CAST(CONCAT(COALESCE(spclty.name,''), ' - ', COALESCE(w.name,'')) AS VARCHAR(250)) AS spclty_ward_name,
        w.name AS ward_name,
        iptdiag.icd10,
        CAST(CONCAT(COALESCE(iptdiag.icd10,''), ' - ', COALESCE(i1.name,'')) AS VARCHAR(250)) AS icdname,
        ptt.name AS pttype_name,
        dc1.name AS dchtype_name,
        dt.name  AS admdoctor_name,
        dct1.name AS incharge_doctor_name,
        id1.confirm_final_summary,
        id1.confirm_audit_summary,
        aa.diag_text_list,
        aa.age_y, aa.age_m, aa.age_d
      FROM ipt
        LEFT OUTER JOIN patient        ON patient.hn       = ipt.hn
        LEFT OUTER JOIN spclty         ON spclty.spclty    = ipt.spclty
        LEFT OUTER JOIN ward w         ON w.ward           = ipt.ward
        LEFT OUTER JOIN iptdiag        ON iptdiag.an       = ipt.an AND iptdiag.diagtype = '1'
        LEFT OUTER JOIN icd101 i1      ON i1.code          = SUBSTRING(iptdiag.icd10, 1, 3)
        LEFT OUTER JOIN an_stat aa     ON aa.an            = ipt.an
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an           = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt     ON ptt.pttype       = ip1.pttype
        LEFT OUTER JOIN dchtype dc1    ON dc1.dchtype      = ipt.dchtype
        LEFT OUTER JOIN doctor dt      ON dt.code          = ipt.admdoctor
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an      = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1    ON dct1.code        = il1.doctor
        LEFT OUTER JOIN ipt_discharge id1 ON id1.an        = ipt.an
      WHERE ipt.dchdate BETWEEN ? AND ?
        ${dchFilter}
        ${wardFilter}
      ORDER BY ipt.dchdate, ipt.regdate, ipt.regtime
      LIMIT 2000`;

    const rows = await dbQuery(sql, params);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ─── IPD Diagnosis Routes ─────────────────────────────────────────────────────

app.get('/api/ipd/patient/:an', requireAuth, async (req, res) => {
  try {
    const { an } = req.params;
    const rows = await dbQuery(`
      SELECT ipt.an, ipt.hn, CAST(ipt.regdate AS DATE) AS regdate, ipt.regtime,
             CAST(ipt.dchdate AS DATE) AS dchdate, ipt.dchtime,
             CAST(CONCAT(p.pname, p.fname, ' ', p.lname) AS VARCHAR(250)) AS patient_name,
             CAST(CONCAT(COALESCE(sp.name,''), ' - ', COALESCE(w.name,'')) AS VARCHAR(250)) AS spclty_ward_name,
             w.name AS ward_name, sp.name AS spclty_name,
             ptt.name AS pttype_name,
             dt.name  AS admdoctor_name,
             dct1.name AS incharge_doctor_name,
             COALESCE(il1.doctor,'') AS incharge_doctor_code,
             COALESCE(dct1.licenseno,'') AS incharge_doctor_licenseno,
             aa.diag_text_list,
             aa.age_y, aa.age_m, aa.age_d,
             aa.admdate,
             id1.confirm_final_summary
      FROM ipt
        LEFT OUTER JOIN patient p      ON p.hn           = ipt.hn
        LEFT OUTER JOIN spclty sp      ON sp.spclty       = ipt.spclty
        LEFT OUTER JOIN ward w         ON w.ward          = ipt.ward
        LEFT OUTER JOIN an_stat aa     ON aa.an           = ipt.an
        LEFT OUTER JOIN ipt_pttype ip1 ON ip1.an          = ipt.an AND ip1.pttype_number = 1
        LEFT OUTER JOIN pttype ptt     ON ptt.pttype      = ip1.pttype
        LEFT OUTER JOIN doctor dt      ON dt.code         = ipt.admdoctor
        LEFT OUTER JOIN ipt_doctor_list il1 ON il1.an     = ipt.an AND il1.ipt_doctor_type_id = 1 AND il1.active_doctor = 'Y'
        LEFT OUTER JOIN doctor dct1    ON dct1.code       = il1.doctor
        LEFT OUTER JOIN ipt_discharge id1 ON id1.an       = ipt.an
      WHERE ipt.an = ? LIMIT 1`, [an]);

    const row = rows[0] || null;
    if (row) {
      // คำนวณ LOS ใน Node.js — pg คืน date เป็น string, mysql2 คืนเป็น Date object
      const toDay = v => {
        if (!v) return null;
        const s = (v instanceof Date) ? v.toISOString() : String(v);
        const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
      };
      const adm = toDay(row.admdate);
      const dch = toDay(row.dchdate);
      row.los = (adm && dch) ? Math.round((dch - adm) / 86400000) : null;
    }
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[ipd/patient] ERROR:', e.message);
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/ipd/diagnosis/:an', requireAuth, async (req, res) => {
  try {
    const { an } = req.params;
    const rows = await dbQuery(`
      SELECT id.an, id.icd10, i.name AS icd10_name, id.diagtype,
             COALESCE(id.doctor, '') AS doctor_code,
             COALESCE(id.dx_guid, '') AS dx_guid
      FROM iptdiag id
        LEFT OUTER JOIN icd101 i ON i.code = id.icd10
      WHERE id.an = ?
        AND id.icd10 NOT BETWEEN '0' AND '99999'
      ORDER BY id.diagtype, id.icd10`, [an]);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/api/ipd/diagnosis', requireAuth, async (req, res) => {
  try {
    const { an, diagnoses, doctor_code, confirmed, procedures } = req.body;
    if (!an || !diagnoses || !Array.isArray(diagnoses))
      return res.json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });

    const loginName = req.user.officer_login_name || '';

    // รันทั้งหมดใน transaction เดียว: ถ้า INSERT ใดล้มเหลว จะ ROLLBACK การ DELETE ด้วย
    // ป้องกันไม่ให้ข้อมูลเดิมของ an นี้ถูกลบทิ้งโดยไม่มีข้อมูลใหม่มาแทน (บทเรียนจากฝั่ง OPD)
    await withTransaction(async (query) => {
      // ลบ ICD10 เดิมที่ไม่ใช่ตัวเลข (logic เดิม ไม่เปลี่ยนแปลง)
      await query(`DELETE FROM iptdiag WHERE an = ? AND icd10 NOT BETWEEN '0' AND '99999'`, [an]);

      for (const dx of diagnoses) {
        const { icd10, diagtype } = dx;
        let saved = false;

        // Level 1: ใช้ get_serialnumber + NOW() สำหรับ timestamp
        try {
          await query(`
            INSERT INTO iptdiag (
              ipt_diag_id, an, diagtype, doctor, icd10, staff,
              hn, entry_datetime, modify_datetime, dx_guid, hos_guid
            )
            SELECT
              get_serialnumber('ipt_diag_id'),
              ipt.an, ?, ?, ?, ?,
              ipt.hn,
              NOW(), NOW(),
              'Y', ?
            FROM ipt WHERE ipt.an = ?`,
            [diagtype, doctor_code||'', icd10, loginName, loginName, an]);
          saved = true;
          console.log(`[ipd] L1 OK ${icd10}`);
        } catch (e1) {
          console.log('[ipd] L1:', e1.message);
        }

        // Level 2: NOW() ไม่มี entry_datetime/modify_datetime
        if (!saved) {
          try {
            await query(`
              INSERT INTO iptdiag (
                ipt_diag_id, an, diagtype, doctor, icd10, staff, hn, dx_guid, hos_guid
              )
              SELECT
                get_serialnumber('ipt_diag_id'),
                ipt.an, ?, ?, ?, ?,
                ipt.hn, 'Y', ?
              FROM ipt WHERE ipt.an = ?`,
              [diagtype, doctor_code||'', icd10, loginName, loginName, an]);
            saved = true;
            console.log(`[ipd] L2 OK ${icd10}`);
          } catch (e2) {
            console.log('[ipd] L2:', e2.message);
          }
        }

        // Level 3: minimal — ipt_diag_id + an + icd10 + diagtype
        if (!saved) {
          try {
            await query(`
              INSERT INTO iptdiag (ipt_diag_id, an, diagtype, doctor, icd10, staff, hn)
              SELECT get_serialnumber('ipt_diag_id'), ipt.an, ?, ?, ?, ?, ipt.hn
              FROM ipt WHERE ipt.an = ?`,
              [diagtype, doctor_code||'', icd10, loginName, an]);
            saved = true;
            console.log(`[ipd] L3 OK ${icd10}`);
          } catch (e3) {
            console.log('[ipd] L3:', e3.message);
          }
        }

        if (!saved) console.log(`[ipd] ALL FAILED for ${icd10}`);
      }

      // ── บันทึก ICD9CM ลง iptdiag ─────────────────────────────────────────────
      // หมายเหตุ: คอลัมน์ ipt_oper_type / ext_code เป็นการเดาตาม ovstdiag ฝั่ง OPD
      // รอ query จริงจากผู้ใช้
      if (Array.isArray(procedures) && procedures.length > 0) {
        for (const proc of procedures) {
          const { icd9cm, oper_type: operTypeName, ext_code, doctor_raw } = proc;

          let operTypeCode = null;
          if (operTypeName) {
            const otRows = await query(
              `SELECT oper_type AS code FROM oper_type WHERE name = ? LIMIT 1`, [operTypeName]);
            if (otRows.length) operTypeCode = otRows[0].code;
          }

          await query(`
            INSERT INTO iptdiag (
              ipt_diag_id, an, diagtype, doctor, icd10, staff,
              hn, entry_datetime, modify_datetime,
              ipt_oper_type, ext_code
            )
            SELECT
              get_serialnumber('ipt_diag_id'),
              ipt.an, 2, ?, ?, ?,
              ipt.hn, NOW(), NOW(),
              ?, ?
            FROM ipt WHERE ipt.an = ?`,
            [doctor_raw || '', icd9cm, loginName,
             operTypeCode, ext_code || '',
             an]);
          console.log(`[ipd save icd9cm] OK ${icd9cm}`);
        }
      }

      // อัปเดต PDX ใน an_stat
      if (diagnoses.length > 0) {
        const primary = diagnoses.find(d => parseInt(d.diagtype) === 1) || diagnoses[0];
        await query(`UPDATE an_stat SET pdx = ? WHERE an = ?`, [primary.icd10, an]);
      }
    });

    res.json({ success: true, message: 'บันทึกการวินิจฉัย IPD สำเร็จ' });
  } catch (e) {
    console.log('[ipd save diagnosis] ROLLBACK:', e.message);
    res.json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/hospital', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT hospitalname FROM opdconfig LIMIT 1`, []);
    const name = rows.length ? (rows[0].hospitalname || rows[0].HOSPITALNAME || Object.values(rows[0])[0] || '') : '';
    res.json({ success: true, hospitalname: name });
  } catch (e) {
    res.json({ success: false, hospitalname: '', message: e.message });
  }
});

app.get('/api/patients', requireAuth, async (req, res) => {
  try {
    const _dn = new Date();
    const today    = `${_dn.getFullYear()}-${String(_dn.getMonth()+1).padStart(2,'0')}-${String(_dn.getDate()).padStart(2,'0')}`;
    const dateFrom = req.query.dateFrom || req.query.date || today;
    const dateTo   = req.query.dateTo   || req.query.date || dateFrom;
    console.log('[/api/patients] query received:', req.query, '-> dateFrom:', dateFrom, 'dateTo:', dateTo);
    const sql = `
      SELECT o.vstdate
        ,o.vsttime
        ,o.vn
        ,oi.name as ovstist
        ,oo.name as ovstost
        ,o.hn
        ,concat(p.pname,p.fname,'  ',p.lname) as ptname
        ,concat(v.age_y,' ','ปี',' ',v.age_m,' ','ด',' ',v.age_d,' ','ว') as age
        ,v.pdx
        ,concat(d.code,'-',d.name,'(',d.licenseno,')') as doctor
        ,oq.dx_text_list
        ,s.name as spclty
        ,k.department
        ,(case when string_agg(oc.cc,',') is null then 'ไม่ได้ลง CC' else string_agg(oc.cc,',') end) as cc
        ,(case when string_agg(dp.pe,',') is null then 'ไม่ได้ลง PE' else string_agg(dp.pe,',') end) as pe
        ,pt.name as pttype
      FROM ovst o
      left outer join ovstist oi on oi.ovstist=o.ovstist
      left outer join ovstost oo on oo.ovstost=o.ovstost
      left outer join patient p on p.hn=o.hn
      left outer join vn_stat v on v.vn=o.vn
      left outer join doctor d on d.code=o.doctor
      left outer join ovst_seq oq on oq.vn=o.vn
      left outer join spclty s on s.spclty=o.spclty
      left outer join kskdepartment k on k.depcode=o.main_dep
      left outer join opdscreen_cc_list oc on oc.vn=o.vn
      left outer join opdscreen_doctor_pe dp on dp.vn=o.vn
      left outer join pttype pt on pt.pttype=o.pttype
      WHERE o.vstdate BETWEEN ? AND ?
      group by o.vstdate,o.vsttime,o.vn,oi.name,oo.name,o.hn,v.pdx,d.name,oq.dx_text_list
        ,s.name,k.department,concat(p.pname,p.fname,'  ',p.lname)
        ,concat(v.age_y,' ','ปี',' ',v.age_m,' ','ด',' ',v.age_d,' ','ว'),d.code,pt.name
      ORDER BY o.vstdate, o.vsttime
    `;
    const rows = await dbQuery(sql, [dateFrom, dateTo]);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/patient/:vn', requireAuth, async (req, res) => {
  try {
    const { vn } = req.params;
    const sql = `
      SELECT o.vstdate,
        o.vsttime,
        o.vn,
        o.hn,
        concat(p.pname,p.fname,'  ',p.lname) as ptname,
        concat(v.age_y,' ','ปี',' ',v.age_m,' ','ด',' ',v.age_d,' ','ว') as age,
        v.pdx,
        concat(d.code,'-',d.name,'(',d.licenseno,')') as doctor,
        oq.dx_text_list,
        oq.doctor_list_text,
        s.spclty as spclty_code,
        s.name as spclty_name,
        k.department as main_dep,
        t.name as pttype_name,
        o.pttypeno,
        (case when string_agg(oc.cc,',') is null then '' else string_agg(oc.cc,',') end) as cc,
        (case when string_agg(dp.pe,',') is null then '' else string_agg(dp.pe,',') end) as pe,
        pt.name as pttype
      FROM ovst o
      left outer join patient p on p.hn=o.hn
      left outer join vn_stat v on v.vn=o.vn
      left outer join doctor d on d.code=o.doctor
      left outer join ovst_seq oq on oq.vn=o.vn
      left outer join spclty s on s.spclty=o.spclty
      left outer join kskdepartment k on k.depcode=o.main_dep
      left outer join pttype t on t.pttype=o.pttype
      left outer join opdscreen_cc_list oc on oc.vn=o.vn
      left outer join opdscreen_doctor_pe dp on dp.vn=o.vn
      left outer join pttype pt on pt.pttype=o.pttype
      WHERE o.vn = ?
      group by o.vstdate,o.vsttime,o.vn,o.hn,v.pdx,
        d.code,d.name,d.licenseno,oq.dx_text_list,oq.doctor_list_text,
        s.spclty,s.name,k.department,t.name,o.pttypeno,pt.name,
        concat(p.pname,p.fname,'  ',p.lname),
        concat(v.age_y,' ','ปี',' ',v.age_m,' ','ด',' ',v.age_d,' ','ว')
    `;
    const rows = await dbQuery(sql, [vn]);
    res.json({ success: true, data: rows[0] || null });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/icd10/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, data: [] });
    const qUpper = q.toUpperCase();
    const rows = await dbQuery(
      `SELECT code, name FROM icd101 WHERE UPPER(code) LIKE ? OR name LIKE ? ORDER BY code LIMIT 30`,
      [`${qUpper}%`, `%${q}%`]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/doctor/:vn', requireAuth, async (req, res) => {
  try {
    const { vn } = req.params;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    let rows = [];

    // ดึงจาก ovstdiag.doctor ก่อน (ถ้าเคยบันทึกแล้ว)
    try {
      rows = await dbQuery(
        `SELECT od.doctor AS code, d.name, COALESCE(d.licenseno,'') AS licenseno
         FROM ovstdiag od
           LEFT OUTER JOIN doctor d ON d.code = od.doctor
         WHERE od.vn = ? AND od.doctor IS NOT NULL AND od.doctor <> ''
         LIMIT 1`,
        [vn]
      );
    } catch (_) {}

    // fallback: ดึงจาก ovst.doctor
    if (!rows.length) {
      try {
        rows = await dbQuery(
          `SELECT d.code, d.name, COALESCE(d.licenseno,'') AS licenseno
           FROM ovst o LEFT OUTER JOIN doctor d ON d.code = o.doctor
           WHERE o.vstdate BETWEEN ? AND ? AND o.vn = ?`,
          [date, date, vn]
        );
      } catch (_) {}
    }

    const r = rows[0] || null;
    if (r) r.doctor_name = `${r.code}-${r.name}(${r.licenseno})`;
    res.json({ success: true, data: r });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Real-time doctor search จาก DB โดยตรง
app.get('/api/doctors/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ success: true, data: [] });
  const like = `%${q}%`;
  try {
    let rows = [];
    // ลำดับ fallback: active='Y' → inactive=0 → ไม่มี filter (ทุกคน)
    try {
      rows = await dbQuery(
        `SELECT code, name, COALESCE(licenseno,'') AS licenseno FROM doctor
         WHERE active = 'Y' AND (name LIKE ? OR licenseno LIKE ? OR code LIKE ?)
         ORDER BY name LIMIT 40`,
        [like, like, like]
      );
    } catch (_) {}

    if (!rows.length) {
      try {
        rows = await dbQuery(
          `SELECT code, name, COALESCE(licenseno,'') AS licenseno FROM doctor
           WHERE inactive = 0 AND (name LIKE ? OR licenseno LIKE ? OR code LIKE ?)
           ORDER BY name LIMIT 40`,
          [like, like, like]
        );
      } catch (_) {}
    }

    if (!rows.length) {
      rows = await dbQuery(
        `SELECT code, name, COALESCE(licenseno,'') AS licenseno FROM doctor
         WHERE (name LIKE ? OR licenseno LIKE ? OR code LIKE ?)
         ORDER BY name LIMIT 40`,
        [like, like, like]
      );
    }

    res.json({ success: true, data: rows.map(d => ({
      code:        d.code,
      name:        d.name,
      licenseno:   d.licenseno || '',
      doctor_name: `${d.code}-${d.name}(${d.licenseno || ''})`,
    }))});
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/doctors', requireAuth, async (req, res) => {
  try {
    let rows = [];
    try {
      rows = await dbQuery(
        `SELECT code, name, COALESCE(licenseno,'') AS licenseno FROM doctor WHERE active = 'Y' ORDER BY name LIMIT 1000`,
        []
      );
    } catch (_) {
      try {
        rows = await dbQuery(
          `SELECT code, name, COALESCE(licenseno,'') AS licenseno FROM doctor WHERE inactive = 0 ORDER BY name LIMIT 1000`,
          []
        );
      } catch (__) {
        rows = await dbQuery(
          `SELECT code, name, COALESCE(licenseno,'') AS licenseno FROM doctor ORDER BY name LIMIT 1000`,
          []
        );
      }
    }
    res.json({ success: true, data: rows.map(d => ({
      code:        d.code,
      name:        d.name,
      licenseno:   d.licenseno || '',
      doctor_name: `${d.code}-${d.name}(${d.licenseno || ''})`,
    }))});
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/diagnosis/:vn', requireAuth, async (req, res) => {
  try {
    const { vn } = req.params;
    let rows = [];
    try {
      // ovstdiag ใช้คอลัมน์ doctor (ไม่ใช่ doctor_code)
      rows = await dbQuery(
        `SELECT od.vn, od.icd10, i.name AS icd10_name, od.diagtype,
                od.doctor AS doctor_code,
                CONCAT(d.code,'-',d.name,'(',COALESCE(d.licenseno,''),')') AS doctor_name,
                od.confirm
         FROM ovstdiag od
           LEFT OUTER JOIN icd101 i ON i.code = od.icd10
           LEFT OUTER JOIN doctor d ON d.code = od.doctor
         WHERE od.vn = ?
           AND od.icd10 NOT BETWEEN '0' AND '99999'
         ORDER BY od.diagtype, od.icd10`,
        [vn]
      );
      console.log(`[diagnosis GET] ovstdiag vn=${vn} rows=${rows.length}`);
    } catch (e1) {
      console.log(`[diagnosis GET] ovstdiag error: ${e1.message}`);
      try {
        rows = await dbQuery(
          `SELECT od.vn, od.icd10, i.name AS icd10_name, od.diagtype,
                  od.doctor_code, d.name AS doctor_name
           FROM ovst_dx od
             LEFT OUTER JOIN icd101 i ON i.code = od.icd10
             LEFT OUTER JOIN doctor d ON d.code = od.doctor_code
           WHERE od.vn = ?
           ORDER BY od.diagtype, od.icd10`,
          [vn]
        );
        console.log(`[diagnosis GET] ovst_dx vn=${vn} rows=${rows.length}`);
      } catch (e2) {
        console.log(`[diagnosis GET] ovst_dx error: ${e2.message}`);
      }
    }
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ดึงรายการวินิจฉัยจากแพทย์ (doctor_diag)
app.get('/api/doctor-diagnosis/:vn', requireAuth, async (req, res) => {
  try {
    const { vn } = req.params;
    let rows = [];
    try {
      rows = await dbQuery(
        `SELECT odd.diag_text, d.name AS doctor_name, odd.diag_datetime
         FROM ovst_doctor_diag odd
           LEFT OUTER JOIN doctor d ON d.code = odd.doctor_code
         WHERE odd.vn = ?
         ORDER BY odd.diag_datetime DESC`,
        [vn]
      );
      console.log(`[doctor-diagnosis GET] vn=${vn} rows=${rows.length}`);
    } catch (e1) {
      console.log(`[doctor-diagnosis GET] error: ${e1.message}`);
    }
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/diagtypes', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT diagtype AS code, concat(diagtype,'-',name) AS name
       FROM diagtype
       WHERE (hos_guid = 'Y' OR hos_guid IS NULL)
       ORDER BY diagtype`
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/api/diagnosis', requireAuth, async (req, res) => {
  try {
    const { vn, diagnoses, doctor_code, confirmed, procedures } = req.body;
    if (!vn || !diagnoses || !Array.isArray(diagnoses)) {
      return res.json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const loginName   = req.user.officer_login_name || '';
    const officerName = req.user.officer_name || loginName;
    const confirmVal  = confirmed ? 'Y' : '';

    // รันทั้งหมดใน transaction เดียว: ถ้า INSERT ใดล้มเหลว จะ ROLLBACK การ DELETE ด้วย
    // ป้องกันไม่ให้ข้อมูลเดิมของ vn นี้ถูกลบทิ้งโดยไม่มีข้อมูลใหม่มาแทน
    await withTransaction(async (query) => {
      // ลบข้อมูลเดิมของ vn นี้ก่อน (ICD10 + ICD9CM)
      await query(`DELETE FROM ovstdiag WHERE vn = ?`, [vn]);

      // ── บันทึก ICD10 ────────────────────────────────────────────────────────
      for (const dx of diagnoses) {
        const { icd10, diagtype } = dx;
        try {
          await query(
            `INSERT INTO ovstdiag
               (ovst_diag_id, vn, hn, vstdate, vsttime,
                dx_guid, confirm, confirm_staff,
                icd10, diagtype, icd103, doctor, staff, update_datetime)
             SELECT
               get_serialnumber('ovst_diag_id'),
               v.vn, v.hn, v.vstdate, v.vsttime,
               'approve', ?, ?,
               ?, ?,
               COALESCE(i.code3, ''),
               ?, ?, CURRENT_TIMESTAMP
             FROM ovst v
             LEFT OUTER JOIN icd101 i ON i.code = ?
             WHERE v.vn = ?`,
            [confirmVal, officerName,
             icd10, diagtype,
             doctor_code || '', loginName,
             icd10, vn]
          );
        } catch (e1) {
          console.log('[save icd10] L1:', e1.message);
          await query(
            `INSERT INTO ovstdiag
               (vn, hn, vstdate, vsttime,
                dx_guid, confirm, confirm_staff,
                icd10, diagtype, icd103, doctor, staff, update_datetime)
             SELECT
               v.vn, v.hn, v.vstdate, v.vsttime,
               'approve', ?, ?,
               ?, ?,
               COALESCE(i.code3, ''),
               ?, ?, CURRENT_TIMESTAMP
             FROM ovst v
             LEFT OUTER JOIN icd101 i ON i.code = ?
             WHERE v.vn = ?`,
            [confirmVal, officerName,
             icd10, diagtype,
             doctor_code || '', loginName,
             icd10, vn]
          );
        }
      }

      // ── บันทึก ICD9CM ลง ovstdiag ───────────────────────────────────────────
      if (Array.isArray(procedures) && procedures.length > 0) {
        for (const proc of procedures) {
          const { icd9cm, oper_type: operTypeName, ext_code, doctor_raw } = proc;

          // lookup oper_type.oper_type (รหัส integer) จากชื่อที่เลือก
          // หมายเหตุ: ตาราง oper_type มีคอลัมน์ oper_type(id) กับ name เท่านั้น ไม่มี code
          let operTypeCode = null;
          if (operTypeName) {
            const otRows = await query(
              `SELECT oper_type AS code FROM oper_type WHERE name = ? LIMIT 1`, [operTypeName]);
            if (otRows.length) operTypeCode = otRows[0].code;
          }

          // ovst_diag_id = MAX(ovst_diag_id)+1, diagtype = 2, update_datetime = เวลาปัจจุบัน
          await query(
            `INSERT INTO ovstdiag
               (ovst_diag_id, vn, hn, vstdate, vsttime,
                icd10, diagtype, doctor, staff, update_datetime,
                ovst_oper_type, ext_code)
             SELECT
               (SELECT COALESCE(MAX(ovst_diag_id),0)+1 FROM ovstdiag),
               v.vn, v.hn, v.vstdate, v.vsttime,
               ?, 2, ?, ?, CURRENT_TIMESTAMP,
               ?, ?
             FROM ovst v WHERE v.vn = ?`,
            [icd9cm, doctor_raw || '', loginName,
             operTypeCode, ext_code || '',
             vn]
          );
          console.log(`[save icd9cm] OK ${icd9cm}`);
        }
      }

      // อัปเดต PDX ใน vn_stat
      if (diagnoses.length > 0) {
        const primary = diagnoses.find(d => parseInt(d.diagtype) === 1) || diagnoses[0];
        await query('UPDATE vn_stat SET pdx = ? WHERE vn = ?', [primary.icd10, vn]);
      }
    });

    res.json({ success: true, message: 'บันทึกการวินิจฉัยสำเร็จ' });
  } catch (error) {
    console.log('[save diagnosis] ROLLBACK:', error.message);
    res.json({ success: false, message: error.message });
  }
});

app.delete('/api/diagnosis/:vn/:icd10', requireAuth, async (req, res) => {
  try {
    const { vn, icd10 } = req.params;
    try { await dbQuery('DELETE FROM ovstdiag WHERE vn = ? AND icd10 = ?', [vn, icd10]); }
    catch (_) { await dbQuery('DELETE FROM ovst_dx WHERE vn = ? AND icd10 = ?', [vn, icd10]); }
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ─── ICD9CM Routes ────────────────────────────────────────────────────────────

app.get('/api/icd9cm/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, data: [] });
    const qUpper = q.toUpperCase();
    const rows = await dbQuery(
      `SELECT code, name FROM icd9cm1 WHERE UPPER(code) LIKE ? OR name LIKE ? ORDER BY code LIMIT 30`,
      [`${qUpper}%`, `%${q}%`]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, data: [], message: error.message });
  }
});

app.get('/api/oper-types', requireAuth, async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT name FROM oper_type ORDER BY name`, []);
    res.json({ success: true, data: rows });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/ovst-doctor/:vn', requireAuth, async (req, res) => {
  try {
    const { vn } = req.params;
    let rows = [];
    try {
      rows = await dbQuery(
        `SELECT o.doctor AS doctor_raw,
                COALESCE(d.name, '') AS doctor_name
         FROM ovst o
           LEFT OUTER JOIN doctor d ON d.code = o.doctor
         WHERE o.vn = ? LIMIT 1`,
        [vn]
      );
    } catch (_) {
      rows = await dbQuery(
        `SELECT doctor AS doctor_raw, '' AS doctor_name FROM ovst WHERE vn = ? LIMIT 1`,
        [vn]
      );
    }
    res.json({ success: true, data: rows[0] || null });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/icd9cm/:vn', requireAuth, async (req, res) => {
  try {
    const { vn } = req.params;
    let rows = [];
    try {
      rows = await dbQuery(
        `SELECT od.icd10 AS icd9cm, i.name AS icd9cm_name,
                ot.name AS oper_type, ot.name AS oper_type_name,
                od.ext_code, od.doctor AS doctor_raw
         FROM ovstdiag od
           LEFT OUTER JOIN icd9cm1 i    ON i.code        = od.icd10
           LEFT OUTER JOIN oper_type ot ON ot.oper_type  = od.ovst_oper_type
         WHERE od.vn = ?
           AND od.icd10 BETWEEN '0' AND '99999'
         ORDER BY od.icd10`,
        [vn]
      );
    } catch (e1) {
      console.log('[icd9cm GET] error:', e1.message);
    }
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ─── ICD9CM (IPD) ──────────────────────────────────────────────────────────────
// หมายเหตุ: ชื่อคอลัมน์ ipt_oper_type / ext_code ใน iptdiag เป็นการเดาตามรูปแบบของ
// ovstdiag (ฝั่ง OPD) — รอ query จริงจากผู้ใช้เพื่อแก้ไขให้ตรงกับ schema จริง
app.get('/api/ipd/icd9cm/:an', requireAuth, async (req, res) => {
  try {
    const { an } = req.params;
    let rows = [];
    try {
      rows = await dbQuery(
        `SELECT id.icd10 AS icd9cm, i.name AS icd9cm_name,
                ot.name AS oper_type, ot.name AS oper_type_name,
                id.ext_code, id.doctor AS doctor_raw
         FROM iptdiag id
           LEFT OUTER JOIN icd9cm1 i    ON i.code        = id.icd10
           LEFT OUTER JOIN oper_type ot ON ot.oper_type  = id.ipt_oper_type
         WHERE id.an = ?
           AND id.icd10 BETWEEN '0' AND '99999'
         ORDER BY id.icd10`,
        [an]
      );
    } catch (e1) {
      console.log('[ipd icd9cm GET] error:', e1.message);
    }
    res.json({ success: true, data: rows });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/ipd/admit-doctor/:an', requireAuth, async (req, res) => {
  try {
    const { an } = req.params;
    let rows = [];
    try {
      rows = await dbQuery(
        `SELECT ipt.admdoctor AS doctor_raw,
                COALESCE(d.name, '') AS doctor_name
         FROM ipt
           LEFT OUTER JOIN doctor d ON d.code = ipt.admdoctor
         WHERE ipt.an = ? LIMIT 1`,
        [an]
      );
    } catch (e1) {
      console.log('[ipd admit-doctor GET] error:', e1.message);
    }
    res.json({ success: true, data: rows[0] || null });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/api/icd9cm', requireAuth, async (req, res) => {
  try {
    const { vn, procedures } = req.body;
    if (!vn || !Array.isArray(procedures)) {
      return res.json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
    }
    const loginName = req.user.officer_login_name || '';

    try { await dbQuery(`DELETE FROM ovstoper WHERE vn = ?`, [vn]); } catch (_) {}

    for (const proc of procedures) {
      const { icd9cm, oper_type, ext_code, doctor_code } = proc;
      let saved = false;

      try {
        await dbQuery(`
          INSERT INTO ovstoper
            (ovstoper_id, vn, hn, vstdate, vsttime,
             icd9cm, oper_type, ext_code, doctor, staff, hos_guid)
          SELECT
            get_serialnumber('ovstoper_id'),
            v.vn, v.hn, v.vstdate, v.vsttime,
            ?, ?, ?, ?, ?, 'approve'
          FROM ovst v WHERE v.vn = ?`,
          [icd9cm, oper_type || '', ext_code || '', doctor_code || '', loginName, vn]
        );
        saved = true;
        console.log(`[icd9cm] L1 OK ${icd9cm}`);
      } catch (e1) {
        console.log('[icd9cm] L1:', e1.message);
      }

      if (!saved) {
        try {
          await dbQuery(`
            INSERT INTO ovstoper (vn, hn, vstdate, vsttime, icd9cm, oper_type, ext_code, doctor, staff)
            SELECT v.vn, v.hn, v.vstdate, v.vsttime, ?, ?, ?, ?, ?
            FROM ovst v WHERE v.vn = ?`,
            [icd9cm, oper_type || '', ext_code || '', doctor_code || '', loginName, vn]
          );
          saved = true;
          console.log(`[icd9cm] L2 OK ${icd9cm}`);
        } catch (e2) {
          console.log('[icd9cm] L2:', e2.message);
        }
      }

      if (!saved) {
        try {
          await dbQuery(`INSERT INTO ovstoper (vn, icd9cm, oper_type, ext_code, doctor, staff) VALUES (?,?,?,?,?,?)`,
            [vn, icd9cm, oper_type || '', ext_code || '', doctor_code || '', loginName]
          );
          saved = true;
          console.log(`[icd9cm] L3 OK ${icd9cm}`);
        } catch (e3) {
          console.log('[icd9cm] L3:', e3.message);
        }
      }

      if (!saved) console.log(`[icd9cm] ALL FAILED for ${icd9cm}`);
    }

    res.json({ success: true, message: 'บันทึก ICD9CM สำเร็จ' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ─── Static & Page Routes ─────────────────────────────────────────────────────

// Serve root → login
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// All other static assets
app.use(express.static(path.join(__dirname, 'public')));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n=================================`);
  console.log(` ระบบลงวินิจฉัย ICD10`);
  console.log(` http://localhost:${PORT}`);
  console.log(`=================================\n`);
});
