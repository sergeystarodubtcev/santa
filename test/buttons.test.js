'use strict';
// Кнопки под рассылкой, шаблон «сроки изменены», новая волна только с датами организатора.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

const clock = Date.parse('2026-12-05T12:00:00+03:00');
const ctx = { now: () => clock, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p) };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const bot = createBot({ core, secret: 's', siteUrl: 'https://santa.example', username: 'b' });
function seed() {
  const db = core.emptyDb();
  const ids = [0, 1, 2].map((i) => {
    const r = call(db, 'POST', '/api/register', { name: 'Кнопка' + i, phone: '+795591000' + i, tg: 'btn_u' + i, password: 'qwerty1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Кнопка ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, { userId: r.user.id });
    db.users.find((u) => u.id === r.user.id).tgChatId = 600 + i;
    return r.user.id;
  });
  return { db, ids };
}

test('рассылка с кнопками: в боте — кнопки Telegram, на сайте — в уведомлении; кривая ссылка — отказ', () => {
  const { db, ids } = seed();
  assert.throws(() => call(db, 'POST', '/api/admin/broadcast', { text: 'x', userIds: ids, buttons: [{ text: 'Плохо', url: 'javascript:alert(1)' }] }, admin), /https:\/\//);
  const n0 = db.notifications.length;
  call(db, 'POST', '/api/admin/broadcast', { text: '{имя}, отправка с {начало} по {срок}', userIds: ids, buttons: [{ kind: 'sent' }, { kind: 'wave' }, { kind: 'nope' }, { text: 'Пост', url: 'https://t.me/c/1' }] }, admin);
  const fresh = db.notifications.slice(n0);
  assert.equal(fresh[0].text, 'Кнопка0, отправка с 1 декабря по 10 декабря', '{начало} и {срок} подставлены');
  assert.deepEqual(fresh[0].buttons.map((b) => b.kind || b.url), ['sent', 'wave', 'https://t.me/c/1'], 'неизвестная кнопка отброшена');
  const out = bot.pushNotifications(db, fresh, null);
  const kb = out[0].reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.callback_data || b.url), ['sent', 'wave', 'https://t.me/c/1']);
  // на сайте уведомление приходит с кнопками
  assert.equal(call(db, 'GET', '/api/me', null, { userId: ids[0] }).notifications[0].buttons.length, 3);
  // без кнопок — как раньше
  const n1 = db.notifications.length;
  call(db, 'POST', '/api/admin/broadcast', { text: 'просто текст', userIds: [ids[0]] }, admin);
  assert.equal(bot.pushNotifications(db, db.notifications.slice(n1), null)[0].reply_markup, undefined);
  assert.ok(db.broadcasts.find((b) => b.buttons && b.buttons.length === 3), 'кнопки видны в истории рассылок');
  // «🌐 Открыть сайт» — ссылка на кабинет
  const n2 = db.notifications.length;
  call(db, 'POST', '/api/admin/broadcast', { text: 'сайт', userIds: [ids[0]], buttons: [{ kind: 'site' }] }, admin);
  assert.equal(bot.pushNotifications(db, db.notifications.slice(n2), null)[0].reply_markup.inline_keyboard[0][0].url, 'https://santa.example/cabinet.html');
});

test('новая волна создаётся только с датами от организатора', () => {
  const { db } = seed();
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  assert.throws(() => call(db, 'POST', '/api/admin/wave-create', {}, admin), /Укажите даты/);
  assert.throws(() => call(db, 'POST', '/api/admin/wave-create', { start: '2026-12-20T00:00:00+03:00', end: '2026-12-11T00:00:00+03:00' }, admin), /раньше начала/);
  call(db, 'POST', '/api/admin/wave-create', { start: '2026-12-14T00:00:00+03:00', end: '2026-12-24T23:59:59+03:00', drawAt: '2026-12-12T00:00:00+03:00' }, admin);
  const w = db.waves[1];
  assert.deepEqual([w.n, w.start, w.end, w.drawAt], [2, '2026-12-14T00:00:00+03:00', '2026-12-24T23:59:59+03:00', '2026-12-12T00:00:00+03:00']);
});

test('бот организатора: готовое напоминание уходит с подходящей кнопкой', () => {
  const { db } = seed();
  const ctxA = Object.assign({}, ctx, { checkAdmin: (p) => p === 'adminpw' });
  let n = 0;
  const msg = (text) => bot.handleUpdate(db, ctxA, { update_id: ++n, message: { message_id: n, chat: { id: 990, type: 'private' }, from: { id: 990 }, text } });
  const press = (data) => bot.handleUpdate(db, ctxA, { update_id: ++n, callback_query: { id: 'c' + n, data, from: { id: 990 }, message: { chat: { id: 990, type: 'private' } } } });
  msg('/admin adminpw');
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  press('adm:r:notsent:1');
  const n0 = db.notifications.length;
  press('adm:go');
  const fresh = db.notifications.slice(n0).filter((x) => x.kind === 'admin');
  assert.ok(fresh.length && fresh.every((x) => x.buttons && x.buttons[0].kind === 'sent'));
});

test('дополнительные кнопки доставляются, переписки открываются по направлению, лимит явный', () => {
  const { db, ids } = seed();
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  const kinds = ['help', 'chat', 'chatSanta', 'chatRecipient', 'wishes', 'track', 'raffle', 'profile', 'rules'];
  const before = db.notifications.length;
  call(db, 'POST', '/api/admin/broadcast', { text: 'Тест', userIds: [ids[0]], buttons: kinds.map((kind) => ({ kind })) }, admin);
  const [notice] = bot.pushNotifications(db, db.notifications.slice(before), null);
  assert.deepEqual(notice.reply_markup.inline_keyboard.flat().map((b) => b.callback_data || b.url), [
    'support', 'chat', 'chat:s', 'chat:r', 'addwish', 'https://santa.example/cabinet.html#gift', 'raffle:menu',
    'https://santa.example/cabinet.html#profile', 'https://santa.example/#rules',
  ]);
  const press = (data) => bot.handleUpdate(db, ctx, { callback_query: { id: 'test', data, from: { id: 600 },
    message: { chat: { id: 600, type: 'private' } } } }).out.flatMap((msg) => msg.reply_markup?.inline_keyboard?.flat() || []);
  assert.deepEqual(press('chat:s').map((b) => b.callback_data), ['msg:s:1']);
  assert.deepEqual(press('chat:r').map((b) => b.callback_data), ['msg:r:1']);
  assert.ok(press('chat').some((b) => b.callback_data === 'msg:r:1'));
  assert.throws(() => call(db, 'POST', '/api/admin/broadcast', { text: 'Тест', userIds: ids,
    buttons: Object.keys(core.BUTTON_KINDS).map((kind) => ({ kind })) }, admin), /до 10 кнопок/);
});
