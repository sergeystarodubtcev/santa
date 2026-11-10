'use strict';
// Проверяем облачную функцию с имитацией Yandex Object Storage.
const test = require('node:test');
const assert = require('node:assert');

const store = new Map();
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  assert.equal(u.host, 'storage.yandexcloud.net');
  assert.equal(opts.headers['X-YaCloud-SubjectToken'], 'iam-token');
  const key = u.pathname;
  if (opts.method === 'PUT') { store.set(key, opts.body); return { ok: true, status: 200, text: async () => '' }; }
  if (!store.has(key)) return { ok: false, status: 404, text: async () => 'NoSuchKey' };
  return { ok: true, status: 200, text: async () => store.get(key) };
};
process.env.BUCKET = 'santa-test';
process.env.ADMIN_PASSWORD = 'adminpw';
const { handler, _internal } = require('../cloud/index.js');
const ctx = { token: { access_token: 'iam-token' } };
const call = async (method, url, body, token) => {
  const r = await handler({
    httpMethod: method, url, path: '/api/{proxy+}', pathParams: { proxy: url.replace(/^\/api\//, '') },
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? Buffer.from(JSON.stringify(body)).toString('base64') : '', isBase64Encoded: true,
  }, ctx);
  return { status: r.statusCode, data: JSON.parse(r.body) };
};

test('маршрут берётся из url или из шаблона', () => {
  assert.equal(_internal.routeOf({ url: '/api/me?x=1' }), '/api/me');
  assert.equal(_internal.routeOf({ path: '/api/{proxy+}', pathParams: { proxy: 'admin/state' } }), '/api/admin/state');
});

test('полный цикл в облачной функции: регистрация → модерация → жеребьёвка, база в бакете', async () => {
  assert.equal((await call('GET', '/api/health')).data.ok, true);
  const tokens = [];
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/register', { name: 'Юзер' + i, phone: '+7922000000' + i, tg: 'cloud_user' + i, password: 'qwerty1', pdConsent: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    tokens.push(r.data.token);
    const p = await call('POST', '/api/participate', { fullName: 'Юзер Облачный ' + i, address: 'ПВЗ Ozon ' + i, agree: true }, r.data.token);
    assert.equal(p.status, 200, JSON.stringify(p.data));
  }
  assert.equal((await call('GET', '/api/public')).data.count, 3);
  assert.ok(store.has('/santa-test/data/db.json'));
  assert.equal((await call('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  const admin = (await call('POST', '/api/admin/login', { password: 'adminpw' })).data.token;
  const st = await call('GET', '/api/admin/state', null, admin);
  assert.equal(st.data.storage.mode, 'yandex-object-storage');
  await call('POST', '/api/admin/approve-all', {}, admin);
  const sh = await call('POST', '/api/admin/shuffle', {}, admin);
  assert.equal(sh.data.pairs.length, 3);
  const me = await call('GET', '/api/me', null, tokens[0]);
  assert.ok(me.data.assignment.recipient.address.startsWith('ПВЗ Ozon'));
  assert.equal((await call('GET', '/api/me', null, 'bad.token')).status, 401);
  // логин работает и после «холодного старта» (новый экземпляр читает базу из бакета)
  assert.equal((await call('POST', '/api/login', { login: '@cloud_user1', password: 'qwerty1' })).status, 200);
});

test('бот в режиме опроса: забирает сообщения у Telegram, отвечает и запоминает offset', async () => {
  // отдельный экземпляр модуля с токеном бота
  delete require.cache[require.resolve('../cloud/index.js')];
  process.env.TG_BOT_TOKEN = '123:abc';
  process.env.TG_BOT_USERNAME = 'kofesanta_bot';
  process.env.SITE_URL = 'https://santa.example';
  const { handler: h } = require('../cloud/index.js');
  const sent = [];
  let served = false;
  const s3fetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      const method = String(url).split('/').pop();
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (method === 'getUpdates') {
        const res = served ? [] : [{ update_id: 500, message: { chat: { id: 77, type: 'private' }, from: { id: 77, username: 'cloud_user1' }, text: '/start' } }];
        served = true;
        return { json: async () => ({ ok: true, result: body.offset > 500 ? [] : res }) };
      }
      sent.push({ method, body });
      return { json: async () => ({ ok: true, result: {} }) };
    }
    return s3fetch(url, opts);
  };
  const r = await h({ messages: [{ details: { payload: 'poll' } }] }, ctx);
  global.fetch = s3fetch;
  assert.equal(r.handled, 1);
  const hello = sent.find((x) => x.method === 'sendMessage' && x.body.chat_id === 77);
  assert.match(hello.body.text, /Привет, <b>Юзер1<\/b>/);
  const db = JSON.parse(store.get('/santa-test/data/db.json'));
  assert.equal(db.tgOffset, 501);
  assert.equal(db.users.find((u) => u.tg === 'cloud_user1').tgChatId, 77);
  delete process.env.TG_BOT_TOKEN;
});

test('режим ретранслятора: апдейты через /api/tg/relay, уведомления копятся в очереди /api/tg/outbox', async () => {
  delete require.cache[require.resolve('../cloud/index.js')];
  delete process.env.TG_BOT_TOKEN;
  process.env.TG_BOT_USERNAME = 'kofesanta_bot';
  process.env.TG_RELAY_SECRET = 'relay-secret';
  const { handler: h } = require('../cloud/index.js');
  const s3fetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) throw new Error('из облака в Telegram ходить нельзя');
    return s3fetch(url, opts);
  };
  const post = async (url, body, headers = {}) => {
    const r = await h({ httpMethod: 'POST', url, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body), isBase64Encoded: false }, ctx);
    return { status: r.statusCode, data: JSON.parse(r.body) };
  };
  // чужой секрет и пустой вебхук не пускаем
  assert.equal((await post('/api/tg/relay', { update: {} }, { 'X-Relay-Secret': 'nope' })).status, 403);
  assert.equal((await post('/api/tg/webhook', { update_id: 1 })).status, 403);
  // /start через ретранслятор → ответ в out
  const r = await post('/api/tg/relay', { update: { update_id: 1, message: { chat: { id: 88, type: 'private' }, from: { id: 88, username: 'cloud_user2' }, text: '/start' } } }, { 'X-Relay-Secret': 'relay-secret' });
  assert.equal(r.status, 200);
  assert.match(r.data.out.find((o) => o.chat_id === 88).text, /Привет, <b>Юзер2<\/b>/);
  // действие на сайте → уведомление в очередь, а не в сеть
  const admin = (await post('/api/admin/login', { password: 'adminpw' })).data.token;
  await post('/api/admin/broadcast', { text: 'Жеребьёвка завтра!', onlyParticipants: true }, { Authorization: 'Bearer ' + admin });
  let q = await post('/api/tg/outbox', {}, { 'X-Relay-Secret': 'relay-secret' });
  assert.ok(q.data.out.some((o) => o.chat_id === 88 && /Жеребьёвка завтра/.test(o.text)));
  q = await post('/api/tg/outbox', {}, { 'X-Relay-Secret': 'relay-secret' });
  assert.equal(q.data.out.length, 0, 'очередь очищается после выдачи');
  global.fetch = s3fetch;
  delete process.env.TG_RELAY_SECRET;
});

test('слежение за страницей: при 200 один раз пишем только админам; пробное — тоже админам', async () => {
  delete require.cache[require.resolve('../cloud/index.js')];
  process.env.TG_BOT_USERNAME = 'kofesanta_bot';
  process.env.TG_RELAY_SECRET = 'relay-secret';
  const { handler: h } = require('../cloud/index.js');
  const post = async (url, body, headers = { 'X-Relay-Secret': 'relay-secret' }) => {
    const r = await h({ httpMethod: 'POST', url, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body), isBase64Encoded: false }, ctx);
    return { status: r.statusCode, data: JSON.parse(r.body) };
  };
  // делаем админа через бота
  await post('/api/tg/relay', { update: { update_id: 2, message: { chat: { id: 4242, type: 'private' }, from: { id: 4242 }, text: '/admin adminpw' } } });
  const w = { key: 'advent', title: 'Адвент', url: 'https://shop.example/advent' };
  assert.equal((await post('/api/tg/watch', Object.assign({ status: 200 }, w), { 'X-Relay-Secret': 'nope' })).status, 403);
  const t = await post('/api/tg/watch', Object.assign({ test: true }, w));
  assert.equal(t.data.admins, 1);
  assert.deepEqual(t.data.out.map((o) => o.chat_id), [4242]);
  assert.match(t.data.out[0].text, /Пробное сообщение/);
  let r = await post('/api/tg/watch', Object.assign({ status: 404 }, w));
  assert.equal(r.data.out.length, 0);
  assert.equal(r.data.done, false);
  r = await post('/api/tg/watch', Object.assign({ status: 200 }, w));
  assert.deepEqual(r.data.out.map((o) => o.chat_id), [4242], 'только админам, не участникам');
  assert.match(r.data.out[0].text, /Адвент появился/);
  r = await post('/api/tg/watch', Object.assign({ status: 200 }, w));
  assert.equal(r.data.out.length, 0, 'второй раз не шлём');
  assert.equal(r.data.done, true);
  delete process.env.TG_RELAY_SECRET;
});
