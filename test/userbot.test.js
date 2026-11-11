'use strict';
// Личный аккаунт организатора: подстановки в рассылке, очередь для тех, у кого нет бота, вход и отправка.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
process.env.BUCKET = process.env.BUCKET || 'santa-test';
process.env.TG_BOT_USERNAME = 'kofesanta_bot';
const { userPoll } = require('../cloud/index.js')._internal;
const { createUserbot, encrypt, decrypt, keyFrom } = require('../relay/userbot.js');

let clock = Date.parse('2026-12-08T12:00:00+03:00');
const ctx = { now: () => clock, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p), checkAdmin: (p) => p === 'adminpw' };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
function seed() {
  const db = core.emptyDb();
  const ids = [0, 1, 2, 3].map((i) => {
    const r = call(db, 'POST', '/api/register', { name: 'Игрок' + i + ' Фамилия', phone: '+7955300000' + i, tg: 'ub_user' + i, password: 'qwerty1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Игрок ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, { userId: r.user.id });
    return r.user.id;
  });
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  db.users[0].tgChatId = 500; // у первого есть бот
  return { db, ids };
}

test('рассылка: {имя}, {срок}, {осталось}; тем, у кого нет бота, — в очередь личного аккаунта', () => {
  const { db, ids } = seed();
  assert.throws(() => call(db, 'POST', '/api/admin/broadcast', { text: 'x', userIds: ids, userTg: true }, admin), /не подключён/);
  db.userAcc = { status: 'ready', session: 'v1:xxx' };
  const r = call(db, 'POST', '/api/admin/broadcast', { text: '{имя}, отправьте до {срок} ({осталось})', userIds: ids, site: true, tg: true, userTg: true }, admin);
  assert.equal(r.viaUser, 3, 'трое без бота');
  const n = db.notifications.filter((x) => x.userId === ids[1]).pop();
  assert.equal(n.text, 'Игрок1, отправьте до 10 декабря (осталось 3 дня)');
  assert.equal(db.userOutbox.length, 3);
  assert.ok(!db.userOutbox.some((x) => x.userId === ids[0]), 'у кого есть бот — пишет бот');
  assert.equal(db.userOutbox[0].text.startsWith('Игрок'), true);
  clock = Date.parse('2026-12-12T12:00:00+03:00');
  assert.match(core.fillText(db, ctx, db.users[1], '{осталось}'), /срок уже прошёл/);
  const st = call(db, 'GET', '/api/admin/state', null, admin);
  assert.equal(st.userAcc.status, 'ready');
  assert.equal(st.userAcc.session, undefined, 'сессия в админку не уходит');
  assert.equal(st.broadcasts[0].uQueued, 3);
  const exp = call(db, 'GET', '/api/admin/export', null, admin);
  assert.equal(exp.userAcc.session, undefined, 'и в бэкап тоже');
});

test('вход в аккаунт и отправка: шаги через облако, код и пароль не задерживаются в базе', async () => {
  const { db, ids } = seed();
  let now = Date.parse('2026-12-08T12:00:00+03:00');
  // фальшивый Telegram
  const sent = [];
  let behaviour = {};
  const fakeClient = (session) => ({
    session: { save: () => 'SESSION-STRING' },
    async sendCode(api, phone) { assert.equal(phone, '+79001112233'); return { phoneCodeHash: 'HASH', isCodeViaApp: true }; },
    async invoke(req) {
      if (req.kind === 'SignIn') {
        if (req.phoneCode !== '12345') { const e = new Error('x'); e.errorMessage = 'PHONE_CODE_INVALID'; throw e; }
        const e = new Error('x'); e.errorMessage = 'SESSION_PASSWORD_NEEDED'; throw e;
      }
      if (req.kind === 'GetPassword') return { srp: 1 };
      if (req.kind === 'CheckPassword') { if (req.password !== 'srp:secretpw') { const e = new Error('x'); e.errorMessage = 'PASSWORD_HASH_INVALID'; throw e; } return {}; }
      return {};
    },
    async getMe() { return { firstName: 'Санта', lastName: 'Организатор', username: 'santa_org' }; },
    async sendMessage(to, { message }) {
      const b = behaviour[to];
      if (b === 'privacy') { const e = new Error('x'); e.errorMessage = 'USER_PRIVACY_RESTRICTED'; throw e; }
      if (b === 'flood') { const e = new Error('x'); e.errorMessage = 'PEER_FLOOD'; throw e; }
      sent.push({ to, message, session });
    },
    async destroy() {},
  });
  const lib = {
    Api: { auth: { SignIn: function (o) { Object.assign(this, o, { kind: 'SignIn' }); }, CheckPassword: function (o) { Object.assign(this, o, { kind: 'CheckPassword' }); }, LogOut: function () { this.kind = 'LogOut'; } },
      account: { GetPassword: function () { this.kind = 'GetPassword'; } } },
    computeCheck: async (pwd, password) => 'srp:' + password,
    makeClient: async (session) => fakeClient(session),
  };
  const site = async (path, body) => { assert.equal(path, '/api/tg/user-poll'); const r = userPoll(db, body, now); delete r.changed; return r; };
  const ub = createUserbot({ apiId: 1, apiHash: 'h', botToken: 'TOKEN', site, lib, sleep: async () => {}, now: () => now });
  const step = async () => {
    const res = await site('/api/tg/user-poll', { want: ub._state().ready ? 1 : 0 });
    let report = res.task ? await ub.doTask(res.task) : null;
    if (!report && !ub._state().ready && res.session) report = await ub.restore(res.session);
    const results = [];
    for (const it of res.items) { const r = await ub.send(it); results.push(r.result); if (r.report) report = r.report; }
    if (report || results.length) await site('/api/tg/user-poll', { report, results, want: 0 });
    return res;
  };
  // админ вводит телефон
  call(db, 'POST', '/api/admin/useracc', { action: 'phone', value: '+7 900 111-22-33' }, admin);
  await step();
  assert.equal(db.userAcc.status, 'code_sent');
  assert.match(call(db, 'GET', '/api/admin/state', null, admin).userAcc.phone, /•••/);
  // неверный код
  call(db, 'POST', '/api/admin/useracc', { action: 'code', value: '00000' }, admin);
  assert.equal(db.userAcc.code, '00000');
  await step();
  assert.equal(db.userAcc.code, undefined, 'код удалён из базы, как только его забрал ретранслятор');
  assert.equal(db.userAcc.status, 'code_sent');
  assert.match(db.userAcc.error, /Неверный код/);
  // верный код → облачный пароль
  call(db, 'POST', '/api/admin/useracc', { action: 'code', value: '12-345' }, admin);
  await step();
  assert.equal(db.userAcc.status, 'need_password');
  call(db, 'POST', '/api/admin/useracc', { action: 'password', value: 'wrong' }, admin);
  await step();
  assert.equal(db.userAcc.password, undefined);
  assert.match(db.userAcc.error, /Неверный облачный пароль/);
  call(db, 'POST', '/api/admin/useracc', { action: 'password', value: 'secretpw' }, admin);
  await step();
  assert.equal(db.userAcc.status, 'ready');
  assert.equal(db.userAcc.me.username, 'santa_org');
  assert.ok(db.userAcc.session.startsWith('v1:'), 'сессия зашифрована');
  assert.equal(decrypt(db.userAcc.session, keyFrom('TOKEN')), 'SESSION-STRING');
  assert.ok(!JSON.stringify(db).includes('SESSION-STRING'), 'в базе нет открытой сессии');
  assert.ok(!JSON.stringify(db).includes('secretpw'), 'и пароля');
  // рассылка: трое без бота; у одного закрыты сообщения
  behaviour = { ub_user2: 'privacy' };
  call(db, 'POST', '/api/admin/broadcast', { text: '{имя}, срок до {срок}', userIds: ids, site: false, tg: false, userTg: true }, admin);
  for (let i = 0; i < 4; i++) await step();
  assert.equal(sent.length, 2);
  assert.match(sent[0].message, /^Игрок\d, срок до 10 декабря/);
  assert.match(sent[0].message, /@kofesanta_bot/, 'в конце — приглашение в бот');
  const b = call(db, 'GET', '/api/admin/state', null, admin).broadcasts[0];
  assert.deepEqual([b.uTotal, b.uSent, b.uFailed, b.uQueued], [3, 2, 1, 0]);
  assert.match(b.uErrors[0], /@ub_user2: закрыл сообщения от незнакомых/);
  // спам-блок: стоп, сообщение остаётся в очереди, админам — сигнал
  db.tgAdmins = [999];
  behaviour = { ub_user1: 'flood' };
  call(db, 'POST', '/api/admin/broadcast', { text: 'ещё раз', userIds: [ids[1]], site: false, tg: false, userTg: true }, admin);
  await step();
  assert.equal(db.userAcc.status, 'limited');
  assert.equal(db.userOutbox.filter((x) => x.status === 'queued').length, 1);
  assert.ok((db.tgOutbox || []).some((m) => m.chat_id === 999 && /спам-блок/.test(m.text)));
  // пока ограничен — не отдаём сообщения; «Продолжить» — снова в работу
  assert.equal(userPoll(db, { want: 1 }, now).items.length, 0);
  call(db, 'POST', '/api/admin/useracc', { action: 'resume' }, admin);
  behaviour = {};
  await step();
  assert.equal(sent.length, 3);
  // суточный лимит
  db.userAcc.sent = { day: new Date(now + 3 * 3600e3).toISOString().slice(0, 10), n: 40 };
  call(db, 'POST', '/api/admin/broadcast', { text: 'лимит', userIds: [ids[1]], site: false, tg: false, userTg: true }, admin);
  assert.equal(userPoll(db, { want: 1 }, now).items.length, 0, 'суточный лимит');
  now += 86400e3;
  assert.equal(userPoll(db, { want: 1 }, now).items.length, 1, 'на следующий день — продолжаем');
  // отключение
  call(db, 'POST', '/api/admin/useracc', { action: 'logout' }, admin);
  await step();
  assert.equal(db.userAcc.status, 'off');
  assert.equal(db.userAcc.session, undefined);
});

test('шифрование сессии: другой ключ не расшифрует', () => {
  const enc = encrypt('abc', keyFrom('A'));
  assert.equal(decrypt(enc, keyFrom('A')), 'abc');
  assert.throws(() => decrypt(enc, keyFrom('B')));
});

test('переключатель: выключено — рассылка с аккаунта запрещена, очередь на паузе', () => {
  const { db, ids } = seed();
  db.userAcc = { status: 'ready', session: 'v1:x' };
  call(db, 'POST', '/api/admin/broadcast', { text: 'a', userIds: ids, site: false, tg: false, userTg: true }, admin);
  call(db, 'POST', '/api/admin/settings', { userTg: false }, admin);
  assert.equal(call(db, 'GET', '/api/admin/state', null, admin).userAcc.enabled, false);
  assert.throws(() => call(db, 'POST', '/api/admin/broadcast', { text: 'b', userIds: ids, userTg: true }, admin), /выключена/);
  assert.equal(userPoll(db, { want: 1 }, Date.now()).items.length, 0, 'очередь на паузе');
  call(db, 'POST', '/api/admin/settings', { userTg: true }, admin);
  assert.equal(userPoll(db, { want: 1 }, Date.now()).items.length, 1);
});

test('Санта подтверждает «собираю посылку» — на сайте и в боте', () => {
  const { db, ids } = seed();
  const { createBot } = require('../cloud/bot.js');
  const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });
  assert.equal(call(db, 'GET', '/api/me', null, { userId: ids[1] }).assignment.ackAt, null);
  call(db, 'POST', '/api/ack', {}, { userId: ids[1] });
  assert.ok(call(db, 'GET', '/api/me', null, { userId: ids[1] }).assignment.ackAt);
  // бот: у Санты без подтверждения — кнопка «Участвую, собираю посылку»
  const r1 = bot.handleUpdate(db, ctx, { update_id: 1, callback_query: { id: 'c1', data: 'whom', from: { id: 500 }, message: { chat: { id: 500, type: 'private' } } } });
  const kb = r1.out.find((o) => o.reply_markup && o.reply_markup.inline_keyboard).reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'ack');
  const r2 = bot.handleUpdate(db, ctx, { update_id: 2, callback_query: { id: 'c2', data: 'ack', from: { id: 500 }, message: { chat: { id: 500, type: 'private' } } } });
  assert.match(r2.out.map((o) => o.text).join(' '), /собираете посылку/);
  assert.ok(db.pairs.find((p) => p.santaId === ids[0]).ackAt);
});
