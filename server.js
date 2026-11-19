// Kingdom Clash — online server: static files, accounts & cloud saves, shared world, PvP, owner panel
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const PUB = path.join(__dirname, 'public');
const KS = ['ice', 'fire', 'sand'];
const KN = { ice: 'مملكة الجليد', fire: 'مملكة النار', sand: 'مملكة الرمال' };
const WCC = { x: 0, z: 1150 }; // centre of the Contested Forest (shared world coordinates)
const FOREST_R = 520;
const CASTLE = { ice: { x: 0, z: 0 }, fire: { x: 996, z: 1725 }, sand: { x: -996, z: 1725 } };
const SPY_R = 330;

/* ---------------- storage: MongoDB if MONGODB_URI is set, otherwise a JSON file ---------------- */
const store = (() => {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const cli = new MongoClient(process.env.MONGODB_URI); let col = null;
    const ready = cli.connect().then(() => { col = cli.db('kingdomclash').collection('kv'); console.log('MongoDB connected'); });
    return {
      kind: 'mongo', ready,
      async get(k) { await ready; const d = await col.findOne({ _id: k }); return d ? d.v : null; },
      async put(k, v) { await ready; await col.replaceOne({ _id: k }, { _id: k, v }, { upsert: true }); }
    };
  }
  const dir = path.join(__dirname, 'data'), file = path.join(dir, 'db.json');
  let mem = {}; try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
  let dirty = false;
  setInterval(() => { if (!dirty) return; dirty = false; try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(mem)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error(e); } }, 5000);
  console.log('Using local file storage (data resets when the server is redeployed — set MONGODB_URI to keep it).');
  return { kind: 'file', ready: Promise.resolve(), async get(k) { return mem[k] || null; }, async put(k, v) { mem[k] = v; dirty = true; } };
})();

/* ---------------- static files (gzip cached) ---------------- */
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
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

/* ---------------- shared state ---------------- */
const players = new Map(); // id -> session
const admins = new Set();
const meta = { lock: { ice: false, fire: false, sand: false }, mail: { ice: [], fire: [], sand: [] }, ev: { xp: 1, gold: 1, name: '' }, motd: '', rules: '', fort: { owner: 'fire', t: Date.now() }, food: { ice: 72, fire: 72, sand: 72 }, plots: { ice: [], fire: [], sand: [] } };
const GQ_NEED = { gparade: 6, gwall: 3, gfort: 5, hunt: 3 };
const NPLOTS = 16;
store.ready.then(async () => { const m = await store.get('meta'); if (m) Object.assign(meta, m); }).catch(e => console.error(e));
const saveMeta = () => store.put('meta', meta).catch(() => { });
function kAll(k, o) { const s = JSON.stringify(o); for (const [, p] of players) if (p.joined && p.k === k && p.ws.readyState === 1) p.ws.send(s); }
function setFood(k, v) { meta.food[k] = Math.max(0, Math.min(100, Math.round(v * 10) / 10)); kAll(k, { t: 'food', k, v: meta.food[k] }); }
function plotFor(p) { // houses only exist for players who are online: pick a free plot (prefer the one used last time)
  const used = new Set(); for (const [, o] of players) if (o !== p && o.joined && o.k === p.k && o.plot >= 0) used.add(o.plot);
  const last = p.acc.plots && p.acc.plots[p.k];
  let i = (last != null && last >= 0 && last < NPLOTS && !used.has(last)) ? last : -1;
  if (i < 0) for (let j = 0; j < NPLOTS; j++) if (!used.has(j)) { i = j; break; }
  if (i >= 0) { p.acc.plots = p.acc.plots || {}; p.acc.plots[p.k] = i; }
  return i;
}
let nextId = 1;
const clean = (s, n) => String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);
const num = (v, a, b) => { v = +v; return isFinite(v) ? Math.max(a, Math.min(b, v)) : 0; };
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
function all(o, except) { const s = JSON.stringify(o); for (const [id, p] of players) if (id !== except && p.joined && p.ws.readyState === 1) p.ws.send(s); }
const pub = (id, p) => ({ id, name: p.name, k: p.k, st: p.st, r: p.r, role: p.role, plot: p.plot == null ? -1 : p.plot });
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const keyOf = n => 'acc:' + clean(n, 16).toLowerCase();
const inForest = p => Math.hypot(p.x - WCC.x, p.z - WCC.z) < FOREST_R;
function bySession(name) { const k = keyOf(name); for (const [id, p] of players) if (p.acc && keyOf(p.acc.name) === k) return [id, p]; return null; }

function adminList() {
  const list = [...players].filter(([, p]) => p.joined || p.acc).map(([id, p]) => ({ ...pub(id, p), name: p.acc ? p.acc.name : p.name, k: p.joined ? p.k : (p.acc && p.acc.save && p.acc.save.kingdom) || p.k, joined: p.joined, x: Math.round(p.x), z: Math.round(p.z), gold: p.acc && p.acc.save ? p.acc.save.gold : 0 }));
  const s = JSON.stringify({ t: 'list', lock: meta.lock, p: list, ev: meta.ev, motd: meta.motd, rules: meta.rules, fort: meta.fort, storage: store.kind });
  for (const a of admins) if (a.readyState === 1) a.send(s);
}
async function persist(p) { if (p.acc) { p.acc.last = Date.now(); await store.put(keyOf(p.acc.name), p.acc).catch(e => console.error(e)); } }

/* ---------------- chat translation (on demand, cached) ---------------- */
const TRC = new Map();
async function translate(text, to) {
  const key = to + '|' + text; if (TRC.has(key)) return TRC.get(key);
  let out = null;
  try {
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=' + encodeURIComponent(to) + '&q=' + encodeURIComponent(text), { signal: AbortSignal.timeout(6000) });
    const j = await r.json(); out = (j[0] || []).map(x => x[0]).join('');
  } catch (e) { }
  if (!out) try {
    const r = await fetch('https://api.mymemory.translated.net/get?langpair=autodetect|' + encodeURIComponent(to) + '&q=' + encodeURIComponent(text), { signal: AbortSignal.timeout(6000) });
    const j = await r.json(); out = j && j.responseData && j.responseData.translatedText;
  } catch (e) { }
  if (out) { TRC.set(key, out); if (TRC.size > 5000) TRC.delete(TRC.keys().next().value); }
  return out;
}

/* ---------------- admin ---------------- */
async function adminMsg(ws, m) {
  if (m.t === 'ann') { const t = clean(m.m, 200); if (t) all({ t: 'ann', m: t }); }
  if (m.t === 'ev') { meta.ev = { xp: num(m.xp, 1, 5), gold: num(m.gold, 1, 5), name: clean(m.name, 60) }; all({ t: 'ev', ev: meta.ev }); saveMeta(); }
  if (m.t === 'lock' && KS.includes(m.k)) { meta.lock[m.k] = !!m.on; kAll(m.k, { t: 'lock', k: m.k, on: meta.lock[m.k] }); saveMeta(); }
  if (m.t === 'motd') { meta.motd = clean(m.m, 200); saveMeta(); }
  if (m.t === 'rules') { meta.rules = clean(m.m, 1500); all({ t: 'rules', m: meta.rules }); saveMeta(); }
  if (m.t === 'kick') { const p = players.get(+m.id); if (p) { send(p.ws, { t: 'kick', m: clean(m.m, 120) }); p.ws.close(); } }
  if (m.t === 'jail') { const p = players.get(+m.id); if (p) send(p.ws, { t: 'jail', secs: num(m.secs, 10, 3600) | 0, why: clean(m.why, 120) || 'أمر من صاحب اللعبة' }); }
  if (m.t === 'gold' || m.t === 'rank' || m.t === 'ban') {
    const name = clean(m.name, 16); const k = keyOf(name); const live = bySession(name);
    const acc = live ? live[1].acc : await store.get(k);
    if (!acc) { send(ws, { t: 'err', m: 'لا يوجد حساب بهذا الاسم: ' + name }); return; }
    acc.save = acc.save || {};
    if (m.t === 'gold') { acc.save.gold = Math.max(0, (acc.save.gold || 0) + (num(m.n, -1e6, 1e6) | 0)); if (live) send(live[1].ws, { t: 'setS', patch: { gold: acc.save.gold }, why: (m.n >= 0 ? '👑 صاحب اللعبة منحك ' : '👑 صاحب اللعبة أخذ منك ') + Math.abs(m.n | 0) + ' ذهب' }); }
    if (m.t === 'rank') { acc.save.rank = num(m.r, 0, 13) | 0; if (live) send(live[1].ws, { t: 'setS', patch: { rank: acc.save.rank }, why: '👑 صاحب اللعبة غيّر رتبتك' }); }
    if (m.t === 'ban') { acc.banned = !!m.on; if (live && acc.banned) { send(live[1].ws, { t: 'kick', m: 'تم حظر حسابك' }); live[1].ws.close(); } }
    await store.put(k, acc); send(ws, { t: 'ok', m: 'تم ✅' });
  }
  adminList();
}

/* ---------------- players ---------------- */
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.get('admin') !== null) {
    if (q.get('admin') !== ADMIN_KEY) { send(ws, { t: 'denied' }); return ws.close(); }
    admins.add(ws); adminList();
    ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } adminMsg(ws, m).catch(e => console.error(e)); });
    ws.on('close', () => admins.delete(ws));
    return;
  }
  const id = nextId++;
  const p = { ws, acc: null, name: 'جندي', k: 'ice', st: 'sword', r: 0, role: '', x: 0, y: 0, z: 0, f: 0, a: 'Idle', h: 0, hid: 1, lastChat: 0, lastHit: 0, lastSave: 0, joined: false };
  players.set(id, p);
  let chain = Promise.resolve(); // handle this player's messages strictly in order
  ws.on('message', d => { chain = chain.then(() => handle(d)).catch(e => console.error(e)); });
  async function handle(d) {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    try {
      if (m.t === 'login') {
        const name = clean(m.name, 16); if (name.length < 2) return send(ws, { t: 'auth', ok: false, err: 'name' });
        const k = keyOf(name); let acc = await store.get(k); let isNew = false;
        if (acc) {
          if (acc.banned) return send(ws, { t: 'auth', ok: false, err: 'banned' });
          const okTok = m.token && (acc.tokens || []).includes(m.token);
          const okPass = m.pass && acc.hash === hashPass(m.pass, acc.salt);
          if (!okTok && !okPass) return send(ws, { t: 'auth', ok: false, err: m.token ? 'token' : 'wrong' });
        } else {
          if (!m.pass || String(m.pass).length < 4) return send(ws, { t: 'auth', ok: false, err: m.token ? 'token' : 'short' });
          const salt = crypto.randomBytes(12).toString('hex');
          let save = (m.local && typeof m.local === 'object' && JSON.stringify(m.local).length < 40000) ? m.local : {};
          acc = { name, salt, hash: hashPass(m.pass, salt), save, tokens: [], created: Date.now() }; isNew = true;
        }
        const old = bySession(name); if (old && old[0] !== id) { send(old[1].ws, { t: 'kick', m: 'تم الدخول إلى حسابك من جهاز آخر' }); old[1].ws.close(); }
        const token = crypto.randomBytes(18).toString('hex');
        acc.tokens = [...(acc.tokens || []), token].slice(-5); acc.save = acc.save || {}; acc.save.name = acc.name;
        p.acc = acc; await persist(p); adminList();
        send(ws, { t: 'auth', ok: true, name: acc.name, token, save: acc.save, isNew });
      } else if (!p.acc) {
        return; // everything else needs a logged-in account
      } else if (m.t === 'save') {
        const now = Date.now(); if (now - p.lastSave < 2500) return; p.lastSave = now;
        if (!m.s || typeof m.s !== 'object' || JSON.stringify(m.s).length > 40000) return;
        m.s.name = p.acc.name; p.acc.save = m.s; await persist(p);
      } else if (m.t === 'hello' || m.t === 'prof') {
        p.name = p.acc.name; p.k = KS.includes(m.k) ? m.k : 'ice'; p.st = clean(m.st, 8); p.r = num(m.r, 0, 13) | 0; p.role = clean(m.role, 10);
        if (m.t === 'hello' && !p.joined) {
          p.joined = true;
          p.plot = plotFor(p);
          send(ws, { t: 'welcome', id, lock: meta.lock, plot: p.plot, food: meta.food[p.k], ev: meta.ev, motd: meta.motd, rules: meta.rules, fort: meta.fort, others: [...players].filter(([i, o]) => i !== id && o.joined).map(([i, o]) => pub(i, o)) });
          if (((p.acc.save && p.acc.save.rank) || 0) >= 12) for (const ml of (meta.mail[p.k] || [])) send(ws, { t: 'mail', old: 1, ...ml });
          all({ t: 'add', ...pub(id, p) }, id);
        } else all({ t: 'upd', ...pub(id, p) }, id);
        adminList();
      } else if (m.t === 's') {
        p.x = num(m.x, -5000, 5000); p.y = num(m.y, -50, 400); p.z = num(m.z, -5000, 5000); p.f = num(m.f, -10, 10); p.a = clean(m.a, 32); p.h = m.h ? 1 : 0; p.hid = m.hid ? 1 : 0;
      } else if (m.t === 'c') {
        const now = Date.now(); if (now - p.lastChat < 700) return; p.lastChat = now;
        const t = clean(m.m, 160); if (!t) return;
        const ch = m.ch === p.k ? p.k : 'all'; const msg = { t: 'c', id, name: p.name, k: p.k, r: p.r, m: t, ch };
        if (ch === 'all') all(msg);
        else { const s = JSON.stringify(msg); for (const [, o] of players) { if (!o.joined || o.ws.readyState !== 1) continue; const spy = o.k !== ch && Math.hypot(o.x - CASTLE[ch].x, o.z - CASTLE[ch].z) < SPY_R; if (o.k === ch || spy) o.ws.send(s); } }
      } else if (m.t === 'fort') {
        if (!p.joined || Math.hypot(p.x - WCC.x, p.z - WCC.z) > 70 || meta.fort.owner === p.k) return;
        meta.fort = { owner: p.k, t: Date.now(), by: p.name }; saveMeta();
        all({ t: 'fort', fort: meta.fort, byId: id, msg: p.name + ' رفع راية ' + KN[p.k] + ' على حصن النزاع!' });
      } else if (m.t === 'hit') {
        const tg = players.get(+m.id); const now = Date.now();
        if (!tg || !tg.joined || !p.joined || tg.k === p.k || now - p.lastHit < 250) return; p.lastHit = now;
        if (!inForest(p) || !inForest(tg) || Math.hypot(p.x - tg.x, p.z - tg.z) > 45) return;
        send(tg.ws, { t: 'hurt', d: num(m.d, 1, 60) | 0, by: p.name, k: p.k, id });
      } else if (m.t === 'tr') {
        const now = Date.now(); if (now - (p.lastTr || 0) < 400) return; p.lastTr = now;
        const to = ['ar', 'en', 'fr', 'es', 'pt', 'tr', 'ru'].includes(m.to) ? m.to : 'en';
        const text = clean(m.text, 300); const res = text ? await translate(text, to) : null;
        send(ws, { t: 'trr', id: m.id, text: res });
      } else if (m.t === 'spyCaught') {
        const k = KS.includes(m.k) ? m.k : null; if (!k || k === p.k) return;
        kAll(k, { t: 'c', id: 0, name: '🕵️ الحرّاس', k, r: 0, m: 'قبضنا على جاسوس من ' + KN[p.k] + ': ' + p.name, ch: k });
      } else if (m.t === 'mail') {
        const to = KS.includes(m.to) ? m.to : null; const rank = (p.acc.save && p.acc.save.rank) || 0;
        if (!to || to === p.k || rank < 12) return; const t = clean(m.m, 500); if (!t) return;
        const mail = { from: p.name, fk: p.k, m: t, t: Date.now() };
        const box = meta.mail[to] || (meta.mail[to] = []); box.push(mail); if (box.length > 40) box.shift(); saveMeta();
        for (const [, o] of players) if (o.joined && o.k === to && o.acc && ((o.acc.save && o.acc.save.rank) || 0) >= 12) send(o.ws, { t: 'mail', ...mail });
      } else if (m.t === 'food') {
        const now = Date.now(); if (!p.joined || now - (p.lastFood || 0) < 800) return; p.lastFood = now;
        setFood(p.k, meta.food[p.k] + num(m.d, 0, 20)); saveMeta();
      } else if (m.t === 'gq') {
        const need = GQ_NEED[m.q]; if (!need || !p.joined) return; const now = Date.now(); p.gq = { q: m.q, s: num(m.s, 0, 20) | 0, t: now };
        const grp = [...players.values()].filter(o => o.joined && o.k === p.k && o.gq && o.gq.q === p.gq.q && o.gq.s === p.gq.s && now - o.gq.t < 4000);
        for (const o of grp) send(o.ws, { t: 'gqn', q: p.gq.q, s: p.gq.s, n: grp.length, need });
        if (grp.length >= need) for (const o of grp) { send(o.ws, { t: 'gqok', q: p.gq.q, s: p.gq.s, n: grp.length }); o.gq = null; }
      } else if (m.t === 'died') {
        const k = players.get(+m.by); if (!k || k.k === p.k) return;
        send(k.ws, { t: 'kill', name: p.name, k: p.k });
        all({ t: 'c', id: 0, name: '⚔️ غابة النزاع', k: k.k, r: 0, m: k.name + ' (' + KN[k.k] + ') هزم ' + p.name + ' (' + KN[p.k] + ')' });
      }
    } catch (e) { console.error(e); }
  }
  ws.on('close', () => { players.delete(id); if (p.joined) all({ t: 'del', id }); persist(p); adminList(); });
});

/* world snapshots 10x per second */
setInterval(() => {
  if (!players.size) return;
  const arr = []; for (const [id, p] of players) if (p.joined) arr.push([id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10, Math.round(p.f * 100) / 100, p.a, p.h, p.hid]);
  all({ t: 'snap', p: arr });
}, 100);
/* kingdom food slowly decreases (1% every 90 s) — hunting and cooking fill it */
setInterval(() => { for (const k of KS) if (meta.food[k] > 0) setFood(k, meta.food[k] - 1); saveMeta(); }, 90000);
/* enemy kingdoms try to retake the fort after 40 minutes */
setInterval(() => {
  if (Date.now() - meta.fort.t < 40 * 60 * 1000) return;
  const others = KS.filter(k => k !== meta.fort.owner); const k = others[Math.random() * others.length | 0];
  meta.fort = { owner: k, t: Date.now(), by: '' }; saveMeta();
  all({ t: 'fort', fort: meta.fort, byId: 0, msg: 'جيش ' + KN[k] + ' استولى على حصن النزاع!' });
}, 60000);
setInterval(() => { for (const [, p] of players) if (p.ws.readyState > 1) p.ws.terminate(); }, 30000);
server.listen(PORT, () => console.log('Kingdom Clash server on :' + PORT + ' (storage: ' + store.kind + ')'));
