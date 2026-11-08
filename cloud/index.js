'use strict';
/*
 * Бэкенд тайного Санты для Yandex Cloud Functions (бесплатный тариф).
 *
 * Запросы приходят через API Gateway (/api/...), база — JSON-файл в приватном бакете
 * Object Storage. Доступ к бакету — по IAM-токену сервисного аккаунта функции.
 * Логика та же, что и у обычного сервера: public/js/core.js (копируется сюда при деплое).
 *
 * Переменные окружения функции:
 *   BUCKET          имя бакета
 *   ADMIN_PASSWORD  пароль админки (если пустой — генерируется и хранится в бакете)
 */
const crypto = require('node:crypto');
let core;
try { core = require('./core.js'); } catch (e) { core = require('../public/js/core.js'); } // при деплое core.js кладётся рядом

const BUCKET = process.env.BUCKET;
const S3 = 'https://storage.yandexcloud.net';
const DB_KEY = 'data/db.json';
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 60;

// ---------- Object Storage ----------
async function s3(method, key, token, body, type) {
  const r = await fetch(`${S3}/${BUCKET}/${key}`, {
    method,
    headers: Object.assign({ 'X-YaCloud-SubjectToken': token }, body != null ? { 'Content-Type': type || 'application/json' } : {}),
    body,
  });
  if (method === 'GET' && r.status === 404) return null;
  if (!r.ok) throw new Error(`Object Storage ${method} ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return method === 'GET' ? r.text() : true;
}

// Секреты (ключ подписи сессий и пароль админки, если не задан) живут в бакете и
// кешируются на время жизни экземпляра функции.
let secrets = null;
async function getSecrets(token) {
  if (secrets) return secrets;
  let s = null;
  const raw = await s3('GET', 'data/secrets.json', token);
  if (raw) s = JSON.parse(raw);
  if (!s) {
    s = { secret: crypto.randomBytes(32).toString('base64url'), adminPassword: crypto.randomBytes(9).toString('base64url') };
    await s3('PUT', 'data/secrets.json', token, JSON.stringify(s));
  }
  secrets = { secret: s.secret, adminPassword: process.env.ADMIN_PASSWORD || s.adminPassword };
  return secrets;
}

async function loadDb(token) {
  const raw = await s3('GET', DB_KEY, token);
  return raw ? core.ensure(JSON.parse(raw)) : core.emptyDb();
}

// ---------- crypto ----------
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
function makeAuth(secret, adminPassword) {
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  return {
    issueToken(payload) {
      const body = Buffer.from(JSON.stringify(Object.assign({ exp: Date.now() + TOKEN_TTL }, payload))).toString('base64url');
      return body + '.' + sign(body);
    },
    readToken(token) {
      const [body, sig] = String(token || '').split('.');
      if (!body || !sig) return null;
      const expected = sign(body);
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString());
        return p.exp > Date.now() ? p : null;
      } catch (e) { return null; }
    },
    checkAdmin(pw) {
      return crypto.timingSafeEqual(Buffer.from(sign('admin:' + pw)), Buffer.from(sign('admin:' + adminPassword)));
    },
  };
}

// ---------- rate limit (на экземпляр функции) ----------
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++;
  attempts.set(ip, rec);
  return rec.n > 30;
}

// ---------- HTTP ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const reply = (statusCode, data) => ({
  statusCode,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS),
  body: JSON.stringify(data),
});

function header(event, name) {
  const h = event.headers || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? String(h[k]) : '';
}

// Путь запроса: API Gateway кладёт фактический URL в event.url, шаблон — в event.path.
function routeOf(event) {
  let p = event.url || event.path || '/';
  p = String(p).split('?')[0];
  if (p.includes('{')) {
    const proxy = (event.pathParams || event.params || {}).proxy || '';
    p = '/api/' + proxy;
  }
  if (!p.startsWith('/api/')) p = '/api/' + p.replace(/^\/+/, '');
  return p.replace(/\/+$/, '') || '/';
}

module.exports.handler = async function handler(event, context) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    if (!BUCKET) throw new Error('Не задан BUCKET');
    const token = context && context.token && context.token.access_token;
    if (!token) throw new Error('У функции нет сервисного аккаунта (нет IAM-токена)');
    const path = routeOf(event);

    if (path === '/api/health') {
      const db = await loadDb(token);
      return reply(200, { ok: true, storage: { mode: 'yandex-object-storage', bucket: BUCKET, error: null }, users: db.users.length });
    }

    const ip = header(event, 'x-forwarded-for').split(',')[0].trim() || ((event.requestContext || {}).identity || {}).sourceIp || '';
    if (/login$|register$/.test(path) && rateLimited(ip)) throw new core.SantaError(429, 'Слишком много попыток, попробуйте через 10 минут');

    let body = {};
    if (method === 'POST' && event.body) {
      const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      try { body = JSON.parse(text); } catch (e) { throw new core.SantaError(400, 'Некорректный JSON'); }
    }

    const sec = await getSecrets(token);
    const auth = makeAuth(sec.secret, sec.adminPassword);
    const t = auth.readToken(header(event, 'authorization').replace(/^Bearer\s+/i, ''));
    const db = await loadDb(token); // каждый раз свежая база: экземпляров функции может быть несколько
    const ctx = {
      now: () => Date.now(),
      id: () => crypto.randomBytes(8).toString('hex'),
      random: () => crypto.randomInt(0, 2 ** 32) / 2 ** 32,
      hash, verify, issueToken: auth.issueToken, checkAdmin: auth.checkAdmin,
      storage: () => ({ mode: 'yandex-object-storage', repo: BUCKET, lastSave: null, lastError: null }),
      userId: t && t.uid ? t.uid : null,
      isAdmin: !!(t && t.admin),
    };
    const { data, mutated } = core.handle(db, ctx, method, path, body);
    if (mutated) await s3('PUT', DB_KEY, token, JSON.stringify(db));
    return reply(200, data);
  } catch (e) {
    if (e instanceof core.SantaError) return reply(e.status, { error: e.message });
    console.error(e);
    return reply(500, { error: 'Что-то пошло не так. Кофе пролился 😢' });
  }
};

// для тестов
module.exports._internal = { routeOf, makeAuth };
