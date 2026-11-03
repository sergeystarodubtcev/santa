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
    const r = call(db, 'POST', '/api/register', { name: 'User ' + i, phone: '8900123456' + i, tg: '@user_' + i, password: 'secret1' });
    ids.push(r.user.id);
    call(db, 'POST', '/api/participate', { address: 'Ozon ПВЗ ' + i, wishes: 'кофе', agree: true, prefs: 'coffee' }, as(r.user.id));
  }
  return { db, ids };
}

test('регистрация нормализует телефон и ник, не пускает дубликаты', () => {
  const db = core.emptyDb();
  const r = call(db, 'POST', '/api/register', { name: 'Сергей', phone: '8 (900) 123-45-67', tg: 'https://t.me/Sergey_Coffee', password: 'qwerty' });
  assert.equal(r.user.phone, '+79001234567');
  assert.equal(r.user.tg, 'sergey_coffee');
  assert.throws(() => call(db, 'POST', '/api/register', { name: 'Икс', phone: '+7 900 123 45 67', tg: 'other', password: 'qwerty' }), /телефон/);
  const l1 = call(db, 'POST', '/api/login', { login: '@Sergey_Coffee', password: 'qwerty' });
  const l2 = call(db, 'POST', '/api/login', { login: '89001234567', password: 'qwerty' });
  assert.equal(l1.user.id, l2.user.id);
  assert.throws(() => call(db, 'POST', '/api/login', { login: 'sergey_coffee', password: 'nope' }), /Неверный/);
});

test('анкета требует согласия и адреса, счётчик растёт', () => {
  const { db } = seed(3);
  assert.equal(call(db, 'GET', '/api/public').count, 3);
  const r = call(db, 'POST', '/api/register', { name: 'Аня', phone: '+79990000000', tg: 'anya_v60', password: 'secret1' });
  assert.throws(() => call(db, 'POST', '/api/participate', { address: 'ПВЗ Ozon', agree: false }, as(r.user.id)), /Подтвердите/);
  call(db, 'POST', '/api/participate', { address: 'ПВЗ Ozon', agree: true, notes: 'у меня аллергия на инфьюзы' }, as(r.user.id));
  const pub = call(db, 'GET', '/api/public');
  assert.equal(pub.count, 4);
  assert.equal(pub.recent[0], 'Аня');
});

test('жеребьёвка: одна цепочка, без пар с самим собой, каждый дарит и получает ровно раз', () => {
  for (const n of [2, 3, 7, 30]) {
    const { db, ids } = seed(n);
    assert.throws(() => call(db, 'POST', '/api/admin/shuffle', {}), /админку/);
    call(db, 'POST', '/api/admin/shuffle', {}, admin);
    assert.equal(db.pairs.length, n);
    const santas = new Set(db.pairs.map((p) => p.santaId));
    const recips = new Set(db.pairs.map((p) => p.recipientId));
    assert.equal(santas.size, n);
    assert.equal(recips.size, n);
    db.pairs.forEach((p) => assert.notEqual(p.santaId, p.recipientId));
    // проверяем что это один цикл
    let cur = ids[0], steps = 0;
    do { cur = db.pairs.find((p) => p.santaId === cur).recipientId; steps++; } while (cur !== ids[0]);
    assert.equal(steps, n);
  }
});

test('забаненные не участвуют, после жеребьёвки новые не регистрируются', () => {
  const { db, ids } = seed(4);
  call(db, 'POST', '/api/admin/ban', { userId: ids[0], banned: true }, admin);
  assert.equal(call(db, 'GET', '/api/public').count, 3);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  assert.equal(db.pairs.length, 3);
  assert.ok(!db.pairs.some((p) => p.santaId === ids[0] || p.recipientId === ids[0]));
  const r = call(db, 'POST', '/api/register', { name: 'Late', phone: '+79995550000', tg: 'late_one', password: 'secret1' });
  assert.throws(() => call(db, 'POST', '/api/participate', { address: 'ПВЗ Ozon', agree: true }, as(r.user.id)), /Жеребьёвка/);
});

test('полный цикл: получатель, дедлайн, отправка, «Вам подарок от Деда Мороза», получение', () => {
  const { db, ids } = seed(3);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  const santa = ids[0];
  const recipientId = db.pairs.find((p) => p.santaId === santa).recipientId;

  let me = call(db, 'GET', '/api/me', null, as(santa));
  assert.ok(me.assignment.recipient.address.startsWith('Ozon'));
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
