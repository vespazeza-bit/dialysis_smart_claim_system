const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');
const mysql = require('mysql2/promise');

const PORT = 8765;

// Load MySQL config from db-config.json (reload on each write so changes take effect without restart)
function loadDbConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'db-config.json'), 'utf8');
    return JSON.parse(raw);
  } catch(e) {
    return null;
  }
}

let pool = null;
function getPool() {
  const cfg = loadDbConfig();
  if (!cfg || !cfg.host || !cfg.user || !cfg.database) return null;
  if (!pool) {
    pool = mysql.createPool({
      host:     cfg.host,
      port:     cfg.port || 3306,
      user:     cfg.user,
      password: cfg.password || '',
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 5,
    });
    console.log(`[mysql] pool created → ${cfg.user}@${cfg.host}:${cfg.port||3306}/${cfg.database}`);
  }
  return pool;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-BMS-Target,X-BMS-Auth');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /login.html  serve login.html from parent directory ─────────────────────
  if (req.url === '/login.html' || req.url === '/login') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(404); res.end('login.html not found at ' + path.join(__dirname, '..', 'login.html'));
    }
    return;
  }

  // ── /dmis_main.html  serve dmis_main.html from parent directory ──────────────
  if (req.url === '/dmis_main.html' || req.url.startsWith('/dmis_main.html?')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'dmis_main.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(404); res.end('dmis_main.html not found at ' + path.join(__dirname, '..', 'dmis_main.html'));
    }
    return;
  }

  // ── /get-config  return current db-config (password masked) ─────────────────
  if (req.url === '/get-config') {
    const cfg = loadDbConfig() || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ host: cfg.host||'', port: cfg.port||3306, user: cfg.user||'', database: cfg.database||'', hasPassword: !!(cfg.password) }));
    return;
  }

  // ── /test-config  test connection without saving ──────────────────────────
  if (req.url === '/test-config') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      const body   = await readBody(req);
      const params = new URLSearchParams(body);
      const cfg = { host: params.get('host')||'localhost', port: parseInt(params.get('port'))||3306, user: params.get('user')||'', password: params.get('password')||'', database: params.get('database')||'' };
      const conn = await mysql.createConnection(cfg);
      await conn.query('SELECT 1');
      await conn.end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: `เชื่อมต่อสำเร็จ (${cfg.user}@${cfg.host}/${cfg.database})` }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return;
  }

  // ── /save-config  save credentials to db-config.json & reset pool ─────────
  if (req.url === '/save-config') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      const body   = await readBody(req);
      const params = new URLSearchParams(body);
      const cfg = { host: params.get('host')||'localhost', port: parseInt(params.get('port'))||3306, user: params.get('user')||'', password: params.get('password')||'', database: params.get('database')||'' };
      fs.writeFileSync(path.join(__dirname, 'db-config.json'), JSON.stringify(cfg, null, 2), 'utf8');
      if (pool) { try { await pool.end(); } catch{} pool = null; }  // reset pool so next request uses new config
      console.log(`[config] saved → ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return;
  }

  // ── /api/login  local credentials for DMIS login page ──────────────────────
  if (req.url === '/api/login') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      const body   = await readBody(req);
      let parsed   = {};
      try { parsed = JSON.parse(body); } catch {}
      const { username, password, mode } = parsed;

      // load login config (or use defaults)
      let loginCfg = { username: 'admin', password: 'dmis2569', dmisUrl: '' };
      try {
        const raw = fs.readFileSync(path.join(__dirname, 'login-config.json'), 'utf8');
        Object.assign(loginCfg, JSON.parse(raw));
      } catch {}

      if (username === loginCfg.username && password === loginCfg.password) {
        const dmisUrl = loginCfg.dmisUrl || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, username, mode: mode||'', redirect: dmisUrl || '/dmis_main' }));
        console.log(`[login] ${username} OK → ${dmisUrl || '/dmis_main'}`);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' }));
        console.log(`[login] FAIL user=${username}`);
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
    return;
  }

  // ── /dmis_main  placeholder when no dmisUrl configured ──────────────────────
  if (req.url === '/dmis_main' || req.url.startsWith('/dmis_main?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>DMIS Main</title>
<style>body{font-family:'Sarabun',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#e8f0fb;margin:0;}
.box{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,80,180,0.13);padding:40px 48px;text-align:center;max-width:480px;}
h2{color:#1a6db5;margin-bottom:12px;}p{color:#555;font-size:15px;margin-bottom:20px;}
a{display:inline-block;background:#0073c7;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:700;}
a:hover{background:#005fa3;}</style></head><body>
<div class="box"><h2>✅ เข้าสู่ระบบสำเร็จ</h2>
<p>กรุณากำหนด <b>DMIS URL</b> ใน <code>login-config.json</code><br>แล้วรีสตาร์ท proxy เพื่อ redirect ไปยังระบบ DMIS จริง</p>
<a href="http://localhost:3000">← กลับหน้าหลัก</a></div></body></html>`);
    return;
  }

  // ── /mysql-write  INSERT/UPDATE/DELETE via direct MySQL connection ──────────
  if (req.url === '/mysql-write') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    try {
      const body   = await readBody(req);
      const params = new URLSearchParams(body);
      const sql    = params.get('sql') || '';
      if (!sql) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Missing sql' })); return; }

      const p = getPool();
      if (!p) {
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false, error: 'db-config.json ไม่ถูกต้องหรือยังไม่ได้กรอก MySQL credentials' }));
        return;
      }

      const [result] = await p.query(sql);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, affectedRows: result.affectedRows, insertId: result.insertId }));
    } catch(e) {
      console.error('[mysql-write error]', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /sql-proxy  SELECT via BMS API (GET→POST forward) ──────────────────────
  if (req.url === '/sql-proxy') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Not found'); return; }

    const target = req.headers['x-bms-target'];
    const auth   = req.headers['x-bms-auth'];
    if (!target) { res.writeHead(400); res.end('Missing X-BMS-Target'); return; }

    try {
      const body    = await readBody(req);
      const parsed  = url.parse(`${target}/api/sql`);
      const isHttps = parsed.protocol === 'https:';
      const lib     = isHttps ? https : http;

      // Forward as GET — body already contains "app=BMS.Dashboard.React&sql=<encoded>"
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     `${parsed.pathname}?${body}`,
        method:   'GET',
        headers:  { Authorization: auth },
      };

      await new Promise((resolve, reject) => {
        const proxy = lib.request(options, remote => {
          res.writeHead(remote.statusCode, { 'Content-Type': 'application/json' });
          remote.pipe(res);
          remote.on('end', resolve);
        });
        proxy.on('error', err => {
          console.error('[proxy error]', err.message);
          if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); }
          reject(err);
        });
        proxy.end();
      });
    } catch(e) {
      console.error('[sql-proxy error]', e.message);
      if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); }
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`[proxy] listening on http://localhost:${PORT}`));
