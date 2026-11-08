'use strict';
// Сценарии Telegram-бота без настоящего Telegram: проверяем, что он отвечает и что меняется в базе.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

let clock = Date.parse('2026-11-20T12:00:00+03:00');
const ctx = {
  now: () => clock,
  hash: (p) => 'h:' + p,
  verify: (p, h) => h === 'h:' + p,
  issueToken: (p) => JSON.stringify(p),
  checkAdmin: (p) => p === 'adminpw',
};
const bot = createBot({ core, secret: 's3cret', siteUrl: 'https://santa.example', username: 'kofesanta_bot' });

let upd = 0;
const msg = (db, chatId, text, from = {}) => bot.handleUpdate(db, ctx, { update_id: ++upd, message: { chat: { id: chatId, type: 'private' }, from: Object.assign({ id: chatId }, from), text } });
const contact = (db, chatId, phone) => bot.handleUpdate(db, ctx, { update_id: ++upd, message: { chat: { id: chatId, type: 'private' }, from: { id: chatId }, contact: { phone_number: phone } } });
const press = (db, chatId, data, from = {}) => bot.handleUpdate(db, ctx, { update_id: ++upd, callback_query: { id: 'cb' + upd, data, from: Object.assign({ id: chatId }, from), message: { chat: { id: chatId, type: 'private' } } } });
const texts = (r) => r.out.filter((o) => o.text).map((o) => o.text).join('\n---\n');
const site = (db, method, path, body, as) => core.handle(db, Object.assign({}, ctx, as), method, path, body).data;

test('регистрация и анкета прямо в боте', () => {
  const db = core.emptyDb();
  let r = msg(db, 100, '/start', { username: 'New_Guy' });
  assert.match(texts(r), /Не нашёл на сайте аккаунт с ником @new_guy/);
  r = press(db, 100, 'reg', { username: 'New_Guy' });
  assert.match(texts(r), /Как вас зовут/);
  msg(db, 100, 'Петя');
  r = contact(db, 100, '+7 (911) 222-33-44');
  assert.match(texts(r), /согласие на обработку персональных данных/);
  r = msg(db, 100, 'да');
  assert.match(texts(r), /нажмите кнопку/);
  assert.equal(db.users.length, 0, 'без кнопки согласия аккаунт не создаётся');
  r = press(db, 100, 'consent', { username: 'New_Guy' });
  assert.match(texts(r), /Аккаунт создан[\s\S]*@new_guy[\s\S]*пароль/);
  const u = db.users[0];
  assert.equal(u.tg, 'new_guy');
  assert.equal(u.phone, '+79112223344');
  assert.equal(u.tgChatId, 100);
  assert.ok(u.pdConsentAt);
  // анкета
  assert.match(texts(r), /ФИО получателя/);
  r = msg(db, 100, 'Петров Пётр Петрович');
  assert.match(texts(r), /пункта выдачи Ozon/);
  msg(db, 100, 'Москва, Ленина 5, кв. 7');
  r = press(db, 100, 'skip');
  r = press(db, 100, 'prefs:coffee');
  r = press(db, 100, 'skip');
  r = press(db, 100, 'agree');
  assert.match(texts(r), /только адрес пункта выдачи/i);
  assert.match(texts(r), /пункта выдачи Ozon/); // вернулись к шагу адреса
  msg(db, 100, 'ПВЗ Ozon, Москва, Тверская 7');
  press(db, 100, 'skip');
  press(db, 100, 'prefs:noncoffee');
  msg(db, 100, 'аллергия на инфьюзы');
  r = press(db, 100, 'agree');
  assert.match(texts(r), /Анкета сохранена[\s\S]*на модерации/);
  const p = db.participations[u.id];
  assert.equal(p.address, 'ПВЗ Ozon, Москва, Тверская 7');
  assert.equal(p.prefs, 'noncoffee');
  assert.equal(p.notes, 'аллергия на инфьюзы');
  assert.equal(p.moderation, 'pending');
});

test('привязка: по нику автоматически и по ссылке из личного кабинета; админ и модерация кнопками', () => {
  const db = core.emptyDb();
  const a = site(db, 'POST', '/api/register', { name: 'Аня', phone: '+79000000001', tg: 'anya_v60', password: 'qwerty1', pdConsent: true });
  const b = site(db, 'POST', '/api/register', { name: 'Боря', phone: '+79000000002', tg: 'borya_site', password: 'qwerty1', pdConsent: true });
  // по нику
  let r = msg(db, 201, '/start', { username: 'Anya_V60' });
  assert.match(texts(r), /Привет, <b>Аня<\/b>! ☕[\s\S]*Напомню, когда начнётся жеребьёвка/);
  assert.equal(db.users.find((u) => u.id === a.user.id).tgChatId, 201);
  // по ссылке из ЛК (ник в телеге другой)
  const url = bot.linkUrl(b.user.id);
  assert.match(url, /^https:\/\/t\.me\/kofesanta_bot\?start=[A-Za-z0-9_-]+$/);
  assert.ok(url.split('start=')[1].length <= 64);
  r = msg(db, 202, '/start ' + url.split('start=')[1], { username: 'other_nick' });
  assert.match(texts(r), /Привет, <b>Боря<\/b>/);
  assert.equal(db.users.find((u) => u.id === b.user.id).tgChatId, 202);
  // поддельная ссылка не работает
  r = msg(db, 203, '/start ' + b.user.id + '_forged', { username: 'hacker' });
  assert.match(texts(r), /Не нашёл/);
  // админ
  assert.match(texts(msg(db, 999, '/admin wrong')), /Неверный/);
  assert.match(texts(msg(db, 999, '/admin adminpw')), /вы админ/);
  // новая анкета → админу с кнопками
  const n0 = db.notifications.length;
  site(db, 'POST', '/api/participate', { fullName: 'Анна Смирнова', address: 'ПВЗ Ozon 1', agree: true }, { userId: a.user.id });
  const pushed = bot.pushNotifications(db, db.notifications.slice(n0), null);
  const toAdmin = pushed.find((o) => o.chat_id === 999);
  assert.match(toAdmin.text, /Новая анкета на модерации[\s\S]*@anya_v60/);
  assert.equal(toAdmin.reply_markup.inline_keyboard[0][0].callback_data, `mod:approved:${a.user.id}`);
  assert.ok(pushed.find((o) => o.chat_id === 201), 'участнику тоже приходит уведомление');
  // не-админ не может модерировать
  press(db, 201, `mod:approved:${a.user.id}`);
  assert.equal(db.participations[a.user.id].moderation, 'pending');
  r = press(db, 999, `mod:approved:${a.user.id}`);
  assert.match(texts(r), /Одобрено: @anya_v60/);
  assert.equal(db.participations[a.user.id].moderation, 'approved');
});

function drawnDb() {
  const db = core.emptyDb();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = site(db, 'POST', '/api/register', { name: 'Юзер' + i, phone: '+7955000000' + i, tg: 'santa_user' + i, password: 'qwerty1', pdConsent: true });
    site(db, 'POST', '/api/participate', { fullName: 'Юзер Санта ' + i, address: 'ПВЗ Ozon ' + i, agree: true, wishes: 'дрипы' }, { userId: r.user.id });
    ids.push(r.user.id);
    msg(db, 300 + i, '/start', { username: 'santa_user' + i });
  }
  msg(db, 999, '/admin adminpw');
  site(db, 'POST', '/api/admin/approve-all', {}, { isAdmin: true });
  const n0 = db.notifications.length;
  site(db, 'POST', '/api/admin/shuffle', {}, { isAdmin: true });
  return { db, ids, n0 };
}

test('после жеребьёвки: уведомление с кнопкой «Узнать кому», отправка и «Вам подарок от Деда Мороза»', () => {
  const { db, ids, n0 } = drawnDb();
  const pushed = bot.pushNotifications(db, db.notifications.slice(n0), null);
  const m = pushed.find((o) => o.chat_id === 300);
  assert.match(m.text, /Жеребьёвка проведена/);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, 'whom');
  let r = press(db, 300, 'whom');
  const pair = db.pairs.find((p) => p.santaId === ids[0]);
  const rec = db.users.find((u) => u.id === pair.recipientId);
  assert.match(texts(r), new RegExp(`Тайный Санта для <b>${rec.name}</b>[\\s\\S]*ПВЗ Ozon[\\s\\S]*@${rec.tg}`));
  // отправил с трек-номером
  press(db, 300, 'sent');
  const n1 = db.notifications.length;
  r = msg(db, 300, 'TRACK-777');
  assert.match(texts(r), /подарок отправлен/);
  assert.equal(pair.status, 'sent');
  assert.equal(pair.track, 'TRACK-777');
  const toRec = bot.pushNotifications(db, db.notifications.slice(n1), r.actingUid).find((o) => o.chat_id === rec.tgChatId);
  assert.match(toRec.text, /Вам подарок от Деда Мороза/);
  assert.equal(toRec.reply_markup.inline_keyboard[0][0].callback_data, 'received');
  r = press(db, rec.tgChatId, 'received');
  assert.match(texts(r), /подарок получен/);
  assert.equal(pair.status, 'received');
});

test('напоминания: старт отправки, за 7/5/3/2 дня, последний день + админу, просрочка', () => {
  const { db, ids } = drawnDb();
  const at = (iso) => { clock = Date.parse(iso); return bot.runReminders(db, ctx); };
  assert.equal(at('2026-11-25T12:00:00+03:00').length, 0, 'до старта тишина');
  let out = at('2026-12-01T12:00:00+03:00');
  assert.equal(out.filter((o) => /Пора отправлять подарки/.test(o.text)).length, 3);
  assert.equal(at('2026-12-01T18:00:00+03:00').length, 0, 'одно и то же напоминание дважды не шлём');
  // один отправил — ему больше не напоминаем
  site(db, 'POST', '/api/sent', {}, { userId: ids[0] });
  out = at('2026-12-03T12:00:00+03:00');
  assert.equal(out.length, 2);
  assert.match(out[0].text, /неделя/);
  assert.match(at('2026-12-05T12:00:00+03:00')[0].text, /осталось <b>5 дней<\/b>/);
  assert.equal(at('2026-12-06T12:00:00+03:00').length, 0, 'за 4 дня не напоминаем');
  assert.match(at('2026-12-07T12:00:00+03:00')[0].text, /осталось <b>3 дня<\/b>/);
  assert.match(at('2026-12-08T12:00:00+03:00')[0].text, /осталось <b>2 дня<\/b>/);
  out = at('2026-12-10T12:00:00+03:00');
  const user = out.filter((o) => o.chat_id !== 999);
  const admin = out.filter((o) => o.chat_id === 999);
  assert.equal(user.length, 2);
  assert.match(user[0].text, /последний день[\s\S]*чёрный список/);
  assert.equal(admin.length, 2);
  assert.match(admin[0].text, /последний день[\s\S]*@santa_user/);
  out = at('2026-12-11T12:00:00+03:00');
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => o.chat_id === 999 && /Срок отправки прошёл/.test(o.text)));
  clock = Date.parse('2026-11-20T12:00:00+03:00');
});
