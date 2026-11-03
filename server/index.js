'use strict';
/*
 * Бэкенд тайного Санты Кофеманьяков. Без внешних зависимостей: только Node.js >= 18.
 * Хранит всё в JSON-файле (DATA_DIR/db.json), раздаёт фронтенд из /public.
 *
 * Переменные окружения:
 *   PORT            порт (по умолчанию 3000)
 *   DATA_DIR        папка для базы (по умолчанию ./data)
 *   ADMIN_PASSWORD  пароль админки (если не задан — генерируется и пишется в лог)
 *   SECRET          ключ подписи токенов (если не задан — генерируется и хранится в DATA_DIR)
 *   CORS_ORIGIN     разрешённый Origin для фронтенда на GitHub Pages (по умолчанию *)
 *
 * Бесплатные хостинги (Render free и т.п.) стирают диск при перезапуске. Чтобы база не терялась,
 * можно хранить её копию в ПРИВАТНОМ GitHub-репозитории:
 *   GITHUB_DATA_REPO  owner/repo приватного репозитория для данных (например sergey/santa-data)
 *   GITHUB_TOKEN      fine-grained токен с правом Contents: Read and write на этот репозиторий
 *   GITHUB_DATA_PATH  путь к файлу (по умолчанию db.json)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../public/js/core.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 60; // 60 дней

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- secrets ----------
function persistentSecret(file, envValue, bytes) {
  if (envValue) return envValue;
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const v = crypto.randomBytes(bytes).toString('base64url');
  fs.writeFileSync(p, v, { mode: 0o600 });
  return v;
}
const SECRET = persistentSecret('.secret', process.env.SECRET, 32);
const ADMIN_PASSWORD = persistentSecret('.admin-password', process.env.ADMIN_PASSWORD, 9);
if (!process.env.ADMIN_PASSWORD) {
  console.log(`[santa] ADMIN_PASSWORD не задан. Пароль админки: ${ADMIN_PASSWORD} (сохранён в ${path.join(DATA_DIR, '.admin-password')})`);
}

// ---------- database ----------
let db;
try {
  db = core.ensure(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[santa] не удалось прочитать базу, создаю новую:', e.message);
  db = core.emptyDb();
}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
  ghSchedule();
}

// ---------- optional: mirror the database to a private GitHub repo ----------
const GH_REPO = process.env.GITHUB_DATA_REPO;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_PATH = process.env.GITHUB_DATA_PATH || 'db.json';
const GH_URL = GH_REPO ? `https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}` : null;
const ghHeaders = () => ({ Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'coffeemaniacs-santa' });
let ghSha = null, ghTimer = null, ghChain = Promise.resolve();

async function ghLoad() {
  const r = await fetch(GH_URL, { headers: ghHeaders() });
  if (r.status === 404) { console.log('[santa] в репозитории данных пока нет базы — создам при первом сохранении'); return; }
  if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  ghSha = j.sha;
  let text = Buffer.from(j.content || '', 'base64').toString('utf8');
  if (!text && j.download_url) text = await (await fetch(j.download_url, { headers: ghHeaders() })).text();
  db = core.ensure(JSON.parse(text));
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
  console.log(`[santa] база загружена из github.com/${GH_REPO}/${GH_PATH}: ${db.users.length} пользователей`);
}
async function ghPush() {
  const body = { message: 'santa db ' + new Date().toISOString(), content: Buffer.from(JSON.stringify(db, null, 1)).toString('base64') };
  if (ghSha) body.sha = ghSha;
  let r = await fetch(GH_URL, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) { // устаревший sha — перечитываем и пробуем снова
    const cur = await fetch(GH_URL, { headers: ghHeaders() });
    if (cur.ok) { body.sha = (await cur.json()).sha; r = await fetch(GH_URL, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) }); }
  }
  if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 200));
  ghSha = (await r.json()).content.sha;
}
function ghSchedule() {
  if (!GH_URL) return;
  clearTimeout(ghTimer);
  ghTimer = setTimeout(() => { ghChain = ghChain.then(ghPush).catch((e) => console.error('[santa] не удалось сохранить в GitHub:', e.message)); }, 2000);
}

// ---------- crypto helpers ----------
function hash(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
function verify(password, stored) {
  const [alg, salt, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const a = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), 32);
  const b = Buffer.from(h, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function issueToken(payload) {
  const body = Buffer.from(JSON.stringify(Object.assign({ exp: Date.now() + TOKEN_TTL }, payload))).toString('base64url');
  return body + '.' + sign(body);
}
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
function checkAdmin(pw) {
  const a = Buffer.from(sign('admin:' + pw));
  const b = Buffer.from(sign('admin:' + ADMIN_PASSWORD));
  return crypto.timingSafeEqual(a, b);
}

// ---------- rate limit for logins ----------
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++;
  attempts.set(ip, rec);
  return rec.n > 30;
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new core.SantaError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new core.SantaError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/')) rel += 'index.html';
  if (!path.extname(rel)) rel += '.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p>Дед Мороз не нашёл эту страницу. <a href="/">На главную</a></p>');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }

  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    if (/login$|register$/.test(url.pathname) && rateLimited(ip)) throw new core.SantaError(429, 'Слишком много попыток, попробуйте через 10 минут');
    const body = req.method === 'POST' ? await readBody(req) : {};
    const auth = readToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const ctx = {
      now: () => Date.now(),
      id: () => crypto.randomBytes(8).toString('hex'),
      random: () => crypto.randomInt(0, 2 ** 32) / 2 ** 32,
      hash, verify, issueToken, checkAdmin,
      userId: auth && auth.uid ? auth.uid : null,
      isAdmin: !!(auth && auth.admin),
    };
    const { data, mutated } = core.handle(db, ctx, req.method, url.pathname, body);
    if (mutated) save();
    send(res, 200, data);
  } catch (e) {
    if (e instanceof core.SantaError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Что-то пошло не так. Кофе пролился 😢' });
  }
});

if (require.main === module) {
  (async () => {
    if (GH_URL) {
      if (!GH_TOKEN) throw new Error('GITHUB_DATA_REPO задан, но нет GITHUB_TOKEN');
      await ghLoad();
    }
    server.listen(PORT, () => console.log(`[santa] http://localhost:${PORT}  (база: ${DB_FILE}${GH_URL ? ' + github:' + GH_REPO : ''})`));
  })().catch((e) => { console.error('[santa] не удалось запуститься:', e.message); process.exit(1); });
}
module.exports = server;
