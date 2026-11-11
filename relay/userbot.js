'use strict';
/*
 * Личный Telegram-аккаунт организатора (MTProto через библиотеку GramJS «telegram»).
 * Работает внутри ретранслятора (GitHub Actions) рядом с ботом и пишет участникам,
 * у которых не подключён бот: бот не может написать первым, а обычный аккаунт — может.
 *
 * Всё управление — из админки сайта: телефон → код из Telegram → облачный пароль (если есть).
 * Облако отдаёт шаги входа и сообщения через /api/tg/user-poll и получает обратно результаты.
 * Сессия хранится в облаке зашифрованной (AES-256-GCM, ключ выводится из токена бота).
 *
 * Бережём аккаунт от спам-блока Telegram: по одному сообщению раз в 30–60 секунд,
 * суточный лимит считает облако; на FLOOD_WAIT — пауза, на PEER_FLOOD — стоп и сигнал админам.
 *
 * Переменные: TG_API_ID и TG_API_HASH (my.telegram.org → API development tools) — секреты GitHub.
 */
const crypto = require('node:crypto');

const keyFrom = (botToken) => crypto.createHash('sha256').update('userbot-session:' + botToken).digest();
function encrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(blob, key) {
  const raw = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

const errText = (e) => String((e && (e.errorMessage || e.message)) || e);

function createUserbot(opts) {
  const { apiId, apiHash, botToken, site, log = () => {} } = opts;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rand = opts.random || Math.random;
  const now = opts.now || Date.now;
  const key = keyFrom(botToken);
  let lib = opts.lib || null; // { Api, computeCheck, makeClient } — подменяется в тестах
  function telegram() {
    if (lib) return lib;
    if (!apiId || !apiHash) throw new Error('Не заданы секреты TG_API_ID и TG_API_HASH в GitHub (Settings → Secrets → Actions)');
    let t;
    try { t = require('telegram'); } catch (e) { throw new Error('Библиотека telegram не установлена в ретрансляторе'); }
    const { StringSession } = require('telegram/sessions');
    const { computeCheck } = require('telegram/Password');
    lib = {
      Api: t.Api,
      computeCheck,
      async makeClient(session) {
        const c = new t.TelegramClient(new StringSession(session || ''), Number(apiId), apiHash, {
          connectionRetries: 5, deviceModel: 'Santa Organizer', systemVersion: 'Linux', appVersion: '1.0',
        });
        c.setLogLevel('error');
        await c.connect();
        return c;
      },
    };
    return lib;
  }

  let client = null;
  let phone = null;
  let phoneCodeHash = null;
  let ready = false;
  let triedSession = null;

  async function drop() {
    if (client) { try { await client.destroy(); } catch (e) { /* ignore */ } }
    client = null; ready = false;
  }

  async function finish() {
    const me = await client.getMe();
    ready = true;
    phoneCodeHash = null;
    const session = client.session.save();
    triedSession = null;
    log('👤 аккаунт организатора подключён:', me.username || me.firstName);
    return { status: 'ready', session: encrypt(session, key), me: { name: [me.firstName, me.lastName].filter(Boolean).join(' '), username: me.username || null } };
  }

  async function doTask(task) {
    try {
      const L = telegram();
      if (task.type === 'send_code') {
        await drop();
        client = await L.makeClient('');
        phone = task.phone;
        const r = await client.sendCode({ apiId: Number(apiId), apiHash }, phone);
        phoneCodeHash = r.phoneCodeHash;
        log('👤 код для входа отправлен', r.isCodeViaApp ? 'в Telegram' : 'по SMS');
        return { status: 'code_sent' };
      }
      if (task.type === 'sign_in') {
        if (!client || !phoneCodeHash) return { status: 'off', error: 'Ретранслятор перезапустился — запросите код заново' };
        try {
          const r = await client.invoke(new L.Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: String(task.code) }));
          if (r && r.className === 'auth.AuthorizationSignUpRequired') return { status: 'off', error: 'На этот номер нет аккаунта Telegram' };
          return await finish();
        } catch (e) {
          const m = errText(e);
          if (m.includes('SESSION_PASSWORD_NEEDED')) return { status: 'need_password' };
          if (m.includes('PHONE_CODE_INVALID')) return { status: 'code_sent', error: 'Неверный код — введите ещё раз' };
          if (m.includes('PHONE_CODE_EXPIRED')) return { status: 'off', error: 'Код устарел — запросите новый' };
          throw e;
        }
      }
      if (task.type === 'password') {
        if (!client) return { status: 'off', error: 'Ретранслятор перезапустился — запросите код заново' };
        try {
          const pwd = await client.invoke(new L.Api.account.GetPassword());
          const check = await L.computeCheck(pwd, String(task.password));
          await client.invoke(new L.Api.auth.CheckPassword({ password: check }));
          return await finish();
        } catch (e) {
          if (errText(e).includes('PASSWORD_HASH_INVALID')) return { status: 'need_password', error: 'Неверный облачный пароль' };
          throw e;
        }
      }
      if (task.type === 'logout') {
        if (client && ready) { try { await client.invoke(new L.Api.auth.LogOut()); } catch (e) { /* ignore */ } }
        await drop();
        log('👤 аккаунт организатора отключён');
        return { status: 'off' };
      }
    } catch (e) {
      const m = errText(e);
      log('👤 ошибка входа:', m);
      if (e && e.seconds) return { status: 'off', error: `Telegram просит подождать ${Math.ceil(e.seconds / 60)} мин перед следующей попыткой` };
      if (m.includes('PHONE_NUMBER_INVALID')) return { status: 'off', error: 'Неверный номер телефона' };
      if (m.includes('PHONE_NUMBER_BANNED')) return { status: 'off', error: 'Этот номер заблокирован в Telegram' };
      if (m.includes('API_ID_INVALID')) return { status: 'off', error: 'Неверные TG_API_ID / TG_API_HASH' };
      return { status: 'off', error: m.slice(0, 200) };
    }
    return null;
  }

  // Новая смена ретранслятора: поднимаем сохранённую сессию
  async function restore(enc) {
    triedSession = enc;
    try {
      const L = telegram();
      let session;
      try { session = decrypt(enc, key); } catch (e) { return { status: 'off', error: 'Не удалось прочитать сохранённую сессию — подключите аккаунт заново', clearSession: true }; }
      await drop();
      client = await L.makeClient(session);
      const me = await client.getMe();
      ready = true;
      log('👤 аккаунт организатора на месте:', me.username || me.firstName);
      return null;
    } catch (e) {
      const m = errText(e);
      await drop();
      if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(m)) {
        return { status: 'off', error: 'Сессия аккаунта завершена (вышли из него на телефоне?) — подключите заново', clearSession: true };
      }
      log('👤 не удалось подключиться:', m);
      triedSession = null; // попробуем ещё раз позже
      return null;
    }
  }

  // Одно сообщение. Возвращает { result, report?, stop? }
  async function send(item) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await client.sendMessage(item.tg, { message: item.text, linkPreview: false });
        return { result: { id: item.id, ok: true } };
      } catch (e) {
        const m = errText(e);
        if (e && e.seconds) {
          if (e.seconds <= 60 && attempt === 0) { await sleep(e.seconds * 1000 + 1000); continue; }
          return { result: { id: item.id, retry: true }, report: { status: 'ready', pauseSec: e.seconds, error: `Telegram попросил паузу ${Math.ceil(e.seconds / 60)} мин — продолжим автоматически` }, stop: true };
        }
        if (m.includes('PEER_FLOOD')) {
          return { result: { id: item.id, retry: true }, report: { status: 'limited', error: 'Telegram ограничил аккаунт (спам-блок): сейчас он может писать только контактам. Откройте в этом аккаунте @SpamBot, затем нажмите «Продолжить» в админке' }, stop: true };
        }
        if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(m)) {
          ready = false;
          return { result: { id: item.id, retry: true }, report: { status: 'off', error: 'Сессия аккаунта завершена — подключите заново', clearSession: true }, stop: true };
        }
        let why = m.slice(0, 150);
        if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|No user has|Cannot find any entity/i.test(m)) why = 'ник не найден в Telegram';
        else if (/PRIVACY|USER_PRIVACY_RESTRICTED/.test(m)) why = 'закрыл сообщения от незнакомых';
        else if (/USER_IS_BLOCKED|YOU_BLOCKED_USER|blocked/i.test(m)) why = 'заблокировал аккаунт организатора';
        else if (/USER_IS_BOT|BOT/.test(m)) why = 'это бот';
        return { result: { id: item.id, ok: false, error: why } };
      }
    }
    return { result: { id: item.id, retry: true } };
  }

  async function loop(stopAt) {
    const nap = (ms) => sleep(Math.max(0, Math.min(ms, stopAt - now()))); // не дольше конца смены
    let report = null;
    let results = [];
    while (now() < stopAt) {
      const res = await site('/api/tg/user-poll', { report, results, want: ready ? 1 : 0 });
      report = null; results = [];
      if (res.task) report = await doTask(res.task);
      else if (!ready && res.session && res.session !== triedSession && ['ready', 'limited'].includes(res.status)) report = await restore(res.session);
      if (res.status === 'off' && ready && !res.task) await drop(); // отключили в админке
      let sent = false;
      for (const item of res.items || []) {
        if (!ready) { results.push({ id: item.id, retry: true }); continue; }
        const r = await send(item);
        results.push(r.result);
        if (r.report) report = r.report;
        sent = true;
        log('👤 сообщение @' + item.tg + ':', r.result.ok ? 'отправлено' : r.result.retry ? 'отложено' : r.result.error);
        if (r.stop) break;
      }
      if (sent) { await nap(30000 + rand() * 30000); continue; } // пауза между сообщениями — как у живого человека
      if (report || results.length) continue; // шаг входа — сразу сообщаем облаку
      const loggingIn = res.status && !['ready', 'off', 'limited'].includes(res.status);
      await nap(loggingIn ? 4000 : 15000);
    }
    if (report || results.length) await site('/api/tg/user-poll', { report, results, want: 0 });
    await drop();
  }

  return { loop, doTask, restore, send, _state: () => ({ ready, phoneCodeHash }) };
}

module.exports = { createUserbot, encrypt, decrypt, keyFrom };
