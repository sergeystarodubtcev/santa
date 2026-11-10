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
  };

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
      notifications: [],
      settings: Object.assign({}, DEFAULT_SETTINGS),
      // Telegram-бот: состояние диалогов, чаты админов, отправленные напоминания
      tgState: {},
      tgAdmins: [],
      tgReminders: {},
    };
  }

  function ensure(db) {
    const base = emptyDb();
    for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
    db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings || {});
    if (db.settings.chatUrl === 'https://t.me/c/1641902727/156432') db.settings.chatUrl = DEFAULT_SETTINGS.chatUrl;
    return db;
  }

  // ---------- helpers ----------
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);

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
  function activeParticipants(db) {
    return db.users.filter((u) => !u.banned && db.participations[u.id] && modStatus(db.participations[u.id]) !== 'rejected');
  }
  // Допущенные модерацией — только они попадают в жеребьёвку.
  function approvedParticipants(db) {
    return db.users.filter((u) => !u.banned && db.participations[u.id] && modStatus(db.participations[u.id]) === 'approved');
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
    const out = db.pairs.find((p) => p.santaId === uid);
    const inc = db.pairs.find((p) => p.recipientId === uid);
    if (out && out.status !== 'assigned') return 'Вы уже отправили свой подарок';
    if (inc && inc.status !== 'assigned') return 'Ваш Тайный Санта уже отправил вам посылку';
    return null;
  }

  // Убрать участника из жеребьёвки с перестройкой цепочки: его Санта начинает дарить его получателю.
  // Возвращает текстовый отчёт для админов.
  function removeFromDraw(db, ctx, uid) {
    const out = db.pairs.find((p) => p.santaId === uid);
    const inc = db.pairs.find((p) => p.recipientId === uid);
    const lines = [];
    db.pairs = db.pairs.filter((p) => p.santaId !== uid);
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
    return lines;
  }

  function deleteUser(db, uid) {
    db.users = db.users.filter((u) => u.id !== uid);
    delete db.participations[uid];
    db.notifications = db.notifications.filter((n) => n.userId !== uid);
    if (db.tgState) Object.keys(db.tgState).forEach((k) => { if (db.tgState[k] && db.tgState[k].uid === uid) delete db.tgState[k]; });
  }

  // Проблемы распределения после ручных правок
  function pairsCheck(db) {
    if (!db.pairs.length) return { noRecipient: [], noSanta: [], doubleSanta: [] };
    const players = approvedParticipants(db).map((u) => u.id);
    const giving = new Set(db.pairs.map((p) => p.santaId));
    const recvCount = {};
    db.pairs.forEach((p) => { recvCount[p.recipientId] = (recvCount[p.recipientId] || 0) + 1; });
    return {
      noRecipient: players.filter((id) => !giving.has(id)).map((id) => nick(db, id)),
      noSanta: players.filter((id) => !recvCount[id]).map((id) => nick(db, id)),
      doubleSanta: Object.keys(recvCount).filter((id) => recvCount[id] > 1).map((id) => nick(db, id)),
    };
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
    if (!existing && db.drawnAt) fail(409, 'Жеребьёвка уже проведена — регистрация закрыта');
    if (!existing && !db.settings.regOpen) fail(409, 'Регистрация закрыта');
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
    const prefs = PREFS[body.prefs] ? body.prefs : 'any';
    // Новая анкета (и отклонённая после правок) уходит на модерацию; одобренная остаётся одобренной.
    const moderation = existing && modStatus(existing) === 'approved' ? 'approved' : 'pending';
    db.participations[userId] = {
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
    if (!existing) notify(db, ctx, userId, 'Анкета отправлена на модерацию. Как только организаторы её проверят, вы попадёте в жеребьёвку 🎅', 'info', 'moderation');
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
    const people = approvedParticipants(db);
    if (people.length < 2) fail(400, 'Нужно минимум 2 участника, одобренных модерацией');
    if (db.pairs.some((p) => p.status !== 'assigned') && !(body && body.force)) {
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
    // Порядок пар тоже случайный — по списку нельзя восстановить, кто кому дарит «по цепочке».
    const order = shuffled(ids.map((_, i) => i));
    db.pairs = order.map((i) => ({
      santaId: ids[i],
      recipientId: recipients[i],
      status: 'assigned',
      track: '',
      sentAt: null,
      receivedAt: null,
    }));
    db.drawnAt = ctx.now();
    for (const id of ids) {
      notify(db, ctx, id, 'Жеребьёвка проведена! Загляните в «Кому я дарю» — там имя и адрес получателя 🎁', 'success', 'whom');
    }
    return { pairs: db.pairs.length };
  }

  function resetDraw(db) {
    db.pairs = [];
    db.drawnAt = null;
  }

  function markSent(db, ctx, userId, body) {
    const pair = db.pairs.find((p) => p.santaId === userId);
    if (!pair) fail(404, 'У вас пока нет получателя');
    pair.status = pair.status === 'received' ? 'received' : 'sent';
    pair.track = str(body && body.track, 80);
    pair.sentAt = pair.sentAt || ctx.now();
    notify(db, ctx, pair.recipientId, 'Вам подарок от Деда Мороза! 🎁 Посылка уже в пути' + (pair.track ? ' (трек: ' + pair.track + ')' : ''), 'gift', 'gift');
    return pair;
  }

  function markReceived(db, ctx, userId) {
    const pair = db.pairs.find((p) => p.recipientId === userId);
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
    const start = Date.parse(db.settings.sendStart);
    const end = Date.parse(db.settings.sendEnd);
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
    const out = { user: publicUser(user), participation: part ? Object.assign({}, part, { moderation: modStatus(part) }) : null, drawn: !!db.drawnAt };
    const mine = db.pairs.find((p) => p.santaId === userId);
    if (mine) {
      const r = db.users.find((u) => u.id === mine.recipientId) || {};
      const rp = db.participations[mine.recipientId] || {};
      out.assignment = {
        recipient: { name: r.name, fullName: rp.fullName || r.name, phone: r.phone, tg: r.tg, address: rp.address, wishes: rp.wishes, notes: rp.notes, prefs: rp.prefs },
        status: mine.status, track: mine.track, sentAt: mine.sentAt, receivedAt: mine.receivedAt,
      };
    }
    const incoming = db.pairs.find((p) => p.recipientId === userId);
    if (incoming) out.incoming = { status: incoming.status, track: incoming.track, sentAt: incoming.sentAt, receivedAt: incoming.receivedAt };
    out.deadline = deadlineNotice(db, now, mine);
    out.notifications = db.notifications.filter((n) => n.userId === userId || n.userId === '*').slice(-30).reverse();
    out.settings = publicSettings(db);
    return out;
  }

  function publicSettings(db) {
    const s = db.settings;
    return { regOpen: s.regOpen, sendStart: s.sendStart, sendEnd: s.sendEnd, budgetMin: s.budgetMin, budgetMax: s.budgetMax, announcement: s.announcement, chatUrl: s.chatUrl };
  }

  function publicStats(db) {
    const people = activeParticipants(db)
      .map((u, i) => ({ name: firstName(u.name), at: db.participations[u.id].joinedAt, i }))
      .sort((a, b) => b.at - a.at || b.i - a.i);
    return {
      count: people.length,
      recent: people.slice(0, 15).map((p) => p.name),
      drawn: !!db.drawnAt,
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
        return Object.assign(publicUser(u), { pdConsentAt: u.pdConsentAt || null, participation: part ? Object.assign({}, part, { moderation: modStatus(part) }) : null });
      }),
      pairs: db.pairs.map((p) => Object.assign({}, p, {
        santa: byId[p.santaId] ? '@' + byId[p.santaId].tg : '—',
        recipient: byId[p.recipientId] ? '@' + byId[p.recipientId].tg : '—',
      })),
      pairsCheck: pairsCheck(db),
      adminLog: db.notifications.filter((n) => n.userId === ADMINS).slice(-60).reverse(),
      stats: {
        users: db.users.length,
        participants: activeParticipants(db).length,
        approved: approvedParticipants(db).length,
        pending: db.users.filter((u) => !u.banned && db.participations[u.id] && modStatus(db.participations[u.id]) === 'pending').length,
        banned: db.users.filter((u) => u.banned).length,
        sent: db.pairs.filter((p) => p.status !== 'assigned').length,
        received: db.pairs.filter((p) => p.status === 'received').length,
      },
    };
  }

  function updateSettings(db, body) {
    const s = db.settings;
    if ('regOpen' in body) s.regOpen = !!body.regOpen;
    for (const k of ['sendStart', 'sendEnd']) {
      if (body[k]) {
        if (isNaN(Date.parse(body[k]))) fail(400, 'Неверная дата: ' + k);
        s[k] = body[k];
      }
    }
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
    const adminState = (d) => Object.assign(adminStateRaw(d), { storage: ctx.storage ? ctx.storage() : null });
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
          notifyAdmins(db, ctx, `🗑 ${who(u)} удалил аккаунт и данные (жеребьёвки для него не было).`);
        }
        return ok(undefined, true);
      }
      case 'POST /api/sent': markSent(db, ctx, needUser(), body); return ok(me(db, ctx, ctx.userId), true);
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
      case 'POST /api/admin/reset': needAdmin(); resetDraw(db); return ok(adminState(db), true);
      case 'POST /api/admin/settings': needAdmin(); updateSettings(db, body); return ok(adminState(db), true);
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
      case 'POST /api/admin/pair-set': {
        // ручная правка: кому дарит Санта
        needAdmin();
        const santa = getUser(db, body.santaId);
        if (!body.recipientId) {
          db.pairs = db.pairs.filter((p) => p.santaId !== santa.id);
          notifyAdmins(db, ctx, `✏️ Вручную: у @${santa.tg} больше нет получателя.`);
          return ok(adminState(db), true);
        }
        const rec = getUser(db, body.recipientId);
        if (rec.id === santa.id) fail(400, 'Нельзя дарить самому себе');
        let p = db.pairs.find((x) => x.santaId === santa.id);
        if (p && p.recipientId === rec.id) return ok(adminState(db));
        if (!p) { p = { santaId: santa.id }; db.pairs.push(p); }
        Object.assign(p, { recipientId: rec.id, status: 'assigned', track: '', sentAt: null, receivedAt: null });
        if (!db.drawnAt) db.drawnAt = ctx.now();
        notify(db, ctx, santa.id, 'Организаторы назначили вам получателя подарка 🎁 Загляните в «Кому я дарю».', 'warn', 'whom');
        notifyAdmins(db, ctx, `✏️ Вручную: @${santa.tg} теперь дарит @${rec.tg}.`);
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/pair-status': {
        needAdmin();
        const p = db.pairs.find((x) => x.santaId === body.santaId);
        if (!p) fail(404, 'Пара не найдена');
        if (!['assigned', 'sent', 'received'].includes(body.status)) fail(400, 'Неверный статус');
        p.status = body.status;
        if (body.status !== 'assigned' && !p.sentAt) p.sentAt = ctx.now();
        if (body.status === 'received' && !p.receivedAt) p.receivedAt = ctx.now();
        return ok(adminState(db), true);
      }
      case 'POST /api/admin/broadcast': {
        needAdmin();
        const text = str(body.text, 500);
        if (!text) fail(400, 'Пустое сообщение');
        const targets = body.onlyParticipants ? activeParticipants(db) : db.users;
        targets.forEach((u) => notify(db, ctx, u.id, text, 'admin'));
        return ok({ sent: targets.length }, true);
      }
      case 'GET /api/admin/export': needAdmin(); return ok(db);
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

  return { handle, modStatus, emptyDb, ensure, SantaError, PREFS, DEFAULT_SETTINGS, plural, normPhone, normTg, DAY };
});
