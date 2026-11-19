// Kingdom Clash — online server (static files + WebSocket)
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.css': 'text/css' };
const cache = new Map();
function serve(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(f), type = MIME[ext] || 'application/octet-stream';
    const gz = /gzip/.test(req.headers['accept-encoding'] || '') && /\.(html|js|json|css)$/.test(f);
    const hdr = { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
    if (gz) {
      let c = cache.get(f);
      if (!c || c.m !== st.mtimeMs) { c = { m: st.mtimeMs, b: zlib.gzipSync(fs.readFileSync(f), { level: 9 }) }; cache.set(f, c); }
      hdr['Content-Encoding'] = 'gzip'; res.writeHead(200, hdr); return res.end(c.b);
    }
    res.writeHead(200, hdr); fs.createReadStream(f).pipe(res);
  });
}
const server = http.createServer(serve);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

const players = new Map(); // id -> {ws,name,k,st,r,role,x,y,z,f,a,h,hid,lastChat}
const admins = new Set();
const state = { ev: { xp: 1, gold: 1, name: '' }, motd: '' };
let nextId = 1;
const KS = ['ice', 'fire', 'sand'];
const clean = (s, n) => String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);
const num = (v, a, b) => { v = +v; return isFinite(v) ? Math.max(a, Math.min(b, v)) : 0; };
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function all(o, except) { const s = JSON.stringify(o); for (const [id, p] of players) if (id !== except && p.ws.readyState === 1) p.ws.send(s); }
function pub(id, p) { return { id, name: p.name, k: p.k, st: p.st, r: p.r, role: p.role }; }
function adminList() { const list = [...players].map(([id, p]) => ({ ...pub(id, p), x: Math.round(p.x), z: Math.round(p.z) })); const s = JSON.stringify({ t: 'list', p: list, ev: state.ev, motd: state.motd }); for (const a of admins) if (a.readyState === 1) a.send(s); }

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.get('admin') !== null) {
    if (q.get('admin') !== ADMIN_KEY) { send(ws, { t: 'denied' }); return ws.close(); }
    admins.add(ws); adminList();
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.t === 'ann') { const t = clean(m.m, 200); if (t) all({ t: 'ann', m: t }); }
      if (m.t === 'ev') { state.ev = { xp: num(m.xp, 1, 5), gold: num(m.gold, 1, 5), name: clean(m.name, 60) }; all({ t: 'ev', ev: state.ev }); }
      if (m.t === 'motd') { state.motd = clean(m.m, 200); }
      if (m.t === 'kick') { const p = players.get(+m.id); if (p) { send(p.ws, { t: 'kick', m: clean(m.m, 120) }); p.ws.close(); } }
      adminList();
    });
    ws.on('close', () => admins.delete(ws));
    return;
  }
  const id = nextId++;
  const p = { ws, name: 'جندي', k: 'ice', st: 'sword', r: 0, role: '', x: 0, y: 0, z: 0, f: 0, a: 'Idle', h: 0, hid: 1, lastChat: 0, joined: false };
  players.set(id, p);
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t === 'hello' || m.t === 'prof') {
      p.name = clean(m.name, 16) || 'جندي'; p.k = KS.includes(m.k) ? m.k : 'ice'; p.st = clean(m.st, 8); p.r = num(m.r, 0, 13) | 0; p.role = clean(m.role, 10);
      if (m.t === 'hello' && !p.joined) {
        p.joined = true;
        send(ws, { t: 'welcome', id, ev: state.ev, motd: state.motd, others: [...players].filter(([i, o]) => i !== id && o.joined).map(([i, o]) => pub(i, o)) });
        all({ t: 'add', ...pub(id, p) }, id);
      } else all({ t: 'upd', ...pub(id, p) }, id);
      adminList();
    } else if (m.t === 's') {
      p.x = num(m.x, -5000, 5000); p.y = num(m.y, -50, 400); p.z = num(m.z, -5000, 5000); p.f = num(m.f, -10, 10); p.a = clean(m.a, 32); p.h = m.h ? 1 : 0; p.hid = m.hid ? 1 : 0;
    } else if (m.t === 'c') {
      const now = Date.now(); if (now - p.lastChat < 700) return; p.lastChat = now;
      const t = clean(m.m, 120); if (t) all({ t: 'c', id, name: p.name, k: p.k, r: p.r, m: t });
    }
  });
  ws.on('close', () => { players.delete(id); all({ t: 'del', id }); adminList(); });
});
// world snapshots 10x per second
setInterval(() => {
  if (!players.size) return;
  const arr = []; for (const [id, p] of players) if (p.joined) arr.push([id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10, Math.round(p.f * 100) / 100, p.a, p.h, p.hid]);
  all({ t: 'snap', p: arr });
}, 100);
setInterval(() => { for (const [, p] of players) if (p.ws.readyState !== 1) p.ws.terminate(); }, 30000);
server.listen(PORT, () => console.log('Kingdom Clash server on :' + PORT));
