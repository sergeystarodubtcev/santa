'use strict';
// Удаление аккаунта после жеребьёвки, помощь администратора, ручная правка пар.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

const ctx = {
  now: () => Date.parse('2026-11-25T12:00:00+03:00'),
  hash: (p) => 'h:' + p,
  verify: (p, h) => h === 'h:' + p,
  issueToken: (p) => JSON.stringify(p),
  checkAdmin: (p) => p === 'adminpw',
};
const call = (db, method, path, body, as) => core.handle(db, Object.assign({}, ctx, as), method, path, body).data;
const admin = { isAdmin: true };
const bot = createBot({ core, secret: 's', siteUrl: 'https://santa.example', username: 'kofesanta_bot' });
let upd = 0;
const msg = (db, chatId, text, from = {}) => bot.handleUpdate(db, ctx, { update_id: ++upd, message: { message_id: upd, chat: { id: chatId, type: 'private' }, from: Object.assign({ id: chatId }, from), text } });

// цепочка A→B→C→D→A, чтобы было предсказуемо
function chainDb(n = 4) {
  const db = core.emptyDb();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = call(db, 'POST', '/api/register', { name: 'U' + i, phone: '+7966000000' + i, tg: 'user_' + i, password: 'qwerty1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Юзер ' + i, address: 'ПВЗ Ozon ' + i, agree: true }, { userId: r.user.id });
    ids.push(r.user.id);
  }
  call(db, 'POST', '/api/admin/approve-all', {}, admin);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  db.pairs = ids.map((id, i) => ({ santaId: id, recipientId: ids[(i + 1) % n], status: 'assigned', track: '', sentAt: null, receivedAt: null }));
  return { db, ids };
}
const recipientOf = (db, id) => (db.pairs.find((p) => p.santaId === id) || {}).recipientId;
const adminLog = (db) => db.notifications.filter((n) => n.userId === '@admins').map((n) => n.text).join('\n');

test('после жеребьёвки: удаление перестраивает цепочку, Санта узнаёт новый адрес, админ получает отчёт', () => {
  const { db, ids } = chainDb();
  const [A, B, C] = ids; // A→B→C
  assert.throws(() => call(db, 'POST', '/api/account/delete', {}, { userId: B }), /УДАЛИТЬ/);
  call(db, 'POST', '/api/account/delete', { confirm: 'УДАЛИТЬ' }, { userId: B });
  assert.equal(recipientOf(db, A), C, 'Санта удалённого теперь дарит его получателю');
  assert.ok(!db.users.some((u) => u.id === B));
  assert.ok(!db.pairs.some((p) => p.santaId === B || p.recipientId === B));
  const toA = db.notifications.filter((n) => n.userId === A).pop();
  assert.match(toA.text, /получатель вышел из игры[\s\S]*новые имя, ФИО и адрес/i);
  assert.equal(toA.action, 'whom');
  assert.match(adminLog(db), /🗑 U1 @user_1 .* удалил аккаунт ПОСЛЕ жеребьёвки[\s\S]*@user_0 теперь дарит @user_2/);
  assert.deepEqual(call(db, 'GET', '/api/admin/state', null, admin).pairsCheck, { noRecipient: [], noSanta: [], doubleSanta: [] });
});

test('если посылка уже в пути — удалить нельзя, только через администратора (и админ об этом узнаёт)', () => {
  const { db, ids } = chainDb();
  const [A, B] = ids;
  call(db, 'POST', '/api/sent', { track: 'T1' }, { userId: A }); // A уже отправил B
  let err;
  try { call(db, 'POST', '/api/account/delete', { confirm: 'УДАЛИТЬ' }, { userId: B }); } catch (e) { err = e; }
  assert.equal(err.code, 'need_admin');
  assert.match(err.message, /уже отправил вам посылку[\s\S]*администратора/);
  try { call(db, 'POST', '/api/account/delete', { confirm: 'УДАЛИТЬ' }, { userId: A }); } catch (e) { err = e; }
  assert.equal(err.code, 'need_admin');
  assert.ok(db.users.some((u) => u.id === B), 'аккаунт не удалён');
  assert.match(adminLog(db), /🆘 U1 @user_1 .* хотел удалить аккаунт, но не может/);
});

test('пара из двух: второй остаётся без пары, админу — предупреждение', () => {
  const { db, ids } = chainDb(2);
  call(db, 'POST', '/api/account/delete', { confirm: 'УДАЛИТЬ' }, { userId: ids[0] });
  assert.equal(db.pairs.length, 0);
  assert.match(adminLog(db), /@user_1 остался без получателя и без Санты/);
});

test('до жеребьёвки удаление простое, админ тоже узнаёт', () => {
  const db = core.emptyDb();
  const r = call(db, 'POST', '/api/register', { name: 'Оля', phone: '+79660000099', tg: 'olya_x', password: 'qwerty1', pdConsent: true });
  call(db, 'POST', '/api/account/delete', {}, { userId: r.user.id });
  assert.equal(db.users.length, 0);
  assert.match(adminLog(db), /🗑 Оля @olya_x .* удалил аккаунт/);
});

test('админ: удаление и «из пар» с перестройкой, ручная правка пары, проверка распределения', () => {
  const { db, ids } = chainDb(5);
  const [A, B, C, D, E] = ids; // A→B→C→D→E→A
  call(db, 'POST', '/api/sent', {}, { userId: A }); // даже если отправлено — админ может
  call(db, 'POST', '/api/admin/delete', { userId: B }, admin);
  assert.equal(recipientOf(db, A), C);
  assert.match(adminLog(db), /Организатор удалил U1[\s\S]*@user_0 теперь дарит @user_2 .*прошлая посылка уже была отправлена/);
  call(db, 'POST', '/api/admin/remove-from-draw', { userId: D }, admin);
  assert.equal(recipientOf(db, C), E);
  assert.ok(db.users.some((u) => u.id === D), 'аккаунт остался');
  // ручная правка: C дарит A → у E нет Санты, у A двое
  call(db, 'POST', '/api/admin/pair-set', { santaId: C, recipientId: A }, admin);
  let chk = call(db, 'GET', '/api/admin/state', null, admin).pairsCheck;
  assert.deepEqual(chk.noSanta, ['@user_4']); // E; D исключён из жеребьёвки и в проверке не участвует
  assert.deepEqual(chk.noRecipient, []);
  assert.deepEqual(chk.doubleSanta, ['@user_0']);
  assert.throws(() => call(db, 'POST', '/api/admin/pair-set', { santaId: C, recipientId: C }, admin), /самому себе/);
  call(db, 'POST', '/api/admin/pair-set', { santaId: C, recipientId: E }, admin);
  chk = call(db, 'GET', '/api/admin/state', null, admin).pairsCheck;
  assert.deepEqual(chk.doubleSanta, []);
  assert.match(db.notifications.filter((n) => n.userId === C).pop().text, /назначили вам получателя/);
  assert.match(adminLog(db), /✏️ Вручную: @user_2 теперь дарит @user_4/);
});

test('бот: журнал админам, «Помощь администратора» с пересылкой и ником, ответ через /reply', () => {
  const { db, ids } = chainDb();
  msg(db, 999, '/admin adminpw');
  msg(db, 501, '/start', { username: 'user_1' });
  // журнал удалений уходит админам в Telegram
  const n0 = db.notifications.length;
  call(db, 'POST', '/api/sent', {}, { userId: ids[0] });
  try { call(db, 'POST', '/api/account/delete', { confirm: 'УДАЛИТЬ' }, { userId: ids[1] }); } catch (e) { /* need_admin */ }
  const pushed = bot.pushNotifications(db, db.notifications.slice(n0), null);
  assert.ok(pushed.some((o) => o.chat_id === 999 && /хотел удалить аккаунт/.test(o.text)));
  // ссылка «помощь» с сайта открывает режим помощи
  const url = bot.linkUrl(ids[1], true);
  assert.match(url, /start=help-/);
  let r = msg(db, 501, '/start ' + url.split('start=')[1], { username: 'user_1' });
  assert.ok(r.out.some((o) => o.chat_id === 501 && /передам всё организатору/.test(o.text)));
  const toAdmin = r.out.find((o) => o.chat_id === 999);
  assert.match(toAdmin.text, /@user_1<\/b> открыл «Помощь администратора»[\s\S]*его Санта: @user_0 \(отправлено\)[\s\S]*\/reply @user_1/);
  r = msg(db, 501, 'Я переезжаю, посылку не заберу', { username: 'user_1' });
  assert.ok(r.out.some((o) => o.chat_id === 999 && /@user_1<\/b> \(U1\):\nЯ переезжаю/.test(o.text)));
  // фото — пересылается
  r = bot.handleUpdate(db, ctx, { update_id: ++upd, message: { message_id: 77, chat: { id: 501, type: 'private' }, from: { id: 501, username: 'user_1' }, photo: [{}] } });
  assert.ok(r.out.some((o) => o.method === 'forwardMessage' && o.chat_id === 999 && o.message_id === 77));
  r = msg(db, 501, '✅ Готово');
  assert.match(r.out[0].text, /Организатор ответит здесь/);
  // ответ админа
  r = msg(db, 999, '/reply @user_1 Поменяю адрес вручную, не переживай');
  assert.ok(r.out.some((o) => o.chat_id === 501 && /Ответ организатора[\s\S]*не переживай/.test(o.text)));
  // не-админ не может /reply
  r = msg(db, 501, '/reply @user_0 привет');
  assert.ok(!r.out.some((o) => o.chat_id !== 501));
  // кнопка помощи для незарегистрированного
  r = msg(db, 777, '🆘 Помощь администратора', { username: 'stranger' });
  assert.ok(r.out.some((o) => o.chat_id === 999 && /@stranger<\/b> открыл/.test(o.text)));
});

test('профиль: можно исправить ник, имя и телефон; занятые не даём; после жеребьёвки — админу в журнал', () => {
  const { db, ids } = chainDb();
  const [A, B] = ids;
  assert.throws(() => call(db, 'POST', '/api/profile', { name: 'U0', tg: '@user_1', phone: '+79660000000' }, { userId: A }), /ник .* занят/);
  assert.throws(() => call(db, 'POST', '/api/profile', { name: 'U0', tg: 'ok_nick', phone: '+79660000001' }, { userId: A }), /телефон уже указан/);
  assert.throws(() => call(db, 'POST', '/api/profile', { name: 'U0', tg: 'a', phone: '+79660000000' }, { userId: A }), /Ник в Telegram/);
  const me = call(db, 'POST', '/api/profile', { name: 'Аня', tg: 'https://t.me/Anya_Real', phone: '8 966 000 00 00' }, { userId: A });
  assert.equal(me.user.tg, 'anya_real');
  assert.equal(me.user.name, 'Аня');
  // Санта того, кто сменил ник, видит новый ник у получателя
  const santaOfA = db.pairs.find((p) => p.recipientId === A).santaId;
  assert.equal(call(db, 'GET', '/api/me', null, { userId: santaOfA }).assignment.recipient.tg, 'anya_real');
  assert.match(adminLog(db), /✏️ @anya_real исправил профиль после жеребьёвки: ник @user_0 → @anya_real, имя «U0» → «Аня»/);
  // вход по новому нику работает
  assert.equal(call(db, 'POST', '/api/login', { login: '@anya_real', password: 'qwerty1' }).user.id, A);
  assert.ok(B);
});

test('админ: правит профиль и анкету любого участника, сбрасывает пароль; участник и журнал в курсе', () => {
  const { db, ids } = chainDb();
  const [A] = ids;
  assert.throws(() => call(db, 'POST', '/api/admin/user-edit', { userId: A, name: 'U0', tg: 'user_1', phone: '+79660000000' }, {}), /админку/);
  assert.throws(() => call(db, 'POST', '/api/admin/user-edit', { userId: A, name: 'U0', tg: 'user_1', phone: '+79660000000' }, admin), /ник уже занят/);
  call(db, 'POST', '/api/admin/user-edit', {
    userId: A, name: 'Анна', tg: '@anna_fix', phone: '+79660000000', password: 'newpass1',
    anketa: { fullName: 'Анна Исправленная', address: 'ПВЗ Ozon, Казань, Баумана 1', wishes: 'чай', notes: 'без орехов', prefs: 'noncoffee' },
  }, admin);
  const u = db.users.find((x) => x.id === A);
  assert.equal(u.tg, 'anna_fix');
  assert.equal(db.participations[A].address, 'ПВЗ Ozon, Казань, Баумана 1');
  assert.equal(db.participations[A].prefs, 'noncoffee');
  assert.equal(call(db, 'POST', '/api/login', { login: '@anna_fix', password: 'newpass1' }).user.id, A);
  assert.match(db.notifications.filter((n) => n.userId === A).pop().text, /Организаторы обновили ваши данные/);
  assert.match(adminLog(db), /Организатор поправил данные @user_0 \(теперь @anna_fix\)/);
  assert.match(adminLog(db), /ПВЗ: «ПВЗ Ozon 0» → «ПВЗ Ozon, Казань, Баумана 1»/);
  assert.match(adminLog(db), /пароль сброшен/);
  // Санта видит новый адрес
  const santa = db.pairs.find((p) => p.recipientId === A).santaId;
  assert.equal(call(db, 'GET', '/api/me', null, { userId: santa }).assignment.recipient.address, 'ПВЗ Ozon, Казань, Баумана 1');
  // анкету можно создать тому, у кого её нет
  const r = call(db, 'POST', '/api/register', { name: 'Без анкеты', phone: '+79660000077', tg: 'no_form', password: 'qwerty1', pdConsent: true });
  call(db, 'POST', '/api/admin/user-edit', { userId: r.user.id, name: 'Без анкеты', tg: 'no_form', phone: '+79660000077', anketa: { fullName: 'Иван Иванов', address: 'ПВЗ Ozon 7' } }, admin);
  assert.equal(db.participations[r.user.id].moderation, 'approved');
});
