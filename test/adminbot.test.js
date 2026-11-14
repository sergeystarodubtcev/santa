'use strict';
// Панель организатора в боте: статус по волнам, списки «кто что не сделал», напоминания и рассылка.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

let clock = Date.parse('2026-12-05T12:00:00+03:00');
const ctx = { now: () => clock, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p), checkAdmin: (p) => p === 'adminpw' };
const call = (db, m, p, b, as) => core.handle(db, Object.assign({}, ctx, as), m, p, b).data;
const admin = { isAdmin: true };
const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });
let n = 0;
const ADMIN = 990;
const msg = (db, chat, text) => bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
const press = (db, chat, data) => bot.handleUpdate(db, ctx, { update_id: ++n, callback_query: { id: 'c' + n, data, from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } });
const texts = (r) => r.out.filter((o) => o.text).map((o) => o.text).join('\n');
const buttons = (r) => r.out.flatMap((o) => (o.reply_markup && o.reply_markup.inline_keyboard ? o.reply_markup.inline_keyboard.flat().map((b) => b.callback_data) : []));

function seed() {
  const db = core.emptyDb();
  const ids = [0, 1, 2, 3, 4].map((i) => {
    const r = call(db, 'POST', '/api/register', { name: 'Игрок' + i, phone: '+795590000' + i, tg: 'adm_u' + i, password: 'qwerty1', pdConsent: true });
    call(db, 'POST', '/api/participate', { fullName: 'Игрок ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, { userId: r.user.id });
    if (i < 3) db.users.find((u) => u.id === r.user.id).tgChatId = 900 + i;
    return r.user.id;
  });
  call(db, 'POST', '/api/register', { name: 'Безанкеты', phone: '+79559009999', tg: 'adm_noform', password: 'qwerty1', pdConsent: true });
  msg(db, ADMIN, '/admin adminpw');
  call(db, 'POST', '/api/admin/shuffle', {}, admin);
  call(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, admin);
  return { db, ids };
}

test('бот организатора: статус, списки, напоминание с подтверждением', () => {
  const { db, ids } = seed();
  call(db, 'POST', '/api/ack', {}, { userId: ids[0] });
  call(db, 'POST', '/api/sent', {}, { userId: ids[1] });
  // меню организатора
  const g = msg(db, ADMIN, '/admin adminpw');
  assert.ok(JSON.stringify(g.out).includes('📊 Статус') && JSON.stringify(g.out).includes('📣 Рассылка'));
  // статус
  let r = msg(db, ADMIN, '📊 Статус');
  assert.match(texts(r), /Волна 1<\/b> · ✅ пары у участников/);
  assert.match(texts(r), /не подтвердили: 3 · 📦 не отправили: 4 · 🚚 отправили: 1/);
  assert.match(texts(r), /без анкеты: 1 · без бота: 2/);
  assert.deepEqual(buttons(r).filter((b) => b.startsWith('adm:l:')), ['adm:l:noack:1', 'adm:l:notsent:1', 'adm:l:notgot:1', 'adm:l:noform:1', 'adm:l:nobot:1']);
  // список «не отправили»
  r = press(db, ADMIN, 'adm:l:notsent:1');
  const t = texts(r);
  const santas = db.pairs.filter((p) => p.status === 'assigned').map((p) => db.users.find((u) => u.id === p.santaId).tg);
  santas.forEach((tg) => assert.ok(t.includes('@' + tg), tg));
  assert.ok(!t.includes('@' + db.users.find((u) => u.id === ids[1]).tg + ' '), 'отправивший не в списке');
  assert.ok(buttons(r).includes('adm:r:notsent:1'));
  // напоминание: сначала показываем текст, без кнопки — ничего не уходит
  const n0 = db.notifications.length;
  r = press(db, ADMIN, 'adm:r:notsent:1');
  assert.match(texts(r), /Проверьте рассылку[\s\S]*4 чел\./);
  assert.equal(db.notifications.length, n0, 'до подтверждения ничего не отправлено');
  r = press(db, ADMIN, 'adm:go');
  assert.match(texts(r), /Отправлено: 4/);
  const sent = db.notifications.slice(n0).filter((x) => x.kind === 'admin');
  assert.equal(sent.length, 4);
  assert.match(sent[0].text, /^Игрок\d, напоминаем: подарок нужно отправить до 10 декабря \(осталось 6 дней\)/, 'имя и срок подставлены');
  assert.ok(db.broadcasts.length === 1, 'рассылка в истории админки');
  // повторное нажатие «Отправить» — устарело, второй раз не шлём
  r = press(db, ADMIN, 'adm:go');
  assert.match(texts(r), /устарела/);
  assert.equal(db.broadcasts.length, 1);
});

test('бот организатора: свой текст, текст для общего чата, отмена; обычному участнику — нельзя', () => {
  const { db } = seed();
  // свой текст всем участникам
  let r = msg(db, ADMIN, '📣 Рассылка');
  assert.ok(buttons(r).includes('adm:o:all:0'));
  press(db, ADMIN, 'adm:o:all:0');
  r = msg(db, ADMIN, '{имя}, завтра финальный созвон в 20:00 ☕');
  assert.match(texts(r), /Проверьте рассылку[\s\S]*5 чел\./);
  r = press(db, ADMIN, 'adm:x');
  assert.match(texts(r), /Отменил/);
  assert.equal((db.broadcasts || []).length, 0);
  press(db, ADMIN, 'adm:o:all:0');
  msg(db, ADMIN, '{имя}, завтра финальный созвон в 20:00 ☕');
  press(db, ADMIN, 'adm:go');
  assert.equal(db.broadcasts.length, 1);
  assert.ok(db.notifications.some((x) => x.text === 'Игрок0, завтра финальный созвон в 20:00 ☕'));
  // текст для общего чата
  r = press(db, ADMIN, 'adm:c:nobot:0');
  assert.match(texts(r), /^Ребята! 👋\n@adm_u3\n@adm_u4\n\nП/);
  // обычный участник не может
  const u = 900;
  r = press(db, u, 'adm:st');
  assert.ok(!/Волна 1<\/b>/.test(texts(r)));
  r = msg(db, u, '📊 Статус');
  assert.ok(!/Волна 1<\/b>/.test(texts(r)), 'статус не показываем участникам');
  const nb = (db.broadcasts || []).length;
  press(db, u, 'adm:o:all:0');
  msg(db, u, 'спам всем');
  press(db, u, 'adm:go');
  assert.equal((db.broadcasts || []).length, nb, 'участник не может делать рассылки');
});

test('бот организатора: черновик жеребьёвки и вторая волна в статусе', () => {
  const { db } = seed();
  call(db, 'POST', '/api/admin/wave-create', {}, admin);
  let r = msg(db, ADMIN, '📊 Статус');
  assert.match(texts(r), /Волна 2<\/b> · 📝 идёт запись/);
  assert.ok(buttons(r).includes('adm:st:1') && buttons(r).includes('adm:st:2'), 'переключатель волн');
  r = press(db, ADMIN, 'adm:st:1');
  assert.match(texts(r), /Волна 1<\/b>/);
});
