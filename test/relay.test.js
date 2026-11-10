'use strict';
// Прогон ретранслятора бота с подменённой сетью: не падает, отвечает на апдейты, отдаёт очередь, шлёт тест.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('ретранслятор бота: полная короткая смена без ошибок', () => {
  const out = execFileSync(process.execPath, ['-r', path.join(__dirname, 'fixtures/relay-mock.js'), path.join(__dirname, '../relay/bot-runner.js')], {
    env: Object.assign({}, process.env, { TG_BOT_TOKEN: '1:x', SITE_API: 'https://site', RUN_MINUTES: '0.03', SEND_TEST: 'true' }),
    encoding: 'utf8', timeout: 20000,
  });
  assert.match(out, /SENT .*"chat_id":5.*Привет!/);
  assert.match(out, /SENT .*Из очереди/);
  assert.match(out, /SENT .*Тест/);
  assert.match(out, /Смена закончилась/);
});
