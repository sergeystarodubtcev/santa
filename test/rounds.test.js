'use strict';
// Второй круг, рассылки с выбором людей, вопрос «будете участвовать?» тем, кто без анкеты.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

let clock = Date.parse('2026-11-20T12:00:00+03:00');
const ctx = { now: () => clock, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p), checkAdmin: (p) => p === 'adminpw' };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });
let n = 0;
const msg = (db, chat, text, from = {}) => bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: chat, type: 'private' }, from: Object.assign({ id: chat }, from), text } });
const press = (db, chat, data) => bot.handleUpdate(db, ctx, { update_id: ++n, callback_query: { id: 'c' + n, data, from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } });
const texts = (r) => r.out.filter((o) => o.text).map((o) => o.text).join('\n');
function user(db, i, form = true) {
  const r = call(db, 'POST', '/api/register', { name: 'P' + i, phone: '+7955100000' + i, tg: 'player_' + i, password: 'qwerty1', pdConsent: true });
  if (form) call(db, 'POST', '/api/participate', { fullName: 'Игрок ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, { userId: r.user.id });
  return r.user.id;
}

test('второй круг: запись после первой жеребьёвки, своя жеребьёвка и свои сроки', () => {
  const db = core.emptyDb();
  const first = [0, 1, 2].map((i) => user(db, i));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  const late = [3, 4, 5].map((i) => user(db, i));
  late.forEach((id) => assert.equal(db.participations[id].round, 2));
  assert.equal(call(db, 'GET', '/api/admin/state', null, admin).stats.round2, 3);
  // во втором круге своя жеребьёвка, первый круг не трогаем
  const pairs1 = JSON.stringify(db.pairs);
  call(db, 'POST', '/api/admin/shuffle', { round: 2 }, admin);
  assert.equal(db.pairs.length, 6);
  assert.equal(JSON.stringify(db.pairs.filter((p) => p.round !== 2)), pairs1);
  for (const p of db.pairs.filter((x) => x.round === 2)) {
    assert.ok(late.includes(p.santaId) && late.includes(p.recipientId), 'второй круг дарит друг другу');
  }
  for (const p of db.pairs.filter((x) => x.round !== 2)) assert.ok(first.includes(p.recipientId));
  // свои сроки: в дедлайне используется даты второго круга
  call(db, 'POST', '/api/admin/settings', { round2SendStart: '2026-12-12T00:00:00+03:00', round2SendEnd: '2026-12-22T23:59:59+03:00' }, admin);
  clock = Date.parse('2026-12-20T12:00:00+03:00');
  assert.match(call(db, 'GET', '/api/me', null, { userId: late[0] }).deadline.text, /У ВАС 3 ДНЯ/);
  assert.match(call(db, 'GET', '/api/me', null, { userId: first[0] }).deadline.text, /Срок отправки прошёл/);
  // после второй жеребьёвки запись закрыта
  const r = call(db, 'POST', '/api/register', { name: 'Late', phone: '+79551999999', tg: 'very_late', password: 'qwerty1', pdConsent: true });
  assert.throws(() => call(db, 'POST', '/api/participate', { fullName: 'Поздний', address: 'ПВЗ Ozon, Казань', agree: true }, { userId: r.user.id }), /Обе жеребьёвки/);
  // сброс второго круга не трогает первый
  call(db, 'POST', '/api/admin/reset', { round: 2 }, admin);
  assert.equal(db.pairs.length, 3);
  assert.ok(db.drawnAt && !db.drawn2At);
  clock = Date.parse('2026-11-20T12:00:00+03:00');
});

test('рассылка: выбранным людям, только на сайт или только в Telegram, удаление из кабинетов', () => {
  const db = core.emptyDb();
  const ids = [0, 1, 2].map((i) => user(db, i));
  msg(db, 700, '/start', { username: 'player_0' });
  // только выбранным и только в Telegram
  let n0 = db.notifications.length;
  call(db, 'POST', '/api/admin/broadcast', { text: 'Только в телегу', userIds: [ids[0], ids[1]], site: false, tg: true }, admin);
  let fresh = db.notifications.slice(n0);
  assert.equal(fresh.length, 2);
  assert.ok(!call(db, 'GET', '/api/me', null, { userId: ids[0] }).notifications.some((x) => /Только в телегу/.test(x.text)), 'на сайте не видно');
  assert.ok(bot.pushNotifications(db, fresh, null).some((o) => o.chat_id === 700 && /Только в телегу/.test(o.text)));
  // только на сайт
  n0 = db.notifications.length;
  const r = call(db, 'POST', '/api/admin/broadcast', { text: 'Только на сайт', userIds: [ids[0]], site: true, tg: false }, admin);
  fresh = db.notifications.slice(n0);
  assert.equal(bot.pushNotifications(db, fresh, null).length, 0, 'в Telegram не уходит');
  assert.ok(call(db, 'GET', '/api/me', null, { userId: ids[0] }).notifications.some((x) => /Только на сайт/.test(x.text)));
  assert.throws(() => call(db, 'POST', '/api/admin/broadcast', { text: 'x', userIds: [], site: true }, admin), /Никто не выбран/);
  assert.throws(() => call(db, 'POST', '/api/admin/broadcast', { text: 'x', userIds: ids, site: false, tg: false }, admin), /куда отправить/);
  // история и удаление
  const st = call(db, 'GET', '/api/admin/state', null, admin);
  assert.equal(st.broadcasts.length, 2);
  assert.equal(st.broadcasts[0].text, 'Только на сайт');
  call(db, 'POST', '/api/admin/broadcast-delete', { id: r.id }, admin);
  assert.ok(!call(db, 'GET', '/api/me', null, { userId: ids[0] }).notifications.some((x) => /Только на сайт/.test(x.text)));
  assert.equal(call(db, 'GET', '/api/admin/state', null, admin).broadcasts.length, 1);
});

test('бот спрашивает тех, кто без анкеты: заполнить или удалиться; в журнале — «не создал анкету»', () => {
  const db = core.emptyDb();
  msg(db, 999, '/admin adminpw');
  const a = user(db, 1, false);
  const b = user(db, 2, false);
  msg(db, 801, '/start', { username: 'player_1' });
  msg(db, 802, '/start', { username: 'player_2' });
  assert.equal(bot.runReminders(db, ctx).length, 0, 'в первые сутки не дёргаем');
  clock += 25 * 3600e3;
  let out = bot.runReminders(db, ctx);
  assert.equal(out.length, 2);
  assert.match(out[0].text, /не заполнили анкету[\s\S]*Будете участвовать/);
  assert.equal(bot.runReminders(db, ctx).length, 0, 'спрашиваем один раз');
  // второй отказывается
  let r = press(db, 802, 'noform_del');
  assert.match(texts(r), /Точно удалить аккаунт/);
  r = press(db, 802, 'noform_del_yes');
  assert.match(texts(r), /аккаунт удалён, данные стёрты/);
  assert.ok(!db.users.some((u) => u.id === b));
  assert.ok(db.notifications.some((x) => x.userId === '@admins' && /P2 @player_2 .* не создал анкету — удалился самостоятельно/.test(x.text)));
  // первый соглашается — открывается анкета
  r = press(db, 801, 'form');
  assert.match(texts(r), /ФИО получателя/);
  assert.ok(db.users.some((u) => u.id === a));
  clock = Date.parse('2026-11-20T12:00:00+03:00');
});
