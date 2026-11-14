'use strict';
// Повторное участие: запись в следующую волну тех, кто уже играет. Анкета копируется из прошлой волны,
// у человека по паре в каждой волне, аккаунт и вход не меняются.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const W2DATES = { start: '2026-12-11T00:00:00+03:00', end: '2026-12-20T23:59:59+03:00' };
const { createBot } = require('../cloud/bot.js');

let clock = Date.parse('2026-11-20T12:00:00+03:00');
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ctx = { now: () => clock, random: rnd, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p), checkAdmin: (p) => p === 'adminpw' };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const as = (id) => ({ userId: id });
const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });
let n = 0;
const msg = (db, chat, text) => bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
const press = (db, chat, data) => bot.handleUpdate(db, ctx, { update_id: ++n, callback_query: { id: 'c' + n, data, from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } });
const texts = (r) => r.out.filter((o) => o.text).map((o) => o.text).join('\n');
const buttons = (r) => r.out.flatMap((o) => (o.reply_markup && o.reply_markup.inline_keyboard ? o.reply_markup.inline_keyboard.flat().map((b) => b.callback_data) : []));

function user(db, i, extra) {
  const r = call(db, 'POST', '/api/register', { name: 'W' + i, phone: '+795570' + String(i).padStart(5, '0'), tg: 'wj_user' + i, password: 'pass' + i + 'xx', pdConsent: true });
  call(db, 'POST', '/api/participate', Object.assign({ fullName: 'Участник Номер ' + i, address: 'ПВЗ Ozon, Казань, Баумана ' + i, wishes: 'дрипы ' + i, prefs: 'coffee', agree: true }, extra || {}), as(r.user.id));
  return r.user.id;
}
function assertValid(db, w) {
  const ids = core.handle(db, Object.assign({}, ctx, admin), 'GET', '/api/admin/state').data.waves.find((x) => x.n === w);
  assert.deepEqual(core.checkWave(db, w), [], `волна ${w} без ошибок`);
  return ids;
}

test('повторное участие: запись во 2-ю волну с копией анкеты, две пары, отдельные отметки', () => {
  const db = core.emptyDb();
  const ids = [0, 1, 2, 3, 4].map((i) => user(db, i));
  const [A, B, C] = ids;
  // во время записи в 1-ю волну — «следующих волн» нет
  assert.equal(call(db, 'GET', '/api/me', null, as(A)).nextWave, null);
  assert.throws(() => call(db, 'POST', '/api/wave-join', { fullName: 'x x x', address: 'ПВЗ Ozon, Казань', agree: true }, as(A)), /первую волну/);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  // после жеребьёвки, до создания волны — лист ожидания
  let me = call(db, 'GET', '/api/me', null, as(A));
  assert.equal(me.nextWave.n, null);
  assert.equal(me.nextWave.anketa.address, 'ПВЗ Ozon, Казань, Баумана 0', 'анкета подставляется из прошлой');
  // создаём 2-ю волну — всем участникам предложение записаться
  const n0 = db.notifications.length;
  call(db, 'POST', '/api/admin/wave-create', W2DATES, admin);
  const offers = db.notifications.slice(n0).filter((x) => x.action === 'wavejoin');
  assert.deepEqual(offers.map((x) => x.userId).sort(), ids.slice().sort(), 'каждому участнику — предложение');
  me = call(db, 'GET', '/api/me', null, as(A));
  assert.deepEqual([me.nextWave.n, me.nextWave.joined], [2, false]);
  // A записывается с новым адресом и пожеланиями; основная анкета не меняется
  call(db, 'POST', '/api/wave-join', { fullName: 'Участник Номер 0', address: 'ПВЗ Ozon, Москва, Тверская 1', wishes: 'теперь чай', prefs: 'noncoffee', agree: true }, as(A));
  assert.equal(db.participations[A].address, 'ПВЗ Ozon, Казань, Баумана 0', 'основная анкета не тронута');
  assert.equal(db.waveAnketas[A][2].address, 'ПВЗ Ozon, Москва, Тверская 1');
  assert.deepEqual([db.wave2[A].round, db.wave2[A].status], [2, 'confirmed']);
  // повторная запись — без дублей
  const nn = db.notifications.length;
  call(db, 'POST', '/api/wave-join', { fullName: 'Участник Номер 0', address: 'ПВЗ Ozon, Москва, Тверская 1', wishes: 'теперь чай', agree: true }, as(A));
  assert.equal(db.notifications.length, nn, 'повторное сохранение — без лишних уведомлений');
  assert.equal(Object.keys(db.wave2).filter((k) => k === A).length, 1);
  // B и C — с прошлыми данными; новичок — напрямую во 2-ю волну
  for (const id of [B, C]) call(db, 'POST', '/api/wave-join', Object.assign({}, call(db, 'GET', '/api/me', null, as(id)).nextWave.anketa, { agree: true }), as(id));
  const N = call(db, 'POST', '/api/register', { name: 'Новичок', phone: '+79557099999', tg: 'wj_new', password: 'newpass1', pdConsent: true }).user.id;
  call(db, 'POST', '/api/participate', { fullName: 'Новичок Новый', address: 'ПВЗ Ozon, Казань, Новая 1', agree: true, wave2: true }, as(N));
  // первая волна осталась целой
  assertValid(db, 1);
  assert.equal(core.handle(db, Object.assign({}, ctx, admin), 'GET', '/api/admin/state').data.waves[0].members, 5);
  // жеребьёвка 2-й волны
  call(db, 'POST', '/api/admin/shuffle', { round: 2 }, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 2 }, admin);
  const w2 = db.pairs.filter((p) => p.round === 2);
  assert.deepEqual(w2.map((p) => p.santaId).sort(), [A, B, C, N].sort(), 'во 2-й волне — записавшиеся');
  assertValid(db, 2);
  // у A две пары: в 1-й и во 2-й волне
  me = call(db, 'GET', '/api/me', null, as(A));
  assert.deepEqual(me.assignments.map((x) => x.round), [1, 2]);
  assert.deepEqual(me.incomings.map((x) => x.round), [1, 2]);
  // Санта A во 2-й волне видит новую анкету, в 1-й — старую
  const s2 = w2.find((p) => p.recipientId === A).santaId;
  const s1 = db.pairs.find((p) => (p.round || 1) === 1 && p.recipientId === A).santaId;
  const v2 = call(db, 'GET', '/api/me', null, as(s2)).assignments.find((x) => x.round === 2);
  const v1 = call(db, 'GET', '/api/me', null, as(s1)).assignments.find((x) => x.round === 1);
  assert.equal(v2.recipient.address, 'ПВЗ Ozon, Москва, Тверская 1');
  assert.equal(v2.recipient.wishes, 'теперь чай');
  assert.equal(v1.recipient.address, 'ПВЗ Ozon, Казань, Баумана 0');
  // отметки — в своей волне
  call(db, 'POST', '/api/ack', { round: 2 }, as(A));
  call(db, 'POST', '/api/sent', { round: 2, track: 'W2' }, as(A));
  const pa1 = db.pairs.find((p) => (p.round || 1) === 1 && p.santaId === A);
  const pa2 = w2.find((p) => p.santaId === A);
  assert.equal(pa2.status, 'sent');
  assert.equal(pa1.status, 'assigned', 'подарок 1-й волны не тронут');
  assert.ok(pa2.ackAt && !pa1.ackAt);
  call(db, 'POST', '/api/sent', { round: 1 }, as(s1));
  call(db, 'POST', '/api/received', { round: 1 }, as(A));
  assert.equal(db.pairs.find((p) => (p.round || 1) === 1 && p.recipientId === A).status, 'received');
  assert.equal(w2.find((p) => p.recipientId === A).status, 'assigned', 'подарок 2-й волны ещё в пути');
  // аккаунт: тот же вход, без дублей
  assert.equal(db.users.filter((u) => u.tg === 'wj_user0').length, 1);
  assert.ok(call(db, 'POST', '/api/login', { login: '@wj_user0', password: 'pass0xx' }).token);
  assert.equal(db.users.length, 6);
});

test('бот: «🌊 Следующие волны», запись с теми же данными и с правкой, «Кому я дарю» по волнам', () => {
  const db = core.emptyDb();
  const ids = [0, 1, 2, 3].map((i) => user(db, i));
  ids.forEach((id, i) => { db.users.find((u) => u.id === id).tgChatId = 800 + i; });
  // в меню есть кнопка
  const g = msg(db, 800, '/start');
  assert.ok(JSON.stringify(g.out).includes('🌊 Следующие волны'));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  call(db, 'POST', '/api/admin/wave-create', W2DATES, admin);
  // уведомление «Открылась запись» превращается в кнопку
  const offer = db.notifications.filter((x) => x.userId === ids[0] && x.action === 'wavejoin').pop();
  assert.equal(bot.pushNotifications(db, [offer], null)[0].reply_markup.inline_keyboard[0][0].callback_data, 'wave');
  // 1) с теми же данными
  let r = msg(db, 800, '🌊 Следующие волны');
  assert.match(texts(r), /Открыта запись в <b>2-ю волну/);
  assert.match(texts(r), /ПВЗ Ozon, Казань, Баумана 0/, 'показывает прошлую анкету');
  assert.deepEqual(buttons(r), ['wj:yes', 'wj:edit']);
  r = press(db, 800, 'wj:yes');
  assert.match(texts(r), /Участвую во 2-й волне|Подтверждаете участие/);
  r = press(db, 800, 'agree');
  assert.match(texts(r), /Вы во? 2-й волне/);
  assert.deepEqual([db.wave2[ids[0]].round, db.wave2[ids[0]].status], [2, 'confirmed']);
  assert.equal(db.waveAnketas[ids[0]][2].address, 'ПВЗ Ozon, Казань, Баумана 0');
  r = msg(db, 800, '🌊 Следующие волны');
  assert.match(texts(r), /Вы участвуете в <b>2-й волне/);
  // 2) с правкой: всё «оставить», кроме пожеланий
  press(db, 801, 'wj:edit');
  press(db, 801, 'keep'); // ФИО
  press(db, 801, 'keep'); // ПВЗ
  msg(db, 801, 'хочу свечку'); // пожелания
  press(db, 801, 'keep'); // тематика
  press(db, 801, 'keep'); // пометки (пусто → «Пропустить»)
  r = press(db, 801, 'agree');
  assert.match(texts(r), /Вы во? 2-й волне/);
  assert.equal(db.waveAnketas[ids[1]][2].wishes, 'хочу свечку');
  assert.equal(db.waveAnketas[ids[1]][2].fullName, 'Участник Номер 1');
  assert.equal(db.participations[ids[1]].wishes, 'дрипы 1', 'основная анкета не изменилась');
  // ещё двое — и жеребьёвка 2-й волны
  press(db, 802, 'wj:yes'); press(db, 802, 'agree');
  press(db, 803, 'wj:yes'); press(db, 803, 'agree');
  call(db, 'POST', '/api/admin/shuffle', { round: 2 }, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 2 }, admin);
  // «Кому я дарю» — две карточки
  r = press(db, 800, 'whom');
  const t = texts(r);
  assert.match(t, /1-я волна/);
  assert.match(t, /2-я волна/);
  assert.deepEqual(buttons(r).filter((x) => /^(ack|sentw):/.test(x)).sort(), ['ack:1', 'ack:2', 'sentw:1', 'sentw:2']);
  // «Я отправил» при двух неотправленных — спрашивает, какой
  r = msg(db, 800, '📦 Я отправил подарок');
  assert.match(texts(r), /Какой подарок/);
  assert.deepEqual(buttons(r), ['sentw:1', 'sentw:2']);
  press(db, 800, 'sentw:2');
  press(db, 800, 'skip');
  assert.equal(db.pairs.find((p) => p.round === 2 && p.santaId === ids[0]).status, 'sent');
  assert.equal(db.pairs.find((p) => (p.round || 1) === 1 && p.santaId === ids[0]).status, 'assigned');
  // «собираю посылку» для 1-й волны
  press(db, 800, 'ack:1');
  assert.ok(db.pairs.find((p) => (p.round || 1) === 1 && p.santaId === ids[0]).ackAt);
});

test('лист ожидания → 3-я волна: анкета переезжает, приглашение, подтверждение, жеребьёвка', () => {
  const db = core.emptyDb();
  const ids = [0, 1, 2].map((i) => user(db, i));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  // волна ещё не создана — лист ожидания
  ids.forEach((id) => call(db, 'POST', '/api/wave-join', Object.assign({}, call(db, 'GET', '/api/me', null, as(id)).nextWave.anketa, { agree: true }), as(id)));
  assert.ok(ids.every((id) => db.wave2[id].status === 'waiting' && db.waveAnketas[id].next));
  assert.equal(call(db, 'GET', '/api/me', null, as(ids[0])).nextWave.joined, true);
  // отказ из листа ожидания
  call(db, 'POST', '/api/admin/wave-create', W2DATES, admin);
  ids.forEach((id) => assert.deepEqual([db.wave2[id].round, db.wave2[id].status], [2, 'invited']));
  assert.ok(ids.every((id) => db.waveAnketas[id][2] && !db.waveAnketas[id].next), 'анкета переехала в волну');
  ids.forEach((id) => call(db, 'POST', '/api/wave2', { join: true }, as(id)));
  call(db, 'POST', '/api/admin/shuffle', { round: 2 }, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 2 }, admin);
  assertValid(db, 2);
  // и сразу в 3-ю: двое записываются
  call(db, 'POST', '/api/admin/wave-create', W2DATES, admin);
  [ids[0], ids[1]].forEach((id) => call(db, 'POST', '/api/wave-join', Object.assign({}, call(db, 'GET', '/api/me', null, as(id)).nextWave.anketa, { agree: true }), as(id)));
  call(db, 'POST', '/api/admin/shuffle', { round: 3 }, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 3 }, admin);
  // все три волны целы; у первого — три пары
  [1, 2, 3].forEach((w) => assertValid(db, w));
  assert.deepEqual(call(db, 'GET', '/api/me', null, as(ids[0])).assignments.map((x) => x.round), [1, 2, 3]);
  // в админке у 2-й волны по-прежнему 3 участника (хотя двое уже в 3-й)
  const st = core.handle(db, Object.assign({}, ctx, admin), 'GET', '/api/admin/state').data;
  assert.deepEqual(st.waves.map((w) => w.members), [3, 3, 2]);
});

test('ограничения: без анкеты, бан, закрытая запись', () => {
  const db = core.emptyDb();
  const ids = [0, 1, 2].map((i) => user(db, i));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  call(db, 'POST', '/api/admin/wave-create', W2DATES, admin);
  const r = call(db, 'POST', '/api/register', { name: 'Без', phone: '+79557088888', tg: 'wj_noform', password: 'qwerty1', pdConsent: true });
  assert.throws(() => call(db, 'POST', '/api/wave-join', { fullName: 'Без Анкеты', address: 'ПВЗ Ozon, Казань', agree: true }, as(r.user.id)), /Сначала заполните анкету/);
  assert.throws(() => call(db, 'POST', '/api/wave-join', { fullName: 'Участник Номер 0', address: 'ПВЗ Ozon, Казань', agree: false }, as(ids[0])), /Подтвердите участие/);
  assert.throws(() => call(db, 'POST', '/api/wave-join', { fullName: 'Участник Номер 0', address: 'ПВЗ Ozon, Казань, кв 5', agree: true }, as(ids[0])), /только адрес пункта выдачи/);
  call(db, 'POST', '/api/admin/ban', { userId: ids[1], banned: true }, admin);
  assert.throws(() => call(db, 'POST', '/api/wave-join', { fullName: 'Участник Номер 1', address: 'ПВЗ Ozon, Казань', agree: true }, as(ids[1])), /чёрном списке/);
  call(db, 'POST', '/api/admin/settings', { round2Open: false }, admin);
  assert.throws(() => call(db, 'POST', '/api/wave-join', { fullName: 'Участник Номер 2', address: 'ПВЗ Ozon, Казань', agree: true }, as(ids[2])), /закрыта/);
  assert.equal(call(db, 'GET', '/api/me', null, as(ids[2])).nextWave, null);
});
