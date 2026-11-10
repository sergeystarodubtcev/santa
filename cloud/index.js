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

const { createBot } = require('./bot.js');

const BUCKET = process.env.BUCKET;
const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_USERNAME = process.env.TG_BOT_USERNAME || '';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
// Секрет вебхука Telegram (заголовок X-Telegram-Bot-Api-Secret-Token); deploy.sh считает его так же.
const TG_HOOK_SECRET = TG_TOKEN ? crypto.createHash('sha256').update(TG_TOKEN).digest('hex').slice(0, 32) : '';
// Режим «ретранслятора»: из облака нет связи с Telegram, поэтому бота крутит GitHub Actions (relay/bot-runner.js).
// Он забирает апдейты у Telegram, передаёт их сюда (/api/tg/relay) и отправляет ответы; исходящие уведомления
// копятся в очереди db.tgOutbox и забираются через /api/tg/outbox. Секрет общий: sha256(токен бота).
const TG_RELAY_SECRET = process.env.TG_RELAY_SECRET || '';
// Страницы, за которыми следит бот: когда начнут отвечать 200 — один раз пишем админам.
const WATCH = [
  {
    key: 'tastycoffee-advent-2027', title: 'Адвент-календарь Tasty Coffee 2027',
    url: 'https://shop.tastycoffee.ru/coffee/advent-music-calendar-2027', slug: 'advent-music-calendar-2027',
    mustContain: [/адвент/i, /advent/i],
  },
  {
    // ждём не появления страницы (она уже есть с кнопкой «Узнать о старте продаж»), а старта продаж
    key: 'tastycoffee-advent-secret-2027-sale', title: 'Секретный адвент-календарь Tasty Coffee 2027',
    url: 'https://shop.tastycoffee.ru/coffee/advent-secret-calendar-2027', slug: 'advent-secret-calendar-2027',
    mustContain: [/адвент/i, /advent/i], onSale: true,
  },
];

// Состояние товара на странице магазина (Nuxt): данные лежат в <script id="__NUXT_DATA__"> массивом,
// где поля объекта — номера ячеек. Пока продаж нет, у товара is_archive = true и на странице
// кнопка «Узнать о старте продаж»; в продаже — is_archive = false и есть цена.
function shopProduct(html, slug) {
  const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[1]); } catch (e) { return null; }
  if (!Array.isArray(arr)) return null;
  const val = (i) => (Number.isInteger(i) && i >= 0 && i < arr.length ? arr[i] : undefined);
  for (const x of arr) {
    if (!x || typeof x !== 'object' || Array.isArray(x) || !('is_archive' in x) || !('slug' in x)) continue;
    if (!String(val(x.slug) || '').includes(slug)) continue;
    return { name: val(x.name), price: Number(val(x.price)) || 0, archived: val(x.is_archive) === true };
  }
  return null;
}
const WATCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
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

// ---------- Telegram ----------
async function tgSend(list) {
  if (!TG_TOKEN) return;
  for (const item of list) {
    const { method = 'sendMessage', ...payload } = item;
    if (method === 'sendMessage') Object.assign(payload, { parse_mode: 'HTML', disable_web_page_preview: true });
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) console.error('telegram', method, payload.chat_id, j.description);
    } catch (e) { console.error('telegram', method, e.message); }
  }
}
const botFor = (sec) => ((TG_TOKEN || TG_RELAY_SECRET) && TG_USERNAME ? createBot({ core, secret: sec.secret, siteUrl: SITE_URL, username: TG_USERNAME }) : null);
// Доставка исходящих сообщений: напрямую (если есть связь) или в очередь для ретранслятора.
// В режиме ретранслятора вызывать ДО сохранения базы.
function queueOut(db, out) {
  if (!TG_RELAY_SECRET || !out.length) return false;
  db.tgOutbox = (db.tgOutbox || []).concat(out).slice(-500);
  return true;
}

function makeCtx(auth, t) {
  return {
    now: () => Date.now(),
    id: () => crypto.randomBytes(8).toString('hex'),
    random: () => crypto.randomInt(0, 2 ** 32) / 2 ** 32,
    hash, verify, issueToken: auth.issueToken, checkAdmin: auth.checkAdmin,
    storage: () => ({ mode: 'yandex-object-storage', repo: BUCKET, lastSave: null, lastError: null }),
    userId: t && t.uid ? t.uid : null,
    isAdmin: !!(t && t.admin),
  };
}

// ---------- Telegram: опрос вместо вебхука ----------
// Серверы Telegram не всегда могут достучаться до российского облака (вебхук ловит «Connection timed out»),
// поэтому функция сама раз в минуту забирает обновления. Если идёт диалог — остаётся на связи
// (long polling) и отвечает сразу; в тишине выходит за доли секунды, чтобы укладываться в бесплатный лимит.
async function pollTelegram(token, sec, bot) {
  const started = Date.now();
  const auth = makeAuth(sec.secret, sec.adminPassword);
  let lastActivity = 0;
  let handled = 0;
  while (Date.now() - started < 48000) {
    const db = await loadDb(token);
    const wait = lastActivity && Date.now() - lastActivity < 25000 ? 10 : 0;
    let r;
    try {
      r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: db.tgOffset || 0, timeout: wait, allowed_updates: ['message', 'callback_query'] }),
      }).then((x) => x.json());
    } catch (e) { console.error('getUpdates', e.message); break; }
    if (!r.ok) { console.error('getUpdates', r.error_code, r.description); break; } // 409 — уже опрашивает другой экземпляр
    if (!r.result.length) { if (!wait) break; continue; }
    let out = [];
    for (const update of r.result) {
      db.tgOffset = update.update_id + 1;
      try {
        const n0 = db.notifications.length;
        const res = bot.handleUpdate(db, makeCtx(auth, null), update);
        out.push(...res.out, ...bot.pushNotifications(db, db.notifications.slice(n0), res.actingUid));
      } catch (e) { console.error('tg update', e); }
      handled++;
    }
    await s3('PUT', DB_KEY, token, JSON.stringify(db));
    await tgSend(out);
    out = [];
    lastActivity = Date.now();
  }
  return { ok: true, handled };
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
  // Таймеры: payload "poll" — забрать сообщения бота (раз в минуту), иначе — ежедневные напоминания
  if (Array.isArray(event.messages) && !event.httpMethod) {
    const token = context && context.token && context.token.access_token;
    const sec = await getSecrets(token);
    const bot = botFor(sec);
    if (!bot) return { ok: true, skipped: 'bot not configured' };
    const payload = ((event.messages[0] || {}).details || {}).payload || '';
    if (payload === 'poll') return pollTelegram(token, sec, bot);
    const db = await loadDb(token);
    const out = bot.runReminders(db, makeCtx(makeAuth(sec.secret, sec.adminPassword), null));
    if (out.length) {
      const queued = queueOut(db, out);
      await s3('PUT', DB_KEY, token, JSON.stringify(db));
      if (!queued) await tgSend(out);
    }
    return { ok: true, sent: out.length };
  }
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    if (!BUCKET) throw new Error('Не задан BUCKET');
    const token = context && context.token && context.token.access_token;
    if (!token) throw new Error('У функции нет сервисного аккаунта (нет IAM-токена)');
    const path = routeOf(event);

    if (path === '/api/health') {
      const db = await loadDb(token);
      return reply(200, { ok: true, storage: { mode: 'yandex-object-storage', bucket: BUCKET, error: null }, users: db.users.length, tgAdmins: (db.tgAdmins || []).length });
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
    const bot = botFor(sec);

    // Вебхук Telegram
    if (path === '/api/tg/webhook') {
      if (!bot || !TG_HOOK_SECRET || header(event, 'x-telegram-bot-api-secret-token') !== TG_HOOK_SECRET) return reply(403, { error: 'forbidden' });
      try {
        const db = await loadDb(token);
        const n0 = db.notifications.length;
        const { out, actingUid } = bot.handleUpdate(db, makeCtx(auth, null), body);
        out.push(...bot.pushNotifications(db, db.notifications.slice(n0), actingUid));
        await s3('PUT', DB_KEY, token, JSON.stringify(db));
        await tgSend(out);
      } catch (e) { console.error('tg update', e); }
      return reply(200, { ok: true }); // всегда 200, иначе Telegram будет повторять апдейт
    }

    // Ретранслятор (GitHub Actions): апдейт от Telegram → ответы; плюс очередь исходящих
    // Слежение за страницами (например, появление адвент-календаря): ретранслятор сообщает код ответа,
    // функция один раз уведомляет админов бота. Флаг «уже отправлено» — в базе, переживает перезапуски.
    if (path === '/api/tg/watch') {
      if (!bot || !TG_RELAY_SECRET || header(event, 'x-relay-secret') !== TG_RELAY_SECRET) return reply(403, { error: 'forbidden' });
      const db = await loadDb(token);
      const admins = db.tgAdmins || [];
      const esc = (x) => String(x || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      if (body.test) {
        const out = admins.map((chat_id) => ({ chat_id, text: `🧪 Пробное сообщение от Санта-бота.\nСлежу за страницей «${esc(body.title)}»: как только она появится, напишу сюда.\n${esc(body.url)}` }));
        return reply(200, { out, admins: admins.length });
      }
      db.tgWatch = db.tgWatch || {};
      const key = String(body.key || '').slice(0, 80);
      if (!key) throw new core.SantaError(400, 'key');
      if (body.reset) { delete db.tgWatch[key]; await s3('PUT', DB_KEY, token, JSON.stringify(db)); return reply(200, { reset: true }); }
      if (db.tgWatch[key] && !body.dry) return reply(200, { out: [], done: true, admins: admins.length });
      // Страницу проверяем отсюда (из России): зарубежные серверы GitHub до российских магазинов не достают.
      // Проверяем только адреса из списка WATCH — чтобы эндпоинт нельзя было использовать как прокси.
      const w = WATCH.find((x) => x.key === key);
      if (!w) throw new core.SantaError(404, 'unknown watch');
      Object.assign(body, w);
      let status = 0, finalUrl = '', title = '', found = false, product = null;
      try {
        const r = await fetch(w.url, { headers: { 'User-Agent': WATCH_UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
        status = r.status;
        finalUrl = r.url || '';
        const html = await r.text().catch(() => '');
        title = ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim().slice(0, 150);
        // «Появился» = код 200, адрес не увёл на другую страницу, и в заголовке/шапке есть признаки товара
        found = status === 200 && finalUrl.includes(w.slug) && w.mustContain.some((rx) => rx.test(title) || rx.test(html.slice(0, 200000).replace(/<script[\s\S]*?<\/script>/gi, '')));
        if (found && w.onSale) {
          product = shopProduct(html, w.slug);
          found = !!product && !product.archived && product.price > 0 && !/узнать о старте продаж/i.test(html);
        }
      } catch (e) { return reply(200, { out: [], done: false, status: 0, error: String(e.cause && e.cause.code || e.message), admins: admins.length }); }
      if (body.dry) return reply(200, { dry: true, status, finalUrl, title, found, product, alreadyNotified: !!db.tgWatch[key], admins: admins.length });
      if (!found) return reply(200, { out: [], done: false, status, admins: admins.length });
      db.tgWatch[key] = { at: Date.now(), url: body.url };
      // Сообщение кладём в очередь в базе (вместе с отметкой) — оно не потеряется, даже если ретранслятор упадёт.
      const head = w.onSale ? `🛒 <b>${esc(body.title)} — старт продаж!</b>${product && product.price ? `\nЦена: ${product.price} ₽` : ''}` : `🎄 <b>${esc(body.title)} появился!</b>`;
      const out = admins.map((chat_id) => ({ chat_id, text: `${head}\n${esc(body.url)}` }));
      db.tgOutbox = (db.tgOutbox || []).concat(out);
      await s3('PUT', DB_KEY, token, JSON.stringify(db));
      return reply(200, { out: [], queued: out.length, done: true, admins: admins.length });
    }

    if (path === '/api/tg/relay' || path === '/api/tg/outbox') {
      if (!bot || !TG_RELAY_SECRET || header(event, 'x-relay-secret') !== TG_RELAY_SECRET) return reply(403, { error: 'forbidden' });
      const db = await loadDb(token);
      let out = [];
      if (path === '/api/tg/relay' && body.update) {
        const n0 = db.notifications.length;
        const r = bot.handleUpdate(db, makeCtx(auth, null), body.update);
        out = r.out.concat(bot.pushNotifications(db, db.notifications.slice(n0), r.actingUid));
      }
      const queue = db.tgOutbox || [];
      if (path === '/api/tg/relay' || queue.length) {
        db.tgOutbox = [];
        await s3('PUT', DB_KEY, token, JSON.stringify(db));
      }
      return reply(200, { out: out.concat(queue) });
    }

    const t = auth.readToken(header(event, 'authorization').replace(/^Bearer\s+/i, ''));
    const ctx = makeCtx(auth, t);

    // Ссылка «Подписаться на уведомления» для личного кабинета
    if (path === '/api/tg/link') {
      if (!bot) throw new core.SantaError(404, 'Бот пока не подключён');
      if (!ctx.userId) throw new core.SantaError(401, 'Войдите в личный кабинет');
      return reply(200, { url: bot.linkUrl(ctx.userId), helpUrl: bot.linkUrl(ctx.userId, true), username: TG_USERNAME });
    }

    const db = await loadDb(token); // каждый раз свежая база: экземпляров функции может быть несколько

    // Диагностика: видит ли функция Telegram (вызывается из деплоя)
    if (path === '/api/admin/tg-check') {
      if (!ctx.isAdmin) throw new core.SantaError(401, 'Нужен вход в админку');
      const t0 = Date.now();
      try {
        const me = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`).then((x) => x.json());
        const hook = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo`).then((x) => x.json());
        return reply(200, { reachable: true, ms: Date.now() - t0, bot: me.result && me.result.username, webhook: hook.result });
      } catch (e) {
        // повторяем строго через IPv4 — вдруг мешает IPv6
        const v4 = await new Promise((resolve) => {
          const t1 = Date.now();
          const req = require('node:https').get(`https://api.telegram.org/bot${TG_TOKEN}/getMe`, { family: 4, timeout: 10000 }, (res) => {
            let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ ok: true, ms: Date.now() - t1, status: res.statusCode, body: b.slice(0, 120) }));
          });
          req.on('timeout', () => { req.destroy(new Error('timeout')); });
          req.on('error', (er) => resolve({ ok: false, ms: Date.now() - t1, error: er.code || er.message }));
        });
        return reply(200, { reachable: false, ms: Date.now() - t0, error: String(e.cause && e.cause.code || e.message), node: process.version, ipv4: v4 });
      }
    }

    // Ручной запуск напоминаний из админки (для проверки)
    if (path === '/api/admin/run-reminders' && method === 'POST') {
      if (!ctx.isAdmin) throw new core.SantaError(401, 'Нужен вход в админку');
      if (!bot) throw new core.SantaError(404, 'Бот пока не подключён');
      const out = bot.runReminders(db, ctx);
      const queued = queueOut(db, out);
      await s3('PUT', DB_KEY, token, JSON.stringify(db));
      if (!queued) await tgSend(out);
      return reply(200, { sent: out.length });
    }

    const n0 = db.notifications.length;
    const { data, mutated } = core.handle(db, ctx, method, path, body);
    if (mutated) {
      const out = bot ? bot.pushNotifications(db, db.notifications.slice(n0), null) : [];
      const queued = queueOut(db, out);
      await s3('PUT', DB_KEY, token, JSON.stringify(db));
      if (out.length && !queued) await tgSend(out);
    }
    return reply(200, data);
  } catch (e) {
    if (e instanceof core.SantaError) return reply(e.status, { error: e.message, code: e.code });
    console.error(e);
    return reply(500, { error: 'Что-то пошло не так. Кофе пролился 😢' });
  }
};

// для тестов
module.exports._internal = { routeOf, makeAuth };
