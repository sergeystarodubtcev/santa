'use strict';
// Второй круг: подтверждение участия, подтаблица участников, «пострадавшие» с приоритетом.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

let clock = Date.parse('2026-11-20T12:00:00+03:00');
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ctx = { now: () => clock, random: rnd, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p), checkAdmin: (p) => p === 'adminpw' };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const as = (id) => ({ userId: id });
const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });
let n = 0;
const msg = (db, chat, text, from = {}) => bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: chat, type: 'private' }, from: Object.assign({ id: chat }, from), text } });
const press = (db, chat, data) => bot.handleUpdate(db, ctx, { update_id: ++n, callback_query: { id: 'c' + n, data, from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } });
const texts = (r) => r.out.filter((o) => o.text).map((o) => o.text).join('\n');
function user(db, i, extra = {}) {
  const r = call(db, 'POST', '/api/register', { name: 'P' + i, phone: '+7955200000' + i, tg: 'wave_' + i, password: 'qwerty1', pdConsent: true });
  call(db, 'POST', '/api/participate', Object.assign({ fullName: 'Игрок ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, extra), as(r.user.id));
  return r.user.id;
}

test('второй круг: без подтверждения в жеребьёвку не попадают; подтаблица в админке', () => {
  const db = core.emptyDb();
  [0, 1, 2].forEach((i) => user(db, i));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  const a = user(db, 3, { wave2: true });
  const b = user(db, 4, { wave2: true });
  // старые записи второго круга без подтверждения (до обновления) — «ждём подтверждения»
  const c = user(db, 5, { wave2: true });
  delete db.wave2[c];
  core.ensure(db);
  assert.equal(db.wave2[c].status, 'invited');
  let st = call(db, 'GET', '/api/admin/state', null, admin);
  assert.equal(st.stats.round2, 2, 'в жеребьёвку 2-го круга — только подтвердившие');
  assert.equal(st.stats.wave2Invited, 1);
  assert.deepEqual(st.wave2.map((w) => w.status).sort(), ['confirmed', 'confirmed', 'invited']);
  // кабинет: видно приглашение
  assert.equal(call(db, 'GET', '/api/me', null, as(c)).wave2.status, 'invited');
  call(db, 'POST', '/api/admin/shuffle', { round: 2 }, admin);
  const r2 = db.pairs.filter((p) => p.round === 2);
  assert.equal(r2.length, 2);
  assert.ok(!r2.some((p) => p.santaId === c || p.recipientId === c), 'неподтвердивший не в парах');
  assert.ok(r2.every((p) => [a, b].includes(p.santaId)));
  assert.throws(() => call(db, 'POST', '/api/wave2', { join: true }, as(c)), /уже прошла/);
});

test('пострадавший: Санта не отправил → во второй круг с приоритетом, получает надёжного Санту', () => {
  const db = core.emptyDb();
  const first = [0, 1, 2, 3, 4, 5].map((i) => user(db, i));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  // все, кроме одного Санты, отправили подарки
  const bad = first[0];
  const badPair = db.pairs.find((p) => p.santaId === bad);
  const victim = badPair.recipientId;
  first.filter((id) => id !== bad).forEach((id) => call(db, 'POST', '/api/sent', { track: 'T' + id }, as(id)));
  // новички второго круга
  const late = [6, 7, 8, 9].map((i) => user(db, i, { wave2: true }));
  assert.throws(() => call(db, 'POST', '/api/admin/wave2-rescue', { santaId: first[1] }, admin), /уже отметил отправку/);
  call(db, 'POST', '/api/admin/wave2-rescue', { santaId: bad }, admin);
  assert.equal(badPair.failed, true);
  assert.deepEqual([db.wave2[victim].status, db.wave2[victim].reason, db.wave2[victim].priority], ['invited', 'victim', 100]);
  const note = db.notifications.filter((x) => x.userId === victim).pop();
  assert.equal(note.action, 'wave2');
  assert.match(note.text, /в первую очередь/);
  assert.ok(db.notifications.some((x) => x.userId === '@admins' && /не отправил подарок/.test(x.text)));
  // пострадавший подтверждает через бота
  msg(db, 999, '/admin adminpw');
  const vu = db.users.find((u) => u.id === victim);
  vu.tgChatId = 5005;
  const pushed = bot.pushNotifications(db, [note], null);
  assert.equal(pushed[0].reply_markup.inline_keyboard[0][0].callback_data, 'w2:yes');
  const r = press(db, 5005, 'w2:yes');
  assert.match(texts(r), /вы во втором круге/);
  assert.equal(db.wave2[victim].status, 'confirmed');
  // ещё один участник первого круга (уже отправил подарок) приглашён и подтвердил — он «надёжный»
  const helper = first.find((id) => id !== bad && id !== victim);
  call(db, 'POST', '/api/admin/wave2-set', { userId: helper, action: 'invite' }, admin);
  call(db, 'POST', '/api/wave2', { join: true }, as(helper));
  // приоритет — в начале подтаблицы
  assert.equal(call(db, 'GET', '/api/admin/state', null, admin).wave2[0].userId, victim);
  // много раз мешаем: Санта пострадавшего — всегда тот, кто уже отправил подарок в первом круге
  for (let k = 0; k < 30; k++) {
    seed = k + 7;
    call(db, 'POST', '/api/admin/shuffle', { round: 2 }, admin);
    const p = db.pairs.find((x) => x.round === 2 && x.recipientId === victim);
    assert.ok(p && p.priority, 'пара с приоритетом');
    assert.equal(p.santaId, helper, 'надёжный Санта (отправил в первом круге), не новичок');
    assert.ok(db.pairs.filter((x) => x.round === 2).every((x) => x.santaId !== x.recipientId));
    assert.equal(db.pairs.filter((x) => x.round === 2).length, 6);
  }
  const santaOfVictim = db.pairs.find((x) => x.round === 2 && x.recipientId === victim).santaId;
  assert.match(db.notifications.filter((x) => x.userId === santaOfVictim).pop().text, /в приоритете/);
  // у пострадавшего две пары: в кабинете — актуальная (второй круг), отправка отмечается в ней
  const me = call(db, 'GET', '/api/me', null, as(victim));
  assert.equal(me.assignment.round, 2);
  call(db, 'POST', '/api/sent', { track: 'V2' }, as(victim));
  assert.equal(db.pairs.find((x) => x.round === 2 && x.santaId === victim).status, 'sent');
  assert.equal(db.pairs.find((x) => x.round !== 2 && x.santaId === victim).track, 'T' + victim, 'посылка первого круга не тронута');
  // получение: подарок второго круга
  call(db, 'POST', '/api/sent', {}, as(santaOfVictim));
  call(db, 'POST', '/api/received', {}, as(victim));
  assert.equal(db.pairs.find((x) => x.round === 2 && x.recipientId === victim).status, 'received');
});

test('организатор: пригласить, подтвердить за участника, снять приоритет, убрать', () => {
  const db = core.emptyDb();
  const ids = [0, 1, 2].map((i) => user(db, i));
  assert.throws(() => call(db, 'POST', '/api/admin/wave2-set', { userId: ids[0], action: 'invite' }, admin), /после первой жеребьёвки/);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave2-set', { userId: ids[0], action: 'invite' }, admin);
  assert.equal(db.wave2[ids[0]].status, 'invited');
  assert.equal(db.notifications.filter((x) => x.userId === ids[0]).pop().action, 'wave2');
  call(db, 'POST', '/api/admin/wave2-set', { userId: ids[0], action: 'confirm' }, admin);
  assert.equal(db.wave2[ids[0]].status, 'confirmed');
  call(db, 'POST', '/api/admin/wave2-set', { userId: ids[0], action: 'priority' }, admin);
  assert.equal(db.wave2[ids[0]].priority, 100);
  call(db, 'POST', '/api/admin/wave2-set', { userId: ids[0], action: 'priority' }, admin);
  assert.equal(db.wave2[ids[0]].priority, 0);
  call(db, 'POST', '/api/wave2', { join: false }, as(ids[0]));
  assert.equal(db.wave2[ids[0]].status, 'declined');
  call(db, 'POST', '/api/admin/wave2-set', { userId: ids[0], action: 'remove' }, admin);
  assert.equal(db.wave2[ids[0]], undefined);
});

test('анкета через бота после первой жеребьёвки — это и подтверждение второго круга', () => {
  const db = core.emptyDb();
  [0, 1].forEach((i) => user(db, i));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  const r = call(db, 'POST', '/api/register', { name: 'Bot', phone: '+79552999999', tg: 'bot_user', password: 'qwerty1', pdConsent: true });
  db.users.find((u) => u.id === r.user.id).tgChatId = 7007;
  press(db, 7007, 'form');
  msg(db, 7007, 'Ботов Бот');
  msg(db, 7007, 'ПВЗ Ozon, Казань, Баумана 1');
  press(db, 7007, 'skip');
  press(db, 7007, 'prefs:any');
  const last = press(db, 7007, 'skip');
  assert.match(texts(last), /второй круг/);
  press(db, 7007, 'agree');
  assert.equal(db.wave2[r.user.id].status, 'confirmed');
});
