const http   = require('http');
const https  = require('https');
const url    = require('url');
const fs     = require('fs');
const path   = require('path');
const mysql  = require('mysql2/promise');
const crypto = require('crypto');

const PORT = 8765;

// In-memory queue: index.html pushes records here; dmis_main.html polls and consumes
const dmisQueue = [];

// ── WebSocket worker registry ─────────────────────────────────────────────────
const wsWorkers = new Set();

function makeWsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseWsFrames(buf) {
  const frames = []; let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset], b1 = buf[offset + 1];
    const masked = (b1 & 0x80) !== 0;
    let plen = b1 & 0x7f, hend = offset + 2;
    if (plen === 126) { if (hend + 2 > buf.length) break; plen = buf.readUInt16BE(hend); hend += 2; }
    else if (plen === 127) { if (hend + 8 > buf.length) break; plen = Number(buf.readBigUInt64BE(hend)); hend += 8; }
    const mend = masked ? hend + 4 : hend;
    if (mend + plen > buf.length) break;
    let data;
    if (masked) {
      const mask = buf.slice(hend, hend + 4); data = Buffer.alloc(plen);
      for (let i = 0; i < plen; i++) data[i] = buf[mend + i] ^ mask[i % 4];
    } else { data = buf.slice(mend, mend + plen); }
    frames.push({ opcode: b0 & 0x0f, text: data.toString('utf8') });
    offset = mend + plen;
  }
  return frames;
}

function wsSend(socket, msg) {
  try { socket.write(makeWsFrame(JSON.stringify(msg))); } catch(_) {}
}
function broadcastToWorkers(msg) {
  wsWorkers.forEach(s => wsSend(s, msg));
}

// SQL string escape helper
function sqlEsc(v) { return (v == null || v === '') ? 'NULL' : `'${String(v).replace(/\\/g,'\\\\').replace(/'/g,"''")}'`; }

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

  // ── /hemodialysis_form.html  serve HD form (iframe inside dmis_main.html) ───
  if (req.url === '/hemodialysis_form.html' || req.url.startsWith('/hemodialysis_form.html?')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'hemodialysis_form.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(404); res.end('hemodialysis_form.html not found');
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

  // ── /api/health  health check ────────────────────────────────────────────────
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  // ── /api/dmis-send  POST from index.html — queue records for dmis_main.html ──
  if (req.url === '/api/dmis-send') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const body = await readBody(req);
    let records = [];
    try { records = JSON.parse(body); } catch {}
    if (!Array.isArray(records)) records = [records];
    const valid = records.filter(r => r && r.vn);
    // Push to WS workers directly; only queue what has no connected worker
    if (wsWorkers.size > 0) {
      valid.forEach(r => broadcastToWorkers({ action: 'new', data: r }));
      console.log(`[dmis-send] broadcast ${valid.length} records to ${wsWorkers.size} WS worker(s)`);
    } else {
      dmisQueue.push(...valid);
      console.log(`[dmis-send] no WS workers — queued ${valid.length} records (queue=${dmisQueue.length})`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: valid.length, total: dmisQueue.length }));
    return;
  }

  // ── /api/dmis-poll  GET from dmis_main.html — consume queued records ──────────
  if (req.url === '/api/dmis-poll') {
    const items = dmisQueue.splice(0, dmisQueue.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, records: items }));
    return;
  }

  // ── /api/registry/claim  POST from dmis_main.html — update claim_status ──────
  if (req.url === '/api/registry/claim') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      const body = await readBody(req);
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const { vn, claim_by } = data;
      if (!vn) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing vn' }));
        return;
      }
      const p = getPool();
      if (p) {
        await p.query(
          `UPDATE clinic_hd_claim SET claim_status='sent', clinic_hd_claim_sent='Y', ` +
          `clinic_hd_claim_sent_by=${sqlEsc(claim_by)}, clinic_hd_claim_sent_at=NOW() ` +
          `WHERE vn=${sqlEsc(vn)}`
        );
      }
      console.log(`[registry/claim] vn=${vn} → sent`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, vn }));
    } catch(e) {
      console.error('[registry/claim]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /api/start-fill  REST fallback — returns empty list (WS is the primary path) ──
  if (req.url === '/api/start-fill') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, patients: [], message: 'ใช้ WebSocket เป็นช่องทางหลัก' }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`[proxy] listening on http://localhost:${PORT}`));

// ── WebSocket upgrade handler (ws://localhost:8765/ws) ───────────────────────
server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));

  wsWorkers.add(socket);
  console.log(`[ws] worker connected (total=${wsWorkers.size})`);

  // Flush pending queue items to this new worker immediately
  if (dmisQueue.length > 0) {
    const pending = dmisQueue.splice(0, dmisQueue.length);
    pending.forEach(r => wsSend(socket, { action: 'new', data: r }));
    console.log(`[ws] flushed ${pending.length} queued records to new worker`);
  }

  let buf = Buffer.alloc(0);
  socket.on('data', async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const frames = parseWsFrames(buf);
    buf = Buffer.alloc(0); // reset (simple; sufficient for typical frame sizes)
    for (const { opcode, text } of frames) {
      if (opcode === 0x8) { try { socket.destroy(); } catch(_) {} return; }
      if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue; } // pong
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      let msg;
      try { msg = JSON.parse(text); } catch(_) { continue; }
      console.log('[ws] ⬇', msg.action, (msg.data && msg.data.vn) || '');

      if (msg.action === 'register') {
        console.log('[ws] worker registered role=' + (msg.data && msg.data.role));
        continue;
      }
      if (msg.action === 'filled') {
        const { vn, claim_by, status } = msg.data || {};
        if (vn) {
          const p = getPool();
          if (p) {
            try {
              await p.query(
                `UPDATE clinic_hd_claim SET claim_status='sent', clinic_hd_claim_sent='Y', ` +
                `clinic_hd_claim_sent_by=${sqlEsc(claim_by||'')}, clinic_hd_claim_sent_at=NOW() ` +
                `WHERE vn=${sqlEsc(vn)}`
              );
              console.log(`[ws] claim updated vn=${vn}`);
            } catch(e) { console.error('[ws] claim update', e.message); }
          }
        }
        continue;
      }
    }
  });
  socket.on('close', () => { wsWorkers.delete(socket); console.log(`[ws] worker disconnected (total=${wsWorkers.size})`); });
  socket.on('error', () => { wsWorkers.delete(socket); });
});
