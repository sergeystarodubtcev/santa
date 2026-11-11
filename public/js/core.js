/*
 * Ядро тайного Санты Кофеманьяков.
 * Один и тот же код работает и на сервере (Node.js), и в браузере (демо-режим без бэкенда).
 * Вся бизнес-логика + маршрутизатор API: хост (сервер или демо) отвечает только за
 * хранение базы, хеширование паролей и подпись токенов.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SantaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;

  const DEFAULT_SETTINGS = {
    regOpen: true,
    sendStart: '2026-12-01T00:00:00+03:00',
    sendEnd: '2026-12-10T23:59:59+03:00',
    budgetMin: null,
    budgetMax: null,
    announcement: '',
    chatUrl: 'https://t.me/coffeemaniacs_channel/10490',
    // модерация анкет: выключена — все анкеты сразу в игре; включена — ждут решения организаторов
    moderation: false,
    // второй круг: запись после первой жеребьёвки и свои даты отправки
    round2Open: true,
    round2SendStart: '2026-12-11T00:00:00+03:00',
    round2SendEnd: '2026-12-20T23:59:59+03:00',
    // рассылка с личного аккаунта организатора тем, у кого нет бота (можно выключить в админке)
    userTg: true,
  };

  // Распознавание города в адресе (cities.js): в Node — require, в браузере — глобальный SantaCities
  const Cities = (function () {
    try { if (typeof require === 'function') return require('./cities.js'); } catch (e) { /* нет файла */ }
    return typeof self !== 'undefined' && self.SantaCities ? self.SantaCities : null;
  })();
  const detectCity = (address) => (Cities ? Cities.detect(address) : '');

  const PREFS = { coffee: 'Кофейное', noncoffee: 'Некофейное', any: 'Удивите меня' };

  class SantaError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const fail = (status, message) => { throw new SantaError(status, message); };

  function emptyDb() {
    return {
      version: 1,
      users: [],
      participations: {},
      pairs: [],
      drawnAt: null,
      drawn2At: null,
      // Волны: { n, start, end, status: open (запись) | drawn (пары розданы) | closed (остановлена), drawnAt, closedAt }
      waves: [{ n: 1, start: DEFAULT_SETTINGS.sendStart, end: DEFAULT_SETTINGS.sendEnd, status: 'open', drawnAt: null }],
      // Участники волн 2+ — «подтаблица»: { [userId]: { round, status, reason, priority, addedAt, confirmedAt } }
      // status: waiting (лист ожидания следующей волны) | invited (ждём подтверждения) | confirmed | declined
      wave2: {},
      // Личный Telegram-аккаунт организатора: пишет тем, у кого не подключён бот (через ретранслятор)
      userAcc: { status: 'off' },
      userOutbox: [],
      notifications: [],
      broadcasts: [],
      settings: Object.assign({}, DEFAULT_SETTINGS),
      // Telegram-бот: состояние диалогов, чаты админов, отправленные напоминания
      tgState: {},
      tgAdmins: [],
      tgReminders: {},
    };
  }

  function ensure(db) {
    const hadWaves = Array.isArray(db.waves) && db.waves.length > 0;
    const base = emptyDb();
    for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
    db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings || {});
    if (db.settings.chatUrl === 'https://t.me/c/1641902727/156432') db.settings.chatUrl = DEFAULT_SETTINGS.chatUrl;
    // волны из старого формата (первый и второй круг)
    if (!hadWaves) {
      const st = db.settings;
      db.waves = [{ n: 1, start: st.sendStart, end: st.sendEnd, status: db.drawnAt ? 'drawn' : 'open', drawnAt: db.drawnAt || null }];
      const has2 = db.drawn2At || Object.keys(db.wave2 || {}).length || db.pairs.some((x) => x.round === 2)
        || Object.values(db.participations).some((x) => x && x.round === 2);
      if (has2) db.waves.push({ n: 2, start: st.round2SendStart, end: st.round2SendEnd, status: db.drawn2At ? 'drawn' : 'open', drawnAt: db.drawn2At || null });
    }
    // те, кто записался во вторую волну до появления подтверждения, — ждут подтверждения
    for (const uid of Object.keys(db.participations)) {
      const p = db.participations[uid];
      if (p && p.round === 2 && !db.wave2[uid]) db.wave2[uid] = { round: 2, status: 'invited', reason: 'new', priority: 0, addedAt: p.joinedAt || 0 };
    }
    for (const w of Object.values(db.wave2)) if (w && w.round === undefined) w.round = w.status === 'waiting' ? null : 2;
    return db;
  }

  // ---------- helpers ----------
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
  const fmtDay = (iso) => { try { return new Date(Date.parse(iso)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }); } catch (e) { return String(iso).slice(0, 10); } };

  function normPhone(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    if (d.length < 10 || d.length > 15) fail(400, 'Проверьте номер телефона');
    return '+' + d;
  }

  function normTg(v) {
    let t = String(v || '').trim()
      .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '')
      .replace(/^@/, '')
      .toLowerCase();
    if (!/^[a-z0-9_]{4,32}$/.test(t)) fail(400, 'Ник в Telegram: 4–32 символа, латиница, цифры и _');
    return t;
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function newId(ctx) { return ctx.id ? ctx.id() : Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }

  function getUser(db, id) {
    const u = db.users.find((x) => x.id === id);
    if (!u) fail(401, 'Пользователь не найден, войдите заново');
    return u;
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, phone: u.phone, tg: u.tg, createdAt: u.createdAt, banned: !!u.banned, tgLinked: !!u.tgChatId };
  }

  // Статус модерации анкеты: pending — ждёт проверки, approved — допущена к жеребьёвке, rejected — отклонена.
  const modStatus = (p) => (p && p.moderation) || 'pending';
  // Все анкеты в игре (для счётчика): не забаненные и не отклонённые.
  // ---------- волны ----------
  // Волна участника: 1 — по умолчанию, n — записался в волну n, 0 — лист ожидания следующей волны.
  const roundOf = (p) => (p && p.round != null ? p.round : 1);
  const pairRound = (pair) => (pair && pair.round > 1 ? pair.round : 1);
  const waveOf = (db, n) => (db.waves || []).find((w) => w.n === n) || null;
  const lastWave = (db) => (db.waves || [])[(db.waves || []).length - 1] || null;
  const openWave = (db) => (db.waves || []).find((w) => w.status === 'open') || null; // куда сейчас записываются
  const drawnFor = (db, n) => { const w = waveOf(db, n); return w ? w.drawnAt || null : null; };
  function setDrawn(db, n, at) {
    const w = waveOf(db, n);
    if (!w) return;
    w.drawnAt = at || null;
    if (w.status !== 'closed') w.status = at ? 'drawn' : 'open';
    if (n === 1) db.drawnAt = at || null; // совместимость: «первая жеребьёвка прошла»
    if (n === 2) db.drawn2At = at || null;
  }
  function datesFor(db, n) {
    const w = waveOf(db, n) || waveOf(db, 1) || { start: db.settings.sendStart, end: db.settings.sendEnd };
    return { start: w.start, end: w.end };
  }
  const waveName = (n) => `${n}-я волна`;
  const waveIn = (n) => `${n}-й волне`; // «во 2-й волне»
  const waveTo = (n) => `${n}-ю волну`; // «во 2-ю волну»
  // С учётом переключателя: при выключенной модерации «ожидающие» считаются одобренными
  const modEff = (db, p) => { const m = modStatus(p); return m === 'pending' && !db.settings.moderation ? 'approved' : m; };
  function activeParticipants(db) {
    return db.users.filter((u) => !u.banned && db.participations[u.id] && modStatus(db.participations[u.id]) !== 'rejected');
  }
  // Второй круг — подтаблица db.wave2. status: invited (ждём подтверждения) | confirmed (участвует) | declined (отказался).
  // reason: new (записался после 1-й жеребьёвки) | victim (его Санта не отправил подарок) | admin (пригласил организатор).
  // priority: чем выше, тем раньше ему подбирают надёжного Санту (пострадавшим — максимальный).
  const W2_PRIORITY = 100;
  const wave2Of = (db, uid) => (db.wave2 || {})[uid] || null;
  const inWave = (db, uid, n) => { const w = wave2Of(db, uid); return !!w && w.status === 'confirmed' && w.round === n; };
  const myLaterWave = (db, uid) => { const w = wave2Of(db, uid); return w && w.status === 'confirmed' && w.round > 1 ? w.round : null; };
  const w2prio = (db, uid) => (wave2Of(db, uid) || {}).priority || 0;
  // Допущенные модерацией — только они попадают в жеребьёвку. В волны 2+ — только подтвердившие участие.
  function approvedParticipants(db, round) {
    return db.users.filter((u) => !u.banned && db.participations[u.id] && modEff(db, db.participations[u.id]) === 'approved'
      && (!round || (round > 1 ? inWave(db, u.id, round) : roundOf(db.participations[u.id]) === 1)));
  }
  // У «пострадавшего» пары могут быть в обоих кругах — берём актуальную.
  const byRoundDesc = (a, b) => pairRound(b) - pairRound(a);
  function outPair(db, uid) {
    const list = db.pairs.filter((p) => p.santaId === uid).sort(byRoundDesc);
    return list.find((p) => p.status === 'assigned') || list[0] || null;
  }
  function inPair(db, uid) {
    const list = db.pairs.filter((p) => p.recipientId === uid).sort(byRoundDesc);
    return list.find((p) => !p.failed) || list[0] || null;
  }

  // Подстановки в рассылке: {имя}, {срок} — до какого числа отправить подарок, {осталось} — сколько дней осталось
  function fillText(db, ctx, u, text) {
    const pair = outPair(db, u.id);
    const part = db.participations[u.id];
    const round = pair ? pairRound(pair) : myLaterWave(db, u.id) || roundOf(part) || 1;
    const end = Date.parse(datesFor(db, round).end);
    const days = Math.ceil((end - ctx.now()) / DAY);
    const left = days > 0 ? `осталось ${days} ${plural(days, 'день', 'дня', 'дней')}` : 'срок уже прошёл';
    return String(text)
      .replace(/\{имя\}/gi, firstName(u.name) || u.name)
      .replace(/\{срок\}/gi, fmtDay(datesFor(db, round).end))
      .replace(/\{осталось\}/gi, left);
  }

  // Состояние аккаунта организатора для админки — без сессии, кода и пароля
  function userAccView(db) {
    const a = db.userAcc || { status: 'off' };
    const q = db.userOutbox || [];
    return {
      enabled: db.settings.userTg !== false,
      status: a.status || 'off', error: a.error || null, me: a.me || null, updatedAt: a.updatedAt || null,
      phone: a.phone ? a.phone.replace(/^(\+?\d{2})\d+(\d{2})$/, '$1•••••$2') : null,
      pausedUntil: a.pausedUntil || null,
      queued: q.filter((x) => x.status === 'queued' || x.status === 'sending').length,
    };
  }

  // action — подсказка для Telegram-бота, какую кнопку приложить (whom, gift, moderation, …)
  function notify(db, ctx, userId, text, kind, action) {
    db.notifications.push({ id: newId(ctx), userId, text, kind: kind || 'info', action: action || null, createdAt: ctx.now(), read: false });
  }

  // Журнал для организаторов: попадает в админку и (через бота) в Telegram админам.
  const ADMINS = '@admins';
  function notifyAdmins(db, ctx, text) {
    notify(db, ctx, ADMINS, text, 'admin-log', 'admin');
  }
  const nick = (db, id) => { const u = db.users.find((x) => x.id === id); return u ? '@' + u.tg : '(удалён)'; };
  const who = (u) => `${u.name} @${u.tg} ${u.phone}`;

  // Можно ли уйти самому: ни своя посылка, ни посылка для тебя ещё не отправлены.
  function selfRemovalBlock(db, uid) {
    if (db.pairs.some((p) => p.santaId === uid && p.status !== 'assigned')) return 'Вы уже отправили свой подарок';
    if (db.pairs.some((p) => p.recipientId === uid && p.status !== 'assigned')) return 'Ваш Тайный Санта уже отправил вам посылку';
    return null;
  }

  // Убрать участника из жеребьёвки с перестройкой цепочки: его Санта начинает дарить его получателю.
  // Возвращает текстовый отчёт для админов.
  function removeFromDraw(db, ctx, uid) {
    const lines = [];
    for (const round of [...new Set(db.pairs.map(pairRound))]) {
    const same = (p) => pairRound(p) === round;
    const out = db.pairs.find((p) => same(p) && p.santaId === uid);
    const inc = db.pairs.find((p) => same(p) && p.recipientId === uid);
    db.pairs = db.pairs.filter((p) => !(same(p) && p.santaId === uid));
    if (inc) {
      const santaId = inc.santaId;
      const newRecipient = out ? out.recipientId : null;
      if (newRecipient && newRecipient !== santaId) {
        const wasSent = inc.status !== 'assigned';
        Object.assign(inc, { recipientId: newRecipient, status: 'assigned', track: '', sentAt: null, receivedAt: null });
        notify(db, ctx, santaId, 'Ваш получатель вышел из игры. 🎁 Теперь вы дарите подарок другому участнику — новые имя, ФИО и адрес ПВЗ уже в «Кому я дарю». Если вы успели собрать посылку — просто отправьте её по новому адресу.', 'warn', 'whom');
        lines.push(`↪️ ${nick(db, santaId)} теперь дарит ${nick(db, newRecipient)} (новый адрес отправлен ему)` + (wasSent ? ' ⚠️ его прошлая посылка уже была отправлена!' : ''));
      } else {
        db.pairs = db.pairs.filter((p) => p !== inc);
        lines.push(`⚠️ ${nick(db, santaId)} остался без получателя` + (newRecipient === santaId ? ' и без Санты (их было двое в паре)' : '') + ' — назначьте вручную в админке.');
        notify(db, ctx, santaId, 'Ваш получатель вышел из игры. Организаторы скоро назначат вам нового — мы напишем.', 'warn');
      }
    }
    }
    if (db.wave2 && db.wave2[uid]) delete db.wave2[uid];
    return lines;
  }

  function deleteUser(db, uid) {
    db.users = db.users.filter((u) => u.id !== uid);
    delete db.participations[uid];
    if (db.wave2) delete db.wave2[uid];
    if (db.userOutbox) db.userOutbox = db.userOutbox.filter((x) => x.userId !== uid || (x.status !== 'queued' && x.status !== 'sending'));
    db.notifications = db.notifications.filter((n) => n.userId !== uid);
    if (db.tgState) Object.keys(db.tgState).forEach((k) => { if (db.tgState[k] && db.tgState[k].uid === uid) delete db.tgState[k]; });
  }

  // Проблемы распределения после ручных правок
  function pairsCheck(db) {
    const res = { noRecipient: [], noSanta: [], doubleSanta: [] };
    for (const w of db.waves || []) {
      const round = w.n;
      if (!w.drawnAt) continue;
      const tag = round > 1 ? ` (${waveName(round)})` : '';
      const pairs = db.pairs.filter((p) => pairRound(p) === round);
      const players = approvedParticipants(db, round).map((u) => u.id);
      const giving = new Set(pairs.map((p) => p.santaId));
      const recvCount = {};
      pairs.forEach((p) => { recvCount[p.recipientId] = (recvCount[p.recipientId] || 0) + 1; });
      players.filter((id) => !giving.has(id)).forEach((id) => res.noRecipient.push(nick(db, id) + tag));
      players.filter((id) => !recvCount[id]).forEach((id) => res.noSanta.push(nick(db, id) + tag));
      Object.keys(recvCount).filter((id) => recvCount[id] > 1).forEach((id) => res.doubleSanta.push(nick(db, id) + tag));
    }
    return res;
  }

  function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0].slice(0, 20) || 'Кофеманьяк';
  }

  // ---------- users ----------
  function register(db, ctx, body) {
    const name = str(body.name, 60);
    if (name.length < 2) fail(400, 'Как вас зовут?');
    const phone = normPhone(body.phone);
    const tg = normTg(body.tg);
    const password = String(body.password || '');
    if (password.length < 6) fail(400, 'Пароль — минимум 6 символов');
    if (!body.pdConsent) fail(400, 'Нужно согласие на обработку персональных данных');
    if (db.users.some((u) => u.phone === phone)) fail(409, 'Этот телефон уже зарегистрирован — войдите в кабинет');
    if (db.users.some((u) => u.tg === tg)) fail(409, 'Этот Telegram уже зарегистрирован — войдите в кабинет');
    const user = { id: newId(ctx), name, phone, tg, passHash: ctx.hash(password), createdAt: ctx.now(), banned: false, pdConsentAt: ctx.now() };
    db.users.push(user);
    notify(db, ctx, user.id, 'Добро пожаловать к Кофеманьякам! Заполните анкету, чтобы попасть в жеребьёвку ☕', 'info');
    return user;
  }

  function login(db, ctx, body) {
    const raw = String(body.login || '').trim();
    let user = null;
    if (raw) {
      const tg = raw.replace(/^@/, '').toLowerCase();
      user = db.users.find((u) => u.tg === tg);
      if (!user) {
        try { const p = normPhone(raw); user = db.users.find((u) => u.phone === p); } catch (e) { /* not a phone */ }
      }
    }
    if (!user || !ctx.verify(String(body.password || ''), user.passHash)) fail(401, 'Неверный логин или пароль');
    return user;
  }

  // ---------- participation ----------
  function participate(db, ctx, userId, body) {
    const user = getUser(db, userId);
    if (user.banned) fail(403, 'Вы в чёрном списке. Напишите организаторам.');
    const existing = db.participations[userId];
    if (!existing && !db.settings.regOpen) fail(409, 'Регистрация закрыта');
    // после первой жеребьёвки новые участники записываются в открытую волну или в лист ожидания следующей
    let round = existing ? roundOf(existing) : 1;
    if (!existing && db.drawnAt) {
      if (!db.settings.round2Open) fail(409, 'Первая жеребьёвка уже прошла, а запись в следующую волну пока закрыта');
      const ow = openWave(db);
      round = ow ? ow.n : 0;
    }
    const fullName = str(body.fullName, 120);
    if (fullName.length < 3) fail(400, 'Укажите ФИО получателя посылки');
    if (body.phone != null && String(body.phone).trim()) {
      const phone = normPhone(body.phone);
      if (phone !== user.phone) {
        if (db.users.some((u) => u.id !== userId && u.phone === phone)) fail(409, 'Этот телефон уже указан у другого участника');
        user.phone = phone;
      }
    }
    const address = str(body.address, 400);
    if (address.length < 5) fail(400, 'Укажите адрес ближайшего пункта выдачи Ozon');
    // Только ПВЗ, никаких личных адресов — защищаем участников.
    if (/(^|[\s,.])(кв|квартира|кв-ра|апарт)(\.|\s|\d|$)|подъезд|домофон|этаж/i.test(address)) {
      fail(400, 'Укажите только адрес пункта выдачи Ozon — без квартиры, подъезда и домашнего адреса');
    }
    if (!body.agree) fail(400, 'Подтвердите участие и дальнейшую отправку подарка');
    if (round !== 1 && !existing && !body.wave2) fail(400, round ? `Первая жеребьёвка уже прошла — подтвердите участие в ${waveIn(round)}` : 'Первая жеребьёвка уже прошла — подтвердите участие в следующей волне');
    const prefs = PREFS[body.prefs] ? body.prefs : 'any';
    // Новая анкета (и отклонённая после правок) уходит на модерацию; одобренная остаётся одобренной.
    const auto = !db.settings.moderation;
    const moderation = (existing && modStatus(existing) === 'approved') || auto ? 'approved' : 'pending';
    db.participations[userId] = {
      round,
      city: detectCity(address),
      moderation,
      moderatedAt: existing && moderation === 'approved' ? existing.moderatedAt : null,
      fullName,
      address,
      wishes: str(body.wishes, 1000),
      notes: str(body.notes, 500),
      prefs,
      joinedAt: existing ? existing.joinedAt : ctx.now(),
      updatedAt: ctx.now(),
    };
    if (round > 1 && body.wave2 && !inWave(db, userId, round)) {
      db.wave2[userId] = Object.assign({ reason: 'new', priority: 0, addedAt: ctx.now() }, wave2Of(db, userId) || {}, { round, status: 'confirmed', confirmedAt: ctx.now() });
    }
    if (round === 0 && !wave2Of(db, userId)) db.wave2[userId] = { round: null, status: 'waiting', reason: 'new', priority: 0, addedAt: ctx.now() };
    if (!existing && round === 0) notify(db, ctx, userId, 'Вы в листе ожидания следующей волны Тайного Санты 🎅 Как только организаторы её откроют, мы напишем — останется подтвердить участие.', 'success', auto ? 'new-anketa' : 'moderation');
    else if (!existing && round > 1) notify(db, ctx, userId, `Вы записались в ${waveTo(round)} Тайного Санты! 🎅 ` + (auto ? 'Анкета принята — ждём жеребьёвку этой волны.' : 'Анкета на модерации.'), 'success', auto ? 'new-anketa' : 'moderation');
    else if (!existing && auto) notify(db, ctx, userId, 'Анкета принята! 🎅 Вы участвуете в жеребьёвке — мы сообщим, кому дарить.', 'success', 'new-anketa');
    else if (!existing) notify(db, ctx, userId, 'Анкета отправлена на модерацию. Как только организаторы её проверят, вы попадёте в жеребьёвку 🎅', 'info', 'moderation');
    else if (modStatus(existing) === 'rejected') notify(db, ctx, userId, 'Анкета исправлена и снова отправлена на модерацию', 'info');
    return db.participations[userId];
  }

  function leave(db, ctx, userId) {
    if (db.drawnAt && db.pairs.some((p) => p.santaId === userId || p.recipientId === userId)) {
      fail(409, 'Жеребьёвка уже проведена — выйти нельзя, напишите организаторам');
    }
    delete db.participations[userId];
  }

  // ---------- draw ----------
  function shuffle(db, ctx, body) {
    const round = Number(body && body.round) || 1;
    const wave = waveOf(db, round);
    if (!wave) fail(404, 'Такой волны нет');
    if (wave.status === 'closed') fail(409, 'Волна остановлена — сначала возобновите её');
    if (round > 1 && !drawnFor(db, round - 1) && (waveOf(db, round - 1) || {}).status !== 'closed') fail(400, 'Сначала проведите жеребьёвку предыдущей волны');
    const people = approvedParticipants(db, round);
    if (people.length < 2) fail(400, `Нужно минимум 2 участника${round > 1 ? ' в ' + waveIn(round) : ''}, одобренных модерацией`);
    if (db.pairs.some((p) => pairRound(p) === round && p.status !== 'assigned') && !(body && body.force)) {
      fail(409, 'Кто-то уже отправил подарок. Перемешать заново можно только принудительно.');
    }
    const ids = people.map((u) => u.id);
    const rnd = ctx.random || Math.random;
    const shuffled = (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // Полностью случайная раздача: каждому — случайный получатель, никто не дарит сам себе.
    // Перемешиваем, пока не получится перестановка без «самому себе» (в среднем ~3 попытки).
    let recipients;
    do { recipients = shuffled(ids); } while (recipients.some((r, i) => r === ids[i]));
    if (round > 1) prioritize(db, ids, recipients, round);
    // Порядок пар тоже случайный — по списку нельзя восстановить, кто кому дарит «по цепочке».
    const order = shuffled(ids.map((_, i) => i));
    const fresh = order.map((i) => ({
      round,
      santaId: ids[i],
      recipientId: recipients[i],
      priority: round > 1 && w2prio(db, recipients[i]) > 0 ? true : undefined,
      status: 'assigned',
      track: '',
      sentAt: null,
      receivedAt: null,
    }));
    db.pairs = db.pairs.filter((p) => pairRound(p) !== round).concat(fresh);
    setDrawn(db, round, ctx.now());
    for (const p of fresh) {
      notify(db, ctx, p.santaId, (round > 1 ? `Жеребьёвка ${round}-й волны проведена!` : 'Жеребьёвка проведена!') + ' Загляните в «Кому я дарю» — там имя и адрес получателя 🎁'
        + (p.priority ? ' ⭐ Ваш получатель в приоритете: в прошлой волне он остался без подарка. Пожалуйста, отправьте посылку в первую очередь!' : ''), 'success', 'whom');
    }
    return { pairs: fresh.length };
  }

  // Второй круг: участникам с приоритетом (пострадавшим) — надёжных Сант, тех, кто уже отправил подарок в первом круге.
  // recipients[i] — получатель Санты ids[i]; меняем получателей местами, не допуская «самому себе».
  function prioritize(db, ids, recipients, round) {
    const reliable = (id) => db.pairs.some((p) => pairRound(p) < round && p.santaId === id && p.status !== 'assigned');
    const locked = new Set();
    const order = ids.filter((id) => w2prio(db, id) > 0).sort((a, b) => w2prio(db, b) - w2prio(db, a));
    for (const p of order) {
      const i = recipients.indexOf(p);
      if (reliable(ids[i])) { locked.add(i); continue; }
      const free = (s, k) => k !== i && !locked.has(k) && reliable(s) && s !== p && w2prio(db, recipients[k]) === 0;
      let j = ids.findIndex((s, k) => free(s, k) && recipients[k] !== ids[i]);
      if (j >= 0) {
        [recipients[i], recipients[j]] = [recipients[j], recipients[i]];
        locked.add(j);
        continue;
      }
      // надёжный Санта дарит как раз тому, кто дарит пострадавшему (H→X→p): перестраиваем через третьего (Z→r):
      // H→p, X→r, Z→X
      j = ids.findIndex(free);
      if (j < 0) continue;
      const z = ids.findIndex((s, k) => k !== i && k !== j && !locked.has(k) && recipients[k] !== ids[i]);
      if (z < 0) continue;
      const x = ids[i];
      recipients[i] = recipients[z];
      recipients[z] = x;
      recipients[j] = p;
      locked.add(j);
    }
  }

  function resetDraw(db, body) {
    const round = Number(body && body.round) || 1;
    const wave = waveOf(db, round);
    if (!wave) fail(404, 'Такой волны нет');
    if ((db.waves || []).some((w) => w.n > round)) fail(409, 'Уже создана следующая волна — пары этой волны сбросить нельзя');
    db.pairs = db.pairs.filter((p) => pairRound(p) !== round);
    setDrawn(db, round, null);
  }

  // Новая волна (N+1): только когда в последней уже прошла жеребьёвка или она остановлена.
  // Лист ожидания получает приглашение подтвердить участие.
  function createWave(db, ctx, body) {
    const last = lastWave(db);
    if (last && last.status === 'open') fail(409, `Сначала проведите жеребьёвку или остановите ${waveTo(last.n)}`);
    const n = last ? last.n + 1 : 1;
    const day = 86400e3;
    const msk = (t) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
    const startT = body.start ? Date.parse(body.start) : Date.parse(last.end) + 1000;
    const endT = body.end ? Date.parse(body.end) : startT + 9 * day;
    if (isNaN(startT) || isNaN(endT) || endT <= startT) fail(400, 'Проверьте даты волны');
    const start = body.start || msk(startT) + 'T00:00:00+03:00';
    const end = body.end || msk(endT) + 'T23:59:59+03:00';
    db.waves.push({ n, start, end, status: 'open', drawnAt: null, createdAt: ctx.now() });
    let invited = 0;
    for (const uid of Object.keys(db.wave2 || {})) {
      const w = db.wave2[uid];
      if (w.status !== 'waiting' || !db.users.some((u) => u.id === uid)) continue;
      Object.assign(w, { round: n, status: 'invited' });
      if (db.participations[uid] && roundOf(db.participations[uid]) === 0) db.participations[uid].round = n;
      notify(db, ctx, uid, `Открылась запись в ${waveTo(n)} Тайного Санты 🎄 Отправка подарков ${fmtDay(start)} — ${fmtDay(end)}.` + (w.priority ? ' Вам отправят подарок в первую очередь ⭐' : '') + ' Подтвердите участие.', 'info', 'wave2');
      invited++;
    }
    notifyAdmins(db, ctx, `🌊 Создана ${waveName(n)}: отправка ${fmtDay(start)} — ${fmtDay(end)}.` + (invited ? ` Приглашения подтвердить участие: ${invited}.` : ''));
    return { n, invited };
  }

  function markSent(db, ctx, userId, body) {
    const pair = outPair(db, userId);
    if (!pair) fail(404, 'У вас пока нет получателя');
    pair.status = pair.status === 'received' ? 'received' : 'sent';
    pair.track = str(body && body.track, 80);
    pair.sentAt = pair.sentAt || ctx.now();
    notify(db, ctx, pair.recipientId, 'Вам подарок от Деда Мороза! 🎁 Посылка уже в пути' + (pair.track ? ' (трек: ' + pair.track + ')' : ''), 'gift', 'gift');
    return pair;
  }

  function markReceived(db, ctx, userId) {
    const pair = db.pairs.filter((p) => p.recipientId === userId).sort(byRoundDesc).find((p) => p.status === 'sent') || inPair(db, userId);
    if (!pair) fail(404, 'Подарок не найден');
    if (pair.status === 'assigned') fail(409, 'Ваш Санта ещё не отметил отправку');
    pair.status = 'received';
    pair.receivedAt = ctx.now();
    notify(db, ctx, pair.santaId, 'Ваш подарок получен! Спасибо, что вы настоящий Санта ☕✨', 'success');
    return pair;
  }

  // ---------- views ----------
  function deadlineNotice(db, now, pair) {
    if (!pair || pair.status !== 'assigned') return null;
    const dates = datesFor(db, pairRound(pair));
    const start = Date.parse(dates.start);
    const end = Date.parse(dates.end);
    if (now < start) {
      const d = Math.ceil((start - now) / DAY);
      return { kind: 'info', text: `Отправка подарков начнётся через ${d} ${plural(d, 'день', 'дня', 'дней')} — успейте собрать посылку!` };
    }
    if (now <= end) {
      const d = Math.max(1, Math.ceil((end - now) / DAY));
      return {
        kind: d <= 3 ? 'danger' : 'warn',
        text: `У ВАС ${d} ${plural(d, 'ДЕНЬ', 'ДНЯ', 'ДНЕЙ')}, ЧТОБЫ УСПЕТЬ ОТПРАВИТЬ ПОДАРОК`,
        daysLeft: d,
      };
    }
    return { kind: 'danger', text: 'Срок отправки прошёл! Срочно отправьте подарок и отметьте это в кабинете, иначе — чёрный список 🛑' };
  }

  function me(db, ctx, userId) {
    const user = getUser(db, userId);
    const now = ctx.now();
    const part = db.participations[userId];
    const w2 = wave2Of(db, userId);
    const ow = openWave(db);
    const round = myLaterWave(db, userId) || (part ? roundOf(part) : (db.drawnAt ? (ow ? ow.n : 0) : 1));
    const out = {
      user: publicUser(user),
      participation: part ? Object.assign({}, part, { moderation: modEff(db, part) }) : null,
      round,
      drawn: !!drawnFor(db, round),
      dates: datesFor(db, round || 1),
    };
    out.wave2 = w2 ? { status: w2.status, reason: w2.reason, priority: w2.priority || 0, round: w2.round || null,
      dates: w2.round ? datesFor(db, w2.round) : null, drawn: w2.round ? !!drawnFor(db, w2.round) : false,
      open: w2.round ? (waveOf(db, w2.round) || {}).status === 'open' : false } : null;
    const mine = outPair(db, userId);
    if (mine) {
      const r = db.users.find((u) => u.id === mine.recipientId) || {};
      const rp = db.participations[mine.recipientId] || {};
      out.assignment = {
        recipient: { name: r.name, fullName: rp.fullName || r.name, phone: r.phone, tg: r.tg, address: rp.address, wishes: rp.wishes, notes: rp.notes, prefs: rp.prefs },
        status: mine.status, track: mine.track, sentAt: mine.sentAt, receivedAt: mine.receivedAt,
        round: pairRound(mine), priority: !!mine.priority, ackAt: mine.ackAt || mine.sentAt || null,
      };
      out.dates = datesFor(db, pairRound(mine));
    }
    const incoming = inPair(db, userId);
    if (incoming) out.incoming = { status: incoming.status, track: incoming.track, sentAt: incoming.sentAt, receivedAt: incoming.receivedAt, failed: !!incoming.failed && incoming.status === 'assigned', round: pairRound(incoming) };
    out.deadline = deadlineNotice(db, now, mine);
    out.notifications = db.notifications.filter((n) => (n.userId === userId || n.userId === '*') && !n.hideOnSite).slice(-30).reverse();
    out.settings = publicSettings(db);
    return out;
  }

  function publicSettings(db) {
    const s = db.settings;
    const w1 = datesFor(db, 1);
    const ow = openWave(db);
    return { regOpen: s.regOpen, sendStart: w1.start, sendEnd: w1.end, budgetMin: s.budgetMin, budgetMax: s.budgetMax, announcement: s.announcement, chatUrl: s.chatUrl, moderation: !!s.moderation,
      round2Open: !!s.round2Open,
      waves: (db.waves || []).map((w) => ({ n: w.n, start: w.start, end: w.end, status: w.status })),
      openWave: ow ? ow.n : null };
  }

  // Включить/выключить модерацию. При выключении все ожидающие сразу одобряются.
  function setModeration(db, ctx, on) {
    on = !!on;
    if (!!db.settings.moderation === on) return 0;
    db.settings.moderation = on;
    let n = 0;
    if (!on) {
      db.users.forEach((u) => {
        const p = db.participations[u.id];
        if (!u.banned && p && modStatus(p) === 'pending') {
          Object.assign(p, { moderation: 'approved', moderatedAt: ctx.now() });
          notify(db, ctx, u.id, 'Анкета одобрена ✅ Вы участвуете в жеребьёвке!', 'success');
          n++;
        }
      });
    }
    notifyAdmins(db, ctx, on
      ? '🛡 Модерация ВКЛЮЧЕНА: новые анкеты ждут вашего решения.'
      : '🛡 Модерация ВЫКЛЮЧЕНА: все анкеты сразу в игре.' + (n ? ` Одобрено ожидавших: ${n}.` : ''));
    return n;
  }

  function publicStats(db) {
    const people = activeParticipants(db)
      .map((u, i) => ({ name: firstName(u.name), at: db.participations[u.id].joinedAt, i }))
      .sort((a, b) => b.at - a.at || b.i - a.i);
    return {
      count: people.length,
      recent: people.slice(0, 15).map((p) => p.name),
      drawn: !!db.drawnAt,
      drawn2: !!db.drawn2At,
      openWave: (openWave(db) || {}).n || null,
      sent: db.pairs.filter((p) => p.status !== 'assigned').length,
      settings: publicSettings(db),
    };
  }

  function adminStateRaw(db) {
    const byId = Object.fromEntries(db.users.map((u) => [u.id, u]));
    return {
      settings: db.settings,
      drawnAt: db.drawnAt,
      users: db.users.map((u) => {
        const part = db.participations[u.id];
        return Object.assign(publicUser(u), { pdConsentAt: u.pdConsentAt || null, participation: part ? Object.assign({}, part, { moderation: modEff(db, part) }) : null });
      }),
      pairs: db.pairs.map((p) => Object.assign({}, p, {
        santa: byId[p.santaId] ? '@' + byId[p.santaId].tg : '—',
        recipient: byId[p.recipientId] ? '@' + byId[p.recipientId].tg : '—',
      })),
      pairsCheck: pairsCheck(db),
      drawn2At: db.drawn2At,
      waves: (db.waves || []).map((w) => {
        const pairs = db.pairs.filter((p) => pairRound(p) === w.n);
        const live = pairs.filter((p) => !p.failed);
        return Object.assign({}, w, {
          members: approvedParticipants(db, w.n).length,
          invited: w.n > 1 ? Object.values(db.wave2 || {}).filter((x) => x.round === w.n && x.status === 'invited').length : 0,
          pending: w.n === 1 ? db.users.filter((u) => !u.banned && db.participations[u.id] && roundOf(db.participations[u.id]) === 1 && modEff(db, db.participations[u.id]) === 'pending').length : 0,
          pairs: pairs.length,
          noAck: live.filter((p) => p.status === 'assigned' && !p.ackAt).length,
          notSent: live.filter((p) => p.status === 'assigned').length,
          sent: pairs.filter((p) => p.status === 'sent').length,
          received: pairs.filter((p) => p.status === 'received').length,
          failed: pairs.filter((p) => p.failed).length,
        });
      }),
      waitlist: Object.values(db.wave2 || {}).filter((x) => x.status === 'waiting').length,
      wave2: Object.keys(db.wave2 || {}).map((id) => {
        const u = byId[id];
        if (!u) return null;
        const part = db.participations[id];
        const wr = db.wave2[id].round;
        const give = wr && db.pairs.find((p) => pairRound(p) === wr && p.santaId === id);
        const get = wr && db.pairs.find((p) => pairRound(p) === wr && p.recipientId === id);
        return Object.assign({ userId: id, name: u.name, tg: u.tg, banned: !!u.banned, tgLinked: !!u.tgChatId, hasAnketa: !!part,
          moderation: part ? modEff(db, part) : null, giving: give ? give.status : null, receiving: get ? get.status : null }, db.wave2[id]);
      }).filter(Boolean).sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.addedAt || 0) - (b.addedAt || 0)),
      broadcasts: (db.broadcasts || []).slice().reverse().map((b) => (b.userTg ? Object.assign({}, b, {
        uErrors: (db.userOutbox || []).filter((x) => x.broadcastId === b.id && x.status === 'failed').slice(0, 30).map((x) => '@' + x.tg + ': ' + x.error),
        uQueued: (db.userOutbox || []).filter((x) => x.broadcastId === b.id && (x.status === 'queued' || x.status === 'sending')).length,
      }) : b)),
      userAcc: userAccView(db),
      adminLog: db.notifications.filter((n) => n.userId === ADMINS).slice(-60).reverse(),
      stats: {
        users: db.users.length,
        participants: activeParticipants(db).length,
        round1: approvedParticipants(db, 1).length,
        round2: approvedParticipants(db, 2).length,
        wave2Invited: Object.values(db.wave2 || {}).filter((w) => w.status === 'invited').length,
        waitlist: Object.values(db.wave2 || {}).filter((w) => w.status === 'waiting').length,
        approved: approvedParticipants(db).length,
        pending: db.users.filter((u) => !u.banned && db.participations[u.id] && modEff(db, db.participations[u.id]) === 'pending').length,
        banned: db.users.filter((u) => u.banned).length,
        sent: db.pairs.filter((p) => p.status !== 'assigned').length,
        received: db.pairs.filter((p) => p.status === 'received').length,
      },
    };
  }

  function updateSettings(db, body, ctx) {
    const s = db.settings;
    if ('moderation' in body && ctx) setModeration(db, ctx, body.moderation);
    if ('regOpen' in body) s.regOpen = !!body.regOpen;
    if ('round2Open' in body) s.round2Open = !!body.round2Open;
    if ('userTg' in body) s.userTg = !!body.userTg;
    const setDate = (n, key, val) => {
      if (!val) return;
      if (isNaN(Date.parse(val))) fail(400, 'Неверная дата');
      const w = waveOf(db, n);
      if (w) w[key] = val;
    };
    setDate(1, 'start', body.sendStart); setDate(1, 'end', body.sendEnd);
    setDate(2, 'start', body.round2SendStart); setDate(2, 'end', body.round2SendEnd);
    if (body.sendStart && !isNaN(Date.parse(body.sendStart))) s.sendStart = body.sendStart;
    if (body.sendEnd && !isNaN(Date.parse(body.sendEnd))) s.sendEnd = body.sendEnd;
    for (const k of ['budgetMin', 'budgetMax']) {
      if (k in body) s[k] = body[k] === '' || body[k] == null ? null : Math.max(0, Number(body[k]) || 0);
    }
    if ('announcement' in body) s.announcement = str(body.announcement, 500);
    if ('chatUrl' in body) s.chatUrl = str(body.chatUrl, 200);
    return s;
  }

  // ---------- router ----------
  /**
   * ctx: { now(), hash(pw), verify(pw, hash), issueToken(payload), userId, isAdmin, checkAdmin(pw), random(), id() }
   * Возвращает { data, mutated }.
   */
  function handle(db, ctx, method, path, body) {
    body = body || {};
    const adminState = (d) => Object.assign(adminStateRaw(d), { storage: ctx.storage ? ctx.storage() : null, bot: ctx.botUsername || null });
    const needUser = () => { if (!ctx.userId) fail(401, 'Войдите в личный кабинет'); return ctx.userId; };
    const needAdmin = () => { if (!ctx.isAdmin) fail(401, 'Нужен вход в админку'); };
    const ok = (data, mutated) => ({ data: data === undefined ? { ok: true } : data, mutated: !!mutated });

    switch (method + ' ' + path) {
      case 'GET /api/health': return ok({ ok: true });
      case 'GET /api/public': return ok(publicStats(db));
      case 'POST /api/register': {
        const u = register(db, ctx, body);
        return ok({ token: ctx.issueToken({ uid: u.id }), user: publicUser(u) }, true);
      }
      case 'POST /api/login': {
        const u = login(db, ctx, body);
        return ok({ token: ctx.issueToken({ uid: u.id }), user: publicUser(u) });
      }
      case 'GET /api/me': return ok(me(db, ctx, needUser()));
      case 'POST /api/profile': {
        // исправить имя, ник в Telegram или телефон (если ошиблись при регистрации)
        const u = getUser(db, needUser());
        const name = str(body.name, 60);
        if (name.length < 2) fail(400, 'Как вас зовут?');
        const tg = normTg(body.tg);
        const phone = normPhone(body.phone);
        if (db.users.some((x) => x.id !== u.id && x.tg === tg)) fail(409, 'Этот ник в Telegram уже занят другим участником');
        if (db.users.some((x) => x.id !== u.id && x.phone === phone)) fail(409, 'Этот телефон уже указан у другого участника');
        const changes = [];
        if (u.tg !== tg) changes.push(`ник @${u.tg} → @${tg}`);
        if (u.name !== name) changes.push(`имя «${u.name}» → «${name}»`);
        if (u.phone !== phone) changes.push(`телефон ${u.phone} → ${phone}`);
        Object.assign(u, { name, tg, phone });
        if (changes.length && db.pairs.some((p) => p.santaId === u.id || p.recipientId === u.id)) {
          notifyAdmins(db, ctx, `✏️ @${tg} исправил профиль после жеребьёвки: ${changes.join(', ')}.`);
        }
        return ok(me(db, ctx, u.id), changes.length > 0);
      }
      case 'POST /api/participate': participate(db, ctx, needUser(), body); return ok(me(db, ctx, ctx.userId), true);
      case 'POST /api/wave2': {
        // участник подтверждает (или отклоняет) участие во втором круге
        const uid = needUser();
        const u = getUser(db, uid);
        const w = wave2Of(db, uid);
        if (!w) fail(404, 'Вас не приглашали в следующую волну');
        if (!w.round) fail(409, 'Следующая волна ещё не открыта — мы напишем, когда она начнётся');
        if (drawnFor(db, w.round)) fail(409, `Жеребьёвка ${w.round}-й волны уже прошла`);
        if ((waveOf(db, w.round) || {}).status === 'closed') fail(409, 'Эта волна остановлена');
        if (body.join) {
          if (!db.participations[uid]) fail(400, 'Сначала заполните анкету');
          if (w.status !== 'confirmed') {
            Object.assign(w, { status: 'confirmed', confirmedAt: ctx.now() });
            notify(db, ctx, uid, `Вы участвуете в ${waveIn(w.round)} ✅ Мы напишем, когда пройдёт её жеребьёвка.`, 'success');
            notifyAdmins(db, ctx, `🌊 ${who(u)} подтвердил участие в ${waveIn(w.round)}` + (w.priority ? ' (⭐ приоритет)' : '') + '.');
          }
        } else if (w.status !== 'declined') {
          Object.assign(w, { status: 'declined', confirmedAt: null, declinedAt: ctx.now() });
          notifyAdmins(db, ctx, `🙅 ${who(u)} отказался от ${w.round}-й волны.`);
        }
        return ok(me(db, ctx, uid), true);
      }
      case 'POST /api/leave': leave(db, ctx, needUser()); return ok(me(db, ctx, ctx.userId), true);
      case 'POST /api/account/delete': {
        // отзыв согласия на обработку персональных данных — удаляем всё о пользователе
        const uid = needUser();
        const u = getUser(db, uid);
        const inDraw = db.pairs.some((p) => p.santaId === uid || p.recipientId === uid);
        if (inDraw) {
          const block = selfRemovalBlock(db, uid);
          if (block) {
            notifyAdmins(db, ctx, `🆘 ${who(u)} хотел удалить аккаунт, но не может: ${block.toLowerCase()}. Отправлен к администратору в бота.`);
            const e = new SantaError(409, block + ' — удалить аккаунт можно только через администратора. Напишите ему, он всё решит.');
            e.code = 'need_admin';
            throw e;
          }
          if (body.confirm !== 'УДАЛИТЬ') fail(400, 'Подтвердите удаление: введите слово УДАЛИТЬ');
          const lines = removeFromDraw(db, ctx, uid);
          deleteUser(db, uid);
          notifyAdmins(db, ctx, [`🗑 ${who(u)} удалил аккаунт ПОСЛЕ жеребьёвки.`].concat(lines).join('\n'));
        } else {
          deleteUser(db, uid);
          notifyAdmins(db, ctx, body.reason === 'noform'
            ? `🗑 ${who(u)} не создал анкету — удалился самостоятельно (ответил боту «не буду участвовать»).`
            : `🗑 ${who(u)} удалил аккаунт и данные (жеребьёвки для него не было).`);
        }
        return ok(undefined, true);
      }
      case 'POST /api/sent': markSent(db, ctx, needUser(), body); return ok(me(db, ctx, ctx.userId), true);
      case 'POST /api/ack': {
        // Санта подтверждает, что участвует и собирает посылку
        const pair = outPair(db, needUser());
        if (!pair) fail(404, 'У вас пока нет получателя');
        if (!pair.ackAt) pair.ackAt = ctx.now();
        return ok(me(db, ctx, ctx.userId), true);
      }
      case 'POST /api/received': markReceived(db, ctx, needUser()); return ok(me(db, ctx, ctx.userId), true);
      case 'POST /api/notifications/read': {
        const uid = needUser();
        db.notifications.forEach((n) => { if (n.userId === uid) n.read = true; });
        return ok(undefined, true);
      }

      case 'POST /api/admin/login':
        if (!ctx.checkAdmin(String(body.password || ''))) fail(401, 'Неверный пароль администратора');
        return ok({ token: ctx.issueToken({ admin: true }) });
      case 'GET /api/admin/state': needAdmin(); return ok(adminState(db));
      case 'POST /api/admin/shuffle': needAdmin(); shuffle(db, ctx, body); return ok(adminState(db), true);
      case 'POST /api/admin/reset': needAdmin(); resetDraw(db, body); return ok(adminState(db), true);
      case 'POST /api/admin/settings': needAdmin(); updateSettings(db, body, ctx); return ok(adminState(db), true);
      case 'POST /api/admin/moderation': needAdmin(); setModeration(db, ctx, body.enabled); return ok(adminState(db), true);
      case 'POST /api/admin/ban': {
        needAdmin();
        const u = getUser(db, body.userId);
        u.banned = !!body.banned;
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/moderate': {
        needAdmin();
        getUser(db, body.userId);
        const part = db.participations[body.userId];
        if (!part) fail(404, 'У пользователя нет анкеты');
        if (!['approved', 'rejected', 'pending'].includes(body.status)) fail(400, 'Неверный статус модерации');
        if (body.status !== 'approved' && db.pairs.some((p) => p.santaId === body.userId || p.recipientId === body.userId)) {
          fail(409, 'Участник уже в паре. Сначала сбросьте жеребьёвку.');
        }
        const prev = modStatus(part);
        part.moderation = body.status;
        part.moderatedAt = ctx.now();
        part.moderationNote = str(body.note, 300);
        if (prev !== body.status) {
          if (body.status === 'approved') notify(db, ctx, body.userId, 'Анкета одобрена модераторами ✅ Вы участвуете в жеребьёвке!', 'success');
          if (body.status === 'rejected') notify(db, ctx, body.userId, 'Анкета не прошла модерацию' + (part.moderationNote ? ': ' + part.moderationNote : '') + '. Исправьте её или напишите организаторам.', 'danger');
        }
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/approve-all': {
        needAdmin();
        let n = 0;
        db.users.forEach((u) => {
          const part = db.participations[u.id];
          if (!u.banned && part && modStatus(part) === 'pending') {
            part.moderation = 'approved';
            part.moderatedAt = ctx.now();
            notify(db, ctx, u.id, 'Анкета одобрена модераторами ✅ Вы участвуете в жеребьёвке!', 'success');
            n++;
          }
        });
        return ok(Object.assign(adminState(db), { approvedNow: n }), true);
      }
      case 'POST /api/admin/delete': {
        needAdmin();
        const u = getUser(db, body.userId);
        const lines = removeFromDraw(db, ctx, u.id); // пары перестраиваются, если участник был в жеребьёвке
        deleteUser(db, u.id);
        notifyAdmins(db, ctx, [`🗑 Организатор удалил ${who(u)}.`].concat(lines).join('\n'));
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/remove-from-draw': {
        needAdmin();
        const u = getUser(db, body.userId);
        if (!db.pairs.some((p) => p.santaId === u.id || p.recipientId === u.id)) fail(400, 'Участник не в жеребьёвке');
        const lines = removeFromDraw(db, ctx, u.id);
        if (db.participations[u.id]) Object.assign(db.participations[u.id], { moderation: 'rejected', moderationNote: 'Исключён организатором из жеребьёвки', moderatedAt: ctx.now() });
        notify(db, ctx, u.id, 'Организаторы исключили вас из жеребьёвки этого года. Если это ошибка — напишите им.', 'warn');
        notifyAdmins(db, ctx, [`✂️ Организатор убрал из жеребьёвки ${who(u)} (аккаунт остался).`].concat(lines).join('\n'));
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/user-edit': {
        // организатор правит профиль и анкету любого участника (и при необходимости задаёт новый пароль)
        needAdmin();
        const u = getUser(db, body.userId);
        const changes = [];
        const set = (obj, key, val, label) => { if ((obj[key] || '') !== (val || '')) { changes.push(`${label}: «${obj[key] || '—'}» → «${val || '—'}»`); obj[key] = val; } };
        const name = str(body.name, 60);
        if (name.length < 2) fail(400, 'Имя слишком короткое');
        const tg = normTg(body.tg);
        const phone = normPhone(body.phone);
        if (db.users.some((x) => x.id !== u.id && x.tg === tg)) fail(409, 'Этот ник уже занят другим участником');
        if (db.users.some((x) => x.id !== u.id && x.phone === phone)) fail(409, 'Этот телефон уже указан у другого участника');
        const oldTg = u.tg;
        set(u, 'name', name, 'имя');
        set(u, 'tg', tg, 'ник');
        set(u, 'phone', phone, 'телефон');
        if (body.password) {
          if (String(body.password).length < 6) fail(400, 'Пароль — минимум 6 символов');
          u.passHash = ctx.hash(String(body.password));
          changes.push('пароль сброшен');
        }
        if (body.anketa) {
          const a = body.anketa;
          const fullName = str(a.fullName, 120);
          const address = str(a.address, 400);
          if (fullName.length < 3) fail(400, 'Укажите ФИО');
          if (address.length < 5) fail(400, 'Укажите адрес ПВЗ');
          let p = db.participations[u.id];
          if (!p) {
            p = db.participations[u.id] = { moderation: 'approved', moderatedAt: ctx.now(), joinedAt: ctx.now() };
            changes.push('анкета создана организатором');
          }
          set(p, 'fullName', fullName, 'ФИО');
          set(p, 'address', address, 'ПВЗ');
          p.city = detectCity(address);
          set(p, 'wishes', str(a.wishes, 1000), 'пожелания');
          set(p, 'notes', str(a.notes, 500), 'пометки');
          set(p, 'prefs', PREFS[a.prefs] ? a.prefs : 'any', 'тематика');
          p.updatedAt = ctx.now();
        }
        if (changes.length) {
          notify(db, ctx, u.id, 'Организаторы обновили ваши данные: ' + changes.map((c) => c.split(':')[0]).join(', ') + '. Проверьте профиль и анкету.', 'info');
          notifyAdmins(db, ctx, `✏️ Организатор поправил данные @${oldTg}${oldTg !== tg ? ' (теперь @' + tg + ')' : ''}:\n` + changes.join('\n'));
        }
        return ok(adminState(db), changes.length > 0);
      }
      case 'POST /api/admin/wave-create': needAdmin(); createWave(db, ctx, body); return ok(adminState(db), true);
      case 'POST /api/admin/wave-set': {
        // даты волны и остановка/возобновление
        needAdmin();
        const w = waveOf(db, Number(body.n));
        if (!w) fail(404, 'Такой волны нет');
        for (const k of ['start', 'end']) {
          if (body[k]) { if (isNaN(Date.parse(body[k]))) fail(400, 'Неверная дата'); w[k] = body[k]; }
        }
        if (Date.parse(w.end) <= Date.parse(w.start)) fail(400, 'Конец отправки раньше начала');
        if (w.n === 1) { db.settings.sendStart = w.start; db.settings.sendEnd = w.end; }
        if (body.action === 'close' && w.status !== 'closed') {
          w.status = 'closed'; w.closedAt = ctx.now();
          notifyAdmins(db, ctx, `⏹ ${waveName(w.n)} остановлена: напоминания этой волны больше не отправляются.`);
        } else if (body.action === 'reopen' && w.status === 'closed') {
          if (!w.drawnAt && (db.waves || []).some((x) => x.status === 'open' && x !== w)) fail(409, 'Уже есть открытая волна');
          w.status = w.drawnAt ? 'drawn' : 'open'; w.closedAt = null;
          notifyAdmins(db, ctx, `▶️ ${waveName(w.n)} возобновлена.`);
        }
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/wave2-rescue': {
        // Санта не отправил подарок → получатель («пострадавший») переходит в следующую волну с наивысшим приоритетом.
        // Если открытой волны ещё нет — в лист ожидания: приглашение придёт, когда волну создадут.
        needAdmin();
        const r = Number(body.round) || null;
        const pair = db.pairs.find((p) => p.santaId === body.santaId && (r ? pairRound(p) === r : true) && p.status === 'assigned');
        if (!pair) fail(404, 'Пара не найдена или Санта уже отметил отправку');
        const ow = openWave(db);
        const target = ow && ow.n > pairRound(pair) && !ow.drawnAt ? ow.n : null;
        const victim = getUser(db, pair.recipientId);
        Object.assign(pair, { failed: true, failedAt: ctx.now() });
        const prev = wave2Of(db, victim.id);
        const keep = prev && prev.status === 'confirmed' && prev.round === target && target;
        db.wave2[victim.id] = Object.assign({ addedAt: ctx.now() }, prev || {}, {
          reason: 'victim', priority: W2_PRIORITY, round: target, status: keep ? 'confirmed' : target ? 'invited' : 'waiting',
        });
        if (target && !keep) {
          const d = datesFor(db, target);
          notify(db, ctx, victim.id, `Ваш Тайный Санта так и не отправил подарок 😢 Нам очень жаль! Приглашаем вас в ${waveTo(target)}: там вам отправят подарок в первую очередь ⭐ (вы тоже дарите подарок одному участнику, отправка ${fmtDay(d.start)} — ${fmtDay(d.end)}). Подтвердите участие.`, 'warn', 'wave2');
        } else if (!target) {
          notify(db, ctx, victim.id, 'Ваш Тайный Санта так и не отправил подарок 😢 Нам очень жаль! Мы записали вас в следующую волну с приоритетом ⭐ — там вам отправят подарок в первую очередь. Как только волна откроется, придёт приглашение.', 'warn');
        }
        notifyAdmins(db, ctx, `😢 ${nick(db, pair.santaId)} не отправил подарок ${nick(db, victim.id)}. Получатель ` + (target ? `переведён в ${waveTo(target)}` : 'записан в лист ожидания следующей волны') + ' с наивысшим приоритетом ⭐.');
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/wave2-set': {
        // организатор управляет подтаблицей второго круга
        needAdmin();
        const u = getUser(db, body.userId);
        let w = wave2Of(db, u.id);
        const ow = openWave(db);
        if (body.action === 'invite') {
          if (!ow || ow.n < 2) fail(400, 'Нет открытой волны: создайте следующую волну (после первой жеребьёвки)');
          if (w && w.status === 'confirmed' && w.round === ow.n) fail(409, `Участник уже в ${waveIn(ow.n)}`);
          const d = datesFor(db, ow.n);
          db.wave2[u.id] = w = Object.assign({ reason: 'admin', priority: 0, addedAt: ctx.now() }, w || {}, { round: ow.n, status: 'invited' });
          notify(db, ctx, u.id, `Организаторы приглашают вас в ${waveTo(ow.n)} Тайного Санты 🎄 Отправка подарков ${fmtDay(d.start)} — ${fmtDay(d.end)}. Подтвердите участие.`, 'info', 'wave2');
        } else {
          if (!w) fail(404, 'Участника нет в следующих волнах');
          if (body.action === 'confirm') {
            if (!db.participations[u.id]) fail(400, 'У участника нет анкеты');
            if (!w.round) fail(409, 'Следующая волна ещё не создана');
            Object.assign(w, { status: 'confirmed', confirmedAt: ctx.now(), byAdmin: true });
          } else if (body.action === 'decline') Object.assign(w, { status: 'declined', confirmedAt: null, declinedAt: ctx.now() });
          else if (body.action === 'priority') w.priority = w.priority ? 0 : W2_PRIORITY;
          else if (body.action === 'remove') {
            if (w.round && db.pairs.some((p) => pairRound(p) === w.round && (p.santaId === u.id || p.recipientId === u.id))) fail(409, 'Участник уже в парах этой волны — сначала уберите его из пар');
            delete db.wave2[u.id];
          } else fail(400, 'Неизвестное действие');
        }
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/pair-set': {
        // ручная правка: кому дарит Санта
        needAdmin();
        const santa = getUser(db, body.santaId);
        const lw = myLaterWave(db, santa.id);
        const r = Number(body.round) || ((lw && drawnFor(db, lw) && !db.pairs.some((x) => x.santaId === santa.id && pairRound(x) === lw)) ? lw : null);
        const ofSanta = (x) => x.santaId === santa.id && (!r || pairRound(x) === r);
        if (!body.recipientId) {
          db.pairs = db.pairs.filter((p) => !ofSanta(p));
          notifyAdmins(db, ctx, `✏️ Вручную: у @${santa.tg} больше нет получателя.`);
          return ok(adminState(db), true);
        }
        const rec = getUser(db, body.recipientId);
        if (rec.id === santa.id) fail(400, 'Нельзя дарить самому себе');
        let p = db.pairs.find(ofSanta);
        if (p && p.recipientId === rec.id) return ok(adminState(db));
        if (!p) { p = r > 1 ? { round: r, santaId: santa.id } : { santaId: santa.id }; db.pairs.push(p); }
        Object.assign(p, { recipientId: rec.id, status: 'assigned', track: '', sentAt: null, receivedAt: null, failed: undefined, failedAt: undefined,
          priority: pairRound(p) > 1 && w2prio(db, rec.id) > 0 ? true : undefined });
        if (!db.drawnAt) db.drawnAt = ctx.now();
        notify(db, ctx, santa.id, 'Организаторы назначили вам получателя подарка 🎁 Загляните в «Кому я дарю».', 'warn', 'whom');
        notifyAdmins(db, ctx, `✏️ Вручную: @${santa.tg} теперь дарит @${rec.tg}.`);
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/pair-status': {
        needAdmin();
        const r = Number(body.round) || null;
        const p = db.pairs.find((x) => x.santaId === body.santaId && (!r || pairRound(x) === r));
        if (!p) fail(404, 'Пара не найдена');
        if (!['assigned', 'sent', 'received'].includes(body.status)) fail(400, 'Неверный статус');
        p.status = body.status;
        if (body.status !== 'assigned' && !p.sentAt) p.sentAt = ctx.now();
        if (body.status === 'received' && !p.receivedAt) p.receivedAt = ctx.now();
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/broadcast': {
        needAdmin();
        const text = str(body.text, 1000);
        if (!text) fail(400, 'Пустое сообщение');
        const site = body.site !== false;
        const tg = body.tg !== false;
        const viaUser = !!body.userTg; // с аккаунта организатора — тем, у кого нет бота
        if (!site && !tg && !viaUser) fail(400, 'Выберите, куда отправить: на сайт и/или в Telegram');
        if (viaUser && db.settings.userTg === false) fail(400, 'Отправка с аккаунта организатора выключена — включите её в блоке «Аккаунт организатора»');
        if (viaUser && !['ready', 'limited'].includes((db.userAcc || {}).status)) fail(400, 'Аккаунт организатора не подключён — подключите его в блоке «Аккаунт организатора»');
        const targets = Array.isArray(body.userIds)
          ? db.users.filter((u) => body.userIds.includes(u.id))
          : (body.onlyParticipants ? activeParticipants(db) : db.users);
        if (!targets.length) fail(400, 'Никто не выбран');
        const id = newId(ctx);
        let uTotal = 0;
        targets.forEach((u) => {
          const personal = fillText(db, ctx, u, text);
          if (site || tg) {
            notify(db, ctx, u.id, personal, 'admin');
            const n = db.notifications[db.notifications.length - 1];
            n.broadcastId = id;
            if (!site) n.hideOnSite = true;
            if (!tg) n.noTg = true;
          }
          if (viaUser && !u.tgChatId) {
            db.userOutbox = (db.userOutbox || []).concat({ id: newId(ctx), broadcastId: id, userId: u.id, tg: u.tg, text: personal, status: 'queued', at: ctx.now() });
            uTotal++;
          }
        });
        db.broadcasts = (db.broadcasts || []).concat({
          id, text, at: ctx.now(), site, tg, count: targets.length, to: targets.slice(0, 40).map((u) => '@' + u.tg),
          userTg: viaUser || undefined, uTotal: viaUser ? uTotal : undefined, uSent: viaUser ? 0 : undefined, uFailed: viaUser ? 0 : undefined,
        }).slice(-100);
        return ok({ sent: targets.length, id, viaUser: uTotal }, true);
      }
      case 'POST /api/admin/useracc': {
        // подключение личного аккаунта организатора: телефон → код из Telegram → (облачный пароль) → готово.
        // Сам вход выполняет ретранслятор; код и пароль удаляются из базы сразу после передачи ему.
        needAdmin();
        const a = db.userAcc = db.userAcc || { status: 'off' };
        const set = (patch) => Object.assign(a, patch, { error: null, updatedAt: ctx.now() });
        if (body.action === 'phone') {
          const phone = normPhone(body.value);
          Object.keys(a).forEach((k) => delete a[k]);
          set({ status: 'code_requested', phone });
        } else if (body.action === 'code') {
          if (a.status !== 'code_sent') fail(409, 'Сначала запросите код');
          const code = String(body.value || '').replace(/\D/g, '');
          if (code.length < 4) fail(400, 'Введите код из Telegram');
          set({ status: 'code_entered', code });
        } else if (body.action === 'password') {
          if (a.status !== 'need_password') fail(409, 'Пароль сейчас не нужен');
          if (!body.value) fail(400, 'Введите облачный пароль');
          set({ status: 'password_entered', password: String(body.value).slice(0, 200) });
        } else if (body.action === 'logout') {
          set({ status: a.session ? 'logout_requested' : 'off' });
          if (!a.session) { delete a.phone; delete a.me; }
        } else if (body.action === 'cancel') {
          ['code', 'password', 'phone'].forEach((k) => delete a[k]);
          set({ status: a.session ? 'ready' : 'off' });
        } else if (body.action === 'resume') {
          // после спам-блока или паузы — попробовать снова
          if (!a.session) fail(409, 'Аккаунт не подключён');
          set({ status: 'ready', pausedUntil: null });
        } else if (body.action === 'clear-queue') {
          (db.userOutbox || []).forEach((x) => { if (x.status === 'queued') { x.status = 'failed'; x.error = 'отменено организатором'; } });
        } else fail(400, 'Неизвестное действие');
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/broadcast-delete': {
        needAdmin();
        const b = (db.broadcasts || []).find((x) => x.id === body.id);
        if (!b) fail(404, 'Рассылка не найдена');
        db.notifications = db.notifications.filter((n) => n.broadcastId !== b.id);
        db.broadcasts = db.broadcasts.filter((x) => x.id !== b.id);
        return ok(adminState(db), true);
      }
      case 'GET /api/admin/export': {
        // бэкап без сессии аккаунта организатора
        needAdmin();
        const copy = JSON.parse(JSON.stringify(db));
        if (copy.userAcc) { delete copy.userAcc.session; delete copy.userAcc.code; delete copy.userAcc.password; }
        return ok(copy);
      }
      case 'POST /api/admin/import': {
        needAdmin();
        if (!body.db || !Array.isArray(body.db.users)) fail(400, 'Это не похоже на бэкап базы');
        const next = ensure(JSON.parse(JSON.stringify(body.db)));
        Object.keys(db).forEach((k) => delete db[k]);
        Object.assign(db, next);
        return ok(adminState(db), true);
      }
      default:
        fail(404, 'Нет такого метода: ' + method + ' ' + path);
    }
  }

  return { handle, fillText, userAccView, modStatus, roundOf, pairRound, datesFor, waveOf, openWave, emptyDb, ensure, SantaError, PREFS, DEFAULT_SETTINGS, plural, normPhone, normTg, DAY };
});
