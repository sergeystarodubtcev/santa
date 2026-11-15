'use strict';
// Анонимная переписка Санта ↔ получатель, «Дополнить пожелания», уведомление Санте о правке анкеты.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

const clock = Date.parse('2026-12-05T12:00:00+03:00');
const ctx = { now: () => clock, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p) };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const bot = createBot({ core, secret: 's', siteUrl: 'https://santa.example', username: 'b' });

function seed(draw = true) {
  const db = core.emptyDb();
  const ids = [0, 1, 2].map((i) => {
    const r = call(db, 'POST', '/api/register', { name: 'Чат' + i, phone: '+795592000' + i, tg: 'chat_u' + i, password: 'qwerty1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Чатов ' + i, address: 'ПВЗ Ozon, Казань ' + i, wishes: 'кофе', agree: true }, { userId: r.user.id });
    db.users.find((u) => u.id === r.user.id).tgChatId = 700 + i;
    return r.user.id;
  });
  if (draw) { call(db, 'POST', '/api/admin/shuffle', {}, admin); call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin); }
  return { db, ids };
}
const pairOf = (db, santaId) => db.pairs.find((p) => p.santaId === santaId);

test('до жеребьёвки писать некому', () => {
  const { db, ids } = seed(false);
  assert.throws(() => call(db, 'POST', '/api/msg', { to: 'recipient', text: 'привет' }, { userId: ids[0] }), /нет получателя/);
});

test('Санта пишет получателю, тот отвечает — анонимно, с кнопкой «Ответить»', () => {
  const { db, ids } = seed();
  const santa = ids[0];
  const rec = pairOf(db, santa).recipientId;
  const n0 = db.notifications.length;
  assert.throws(() => call(db, 'POST', '/api/msg', { to: 'recipient', text: '  ' }, { userId: santa }), /Напишите/);
  const meS = call(db, 'POST', '/api/msg', { to: 'recipient', round: 1, text: 'Какую обжарку любишь?' }, { userId: santa });
  assert.deepEqual(meS.assignments[0].messages.map((m) => [m.from, m.text]), [['santa', 'Какую обжарку любишь?']]);
  const nt = db.notifications.slice(n0).find((n) => n.userId === rec);
  assert.ok(nt && /Ваш Тайный Санта пишет/.test(nt.text) && !nt.text.includes('Чат0'), 'имя Санты не раскрыто');
  assert.deepEqual(nt.msg, { round: 1, reply: 'santa' });
  const out = bot.pushNotifications(db, [nt], null);
  const btn = out[0].reply_markup.inline_keyboard[0][0];
  assert.deepEqual([btn.text, btn.callback_data], ['↩️ Ответить Санте', 'msg:s:1']);
  // получатель отвечает через бот
  const chat = db.users.find((u) => u.id === rec).tgChatId;
  let n = 0;
  bot.handleUpdate(db, ctx, { update_id: ++n, callback_query: { id: 'c', data: 'msg:s:1', from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } });
  const n1 = db.notifications.length;
  bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: chat, type: 'private' }, from: { id: chat }, text: 'Светлую!' } });
  const back = db.notifications.slice(n1).find((x) => x.userId === santa);
  assert.ok(back && /Ваш получатель пишет: «Светлую!»/.test(back.text));
  assert.equal(bot.pushNotifications(db, [back], null)[0].reply_markup.inline_keyboard[0][0].callback_data, 'msg:r:1');
  const meR = call(db, 'GET', '/api/me', null, { userId: rec });
  assert.deepEqual(meR.incomings[0].messages.map((m) => m.from), ['santa', 'recipient']);
  // третий участник переписку не видит
  const other = ids.find((x) => x !== santa && x !== rec);
  const meO = call(db, 'GET', '/api/me', null, { userId: other });
  assert.ok(!JSON.stringify(meO).includes('Светлую'));
  // бэкап без текстов переписки
  assert.equal(typeof call(db, 'GET', '/api/admin/export', null, admin).messages, 'number');
});

test('лимит 30 сообщений в сутки', () => {
  const { db, ids } = seed();
  for (let i = 0; i < 30; i++) call(db, 'POST', '/api/msg', { to: 'recipient', text: 'm' + i }, { userId: ids[0] });
  assert.throws(() => call(db, 'POST', '/api/msg', { to: 'recipient', text: 'ещё' }, { userId: ids[0] }), /Слишком много/);
});

test('«Дополнить пожелания» и правка анкеты — Санте уведомление', () => {
  const { db, ids } = seed();
  const rec = ids[1];
  const santa = db.pairs.find((p) => p.recipientId === rec).santaId;
  const n0 = db.notifications.length;
  call(db, 'POST', '/api/wishes-add', { text: 'без кружек' }, { userId: rec });
  assert.match(db.participations[rec].wishes, /кофе\n➕ без кружек/);
  assert.ok(db.notifications.slice(n0).some((n) => n.userId === santa && /дополнил пожелания: «без кружек»/.test(n.text)));
  const meS = call(db, 'GET', '/api/me', null, { userId: santa });
  assert.match(meS.assignments[0].recipient.wishes, /без кружек/);
  const n1 = db.notifications.length;
  call(db, 'POST', '/api/participate', { fullName: 'Чатов 1', address: 'ПВЗ Ozon, Казань 99', wishes: 'чай', agree: true }, { userId: rec });
  const upd = db.notifications.slice(n1).find((n) => n.userId === santa);
  assert.ok(upd && /обновил анкету: пожелания, адрес ПВЗ/.test(upd.text), upd && upd.text);
});

test('бот: кнопка «💬 Переписка» и «Написать получателю» под «Кому я дарю»', () => {
  const { db, ids } = seed();
  const chat = 700;
  let n = 0;
  const r1 = bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: chat, type: 'private' }, from: { id: chat }, text: '💬 Переписка' } });
  const m = r1.out[0];
  assert.match(m.text, /Анонимная переписка/);
  assert.ok(m.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'msg:r:1'));
  assert.ok(m.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'msg:s:1'));
  assert.ok(ids.length);
});

test('бот организатора: «🔎 Досье» по @нику — кто кому дарит, анкета, статусы', () => {
  const { db, ids } = seed();
  const ctxA = Object.assign({}, ctx, { checkAdmin: (p) => p === 'pw' });
  let n = 100;
  const say = (text) => bot.handleUpdate(db, ctxA, { update_id: ++n, message: { message_id: n, chat: { id: 990, type: 'private' }, from: { id: 990 }, text } }).out;
  say('/admin pw');
  const pair = pairOf(db, ids[0]);
  call(db, 'POST', '/api/sent', { round: 1, track: 'TRK-77' }, { userId: ids[0] });
  assert.match(say('🔎 Досье')[0].text, /Пришлите @ник/);
  const t = say('@chat_u0')[0].text;
  assert.match(t, /Досье: Чат0/);
  assert.match(t, /ФИО: Чатов 0/);
  const rec = db.users.find((u) => u.id === pair.recipientId);
  assert.ok(t.includes('Дарит') && t.includes('@' + rec.tg), 'кому дарит');
  assert.match(t, /отправлено .*трек TRK-77/);
  assert.match(t, /Ему дарит/);
  // по телефону и несколько совпадений
  assert.match(say('+7955920001')[0].text, /Досье: Чат1/);
  const many = say('чат')[0];
  assert.match(many.text, /Нашёл 3/);
  const id = many.reply_markup.inline_keyboard[1][0].callback_data;
  const r = bot.handleUpdate(db, ctxA, { update_id: ++n, callback_query: { id: 'q', data: id, from: { id: 990 }, message: { chat: { id: 990, type: 'private' } } } }).out;
  assert.match(r.map((o) => o.text || '').join(' '), /Досье: Чат1/);
  assert.match(say('/who @nobody_here')[0].text, /Никого не нашёл/);
  // не админ досье не получает
  const stranger = bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: 701, type: 'private' }, from: { id: 701 }, text: '/who @chat_u0' } }).out;
  assert.ok(!stranger.some((o) => /Досье/.test(o.text || '')));
});
