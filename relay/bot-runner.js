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

async function deliver(out) {
  for (const item of out || []) {
    const { method = 'sendMessage', ...payload } = item;
    if (method === 'sendMessage') Object.assign(payload, { parse_mode: 'HTML', disable_web_page_preview: true });
    await tg(method, payload);
  }
}

// Слежение за страницами: проверку делает облако (из России — российские магазины закрыты для зарубежных
// серверов). Раз в минуту спрашиваем; когда страница появится, облако один раз пришлёт сообщение админам.
const WATCH = [{ key: 'tastycoffee-advent-2027', title: 'Адвент-календарь Tasty Coffee 2027', url: 'https://shop.tastycoffee.ru/coffee/advent-music-calendar-2027' }];
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
    }
    const updates = await tg('getUpdates', { offset, timeout: 20, allowed_updates: ['message', 'callback_query'] });
    if (!updates) { await sleep(3000); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      const res = await site('/api/tg/relay', { update: u });
      await deliver(res.out);
      handled++;
    }
    if (updates.length) log('обработано апдейтов:', handled);
  }
  await tg('getUpdates', { offset, timeout: 0 }); // подтверждаем последние апдейты
  log('Смена закончилась, обработано:', handled);
})().catch((e) => { console.error(e); process.exit(1); });
