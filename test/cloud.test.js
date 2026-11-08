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
