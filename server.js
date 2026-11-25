'use strict';
/*
 * VuPay — serveur de l'application.
 * Node.js 22.5 ou plus récent, aucune dépendance à installer (SQLite intégré à Node).
 * Lancer :  node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

loadEnv(path.join(__dirname, '.env'));
const { DatabaseSync } = require('node:sqlite');
const providers = require('./providers');

const CFG = {
  port: +(process.env.PORT || 3000),
  devOtp: process.env.DEV_SHOW_OTP === '1',
  minOut: +(process.env.MIN_WITHDRAW || 2000),
  goal: +(process.env.DAILY_GOAL || 5),
  bonus: +(process.env.DAILY_BONUS || 300),
  seedDemo: process.env.SEED_DEMO !== '0',
  maxUpload: +(process.env.MAX_UPLOAD_MB || 300) * 1024 * 1024,
  maxVideoSec: +(process.env.MAX_VIDEO_SECONDS || 180),
  adminToken: process.env.ADMIN_TOKEN || '',
  webhookSecret: process.env.PAYOUT_WEBHOOK_SECRET || '',
  tz: process.env.TIMEZONE || 'Africa/Dakar'
};

const COUNTRIES = [
  ['Sénégal', '+221', 'XOF'], ['Côte d’Ivoire', '+225', 'XOF'], ['Mali', '+223', 'XOF'], ['Burkina Faso', '+226', 'XOF'],
  ['Bénin', '+229', 'XOF'], ['Togo', '+228', 'XOF'], ['Niger', '+227', 'XOF'], ['Guinée-Bissau', '+245', 'XOF'],
  ['Cameroun', '+237', 'XAF'], ['Gabon', '+241', 'XAF'], ['Congo', '+242', 'XAF'], ['Tchad', '+235', 'XAF'],
  ['Centrafrique', '+236', 'XAF'], ['Guinée équatoriale', '+240', 'XAF']
];
const OPS = ['Orange Money', 'Wave', 'MTN MoMo', 'Moov Money'];
const CATS = ['pub', 'tuto', 'avis'];
const PAYS = [100, 150, 200, 250, 300, 400, 500];

const DATA = path.join(__dirname, 'data');
const VID_DIR = path.join(DATA, 'videos');
const POS_DIR = path.join(DATA, 'posters');
const PUB = path.join(__dirname, 'public');
for (const d of [DATA, VID_DIR, POS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- base de données
const db = new DatabaseSync(path.join(DATA, 'vupay.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, country INTEGER NOT NULL, phone TEXT NOT NULL, name TEXT NOT NULL, op TEXT NOT NULL,
  ref_code TEXT UNIQUE, balance INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL, UNIQUE(country, phone));
CREATE TABLE IF NOT EXISTS otps(key TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS videos(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, brand TEXT NOT NULL, cat TEXT NOT NULL, pay INTEGER NOT NULL,
  q TEXT NOT NULL, opts TEXT NOT NULL, answer INTEGER NOT NULL, dur REAL NOT NULL, file TEXT, poster TEXT,
  frames TEXT, art TEXT, color TEXT, owner_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS views(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, video_id TEXT NOT NULL, day TEXT NOT NULL, started INTEGER NOT NULL,
  status TEXT NOT NULL, UNIQUE(user_id, video_id, day));
CREATE TABLE IF NOT EXISTS txs(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL, ref TEXT UNIQUE, op TEXT, num TEXT, steps TEXT, created TEXT NOT NULL, day TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bonuses(user_id INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(user_id, day));
`);

if (CFG.seedDemo && db.prepare("SELECT COUNT(*) n FROM videos WHERE kind='demo'").get().n === 0) {
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'demo-videos.json'), 'utf8'));
  const ins = db.prepare(`INSERT INTO videos(id,kind,title,brand,cat,pay,q,opts,answer,dur,frames,art,color,created)
    VALUES(?, 'demo', ?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const v of demo) ins.run('demo-' + v.id, v.title, v.brand, v.cat, v.pay, v.q, JSON.stringify(v.opts), v.a, v.dur, JSON.stringify(v.frames), v.art, v.color, new Date().toISOString());
  console.log(`${demo.length} vidéos de démonstration ajoutées (SEED_DEMO=0 pour ne pas les ajouter).`);
}

// ---------------------------------------------------------------- outils
const nowIso = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: CFG.tz }).format(new Date());
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Requête trop volumineuse.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON invalide.')); } });
    req.on('error', reject);
  });
}

function cleanPhone(country, phone) {
  if (!Number.isInteger(country) || !COUNTRIES[country]) fail(400, 'Pays invalide.');
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 8 || p.length > 10) fail(400, 'Le numéro doit contenir 8 à 10 chiffres.');
  return p;
}
const intl = (country, phone) => COUNTRIES[country][1] + phone;
const str = (v, max, label) => { const s = String(v ?? '').trim(); if (!s) fail(400, label + ' manquant.'); if (s.length > max) fail(400, label + ' trop long.'); return s; };

function authUser(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) fail(401, 'Connexion requise.');
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(t));
  if (!row) fail(401, 'Session expirée, reconnecte-toi.');
  return row;
}

function fmtTx(t) {
  return { id: t.id, kind: t.kind, label: t.label, amount: t.amount, status: t.status, ref: t.ref, op: t.op, num: t.num, steps: t.steps ? JSON.parse(t.steps) : null, at: t.created };
}

function mePayload(u) {
  u = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  const d = today();
  const done = {};
  for (const v of db.prepare("SELECT video_id, status FROM views WHERE user_id = ? AND day = ? AND status IN ('ok','ko')").all(u.id, d)) done[v.video_id] = v.status;
  const todayGain = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM txs WHERE user_id = ? AND day = ? AND amount > 0").get(u.id, d).s;
  const bonus = !!db.prepare('SELECT 1 FROM bonuses WHERE user_id = ? AND day = ?').get(u.id, d);
  const txs = db.prepare('SELECT * FROM txs WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id).map(fmtTx);
  return {
    user: { name: u.name, country: u.country, phone: u.phone, op: u.op, code: u.ref_code, since: u.created },
    balance: u.balance, total: u.total, watched: u.watched, done, todayGain, bonus, tx: txs,
    config: { goal: CFG.goal, bonus: CFG.bonus, minOut: CFG.minOut }
  };
}

function publicVideo(v) {
  const o = { id: v.id, kind: v.kind, title: v.title, brand: v.brand, cat: v.cat, pay: v.pay, q: v.q, opts: JSON.parse(v.opts), dur: v.dur };
  if (v.kind === 'demo') Object.assign(o, { frames: JSON.parse(v.frames), art: v.art, color: v.color });
  else Object.assign(o, { url: '/media/' + v.file, poster: v.poster ? '/posters/' + v.poster : null });
  return o;
}

function setTxStatus(ref, status) {
  const t = db.prepare('SELECT * FROM txs WHERE ref = ?').get(ref);
  if (!t || t.status === 'Envoyé' || t.status === 'Échoué') return;
  const steps = t.steps ? JSON.parse(t.steps) : [];
  const idx = { 'En attente': 0, 'En traitement': 1, 'Envoyé': 2 }[status];
  if (idx !== undefined) { for (let i = 0; i <= idx; i++) steps[i] = steps[i] || nowIso(); }
  tx(() => {
    db.prepare('UPDATE txs SET status = ?, steps = ? WHERE ref = ?').run(status, JSON.stringify(steps), ref);
    if (status === 'Échoué') db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(-t.amount, t.user_id);
  });
}

// ---------------------------------------------------------------- routes API
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('POST', '/api/otp/send', async (req) => {
  const b = await readJson(req);
  const country = +b.country, phone = cleanPhone(country, b.phone);
  const user = db.prepare('SELECT id FROM users WHERE country = ? AND phone = ?').get(country, phone);
  if (b.mode === 'login' && !user) fail(404, 'Aucun compte avec ce numéro. Inscris-toi en 1 minute.');
  const key = country + ':' + phone;
  const prev = db.prepare('SELECT sent_at FROM otps WHERE key = ?').get(key);
  if (prev && Date.now() - prev.sent_at < 30000) fail(429, 'Patiente 30 secondes avant de redemander un code.');
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare('INSERT OR REPLACE INTO otps(key, code_hash, expires, tries, sent_at) VALUES(?,?,?,0,?)').run(key, sha(key + code), Date.now() + 10 * 60000, Date.now());
  await providers.sendSms(intl(country, phone), `VuPay : ton code de vérification est ${code}. Ne le partage avec personne.`);
  return { ok: true, exists: !!user, ...(CFG.devOtp ? { devCode: code } : {}) };
});

route('POST', '/api/otp/verify', async (req) => {
  const b = await readJson(req);
  const country = +b.country, phone = cleanPhone(country, b.phone), key = country + ':' + phone;
  const o = db.prepare('SELECT * FROM otps WHERE key = ?').get(key);
  if (!o || o.expires < Date.now()) fail(400, 'Code expiré. Demande un nouveau code.');
  if (o.tries >= 5) fail(429, 'Trop d’essais. Demande un nouveau code.');
  if (sha(key + String(b.code || '')) !== o.code_hash) {
    db.prepare('UPDATE otps SET tries = tries + 1 WHERE key = ?').run(key);
    fail(400, 'Code incorrect, réessaie.');
  }
  db.prepare('DELETE FROM otps WHERE key = ?').run(key);
  let user = db.prepare('SELECT * FROM users WHERE country = ? AND phone = ?').get(country, phone);
  let created = false;
  if (!user) {
    const name = str(b.name, 40, 'Prénom');
    if (!OPS.includes(b.op)) fail(400, 'Opérateur invalide.');
    let code; do { code = 'VU' + crypto.randomBytes(4).toString('hex').slice(0, 5).toUpperCase(); } while (db.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(code));
    const r = db.prepare('INSERT INTO users(country, phone, name, op, ref_code, created) VALUES(?,?,?,?,?,?)').run(country, phone, name, b.op, code, nowIso());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    created = true;
  }
  const token = rid(32);
  db.prepare('INSERT INTO sessions(token_hash, user_id, created) VALUES(?,?,?)').run(sha(token), user.id, nowIso());
  return { token, created, me: mePayload(user) };
});

route('POST', '/api/logout', async (req) => {
  const t = (req.headers.authorization || '').slice(7);
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  return { ok: true };
});

route('GET', '/api/me', async (req) => mePayload(authUser(req)));

route('PATCH', '/api/me', async (req) => {
  const u = authUser(req), b = await readJson(req);
  if (b.op !== undefined) { if (!OPS.includes(b.op)) fail(400, 'Opérateur invalide.'); db.prepare('UPDATE users SET op = ? WHERE id = ?').run(b.op, u.id); }
  return mePayload(u);
});

route('GET', '/api/videos', async (req) => {
  authUser(req);
  return db.prepare('SELECT * FROM videos WHERE active = 1 ORDER BY (kind = \'demo\'), created DESC').all().map(publicVideo);
});

route('POST', '/api/views', async (req) => {
  const u = authUser(req), b = await readJson(req);
  const v = db.prepare('SELECT * FROM videos WHERE id = ? AND active = 1').get(String(b.videoId || ''));
  if (!v) fail(404, 'Vidéo introuvable.');
  const d = today();
  const ex = db.prepare('SELECT * FROM views WHERE user_id = ? AND video_id = ? AND day = ?').get(u.id, v.id, d);
  if (ex) { if (ex.status !== 'started') fail(409, 'Tu as déjà fait cette vidéo aujourd’hui.'); return { viewId: ex.id }; }
  const id = rid(10);
  db.prepare("INSERT INTO views(id, user_id, video_id, day, started, status) VALUES(?,?,?,?,?, 'started')").run(id, u.id, v.id, d, Date.now());
  return { viewId: id };
});

route('POST', '/api/views/:id/answer', async (req, p) => {
  const u = authUser(req), b = await readJson(req);
  const view = db.prepare('SELECT * FROM views WHERE id = ? AND user_id = ?').get(p.id, u.id);
  if (!view) fail(404, 'Lecture introuvable.');
  if (view.status !== 'started') fail(409, 'Cette vidéo a déjà été validée.');
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(view.video_id);
  const elapsed = (Date.now() - view.started) / 1000;
  if (elapsed < v.dur * 0.9 - 2) fail(400, 'La vidéo n’a pas été regardée en entier.');
  const correct = Number(b.answer) === v.answer;
  let bonusNow = false;
  tx(() => {
    db.prepare('UPDATE views SET status = ? WHERE id = ?').run(correct ? 'ok' : 'ko', view.id);
    if (!correct) return;
    const d = today(), at = nowIso();
    db.prepare('UPDATE users SET balance = balance + ?, total = total + ?, watched = watched + 1 WHERE id = ?').run(v.pay, v.pay, u.id);
    db.prepare("INSERT INTO txs(user_id, kind, label, amount, status, created, day) VALUES(?, 'video', ?, ?, 'Crédité', ?, ?)").run(u.id, v.title, v.pay, at, d);
    const n = db.prepare("SELECT COUNT(*) n FROM views WHERE user_id = ? AND day = ? AND status = 'ok'").get(u.id, d).n;
    if (n >= CFG.goal && !db.prepare('SELECT 1 FROM bonuses WHERE user_id = ? AND day = ?').get(u.id, d)) {
      db.prepare('INSERT INTO bonuses(user_id, day) VALUES(?,?)').run(u.id, d);
      db.prepare('UPDATE users SET balance = balance + ?, total = total + ? WHERE id = ?').run(CFG.bonus, CFG.bonus, u.id);
      db.prepare("INSERT INTO txs(user_id, kind, label, amount, status, created, day) VALUES(?, 'bonus', 'Bonus objectif du jour', ?, 'Crédité', ?, ?)").run(u.id, CFG.bonus, at, d);
      bonusNow = true;
    }
  });
  return { correct, gained: correct ? v.pay : 0, bonus: bonusNow ? CFG.bonus : 0, me: mePayload(u) };
});

route('POST', '/api/withdrawals', async (req) => {
  const u = authUser(req), b = await readJson(req);
  const amount = Math.floor(Number(b.amount));
  if (!Number.isFinite(amount) || amount < CFG.minOut) fail(400, `Le minimum est de ${CFG.minOut} FCFA.`);
  if (!OPS.includes(b.op)) fail(400, 'Opérateur invalide.');
  const num = cleanPhone(u.country, b.number);
  const ref = 'VP' + Date.now().toString().slice(-6) + crypto.randomInt(100, 1000);
  tx(() => {
    const r = db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').run(amount, u.id, amount);
    if (r.changes === 0) fail(400, 'Montant supérieur à ton solde.');
    db.prepare("INSERT INTO txs(user_id, kind, label, amount, status, ref, op, num, steps, created, day) VALUES(?, 'out', ?, ?, 'En attente', ?, ?, ?, ?, ?, ?)")
      .run(u.id, 'Retrait ' + b.op, -amount, ref, b.op, intl(u.country, num), JSON.stringify([nowIso()]), nowIso(), today());
  });
  providers.payout({ ref, amount, currency: COUNTRIES[u.country][2], operator: b.op, phone: intl(u.country, num) }, s => setTxStatus(ref, s))
    .catch(e => { console.error('Retrait', ref, e.message); setTxStatus(ref, 'Échoué'); });
  return { ref, me: mePayload(u) };
});

route('POST', '/api/webhooks/payout', async (req) => {
  if (!CFG.webhookSecret || req.headers['x-webhook-secret'] !== CFG.webhookSecret) fail(401, 'Non autorisé.');
  const b = await readJson(req);
  const status = b.status === 'success' ? 'Envoyé' : b.status === 'failed' ? 'Échoué' : null;
  if (!status) fail(400, 'Statut inconnu.');
  setTxStatus(String(b.reference || ''), status);
  return { ok: true };
});

// ---- espace annonceur
route('PUT', '/api/uploads', async (req) => {
  authUser(req);
  const type = String(req.headers['content-type'] || '');
  const ext = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[type.split(';')[0]];
  if (!ext) fail(415, 'Format refusé. Utilise une vidéo MP4, WebM ou MOV.');
  const len = +(req.headers['content-length'] || 0);
  if (len > CFG.maxUpload) fail(413, `Vidéo trop lourde (${CFG.maxUpload / 1048576} Mo maximum).`);
  const file = rid(12) + '.' + ext, dest = path.join(VID_DIR, file);
  let size = 0;
  req.on('data', c => { size += c.length; if (size > CFG.maxUpload) req.destroy(new HttpError(413, 'Vidéo trop lourde.')); });
  try { await pipeline(req, fs.createWriteStream(dest)); }
  catch (e) { fs.rmSync(dest, { force: true }); throw e instanceof HttpError ? e : new HttpError(400, 'Envoi interrompu.'); }
  return { fileId: file };
});

route('POST', '/api/videos', async (req) => {
  const u = authUser(req), b = await readJson(req, 3 * 1024 * 1024);
  const file = String(b.fileId || '');
  if (!/^[a-f0-9]{24}\.(mp4|webm|mov)$/.test(file) || !fs.existsSync(path.join(VID_DIR, file))) fail(400, 'Vidéo introuvable, renvoie-la.');
  const title = str(b.title, 70, 'Titre'), brand = str(b.brand, 30, 'Marque'), q = str(b.q, 90, 'Question');
  if (!CATS.includes(b.cat)) fail(400, 'Catégorie invalide.');
  if (!PAYS.includes(+b.pay)) fail(400, 'Gain par vue invalide.');
  if (!Array.isArray(b.opts) || b.opts.length !== 4) fail(400, 'Il faut 4 réponses.');
  const opts = b.opts.map((o, i) => str(o, 40, 'Réponse ' + (i + 1)));
  const answer = +b.answer; if (![0, 1, 2, 3].includes(answer)) fail(400, 'Coche la bonne réponse.');
  const dur = Number(b.dur); if (!(dur > 0 && dur <= CFG.maxVideoSec + 1)) fail(400, `La vidéo doit durer ${CFG.maxVideoSec / 60} minutes maximum.`);
  let poster = null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.poster || ''));
  if (m) { poster = rid(10) + '.jpg'; fs.writeFileSync(path.join(POS_DIR, poster), Buffer.from(m[1], 'base64')); }
  const id = 'v' + rid(8);
  db.prepare(`INSERT INTO videos(id, kind, title, brand, cat, pay, q, opts, answer, dur, file, poster, owner_id, created)
    VALUES(?, 'video', ?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, title, brand, b.cat, +b.pay, q, JSON.stringify(opts), answer, dur, file, poster, u.id, nowIso());
  return publicVideo(db.prepare('SELECT * FROM videos WHERE id = ?').get(id));
});

route('GET', '/api/my-videos', async (req) => {
  const u = authUser(req);
  return db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM views w WHERE w.video_id = v.id AND w.status = 'ok') views
    FROM videos v WHERE owner_id = ? AND active = 1 ORDER BY created DESC`).all(u.id).map(v => ({ ...publicVideo(v), views: v.views }));
});

route('DELETE', '/api/videos/:id', async (req, p) => {
  const u = authUser(req);
  const r = db.prepare('UPDATE videos SET active = 0 WHERE id = ? AND owner_id = ?').run(p.id, u.id);
  if (!r.changes) fail(404, 'Vidéo introuvable.');
  return { ok: true };
});

// ---- administration (en-tête X-Admin-Token)
function admin(req) { if (!CFG.adminToken || req.headers['x-admin-token'] !== CFG.adminToken) fail(401, 'Jeton administrateur invalide.'); }
route('GET', '/api/admin/withdrawals', async (req) => {
  admin(req);
  return db.prepare(`SELECT t.*, u.name FROM txs t JOIN users u ON u.id = t.user_id WHERE t.kind = 'out' ORDER BY t.id DESC LIMIT 200`).all()
    .map(t => ({ ...fmtTx(t), name: t.name }));
});
route('POST', '/api/admin/withdrawals/:ref', async (req, p) => {
  admin(req);
  const b = await readJson(req);
  if (!['En traitement', 'Envoyé', 'Échoué'].includes(b.status)) fail(400, 'Statut invalide.');
  setTxStatus(p.ref, b.status);
  return { ok: true };
});
route('GET', '/api/admin/stats', async (req) => {
  admin(req);
  const one = s => db.prepare(s).get();
  return {
    users: one('SELECT COUNT(*) n FROM users').n,
    viewsToday: db.prepare("SELECT COUNT(*) n FROM views WHERE day = ? AND status = 'ok'").get(today()).n,
    paidToUsers: one("SELECT COALESCE(SUM(amount),0) s FROM txs WHERE amount > 0").s,
    pendingWithdrawals: one("SELECT COALESCE(SUM(-amount),0) s FROM txs WHERE kind = 'out' AND status IN ('En attente','En traitement')").s,
    balances: one('SELECT COALESCE(SUM(balance),0) s FROM users').s
  };
});

// ---------------------------------------------------------------- fichiers
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Introuvable');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    if (range) {
      let start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? +range[2] : st.size - 1;
      if (!range[1]) end = st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function safeJoin(dir, name) {
  const p = path.normalize(path.join(dir, name));
  return p.startsWith(dir + path.sep) ? p : null;
}

// ---------------------------------------------------------------- serveur
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && r.re.exec(p);
        if (m) return send(res, 200, await r.handler(req, m.groups || {}));
      }
      return send(res, 404, { error: 'Route inconnue.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Méthode non autorisée');
    if (p.startsWith('/media/')) { const f = safeJoin(VID_DIR, p.slice(7)); return f ? serveFile(req, res, f, 'public, max-age=86400') : send(res, 404, 'Introuvable'); }
    if (p.startsWith('/posters/')) { const f = safeJoin(POS_DIR, p.slice(9)); return f ? serveFile(req, res, f, 'public, max-age=86400') : send(res, 404, 'Introuvable'); }
    const f = safeJoin(PUB, p === '/' ? 'index.html' : p.slice(1));
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(req, res, f, p === '/sw.js' || p.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
    return serveFile(req, res, path.join(PUB, 'index.html'), 'no-cache');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Erreur du serveur, réessaie.' });
  }
});

server.listen(CFG.port, () => {
  console.log(`VuPay en ligne sur http://localhost:${CFG.port}`);
  if (CFG.devOtp) console.log('ATTENTION : DEV_SHOW_OTP=1, les codes SMS sont affichés dans l’appli. Mets 0 en production.');
  if ((process.env.PAYOUT_PROVIDER || 'simulation') === 'simulation') console.log('Retraits en mode simulation : aucun argent n’est envoyé.');
});

// ---------------------------------------------------------------- .env
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
