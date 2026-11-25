'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/js/core');

const now = Date.parse('2026-11-25T12:00:00+03:00');
const wave = (n, status = 'drawn') => ({
  n, status, start: '2026-11-25T00:00:00+03:00', end: '2026-12-10T00:00:00+03:00',
  ...(status === 'drawn' ? { drawnAt: now, confirmedAt: now } : {}),
});
let serial = 0;
const ctx = { isAdmin: true, now: () => now, random: () => 0, id: () => 'new' + ++serial };
const call = (db, method, path, body, extra) => core.handle(db, { ...ctx, ...extra }, method, path, body).data;
const service = (db, action, body) => call(db, 'POST', '/api/admin/service/' + action, body);
const fixture = () => {
  const db = core.emptyDb();
  db.waves = [wave(1), wave(2), wave(3, 'open')];
  db.drawnAt = now;
  db.drawn2At = now;
  for (let i = 0; i < 7; i++) {
    const id = 'u' + i;
    const round = i < 3 ? 1 : i < 6 ? 2 : 3;
    db.users.push({ id, name: 'Участник ' + i, tg: 'member' + i, phone: '+7900000000' + i, pdConsentAt: now, passHash: 'original-' + i });
    db.participations[id] = { round, fullName: 'Участник Тест ' + i, address: 'ПВЗ Ozon, Казань ' + i, wishes: 'Кофе ' + i, prefs: 'coffee', moderation: 'approved' };
    if (round > 1) db.wave2[id] = { round, status: 'confirmed' };
  }
  const pair = (round, from, to) => ({ round, santaId: 'u' + from, recipientId: 'u' + to, status: 'assigned' });
  db.pairs = [pair(1, 0, 1), pair(1, 1, 2), pair(1, 2, 0), pair(2, 3, 4), pair(2, 4, 5), pair(2, 5, 3)];
  return db;
};

test('перевод между подтверждёнными волнами сохраняет аккаунт, перестраивает только нужные связи и требует актуального плана', () => {
  let db = fixture();
  const body = { userId: 'u0', from: 1, to: 2, recipientId: 'u4' };
  const initial = JSON.stringify(db);
  const plan = service(db, 'move', body);
  assert.equal(JSON.stringify(db), initial);
  assert.match(plan.summary, /@member2 → @member1/);
  db.pairs[3].sentAt = now;
  const sent = JSON.stringify(db);
  assert.throws(() => service(db, 'move', { ...body, revision: plan.revision }), /уже отправлена/);
  assert.equal(JSON.stringify(db), sent);
  delete db.pairs[3].sentAt;
  db.pairs[3].ackAt = now;
  assert.throws(() => service(db, 'move', { ...body, revision: plan.revision }), /изменились/);
  const current = service(db, 'move', body);
  service(db, 'move', { ...body, revision: current.revision });
  db = core.ensure(JSON.parse(JSON.stringify(db)));
  assert.deepEqual(core.checkWave(db, 1), []);
  assert.deepEqual(core.checkWave(db, 2), []);
  const me = call(db, 'GET', '/api/me', null, { userId: 'u0', isAdmin: false });
  assert.deepEqual(me.ownAnketas.map((form) => form.round), [2]);
  assert.equal(me.assignments[0].recipient.wishes, 'Кофе 4');
  assert.equal(db.users[0].passHash, 'original-0');
  assert.equal(db.wave2.u6.round, 3);
});

test('перевод из третьей волны в первую и ручное назначение до жеребьёвки', () => {
  const db = fixture();
  db.waves[0] = wave(1, 'open');
  db.pairs = db.pairs.filter((p) => p.round !== 1);
  const body = { userId: 'u6', from: 3, to: 1, recipientId: 'u1' };
  const plan = service(db, 'move', body);
  service(db, 'move', { ...body, revision: plan.revision });
  assert.equal(call(db, 'GET', '/api/me', null, { userId: 'u6', isAdmin: false }).assignments.length, 0);
  call(db, 'POST', '/api/admin/shuffle', { round: 1 });
  assert.deepEqual(core.checkWave(db, 1), []);
  assert.equal(db.pairs.find((p) => p.round === 1 && p.santaId === 'u6').recipientId, 'u1');
  assert.equal(db.pairs.find((p) => p.round === 1 && p.santaId === 'u6').locked, true);
  assert.equal(db.pairs.filter((p) => p.round === 2).length, 3);
});

test('архив и точечное восстановление проверяют аккаунт и сохраняют остальную базу', () => {
  const db = fixture();
  const pairs = JSON.stringify(db.pairs);
  const accounts = JSON.stringify(db.users);
  assert.throws(() => service(db, 'archive', { userId: 'u0' }), /Сначала снимите/);
  service(db, 'archive', { userId: 'u6' });
  assert.equal(db.participations.u6, undefined);
  const [record] = call(db, 'GET', '/api/admin/service/archive');
  assert.equal(record.wishes, 'Кофе 6');
  assert.equal(record.passHash, undefined);
  assert.throws(() => call(db, 'GET', '/api/admin/service/archive', null, { isAdmin: false }), /админку/);
  assert.throws(() => service(db, 'restore', { userId: 'u6', backup: { tg: 'member6', phone: '+79000000000', form: record } }), /не совпадают/);
  service(db, 'restore', { userId: 'u6', archiveId: record.id });
  assert.equal(db.participations.u6.round, 0);
  assert.equal(db.participations.u6.wishes, 'Кофе 6');
  assert.throws(() => service(db, 'restore', { userId: 'u6', archiveId: record.id }), /действующая анкета/);
  service(db, 'form', { userId: 'u6', round: 0, form: { ...record, wishes: 'Чай' } });
  service(db, 'archive', { userId: 'u6' });
  service(db, 'restore', { userId: 'u6', backup: { tg: 'member6', phone: '+79000000006', form: record } });
  assert.equal(db.participations.u6.wishes, 'Кофе 6');
  assert.equal(JSON.stringify(db.pairs), pairs);
  assert.equal(JSON.stringify(db.users), accounts);
  call(db, 'POST', '/api/account/delete', {}, { userId: 'u6', isAdmin: false });
  assert.deepEqual(call(db, 'GET', '/api/admin/service/archive'), []);
});

test('отклонённая анкета с номером волны доступна как анкета без волны', () => {
  const db = fixture();
  db.participations.u6.moderation = 'rejected';
  const user = () => call(db, 'GET', '/api/admin/state').users.find((item) => item.id === 'u6');
  assert.deepEqual(user().serviceSourceRounds, []);
  const body = { userId: 'u6', from: 0, to: 1, recipientId: 'u1' };
  const plan = service(db, 'move', body);
  service(db, 'move', { ...body, revision: plan.revision });
  assert.deepEqual(user().serviceSourceRounds, [1]);
  assert.equal(db.participations.u6.moderation, 'approved');
  assert.equal(db.wave2.u6, undefined);
  assert.deepEqual(core.checkWave(db, 1), []);
});

test('сравнение старой копии и восстановление полей анкеты учитывают актуальное состояние', () => {
  const db = fixture();
  const snapshot = core.serviceBackupSnapshot(JSON.parse(JSON.stringify(db)));
  const old = snapshot.find((item) => item.userId === 'u0');
  assert.deepEqual(old.rounds, [1]);
  assert.equal(old.recipientId, 'u1');
  assert.equal(old.passHash, undefined);
  assert.equal(old.form.wishes, 'Кофе 0');
  const expected = { ...old.form, wishes: 'Современные пожелания' };
  const body = { userId: 'u0', round: 1, expected, backup: { userId: old.userId, form: old.form } };
  assert.throws(() => service(db, 'restore', body), /изменилась после сравнения/);
  db.participations.u0.wishes = expected.wishes;
  const pairs = JSON.stringify(db.pairs);
  const accounts = JSON.stringify(db.users);
  service(db, 'restore', body);
  assert.equal(db.participations.u0.wishes, old.form.wishes);
  assert.equal(db.participations.u0.moderation, 'approved');
  assert.deepEqual(db.participations.u0.round, 1);
  assert.equal(JSON.stringify(db.pairs), pairs);
  assert.equal(JSON.stringify(db.users), accounts);
});

test('воссоздание аккаунта назначает новый ID и пароль, восстанавливает анкету без пар и уведомляет сохранённый чат', () => {
  const db = fixture();
  db.users.find((u) => u.id === 'u6').tgChatId = 606;
  const [backup] = core.serviceBackupSnapshot(JSON.parse(JSON.stringify(db))).filter((row) => row.userId === 'u6');
  call(db, 'POST', '/api/account/delete', {}, { userId: 'u6', isAdmin: false });
  const pairs = JSON.stringify(db.pairs);
  const payload = { backup, password: 'new-password-123', pdConsent: true };
  const extra = { hash: (s) => 'new-hash:' + s };
  assert.throws(() => call(db, 'POST', '/api/admin/service/recreate', { ...payload, pdConsent: false }, extra), /согласился/);
  assert.throws(() => call(db, 'POST', '/api/admin/service/recreate', payload, { ...extra, isAdmin: false }), /админку/);
  const before = db.notifications.length;
  const view = call(db, 'POST', '/api/admin/service/recreate', payload, extra);
  const user = db.users.find((u) => u.tg === 'member6');
  assert.notEqual(user.id, 'u6');
  assert.equal(user.passHash, 'new-hash:' + payload.password);
  assert.equal(view.telegramLinked, true);
  assert.equal(db.participations[user.id].round, 0);
  assert.equal(JSON.stringify(db.pairs), pairs);
  const { createBot } = require('../cloud/bot');
  const bot = createBot({ core, secret: 'test', siteUrl: 'https://example.com', username: 'testbot' });
  const outgoing = bot.pushNotifications(db, db.notifications.slice(before));
  assert.equal(outgoing[0].chat_id, 606);
  assert.match(outgoing[0].text, /аккаунт Тайного Санты восстановлен/);
  assert.equal(outgoing[0].text.includes(payload.password), false);
  assert.throws(() => call(db, 'POST', '/api/admin/service/recreate', payload, extra), /уже зарегистрирован/);

  call(db, 'POST', '/api/account/delete', {}, { userId: user.id, isAdmin: false });
  db.users[0].tgChatId = 606;
  const conflicting = call(db, 'POST', '/api/admin/service/recreate', payload, extra);
  assert.equal(conflicting.telegramLinked, false);
  assert.equal(db.users[0].tgChatId, 606);
});
