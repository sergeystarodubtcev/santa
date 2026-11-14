'use strict';
// Фото к посылке (QR-код и т. п.): загрузка в облаке, доступ только Санте, получателю и организатору, фото из бота.
const test = require('node:test');
const assert = require('node:assert');

const store = new Map();
const deleted = [];
global.fetch = async (url, opts = {}) => {
  const key = new URL(url).pathname;
  if (opts.method === 'PUT') { store.set(key, opts.body); return { ok: true, status: 200, text: async () => '' }; }
  if (opts.method === 'DELETE') { deleted.push(key); store.delete(key); return { ok: true, status: 204, text: async () => '' }; }
  if (!store.has(key)) return { ok: false, status: 404, text: async () => 'NoSuchKey' };
  return { ok: true, status: 200, text: async () => store.get(key) };
};
process.env.BUCKET = 'santa-photo-test';
process.env.ADMIN_PASSWORD = 'adminpw';
const { handler } = require('../cloud/index.js');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');
const ctx = { token: { access_token: 'iam-token' } };
const call = async (method, url, body, token) => {
  const r = await handler({
    httpMethod: method, url, path: '/api/{proxy+}', pathParams: { proxy: url.replace(/^\/api\//, '') },
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? Buffer.from(JSON.stringify(body)).toString('base64') : '', isBase64Encoded: true,
  }, ctx);
  return { status: r.statusCode, data: JSON.parse(r.body) };
};
// маленький PNG 1×1
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('облако: фото к посылке видят Санта, получатель (после отправки) и организатор', async () => {
  const toks = [];
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/register', { name: 'Ф' + i, phone: '+7955800000' + i, tg: 'photo_u' + i, password: 'qwerty1', pdConsent: true });
    await call('POST', '/api/participate', { fullName: 'Фото Тест ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, r.data.token);
    toks.push({ token: r.data.token, id: r.data.user.id });
  }
  const adm = (await call('POST', '/api/admin/login', { password: 'adminpw' })).data.token;
  await call('POST', '/api/admin/shuffle', {}, adm);
  await call('POST', '/api/admin/wave-confirm', { n: 1 }, adm);
  const db = JSON.parse(store.get('/santa-photo-test/data/db.json'));
  const pair = db.pairs.find((p) => p.santaId === toks[0].id);
  const santa = toks[0];
  const rec = toks.find((t) => t.id === pair.recipientId);
  const other = toks.find((t) => t !== santa && t !== rec);
  // не картинка — отказ
  assert.equal((await call('POST', '/api/track-photo', { image: 'data:text/html;base64,PGI+' }, santa.token)).status, 400);
  assert.equal((await call('POST', '/api/track-photo', { image: 'data:image/png;base64,' + 'A'.repeat(2200000) }, santa.token)).status, 413);
  // Санта прикрепляет фото
  let r = await call('POST', '/api/track-photo', { image: PNG }, santa.token);
  assert.equal(r.status, 200);
  const photoId = r.data.assignment.photoId;
  assert.match(photoId, /^[a-f0-9]{24}$/);
  assert.ok(store.has(`/santa-photo-test/data/photos/${photoId}.json`), 'файл лежит в бакете отдельно от базы');
  assert.ok(!store.get('/santa-photo-test/data/db.json').includes('iVBORw0KGgo'), 'картинка не попадает в базу');
  // Санта видит; получатель — пока не отправлено — нет; посторонний — нет
  assert.equal((await call('POST', '/api/photo', { id: photoId }, santa.token)).data.image, PNG);
  assert.equal((await call('POST', '/api/photo', { id: photoId }, rec.token)).status, 404);
  assert.equal((await call('POST', '/api/photo', { id: photoId }, other.token)).status, 404);
  assert.equal((await call('POST', '/api/photo', { id: photoId })).status, 404, 'без входа — нет');
  // после «Я отправил» получатель видит фото и уведомление о нём
  await call('POST', '/api/sent', { track: 'T1' }, santa.token);
  const me = (await call('GET', '/api/me', null, rec.token)).data;
  assert.equal(me.incoming.photoId, photoId);
  assert.ok(me.notifications.some((n) => /прикрепил фото/.test(n.text)));
  assert.equal((await call('POST', '/api/photo', { id: photoId }, rec.token)).data.image, PNG);
  assert.equal((await call('POST', '/api/photo', { id: photoId }, other.token)).status, 404);
  assert.equal((await call('POST', '/api/photo', { id: photoId }, adm)).data.image, PNG, 'организатор видит');
  // замена фото — старый файл удаляется
  r = await call('POST', '/api/track-photo', { image: PNG }, santa.token);
  assert.notEqual(r.data.assignment.photoId, photoId);
  assert.ok(deleted.includes(`/santa-photo-test/data/photos/${photoId}.json`));
  // получателю нельзя прикрепить фото к чужой посылке (у него своя пара, но фото — к своей отправке)
  const r2 = await call('POST', '/api/track-photo', { image: PNG }, rec.token);
  assert.equal(r2.status, 200);
  const db2 = JSON.parse(store.get('/santa-photo-test/data/db.json'));
  assert.equal(db2.pairs.find((p) => p.santaId === rec.id).photoId, r2.data.assignment.photoId, 'фото — к своей паре');
});

test('бот: фото вместо трек-номера — получателю приходит то же фото', () => {
  let clock = Date.parse('2026-12-03T12:00:00+03:00');
  const c = { now: () => clock, hash: (p) => 'h:' + p, verify: (p, h) => h === 'h:' + p, issueToken: (p) => JSON.stringify(p) };
  const callc = (db, m, p, b, as) => core.handle(db, Object.assign({}, c, as), m, p, b).data;
  const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });
  const db = core.emptyDb();
  const ids = [0, 1].map((i) => {
    const r = callc(db, 'POST', '/api/register', { name: 'Б' + i, phone: '+7955810000' + i, tg: 'photo_b' + i, password: 'qwerty1', pdConsent: true });
    callc(db, 'POST', '/api/participate', { fullName: 'Бот Фото ' + i, address: 'ПВЗ Ozon, Казань ' + i, agree: true }, { userId: r.user.id });
    db.users.find((u) => u.id === r.user.id).tgChatId = 700 + i;
    return r.user.id;
  });
  callc(db, 'POST', '/api/admin/shuffle', {}, { isAdmin: true });
  callc(db, 'POST', '/api/admin/wave-confirm', { n: 1 }, { isAdmin: true });
  bot.handleUpdate(db, c, { update_id: 1, callback_query: { id: 'c', data: 'sentw:1', from: { id: 700 }, message: { chat: { id: 700, type: 'private' } } } });
  const n0 = db.notifications.length;
  const r = bot.handleUpdate(db, c, { update_id: 2, message: { message_id: 2, chat: { id: 700, type: 'private' }, from: { id: 700 }, caption: 'TRK-77', photo: [{ file_id: 'small' }, { file_id: 'BIG_FILE_ID' }] } });
  assert.match(r.out.map((o) => o.text || '').join(' '), /подарок отправлен/);
  const p = db.pairs.find((x) => x.santaId === ids[0]);
  assert.deepEqual([p.status, p.track, p.tgPhoto], ['sent', 'TRK-77', 'BIG_FILE_ID']);
  const pushed = bot.pushNotifications(db, db.notifications.slice(n0), ids[0]);
  assert.ok(pushed.some((o) => o.method === 'sendPhoto' && o.chat_id === 701 && o.photo === 'BIG_FILE_ID'), 'получателю — то же фото');
  assert.equal(callc(db, 'GET', '/api/me', null, { userId: ids[1] }).incoming.tgPhoto, true);
});
