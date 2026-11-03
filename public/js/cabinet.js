(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = FX.esc;
  const PREFS = SantaCore.PREFS;
  let me = null;
  let revealedOnce = false;

  // ---------- auth ----------
  $$('[data-tab]').forEach((t) => t.addEventListener('click', () => {
    $$('[data-tab]').forEach((x) => x.classList.toggle('on', x === t));
    $$('[data-auth-view] form').forEach((f) => (f.hidden = f.dataset.form !== t.dataset.tab));
  }));

  async function submit(form, fn) {
    const btn = form.querySelector('[type=submit]');
    const errEl = form.querySelector('[data-err]');
    errEl.textContent = '';
    btn.disabled = true; btn.classList.add('loading');
    try { await fn(); } catch (e) {
      if (e.status === 401 && Api.token()) {
        Api.logout();
        if (!modal.hidden) closePart();
        $('[data-cab-view]').hidden = true;
        $('[data-logout]').hidden = true;
        $('[data-auth-view]').hidden = false;
        $('[data-auth-view] [data-err]').textContent = 'Аккаунт не найден — войдите или зарегистрируйтесь заново';
        btn.disabled = false; btn.classList.remove('loading');
        return;
      }
      errEl.textContent = e.message;
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    }
    btn.disabled = false; btn.classList.remove('loading');
  }

  $('[data-form=login]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    submit(f, async () => {
      const r = await Api.post('/api/login', { login: f.login.value, password: f.password.value });
      Api.setToken(r.token);
      await load();
    });
  });
  $('[data-form=register]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    submit(f, async () => {
      const r = await Api.post('/api/register', { name: f.name.value, phone: f.phone.value, tg: f.tg.value, password: f.password.value });
      Api.setToken(r.token);
      await load();
      openPart();
    });
  });
  $('[data-logout]').addEventListener('click', () => { Api.logout(); location.reload(); });

  // ---------- participation modal ----------
  const modal = $('[data-modal]');
  const pf = $('[data-form=part]');
  function openPart() {
    const p = me.participation || {};
    pf.fullName.value = p.fullName || '';
    pf.phone.value = me.user.phone || '';
    pf.address.value = p.address || '';
    pf.wishes.value = p.wishes || '';
    pf.notes.value = p.notes || '';
    const r = pf.querySelector(`input[name=prefs][value="${p.prefs || 'coffee'}"]`);
    if (r) r.checked = true;
    pf.agree.checked = !!me.participation;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));
    setTimeout(() => pf.address.focus(), 60);
  }
  function closePart() { modal.classList.remove('open'); setTimeout(() => (modal.hidden = true), 250); }
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closePart));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closePart(); });
  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(pf, async () => {
      const first = !me.participation;
      me = await Api.post('/api/participate', {
        fullName: pf.fullName.value, phone: pf.phone.value,
        address: pf.address.value, wishes: pf.wishes.value, notes: pf.notes.value,
        prefs: (pf.querySelector('input[name=prefs]:checked') || {}).value, agree: pf.agree.checked,
      });
      closePart();
      render();
      if (first) FX.burst(innerWidth / 2, innerHeight / 3, { count: 140 });
      FX.toast(first ? 'Вы в игре! 🎅' : 'Анкета сохранена ☕', 'success');
    });
  });

  // ---------- render ----------
  function render() {
    const u = me.user;
    $('[data-auth-view]').hidden = true;
    $('[data-cab-view]').hidden = false;
    $('[data-logout]').hidden = false;
    $('[data-name]').textContent = u.name.split(' ')[0];
    $('[data-sub]').textContent = me.participation
      ? (me.drawn ? 'Жеребьёвка проведена — пора собирать посылку!' : 'Вы в списке участников. Ждём жеребьёвку ☕')
      : 'Вы ещё не заполнили анкету участника.';
    FX.renderBanners($('[data-banners]'), me);

    // big deadline notice
    const n = me.deadline;
    $('[data-notice]').innerHTML = n
      ? `<div class="big-notice ${n.kind}">⏰ ${esc(n.text)}<small>Отправка: ${FX.fmtDate(me.settings.sendStart)} — ${FX.fmtDate(me.settings.sendEnd)}</small></div>`
      : (me.settings.announcement ? `<div class="big-notice info">📣 ${esc(me.settings.announcement)}</div>` : '');

    renderGive();
    renderGift();
    renderPart();
    renderNotifs();

    $('[data-profile]').innerHTML = `
      <dt>Имя</dt><dd>${esc(u.name)}</dd>
      <dt>Телефон</dt><dd>${esc(u.phone)}</dd>
      <dt>Telegram</dt><dd><a href="https://t.me/${esc(u.tg)}" target="_blank" rel="noopener">@${esc(u.tg)}</a></dd>
      <dt>С нами с</dt><dd>${FX.fmtDate(u.createdAt)}</dd>
      ${u.banned ? '<dt>Статус</dt><dd><span class="status banned">🛑 чёрный список</span></dd>' : ''}`;
  }

  function renderGive() {
    const host = $('[data-give]');
    const a = me.assignment;
    if (!me.participation) {
      host.innerHTML = `<div class="sealed"><div class="env">✉️</div><p class="muted">Заполните анкету, чтобы участвовать в жеребьёвке.</p><button class="btn btn-primary" data-open-part>Заполнить анкету</button></div>`;
    } else if (!a) {
      host.innerHTML = `<div class="sealed"><div class="env">🔒</div><p class="muted">Конверт запечатан. Как только организаторы перемешают участников, здесь появится имя, адрес и пожелания вашего получателя.</p></div>`;
    } else {
      const r = a.recipient;
      const statusTxt = { assigned: '⏳ ждёт отправки', sent: '🚚 отправлено', received: '✅ получено' }[a.status];
      host.innerHTML = `
        <div class="${revealedOnce ? '' : 'flip'}">
          <p style="margin-bottom:14px">Вы — Тайный Санта для <b class="grad" style="font-size:20px">${esc(r.name)}</b> <span class="status ${a.status}">${statusTxt}</span></p>
          <dl class="kv">
            <dt>ФИО</dt><dd><span class="copy" data-copy="${esc(r.fullName)}">${esc(r.fullName)}</span></dd>
            <dt>Куда</dt><dd><span class="copy" data-copy="${esc(r.address)}" title="Скопировать">${esc(r.address)}</span> 📋</dd>
            <dt>Телефон</dt><dd><span class="copy" data-copy="${esc(r.phone)}">${esc(r.phone)}</span></dd>
            <dt>Telegram</dt><dd>@${esc(r.tg)}</dd>
            <dt>Тематика</dt><dd>${esc(PREFS[r.prefs] || '—')}</dd>
            <dt>Хочет</dt><dd>${esc(r.wishes) || '<span class="muted">не написал(а) — сюрприз!</span>'}</dd>
            ${r.notes ? `<dt>⚠️ Важно</dt><dd><span class="important">${esc(r.notes)}</span></dd>` : ''}
            ${a.track ? `<dt>Трек</dt><dd>${esc(a.track)}</dd>` : ''}
          </dl>
          ${a.status === 'assigned' ? `
          <form class="form" data-sent style="margin-top:16px">
            <label>Трек-номер (необязательно)<input name="track" placeholder="например, 0123456789-0001-1"></label>
            <button class="btn btn-green btn-block" type="submit">📦 Я отправил подарок!</button>
            <div class="form-err" data-err></div>
          </form>` : `<p class="muted" style="margin-top:14px">Отправлено ${FX.fmtDateTime(a.sentAt)}. Спасибо, Санта! ${a.status === 'received' ? 'Подарок уже получен 💛' : ''}</p>`}
        </div>`;
      revealedOnce = true;
      const sf = $('[data-sent]', host);
      if (sf) sf.addEventListener('submit', (e) => {
        e.preventDefault();
        submit(sf, async () => {
          me = await Api.post('/api/sent', { track: sf.track.value });
          render();
          FX.burst(innerWidth / 2, innerHeight / 2, { count: 160, power: 14 });
          FX.toast('Хо-хо-хо! Получатель увидит, что подарок в пути 🎁', 'success');
        });
      });
    }
    $$('[data-open-part]', host).forEach((b) => b.addEventListener('click', openPart));
    $$('[data-copy]', host).forEach((el) => el.addEventListener('click', () => {
      navigator.clipboard && navigator.clipboard.writeText(el.dataset.copy).then(() => FX.toast('Скопировано 📋'));
    }));
  }

  function renderGift() {
    const host = $('[data-gift]');
    const g = me.incoming;
    if (!g) {
      host.innerHTML = `<div class="sealed"><div class="env">🎄</div><p class="muted">${me.drawn ? 'Ваш Санта уже знает о вас. Ждём!' : 'После жеребьёвки кто-то станет вашим Тайным Сантой.'}</p></div>`;
    } else if (g.status === 'assigned') {
      host.innerHTML = `<div class="sealed"><div class="env">🛷</div><p>Ваш Тайный Санта собирает посылку.</p><p class="muted">Как только он отметит отправку — вы увидите это здесь.</p></div>`;
    } else if (g.status === 'sent') {
      host.innerHTML = `<div class="gift-big">🎁</div>
        <h3 style="justify-content:center;text-align:center;font-size:22px">Вам подарок от Деда Мороза!</h3>
        <p class="muted" style="text-align:center">Отправлен ${FX.fmtDateTime(g.sentAt)}${g.track ? `<br>Трек: <b>${esc(g.track)}</b>` : ''}</p>
        <button class="btn btn-primary btn-block" data-received>🎉 Я получил подарок!</button>`;
      $('[data-received]', host).addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          me = await Api.post('/api/received');
          render();
          FX.burst(innerWidth / 2, innerHeight / 2, { count: 200, power: 16, emojiRatio: 0.6 });
        } catch (ex) { FX.toast(ex.message, 'error'); e.target.disabled = false; }
      });
      if (!sessionStorage.getItem('giftBurst')) {
        sessionStorage.setItem('giftBurst', '1');
        setTimeout(() => FX.burstFrom(host, { count: 120 }), 400);
      }
    } else {
      host.innerHTML = `<div class="gift-big" style="animation:none">🥳</div><p style="text-align:center">Подарок получен ${FX.fmtDateTime(g.receivedAt)}. С наступающим!</p>`;
    }
  }

  function renderPart() {
    const host = $('[data-part]');
    const p = me.participation;
    if (!p) {
      host.innerHTML = `<p class="muted">Анкета не заполнена.</p>${me.user.banned ? '' : '<button class="btn btn-primary" data-open-part>🎅 Участвовать</button>'}`;
    } else {
      host.innerHTML = `<dl class="kv">
        <dt>ФИО</dt><dd>${esc(p.fullName) || '<span class="important">не указано — заполните!</span>'}</dd>
        <dt>Телефон</dt><dd>${esc(me.user.phone)}</dd>
        <dt>Адрес</dt><dd>${esc(p.address)}</dd>
        <dt>Тематика</dt><dd>${esc(PREFS[p.prefs])}</dd>
        <dt>Пожелания</dt><dd>${esc(p.wishes) || '—'}</dd>
        <dt>Пометки</dt><dd>${esc(p.notes) || '—'}</dd>
      </dl>
      <div class="actions">
        <button class="btn btn-ghost btn-sm" data-open-part>✏️ Изменить</button>
        ${me.drawn ? '' : '<button class="btn btn-danger btn-sm" data-leave>Выйти из игры</button>'}
      </div>`;
      const l = $('[data-leave]', host);
      if (l) l.addEventListener('click', async () => {
        if (!confirm('Точно выйти из Тайного Санты?')) return;
        try { me = await Api.post('/api/leave'); render(); } catch (e) { FX.toast(e.message, 'error'); }
      });
    }
    $$('[data-open-part]', host).forEach((b) => b.addEventListener('click', openPart));
  }

  function renderNotifs() {
    const list = me.notifications;
    $('[data-notifs]').innerHTML = list.length
      ? list.map((n) => `<li class="${n.read ? '' : 'unread'} ${n.kind}">${esc(n.text)}<time>${FX.fmtDateTime(n.createdAt)}</time></li>`).join('')
      : '<li>Пока тихо. Как будто перед большим завозом зерна.</li>';
    if (list.some((n) => !n.read)) setTimeout(() => Api.post('/api/notifications/read').catch(() => {}), 2500);
  }

  async function load() {
    me = await Api.get('/api/me');
    render();
  }

  (async () => {
    await FX.chrome();
    if (!Api.token()) { $('[data-auth-view]').hidden = false; return; }
    try { await load(); } catch (e) {
      if (e.status === 401) { Api.logout(); $('[data-auth-view]').hidden = false; }
      else FX.toast(e.message, 'error');
    }
    setInterval(() => { const typing = document.activeElement && document.activeElement.closest('form');
      if (Api.token() && modal.hidden && !typing) Api.get('/api/me').then((m) => { me = m; render(); }).catch(() => {}); }, 30000);
  })();
})();
