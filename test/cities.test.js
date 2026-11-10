'use strict';
// Проверка города в адресе ПВЗ: распознавание, анкета, вопрос в боте.
const test = require('node:test');
const assert = require('node:assert');
const Cities = require('../public/js/cities.js');
const core = require('../public/js/core.js');
const { createBot } = require('../cloud/bot.js');

test('распознавание города: название в любом месте адреса и в любом падеже', () => {
  const ok = ['ПВЗ Ozon, г. Москва, Тверская 7', 'Казань, ул. Баумана 1', 'спб невский 10', 'Ростов-на-Дону, Садовая 5',
    'Мирный пер. 4', 'ул. Ленина 5 Казань', 'Москва ул Тверская 7', 'ПВЗ в Казани на Баумана', 'Новосибирская область, р.п. Кольцово, д. 5',
    'ЕКАТЕРИНБУРГ, Ленина 1', 'Орёл, Комсомольская 2', 'ozon тверская 7 мск'];
  const bad = ['ПВЗ Ozon 1', 'Тверская 7', 'ул. Ленина, д. 5', 'пункт выдачи у дома'];
  for (const a of ok) assert.ok(Cities.hasLocality(a), 'должен распознать: ' + a);
  for (const a of bad) assert.ok(!Cities.hasLocality(a), 'нет города: ' + a);
  assert.equal(Cities.detect('ПВЗ в Казани'), 'Казань');
  assert.ok(Cities.count > 1000);
});

test('анкета запоминает город, админ видит «не распознан»', () => {
  const ctx = { now: () => 1, hash: (p) => 'h:' + p, verify: () => true, issueToken: (p) => JSON.stringify(p), checkAdmin: () => true };
  const db = core.emptyDb();
  const r = core.handle(db, ctx, 'POST', '/api/register', { name: 'Аня', phone: '+79001110000', tg: 'anya_city', password: 'qwerty1', pdConsent: true }).data;
  core.handle(db, Object.assign({ userId: r.user.id }, ctx), 'POST', '/api/participate', { fullName: 'Анна', address: 'ПВЗ Ozon, Казань, Баумана 1', agree: true });
  assert.equal(db.participations[r.user.id].city, 'Казань');
  core.handle(db, Object.assign({ userId: r.user.id }, ctx), 'POST', '/api/participate', { fullName: 'Анна', address: 'ПВЗ Ozon, Баумана 1', agree: true });
  assert.equal(db.participations[r.user.id].city, '', 'без города — пусто, админка покажет ⚠️');
});

test('бот спрашивает «Вы точно указали город?» и даёт исправить или подтвердить', () => {
  const ctx = { now: () => 1, hash: (p) => 'h:' + p, verify: () => true, issueToken: (p) => JSON.stringify(p), checkAdmin: () => true };
  const db = core.emptyDb();
  const r = core.handle(db, ctx, 'POST', '/api/register', { name: 'Боря', phone: '+79001110001', tg: 'borya_city', password: 'qwerty1', pdConsent: true }).data;
  const bot = createBot({ core, secret: 's', siteUrl: 'https://x', username: 'b' });
  let n = 0;
  const msg = (text) => bot.handleUpdate(db, ctx, { update_id: ++n, message: { message_id: n, chat: { id: 9, type: 'private' }, from: { id: 9, username: 'borya_city' }, text } });
  const press = (data) => bot.handleUpdate(db, ctx, { update_id: ++n, callback_query: { id: 'c' + n, data, from: { id: 9 }, message: { chat: { id: 9, type: 'private' } } } });
  const texts = (x) => x.out.filter((o) => o.text).map((o) => o.text).join('\n');
  msg('/start');
  press('form');
  msg('Борис Борисов');
  let x = msg('ПВЗ Ozon, ул. Ленина 5');
  assert.match(texts(x), /Вы точно указали город/);
  x = press('addr_fix');
  assert.match(texts(x), /вместе с городом/);
  x = msg('ПВЗ Ozon, ул. Садовая 1');
  assert.match(texts(x), /Вы точно указали город/);
  x = press('addr_ok'); // «всё верно» — идём дальше
  assert.match(texts(x), /Что хочется получить/);
  press('skip'); press('prefs:any'); press('skip');
  x = press('agree');
  assert.match(texts(x), /Анкета сохранена/);
  assert.equal(db.participations[r.user.id].address, 'ПВЗ Ozon, ул. Садовая 1');
  // с городом — без вопроса
  press('form');
  msg('Борис Борисов');
  x = msg('ПВЗ Ozon, Казань, Баумана 1');
  assert.match(texts(x), /Что хочется получить/);
});
