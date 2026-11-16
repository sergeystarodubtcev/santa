'use strict';
// «📬 Заказ приехал»: код получения от Санты (бот/сайт) или от организатора — получателю «забирайте».
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

const clock = Date.parse('2026-12-05T12:00:00+03:00');
const ctx = { now: () => clock, checkAdmin: (p) => p === 'pw', hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p) };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const bot = createBot({ core, secret: 's', siteUrl: 'https://santa.example', username: 'b' });
function seed() {
  const db = core.emptyDb();
  const ids = [0, 1, 2].map((i) => {
    const r = call(db, 'POST', '/api/register', { name: 'Пик' + i, phone: '+795593000' + i, tg: 'pick_u' + i, password: 'qwerty1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Пиков ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, { userId: r.user.id });
    db.users.find((u) => u.id === r.user.id).tgChatId = 800 + i;
    return r.user.id;
  });
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  return { db, ids };
}
let n = 0;
const say = (db, chat, text, extra) => bot.handleUpdate(db, ctx, { update_id: ++n, message: Object.assign({ message_id: n, chat: { id: chat, type: 'private' }, from: { id: chat }, text }, extra || {}) }).out;
const press = (db, chat, data) => bot.handleUpdate(db, ctx, { update_id: ++n, callback_query: { id: 'c' + n, data, from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } }).out;

test('Санта в боте: «Я отправил» → кнопка «Заказ приехал» → код → получателю «забирайте» с кнопкой «Я получил»', () => {
  const { db, ids } = seed();
  const pair = db.pairs.find((p) => p.santaId === ids[0]);
  press(db, 800, 'sentw:1');
  const out = say(db, 800, 'TRK1');
  const btn = out.flatMap((o) => (o.reply_markup && o.reply_markup.inline_keyboard ? o.reply_markup.inline_keyboard.flat() : [])).find((b) => b.callback_data === 'pick:1');
  assert.ok(btn, 'после «Я отправил» — кнопка «Заказ приехал»');
  press(db, 800, 'pick:1');
  const n0 = db.notifications.length;
  assert.match(say(db, 800, '123-456')[0].text, /Передал получателю/);
  assert.equal(pair.pickupCode, '123-456');
  const note = db.notifications.slice(n0).find((x) => x.userId === pair.recipientId);
  assert.match(note.text, /приехал в пункт выдачи — можно забирать[\s\S]*Код получения: 123-456/);
  const push = bot.pushNotifications(db, [note], null);
  assert.equal(push[0].reply_markup.inline_keyboard[0][0].callback_data, 'received');
  assert.ok(db.notifications.some((x) => x.userId === '@admins' && /передал код получения/.test(x.text)));
  // в кабинете получателя код виден
  const me = call(db, 'GET', '/api/me', null, { userId: pair.recipientId });
  assert.equal(me.incomings[0].pickupCode, '123-456');
  // в «Кому я дарю» у Санты код и кнопка «Изменить код»
  const w = say(db, 800, '🎅 Кому я дарю')[0];
  assert.match(w.text, /Код получения передан: <code>123-456<\/code>/);
  assert.ok(w.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'pick:1'));
});

test('фото QR вместо кода; сайт: /api/pickup; без кода — отказ', () => {
  const { db, ids } = seed();
  press(db, 801, 'pick:1');
  assert.match(say(db, 801, '', { photo: [{ file_id: 'small' }, { file_id: 'QRFILE' }] })[0].text, /Фото добавлено \(1\)/);
  const r2 = say(db, 801, '', { photo: [{ file_id: 'BARCODE' }] })[0];
  assert.match(r2.text, /Фото добавлено \(2\)/);
  assert.equal(r2.reply_markup.inline_keyboard[0][0].callback_data, 'pickdone');
  press(db, 801, 'pickdone');
  const pair = db.pairs.find((p) => p.santaId === ids[1]);
  assert.deepEqual(pair.pickupTgPhotos, ['QRFILE', 'BARCODE']);
  assert.equal(pair.status, 'sent', 'код без «Я отправил» — значит, отправлено');
  const note = db.notifications.filter((x) => x.userId === pair.recipientId).pop();
  const push = bot.pushNotifications(db, [note], null);
  const phs = push.filter((o) => o.method === 'sendPhoto');
  assert.deepEqual(phs.map((o) => o.photo), ['QRFILE', 'BARCODE']);
  assert.match(phs[0].caption, /Штрихкод/);
  assert.throws(() => call(db, 'POST', '/api/pickup', { round: 1, code: ' ' }, { userId: ids[2] }), /Напишите код/);
  call(db, 'POST', '/api/pickup', { round: 1, code: 'ABC' }, { userId: ids[2] });
  assert.equal(db.pairs.find((p) => p.santaId === ids[2]).pickupCode, 'ABC');
});

test('организатор прикрепляет код через «🔎 Досье» и через админку', () => {
  const { db, ids } = seed();
  say(db, 990, '/admin pw');
  const rec = ids[1];
  const santa = db.pairs.find((p) => p.recipientId === rec).santaId;
  const d = say(db, 990, '/who @pick_u1')[0];
  const b = d.reply_markup.inline_keyboard.flat().find((x) => /Прикрепить ему код/.test(x.text));
  press(db, 990, b.callback_data);
  const n0 = db.notifications.length;
  assert.match(say(db, 990, '777 888')[0].text, /Код прикреплён/);
  const fresh = db.notifications.slice(n0);
  assert.ok(fresh.some((x) => x.userId === rec && /Код получения: 777 888/.test(x.text)));
  assert.ok(fresh.some((x) => x.userId === santa && /Организатор передал вашему получателю код/.test(x.text)));
  assert.match(say(db, 990, '/who @pick_u1')[0].text, /приехал, код: <code>777 888<\/code> \(передал организатор/);
  // через сайт-админку (по Санте)
  call(db, 'POST', '/api/admin/pickup', { santaId: ids[2], round: 1, code: 'Z9' }, admin);
  assert.equal(db.pairs.find((p) => p.santaId === ids[2]).pickupCode, 'Z9');
  assert.throws(() => call(db, 'POST', '/api/admin/pickup', { santaId: ids[2], code: 'x' }), /./);
});

test('сайт: фото штрихкода/QR (загруженные картинки) — получатель видит в кабинете, в бот уходят по подписанной ссылке', () => {
  const { db, ids } = seed();
  const pair = db.pairs.find((p) => p.santaId === ids[0]);
  const id1 = 'a'.repeat(24), id2 = 'b'.repeat(24);
  call(db, 'POST', '/api/admin/pickup', { santaId: ids[0], round: 1, photoIds: [id1, id2, 'bad id'] }, admin);
  assert.deepEqual(pair.pickupPhotos, [id1, id2]);
  const me = call(db, 'GET', '/api/me', null, { userId: pair.recipientId });
  assert.deepEqual(me.incomings[0].pickupPhotos, [id1, id2]);
  assert.ok(core.photoAccess(db, pair.recipientId, false, id1) && core.photoAccess(db, ids[0], false, id2));
  const other = ids.find((x) => x !== ids[0] && x !== pair.recipientId);
  assert.ok(!core.photoAccess(db, other, false, id1), 'чужие не видят');
  const note = db.notifications.filter((x) => x.userId === pair.recipientId).pop();
  const { imgSig } = require('../cloud/bot.js');
  const phs = bot.pushNotifications(db, [note], null).filter((o) => o.method === 'sendPhoto');
  assert.equal(phs[0].photo, `https://santa.example/api/img?id=${id1}&s=${imgSig('s', id1)}`);
  assert.equal(phs.length, 2);
  // админ в боте: несколько фото → «Готово»
  say(db, 990, '/admin pw');
  const d = say(db, 990, '/who @' + db.users.find((u) => u.id === db.pairs.find((p) => p.santaId === ids[1]).recipientId).tg)[0];
  press(db, 990, d.reply_markup.inline_keyboard.flat().find((x) => /Прикрепить/.test(x.text)).callback_data);
  say(db, 990, '', { photo: [{ file_id: 'P1' }] });
  say(db, 990, '', { photo: [{ file_id: 'P2' }], caption: '12 34' });
  press(db, 990, 'adm:pkdone');
  const p2 = db.pairs.find((p) => p.santaId === ids[1]);
  assert.deepEqual([p2.pickupTgPhotos, p2.pickupCode], [['P1', 'P2'], '12 34']);
});
