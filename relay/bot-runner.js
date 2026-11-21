'use strict';
/*
 * Ретранслятор Telegram-бота. Запускается в GitHub Actions (.github/workflows/bot.yml).
 *
 * Зачем: из Yandex Cloud нет сетевой связи с Telegram (в обе стороны), а серверы GitHub видят обоих.
 * Скрипт сам опрашивает Telegram (long polling), каждый апдейт передаёт облачной функции
 * (/api/tg/relay) и отправляет в Telegram то, что она ответила. Раз в 20 секунд забирает очередь
 * исходящих уведомлений (/api/tg/outbox): «жеребьёвка проведена», «вам подарок», напоминания о сроках.
 * Вся логика и данные — в облаке (в России); здесь только пересылка сообщений.
 *
 * Переменные: TG_BOT_TOKEN, SITE_API (адрес сайта/шлюза), RUN_MINUTES (сколько работать, по умолчанию 340).
 */
const crypto = require('node:crypto');

const TOKEN = process.env.TG_BOT_TOKEN;
const API = (process.env.SITE_API || '').replace(/\/$/, '');
const RUN_MS = (Number(process.env.RUN_MINUTES) || 340) * 60 * 1000;
if (!TOKEN || !API) { console.error('Нужны TG_BOT_TOKEN и SITE_API'); process.exit(1); }
const SECRET = crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 32);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function tg(method, payload) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(40000),
      });
      const j = await r.json();
      if (j.ok) return j.result;
      if (j.error_code === 429) { await sleep(((j.parameters || {}).retry_after || 3) * 1000); continue; }
      log('telegram', method, j.error_code, j.description);
      return null;
    } catch (e) { log('telegram', method, 'network', e.message); await sleep(2000 * attempt); }
  }
  return null;
}
async function site(path, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(API + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': SECRET },
        body: JSON.stringify(body || {}), signal: AbortSignal.timeout(60000),
      });
      if (r.ok) return r.json();
      log('site', path, r.status, (await r.text()).slice(0, 200));
      if (r.status === 403) return { out: [] };
    } catch (e) { log('site', path, 'network', e.message); }
    await sleep(2000 * attempt);
  }
  return { out: [] };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фото с сайта (ссылка /api/img на наш сервер): Telegram сам его скачать не может (нет связи с облаком),
// поэтому скачиваем здесь и загружаем в Telegram файлом.
async function sendSitePhoto(payload) {
  try {
    const r = await fetch(payload.photo, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = new Blob([await r.arrayBuffer()], { type: r.headers.get('content-type') || 'image/jpeg' });
    const fd = new FormData();
    fd.append('chat_id', String(payload.chat_id));
    if (payload.caption) fd.append('caption', payload.caption);
    fd.append('photo', blob, 'photo.jpg');
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await res.json();
    if (!j.ok) log('telegram sendPhoto (файл)', j.error_code, j.description);
  } catch (e) { log('фото с сайта не отправлено:', e.message); }
}
// Фото, присланные в бот: скачиваем из Telegram и отдаём сайту, чтобы их было видно и в личном кабинете
async function syncPhotos() {
  const need = await site('/api/tg/photos-need');
  for (const fileId of need.fileIds || []) {
    try {
      const f = await tg('getFile', { file_id: fileId });
      if (!f || !f.file_path) throw new Error('getFile');
      const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const type = /\.png$/i.test(f.file_path) ? 'image/png' : /\.webp$/i.test(f.file_path) ? 'image/webp' : 'image/jpeg';
      await site('/api/tg/photo-store', { fileId, image: `data:${type};base64,${buf.toString('base64')}` });
      log('фото из бота сохранено на сайте');
    } catch (e) {
      log('фото из бота не скачалось:', e.message);
      await site('/api/tg/photo-store', { fileId, failed: true });
    }
  }
}

async function deliver(out) {
  for (const item of out || []) {
    const { method = 'sendMessage', pin, ...payload } = item;
    if (method === 'sendMessage') Object.assign(payload, { parse_mode: 'HTML', disable_web_page_preview: true });
    if (method === 'sendPhoto' && typeof payload.photo === 'string' && /\/api\/img\?/.test(payload.photo)) { await sendSitePhoto(payload); continue; }
    const result = await tg(method, payload);
    if (pin && method === 'sendMessage' && result && result.message_id) {
      await tg('pinChatMessage', { chat_id: payload.chat_id, message_id: result.message_id, disable_notification: true });
    }
  }
}

// Слежение за страницами: проверку делает облако (из России — российские магазины закрыты для зарубежных
// серверов). Раз в минуту спрашиваем; когда страница появится, облако один раз пришлёт сообщение админам.
const WATCH = [
  { key: 'tastycoffee-advent-2027', title: 'Адвент-календарь Tasty Coffee 2027', url: 'https://shop.tastycoffee.ru/coffee/advent-music-calendar-2027' },
  { key: 'tastycoffee-advent-secret-2027-sale', title: 'Секретный адвент-календарь Tasty Coffee 2027', url: 'https://shop.tastycoffee.ru/coffee/advent-secret-calendar-2027' },
];
const watchDone = new Set();
async function checkWatch() {
  for (const w of WATCH) {
    if (watchDone.has(w.key)) continue;
    const res = await site('/api/tg/watch', { key: w.key });
    if (res.done) { watchDone.add(w.key); log('watch', w.key, 'готово'); }
    if (res.error) log('watch', w.key, 'ошибка проверки:', res.error);
    await deliver(res.out);
  }
}

(async () => {
  const me = await tg('getMe');
  if (!me) { console.error('Telegram не принял токен'); process.exit(1); }
  log(`Бот @${me.username} запущен, сайт ${API}`);
  await tg('deleteWebhook', { drop_pending_updates: false });
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Начать / привязать аккаунт' }, { command: 'cancel', description: 'Отменить текущий шаг' }] });
  await tg('setMyDescription', { description: '🎅 Тайный Санта Кофеманьяков: регистрация, анкета, кому дарить и напоминания о сроках отправки подарков.' });
  await tg('setMyShortDescription', { short_description: '🎅 Тайный Санта Кофеманьяков' });

  if (process.env.SEND_TEST === 'true') {
    const t = await site('/api/tg/watch', Object.assign({ test: true }, WATCH[0]));
    log('пробное сообщение админам:', t.admins, 'чат(ов)');
    await deliver(t.out);
  }

  const stopAt = Date.now() + RUN_MS;
  // Личный аккаунт организатора: пишет тем, у кого не подключён бот (relay/userbot.js)
  const userbot = require('./userbot.js').createUserbot({
    apiId: process.env.TG_API_ID, apiHash: process.env.TG_API_HASH, botToken: TOKEN, site, log,
  });
  const userLoop = userbot.loop(stopAt).catch((e) => log('👤 аккаунт организатора остановлен:', e.message));
  let lastWatch = 0;
  let offset = 0;
  let lastOutbox = 0;
  let handled = 0;
  while (Date.now() < stopAt) {
    if (Date.now() - lastWatch > 60000) { lastWatch = Date.now(); await checkWatch(); }
    if (Date.now() - lastOutbox > 20000) {
      lastOutbox = Date.now();
      const q = await site('/api/tg/outbox');
      if (q.out && q.out.length) { log('уведомлений из очереди:', q.out.length); await deliver(q.out); }
      await syncPhotos();
    }
    const updates = await tg('getUpdates', { offset, timeout: 20, allowed_updates: ['message', 'callback_query'] });
    if (!updates) { await sleep(3000); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      const res = await site('/api/tg/relay', { update: u });
      await deliver(res.out);
      if (u.message && u.message.photo) lastOutbox = 0; // фото из бота — сразу скачать для сайта
      handled++;
    }
    if (updates.length) log('обработано апдейтов:', handled);
  }
  await tg('getUpdates', { offset, timeout: 0 }); // подтверждаем последние апдейты
  await userLoop;
  log('Смена закончилась, обработано:', handled);
})().catch((e) => { console.error(e); process.exit(1); });
