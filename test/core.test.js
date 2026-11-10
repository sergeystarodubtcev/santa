'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');

let clock = Date.parse('2026-11-20T12:00:00+03:00');
let tokens = {};
function ctx(extra) {
  return Object.assign({
    now: () => clock,
    hash: (p) => 'h:' + p,
    verify: (p, h) => h === 'h:' + p,
    issueToken: (p) => { const t = 't' + Object.keys(tokens).length; tokens[t] = p; return t; },
    checkAdmin: (p) => p === 'secret',
  }, extra || {});
}
const call = (db, m, p, b, extra) => core.handle(db, ctx(extra), m, p, b).data;
const as = (uid) => ({ userId: uid });
const admin = { isAdmin: true };

function seed(n) {
  const db = core.emptyDb();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = call(db, 'POST', '/api/register', { name: 'User ' + i, phone: '8900123456' + i, tg: '@user_' + i, password: 'secret1', pdConsent: true });
    ids.push(r.user.id);
    call(db, 'POST', '/api/participate', { fullName: 'Иванов Иван ' + i, address: 'Ozon ПВЗ ' + i, wishes: 'кофе', agree: true, prefs: 'coffee' }, as(r.user.id));
  }
  call(db, 'POST', '/api/admin/approve-all', {}, admin);
  return { db, ids };
}

test('регистрация нормализует телефон и ник, не пускает дубликаты', () => {
  const db = core.emptyDb();
  const r = call(db, 'POST', '/api/register', { name: 'Сергей', phone: '8 (900) 123-45-67', tg: 'https://t.me/Sergey_Coffee', password: 'qwerty', pdConsent: true });
  assert.equal(r.user.phone, '+79001234567');
  assert.equal(r.user.tg, 'sergey_coffee');
  assert.throws(() => call(db, 'POST', '/api/register', { name: 'Икс', phone: '+7 900 123 45 67', tg: 'other', password: 'qwerty', pdConsent: true }), /телефон/);
  const l1 = call(db, 'POST', '/api/login', { login: '@Sergey_Coffee', password: 'qwerty', pdConsent: true });
  const l2 = call(db, 'POST', '/api/login', { login: '89001234567', password: 'qwerty', pdConsent: true });
  assert.equal(l1.user.id, l2.user.id);
  assert.throws(() => call(db, 'POST', '/api/login', { login: 'sergey_coffee', password: 'nope' }), /Неверный/);
});

test('анкета требует согласия и адреса, счётчик растёт', () => {
  const { db } = seed(3);
  assert.equal(call(db, 'GET', '/api/public').count, 3);
  const r = call(db, 'POST', '/api/register', { name: 'Аня', phone: '+79990000000', tg: 'anya_v60', password: 'secret1', pdConsent: true });
  assert.throws(() => call(db, 'POST', '/api/participate', { fullName: 'Анна Смирнова', address: 'ПВЗ Ozon', agree: false }, as(r.user.id)), /Подтвердите/);
  call(db, 'POST', '/api/participate', { fullName: 'Анна Смирнова', phone: '+7 999 111 22 33', address: 'ПВЗ Ozon', agree: true, notes: 'у меня аллергия на инфьюзы' }, as(r.user.id));
  assert.equal(call(db, 'GET', '/api/me', null, as(r.user.id)).user.phone, '+79991112233'); // телефон обновился в профиле
  assert.throws(() => call(db, 'POST', '/api/participate', { fullName: 'Анна', phone: '89001234560', address: 'ПВЗ Ozon', agree: true }, as(r.user.id)), /другого/);
  const pub = call(db, 'GET', '/api/public');
  assert.equal(pub.count, 4);
  assert.equal(pub.recent[0], 'Аня');
});

test('жеребьёвка: случайная раздача — каждый дарит и получает ровно раз, никто не дарит себе', () => {
  for (const n of [2, 3, 7, 30]) {
    const { db } = seed(n);
    assert.throws(() => call(db, 'POST', '/api/admin/shuffle', {}), /админку/);
    call(db, 'POST', '/api/admin/shuffle', {}, admin);
    assert.equal(db.pairs.length, n);
    assert.equal(new Set(db.pairs.map((p) => p.santaId)).size, n);
    assert.equal(new Set(db.pairs.map((p) => p.recipientId)).size, n);
    db.pairs.forEach((p) => assert.notEqual(p.santaId, p.recipientId));
  }
});

test('жеребьёвка действительно случайна: бывают и взаимные пары, и разные раскладки', () => {
  const { db, ids } = seed(4);
  const seen = new Set();
  let mutual = 0;
  for (let k = 0; k < 300; k++) {
    call(db, 'POST', '/api/admin/shuffle', {}, admin);
    const m = Object.fromEntries(db.pairs.map((p) => [p.santaId, p.recipientId]));
    seen.add(ids.map((id) => m[id]).join(','));
    if (ids.some((id) => m[m[id]] === id)) mutual++;
  }
  assert.equal(seen.size, 9); // для 4 человек существует ровно 9 раскладок без «себе»
  assert.ok(mutual > 0);
});

test('забаненные не участвуют, после жеребьёвки новые не регистрируются', () => {
  const { db, ids } = seed(4);
  call(db, 'POST', '/api/admin/ban', { userId: ids[0], banned: true }, admin);
  assert.equal(call(db, 'GET', '/api/public').count, 3);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  assert.equal(db.pairs.length, 3);
  assert.ok(!db.pairs.some((p) => p.santaId === ids[0] || p.recipientId === ids[0]));
  const r = call(db, 'POST', '/api/register', { name: 'Late', phone: '+79995550000', tg: 'late_one', password: 'secret1', pdConsent: true });
  // после первой жеребьёвки — запись во второй круг
  call(db, 'POST', '/api/participate', { fullName: 'Late One', address: 'ПВЗ Ozon', agree: true }, as(r.user.id));
  assert.equal(db.participations[r.user.id].round, 2);
  assert.equal(call(db, 'GET', '/api/me', null, as(r.user.id)).drawn, false, 'для второго круга жеребьёвки ещё не было');
  const r2 = call(db, 'POST', '/api/register', { name: 'Later', phone: '+79995550001', tg: 'later_one', password: 'secret1', pdConsent: true });
  call(db, 'POST', '/api/admin/settings', { round2Open: false }, admin);
  assert.throws(() => call(db, 'POST', '/api/participate', { fullName: 'Later One', address: 'ПВЗ Ozon', agree: true }, as(r2.user.id)), /второй круг пока закрыта/);
});

test('полный цикл: получатель, дедлайн, отправка, «Вам подарок от Деда Мороза», получение', () => {
  const { db, ids } = seed(3);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  const santa = ids[0];
  const recipientId = db.pairs.find((p) => p.santaId === santa).recipientId;

  let me = call(db, 'GET', '/api/me', null, as(santa));
  assert.ok(me.assignment.recipient.address.startsWith('Ozon'));
  assert.match(me.assignment.recipient.fullName, /^Иванов Иван/);
  assert.equal(me.deadline.kind, 'info'); // до 1 декабря

  clock = Date.parse('2026-12-08T10:00:00+03:00');
  me = call(db, 'GET', '/api/me', null, as(santa));
  assert.equal(me.deadline.daysLeft, 3);
  assert.match(me.deadline.text, /У ВАС 3 ДНЯ, ЧТОБЫ УСПЕТЬ ОТПРАВИТЬ ПОДАРОК/);

  me = call(db, 'POST', '/api/sent', { track: 'TRACK-1' }, as(santa));
  assert.equal(me.assignment.status, 'sent');
  assert.equal(me.deadline, null);

  const rme = call(db, 'GET', '/api/me', null, as(recipientId));
  assert.equal(rme.incoming.status, 'sent');
  assert.equal(rme.incoming.santaId, undefined); // Санта анонимен
  assert.ok(rme.notifications.some((n) => /Вам подарок от Деда Мороза/.test(n.text)));

  call(db, 'POST', '/api/received', {}, as(recipientId));
  assert.equal(db.pairs.find((p) => p.santaId === santa).status, 'received');

  assert.throws(() => call(db, 'POST', '/api/admin/shuffle', {}, admin), /принудительно/);
  call(db, 'POST', '/api/admin/shuffle', { force: true }, admin);
  clock = Date.parse('2026-11-20T12:00:00+03:00');
});

test('админ: логин, настройки, рассылка, экспорт/импорт', () => {
  const { db } = seed(2);
  assert.throws(() => call(db, 'POST', '/api/admin/login', { password: 'bad' }), /Неверный/);
  assert.ok(call(db, 'POST', '/api/admin/login', { password: 'secret' }).token);
  call(db, 'POST', '/api/admin/settings', { budgetMin: '1000', budgetMax: '2500', announcement: 'Жеребьёвка завтра' }, admin);
  const pub = call(db, 'GET', '/api/public');
  assert.equal(pub.settings.budgetMin, 1000);
  assert.equal(pub.settings.announcement, 'Жеребьёвка завтра');
  assert.equal(call(db, 'POST', '/api/admin/broadcast', { text: 'Привет', onlyParticipants: true }, admin).sent, 2);
  const dump = JSON.parse(JSON.stringify(call(db, 'GET', '/api/admin/export', null, admin)));
  const db2 = core.emptyDb();
  call(db2, 'POST', '/api/admin/import', { db: dump }, admin);
  assert.equal(call(db2, 'GET', '/api/public').count, 2);
});

test('согласие на ПДн обязательно, адрес — только ПВЗ', () => {
  const db = core.emptyDb();
  assert.throws(() => call(db, 'POST', '/api/register', { name: 'Олег', phone: '+79005554433', tg: 'oleg_pd', password: 'secret1' }), /персональных данных/);
  const r = call(db, 'POST', '/api/register', { name: 'Олег', phone: '+79005554433', tg: 'oleg_pd', password: 'secret1', pdConsent: true });
  assert.ok(db.users[0].pdConsentAt);
  for (const bad of ['Москва, ул. Ленина 5, кв. 12', 'Тверская 7, подъезд 2, этаж 3', 'СПб, Невский 1 квартира 4']) {
    assert.throws(() => call(db, 'POST', '/api/participate', { fullName: 'Олег Олегов', address: bad, agree: true }, as(r.user.id)), /пункта выдачи/);
  }
  call(db, 'POST', '/api/participate', { fullName: 'Олег Олегов', address: 'ПВЗ Ozon, Москва, Тверская 7', agree: true }, as(r.user.id));
});

test('модерация: в жеребьёвку попадают только одобренные', () => {
  const db = core.emptyDb();
  db.settings.moderation = true;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = call(db, 'POST', '/api/register', { name: 'M' + i, phone: '+7911000000' + i, tg: 'mod_user' + i, password: 'secret1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Мод Юзер ' + i, address: 'ПВЗ Ozon ' + i, agree: true }, as(r.user.id));
    ids.push(r.user.id);
  }
  assert.equal(call(db, 'GET', '/api/me', null, as(ids[0])).participation.moderation, 'pending');
  assert.equal(call(db, 'GET', '/api/public').count, 4); // на модерации тоже считаются в счётчике
  assert.throws(() => call(db, 'POST', '/api/admin/shuffle', {}, admin), /одобренных/);
  call(db, 'POST', '/api/admin/moderate', { userId: ids[0], status: 'approved' }, admin);
  call(db, 'POST', '/api/admin/moderate', { userId: ids[1], status: 'approved' }, admin);
  call(db, 'POST', '/api/admin/moderate', { userId: ids[2], status: 'rejected', note: 'подозрительный аккаунт' }, admin);
  assert.equal(call(db, 'GET', '/api/public').count, 3); // отклонённый не считается
  assert.ok(call(db, 'GET', '/api/me', null, as(ids[2])).notifications.some((n) => /подозрительный/.test(n.text)));
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  assert.deepEqual(new Set(db.pairs.map((p) => p.santaId)), new Set([ids[0], ids[1]]));
  assert.throws(() => call(db, 'POST', '/api/admin/moderate', { userId: ids[0], status: 'rejected' }, admin), /в паре/);
  // исправленная отклонённая анкета снова уходит на модерацию
  call(db, 'POST', '/api/admin/reset', {}, admin);
  call(db, 'POST', '/api/participate', { fullName: 'Мод Юзер 2', address: 'ПВЗ Ozon новый', agree: true }, as(ids[2]));
  assert.equal(db.participations[ids[2]].moderation, 'pending');
  // одобренная после правок остаётся одобренной
  call(db, 'POST', '/api/participate', { fullName: 'Мод Юзер 0', address: 'ПВЗ Ozon другой', agree: true }, as(ids[0]));
  assert.equal(db.participations[ids[0]].moderation, 'approved');
});
