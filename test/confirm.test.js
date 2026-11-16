'use strict';
// Жеребьёвка с подтверждением организатором: автозапуск в 00:00, черновик пар, «изменить пару», подтверждение.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const W2DATES = { start: '2026-12-11T00:00:00+03:00', end: '2026-12-20T23:59:59+03:00' };
const { createBot } = require('../cloud/bot.js');

let clock = Date.parse('2026-11-19T23:58:00+03:00');
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ctx = { now: () => clock, random: rnd, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p), checkAdmin: (p) => p === 'adminpw' };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const as = (id) => ({ userId: id });
const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });

function seedDb(n) {
  const db = core.emptyDb();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = call(db, 'POST', '/api/register', { name: 'U' + i, phone: '+795560' + String(i).padStart(5, '0'), tg: 'cf_user' + i, password: 'qwerty1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Участник ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, as(r.user.id));
    ids.push(r.user.id);
  }
  return { db, ids };
}
// инвариант: в волне каждый участник ровно один раз дарит и ровно один раз получает, никто не дарит себе
function assertValid(db, n, ids) {
  const pairs = db.pairs.filter((p) => (p.round > 1 ? p.round : 1) === n);
  assert.equal(pairs.length, ids.length, 'пар столько же, сколько участников');
  assert.deepEqual(pairs.map((p) => p.santaId).sort(), ids.slice().sort(), 'каждый дарит ровно один раз');
  assert.deepEqual(pairs.map((p) => p.recipientId).sort(), ids.slice().sort(), 'каждый получает ровно один раз');
  assert.ok(pairs.every((p) => p.santaId !== p.recipientId), 'никто не дарит сам себе');
  assert.deepEqual(core.checkWave(db, n), []);
}

test('автожеребьёвка в 00:00 создаёт черновик; участники ничего не видят до подтверждения', () => {
  const { db, ids } = seedDb(6);
  db.tgAdmins = [999];
  call(db, 'POST', '/api/admin/wave-set', { n: 1, drawAt: '2026-11-20T00:00:00+03:00' }, admin);
  assert.equal(core.tick(db, ctx), false, 'до 00:00 ничего не происходит');
  assert.equal(db.pairs.length, 0);
  clock = Date.parse('2026-11-20T00:00:30+03:00');
  const n0 = db.notifications.length;
  assert.equal(core.tick(db, ctx), true);
  assert.equal(db.waves[0].status, 'drawing');
  assertValid(db, 1, ids);
  assert.equal(core.tick(db, ctx), false, 'второй раз не перемешивает');
  // участникам — ни уведомлений, ни получателей; админам — сообщение
  const fresh = db.notifications.slice(n0);
  assert.ok(fresh.every((x) => x.userId === '@admins'), 'пишем только организаторам');
  assert.ok(fresh.some((x) => /готова.*Подтвердить/.test(x.text)));
  for (const id of ids) {
    const me = call(db, 'GET', '/api/me', null, as(id));
    assert.equal(me.assignment, undefined, 'получатель скрыт до подтверждения');
    assert.equal(me.incoming, undefined);
    assert.equal(me.deadline, null);
    assert.equal(me.drawing, true);
  }
  assert.throws(() => call(db, 'POST', '/api/sent', {}, as(ids[0])), /нет получателя/, 'отметить отправку нельзя');
  // бот: «идёт жеребьёвка»
  db.users[0].tgChatId = 501;
  const r = bot.handleUpdate(db, ctx, { update_id: 1, callback_query: { id: 'c', data: 'whom', from: { id: 501 }, message: { chat: { id: 501, type: 'private' } } } });
  assert.match(r.out.map((o) => o.text).join(' '), /Идёт жеребьёвка/);
  assert.equal(bot.runReminders(db, ctx).filter((o) => o.chat_id === 501).length, 0, 'напоминаний по черновику нет');
  // сайт: «идёт жеребьёвка», новые — в лист ожидания
  const pub = call(db, 'GET', '/api/public');
  assert.equal(pub.drawing, 1);
  assert.equal(pub.confirmed, null);
  const late = call(db, 'POST', '/api/register', { name: 'Late', phone: '+79556099999', tg: 'cf_late', password: 'qwerty1', pdConsent: true });
  assert.throws(() => call(db, 'POST', '/api/participate', { fullName: 'Поздний', address: 'ПВЗ Ozon, Казань', agree: true }, as(late.user.id)), /следующей волне/);
  call(db, 'POST', '/api/participate', { fullName: 'Поздний', address: 'ПВЗ Ozon, Казань', agree: true, wave2: true }, as(late.user.id));
  assert.equal(db.wave2[late.user.id].status, 'waiting');
  assertValid(db, 1, ids); // поздний в первую волну не попал
  // пока черновик: ни новой волны, ни остановки, ни «пострадавших»
  assert.throws(() => call(db, 'POST', '/api/admin/wave-create', W2DATES, admin), /подтвердите/);
  assert.throws(() => call(db, 'POST', '/api/admin/wave-set', { n: 1, action: 'close' }, admin), /подтвердите или сбросьте/);
  assert.throws(() => call(db, 'POST', '/api/admin/wave2-rescue', { santaId: ids[0] }, admin), /не подтверждена/);

  // подтверждение
  const before = db.notifications.length;
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  assert.equal(db.waves[0].status, 'drawn');
  const sent = db.notifications.slice(before).filter((x) => x.action === 'whom');
  assert.deepEqual(sent.map((x) => x.userId).sort(), ids.slice().sort(), 'каждому Санте — уведомление');
  for (const id of ids) {
    const me = call(db, 'GET', '/api/me', null, as(id));
    assert.ok(me.assignment && me.assignment.recipient.address, 'после подтверждения получатель виден');
    assert.equal(me.drawing, false);
  }
  const pub2 = call(db, 'GET', '/api/public');
  assert.equal(pub2.drawing, null);
  assert.equal(pub2.confirmed, 1);
  assert.throws(() => call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin), /уже подтверждена/);
  assert.throws(() => call(db, 'POST', '/api/admin/pair-swap', { round: 1, userId: ids[0], side: 'santa' }, admin), /только до подтверждения/);
  // теперь можно создать следующую волну — лист ожидания сразу добавлен в неё
  call(db, 'POST', '/api/admin/wave-create', W2DATES, admin);
  assert.equal(db.wave2[late.user.id].status, 'confirmed');
});

test('«изменить пару»: сотни случайных замен на волнах разного размера — без двойных и «самому себе»', () => {
  for (const n of [3, 4, 5, 7, 10, 25, 60]) {
    const { db, ids } = seedDb(n);
    call(db, 'POST', '/api/admin/shuffle', {}, admin);
    assertValid(db, 1, ids);
    for (let k = 0; k < 120; k++) {
      const userId = ids[Math.floor(rnd() * n)];
      const side = rnd() < 0.5 ? 'santa' : 'recipient';
      const pairs = db.pairs.filter((p) => !p.round || p.round === 1);
      const old = side === 'santa' ? pairs.find((p) => p.santaId === userId).recipientId : pairs.find((p) => p.recipientId === userId).santaId;
      const res = call(db, 'POST', '/api/admin/pair-swap', { round: 1, userId, side }, admin);
      assertValid(db, 1, ids);
      const now = side === 'santa' ? pairs.find((p) => p.santaId === userId).recipientId : pairs.find((p) => p.recipientId === userId).santaId;
      assert.notEqual(now, old, `у человека действительно поменялась пара (n=${n})`);
      assert.ok(res.swapped.length >= 2, 'меняются минимум две пары');
    }
    call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
    assertValid(db, 1, ids);
  }
});

test('двое участников: поменять не с кем; подтверждение с ошибкой в парах не проходит', () => {
  const { db, ids } = seedDb(2);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  assert.throws(() => call(db, 'POST', '/api/admin/pair-swap', { round: 1, userId: ids[0], side: 'santa' }, admin), /не с кем/);
  // испорченные пары (например, ручная правка) — подтвердить нельзя
  const { db: db2, ids: ids2 } = seedDb(4);
  call(db2, 'POST', '/api/admin/shuffle', {}, admin);
  db2.pairs[1].recipientId = db2.pairs[0].recipientId;
  assert.throws(() => call(db2, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin), /ошибками/);
  assert.equal(db2.waves[0].status, 'drawing');
  assert.ok(ids2.length === 4);
});

test('перемешать заново после подтверждения — снова черновик; сброс — снова запись', () => {
  const { db, ids } = seedDb(5);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  assert.equal(db.waves[0].status, 'drawing');
  assert.equal(call(db, 'GET', '/api/me', null, as(ids[0])).assignment, undefined, 'новые пары снова скрыты до подтверждения');
  call(db, 'POST', '/api/admin/reset', { round: 1 }, admin);
  assert.equal(db.waves[0].status, 'open');
  assert.equal(db.pairs.length, 0);
});
