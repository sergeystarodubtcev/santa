/*
 * Клиент API. Если бэкенд доступен — работает с ним.
 * Если нет (например, сайт открыт на GitHub Pages без настроенного API) — включается
 * демо-режим: та же логика из core.js, а база хранится в localStorage браузера.
 */
(function () {
  'use strict';
  const cfg = window.SANTA_CONFIG || {};
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* noop */ } },
  };
  const DEMO_DB = 'santa_demo_db';
  const DEMO_ADMIN_PASSWORD = 'admin';

  let base = (cfg.apiUrl || '').replace(/\/$/, '');
  let modePromise = null;

  function detect() {
    if (!modePromise) {
      modePromise = (async () => {
        if (cfg.forceDemo) return 'demo';
        // Адрес бэкенда задан явно — никогда не уходим в демо (бесплатный хостинг может «просыпаться» до минуты).
        if (base) {
          fetch(base + '/api/health', { cache: 'no-store' }).catch(() => {});
          return 'remote';
        }
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 6000);
          const r = await fetch(base + '/api/health', { signal: ctrl.signal, cache: 'no-store' });
          clearTimeout(t);
          if (r.ok && (r.headers.get('content-type') || '').includes('json')) return 'remote';
        } catch (e) { /* fall through */ }
        return 'demo';
      })();
    }
    return modePromise;
  }

  // ---------- demo backend ----------
  function demoDb() {
    try {
      const raw = LS.get(DEMO_DB);
      if (raw) return SantaCore.ensure(JSON.parse(raw));
    } catch (e) { /* broken */ }
    return seedDemo();
  }
  function seedDemo() {
    const db = SantaCore.emptyDb();
    const names = [['Ольга', 'olga_brew'], ['Илья', 'ilia_poliakov'], ['Маша', 'masha_v60'], ['Дима', 'dima_espresso'], ['Аня', 'anya_aeropress'], ['Кирилл', 'kirill_roast'], ['Света', 'sveta_filter']];
    const t = Date.now() - names.length * 3600e3;
    names.forEach(([name, tg], i) => {
      const id = 'demo' + i;
      db.users.push({ id, name, phone: '+7900000000' + i, tg, passHash: 'demo:demo123', createdAt: t + i * 3600e3, banned: false, pdConsentAt: t });
      db.participations[id] = { moderation: i < 5 ? 'approved' : 'pending', fullName: name + ' Кофеманов', address: 'Ozon ПВЗ, г. Москва, ул. Кофейная, ' + (i + 1), wishes: 'Зерно светлой обжарки, дрип-пакеты', notes: i === 2 ? 'Аллергия на инфьюзы' : '', prefs: ['coffee', 'any', 'noncoffee'][i % 3], joinedAt: t + i * 3600e3, updatedAt: t };
    });
    return db;
  }
  const demoHash = (pw) => 'demo:' + pw; // демо-режим: всё живёт только в вашем браузере
  function demoCall(method, path, body, token) {
    const db = demoDb();
    let auth = null;
    try { auth = token ? JSON.parse(atob(token)) : null; } catch (e) { auth = null; }
    const ctx = {
      now: () => Date.now(),
      hash: demoHash,
      verify: (pw, h) => demoHash(pw) === h,
      issueToken: (p) => btoa(JSON.stringify(p)),
      checkAdmin: (pw) => pw === DEMO_ADMIN_PASSWORD,
      userId: auth && auth.uid,
      isAdmin: !!(auth && auth.admin),
    };
    try {
      const { data, mutated } = SantaCore.handle(db, ctx, method, path, body);
      if (mutated) LS.set(DEMO_DB, JSON.stringify(db));
      return Promise.resolve(JSON.parse(JSON.stringify(data)));
    } catch (e) {
      const err = new Error(e.message);
      err.status = e.status || 500;
      err.code = e.code;
      return Promise.reject(err);
    }
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    const token = opts.admin ? LS.get('santa_admin') : LS.get('santa_token');
    const mode = await detect();
    if (mode === 'demo') return demoCall(method, path, body, token);
    let r;
    try {
      r = await fetch(base + path, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        cache: 'no-store',
      });
    } catch (e) {
      const err = new Error('Сервер просыпается или недоступен. Подождите полминуты и попробуйте ещё раз ☕');
      err.status = 0;
      throw err;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || 'Ошибка ' + r.status);
      err.status = r.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  const Api = {
    mode: detect,
    demoAdminPassword: DEMO_ADMIN_PASSWORD,
    get: (p, o) => request('GET', p, null, o),
    post: (p, b, o) => request('POST', p, b, o),
    token: () => LS.get('santa_token'),
    setToken: (t) => LS.set('santa_token', t),
    adminToken: () => LS.get('santa_admin'),
    setAdminToken: (t) => LS.set('santa_admin', t),
    logout() { LS.set('santa_token', null); },
    resetDemo() { LS.set(DEMO_DB, null); },
  };
  window.Api = Api;
})();
