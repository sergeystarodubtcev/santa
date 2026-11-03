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
    chatUrl: 'https://t.me/c/1641902727/156432',
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
    };
  }

  function ensure(db) {
    const base = emptyDb();
    for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
    db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings || {});
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
    return { id: u.id, name: u.name, phone: u.phone, tg: u.tg, createdAt: u.createdAt, banned: !!u.banned };
  }

  function activeParticipants(db) {
    return db.users.filter((u) => !u.banned && db.participations[u.id]);
  }

  function notify(db, ctx, userId, text, kind) {
    db.notifications.push({ id: newId(ctx), userId, text, kind: kind || 'info', createdAt: ctx.now(), read: false });
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
    if (db.users.some((u) => u.phone === phone)) fail(409, 'Этот телефон уже зарегистрирован — войдите в кабинет');
    if (db.users.some((u) => u.tg === tg)) fail(409, 'Этот Telegram уже зарегистрирован — войдите в кабинет');
    const user = { id: newId(ctx), name, phone, tg, passHash: ctx.hash(password), createdAt: ctx.now(), banned: false };
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
    const address = str(body.address, 400);
    if (address.length < 5) fail(400, 'Укажите адрес ПВЗ Ozon или свой адрес');
    if (!body.agree) fail(400, 'Подтвердите участие и дальнейшую отправку подарка');
    const prefs = PREFS[body.prefs] ? body.prefs : 'any';
    db.participations[userId] = {
      address,
      wishes: str(body.wishes, 1000),
      notes: str(body.notes, 500),
      prefs,
      joinedAt: existing ? existing.joinedAt : ctx.now(),
      updatedAt: ctx.now(),
    };
    if (!existing) notify(db, ctx, userId, 'Вы в игре! Ждите жеребьёвку — мы сообщим, кому дарить 🎅', 'success');
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
    const people = activeParticipants(db);
    if (people.length < 2) fail(400, 'Нужно минимум 2 участника');
    if (db.pairs.some((p) => p.status !== 'assigned') && !(body && body.force)) {
      fail(409, 'Кто-то уже отправил подарок. Перемешать заново можно только принудительно.');
    }
    const ids = people.map((u) => u.id);
    const rnd = ctx.random || Math.random;
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    // Одна большая цепочка: каждый дарит следующему, последний — первому.
    // Никто не дарит сам себе и нет «взаимных» пар при 3+ участниках.
    db.pairs = ids.map((id, i) => ({
      santaId: id,
      recipientId: ids[(i + 1) % ids.length],
      status: 'assigned',
      track: '',
      sentAt: null,
      receivedAt: null,
    }));
    db.drawnAt = ctx.now();
    for (const id of ids) {
      notify(db, ctx, id, 'Жеребьёвка проведена! Загляните в «Кому я дарю» — там имя и адрес получателя 🎁', 'success');
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
    notify(db, ctx, pair.recipientId, 'Вам подарок от Деда Мороза! 🎁 Посылка уже в пути' + (pair.track ? ' (трек: ' + pair.track + ')' : ''), 'gift');
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
    const out = { user: publicUser(user), participation: db.participations[userId] || null, drawn: !!db.drawnAt };
    const mine = db.pairs.find((p) => p.santaId === userId);
    if (mine) {
      const r = db.users.find((u) => u.id === mine.recipientId) || {};
      const rp = db.participations[mine.recipientId] || {};
      out.assignment = {
        recipient: { name: r.name, phone: r.phone, tg: r.tg, address: rp.address, wishes: rp.wishes, notes: rp.notes, prefs: rp.prefs },
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

  function adminState(db) {
    const byId = Object.fromEntries(db.users.map((u) => [u.id, u]));
    return {
      settings: db.settings,
      drawnAt: db.drawnAt,
      users: db.users.map((u) => Object.assign(publicUser(u), { participation: db.participations[u.id] || null })),
      pairs: db.pairs.map((p) => Object.assign({}, p, {
        santa: byId[p.santaId] ? byId[p.santaId].name + ' @' + byId[p.santaId].tg : '—',
        recipient: byId[p.recipientId] ? byId[p.recipientId].name + ' @' + byId[p.recipientId].tg : '—',
      })),
      stats: {
        users: db.users.length,
        participants: activeParticipants(db).length,
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
      case 'POST /api/participate': participate(db, ctx, needUser(), body); return ok(me(db, ctx, ctx.userId), true);
      case 'POST /api/leave': leave(db, ctx, needUser()); return ok(me(db, ctx, ctx.userId), true);
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
      case 'POST /api/admin/delete': {
        needAdmin();
        if (db.pairs.some((p) => p.santaId === body.userId || p.recipientId === body.userId)) {
          fail(409, 'Участник уже в паре. Сначала сбросьте жеребьёвку.');
        }
        db.users = db.users.filter((u) => u.id !== body.userId);
        delete db.participations[body.userId];
        db.notifications = db.notifications.filter((n) => n.userId !== body.userId);
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

  return { handle, emptyDb, ensure, SantaError, PREFS, DEFAULT_SETTINGS, plural, normPhone, normTg, DAY };
});
