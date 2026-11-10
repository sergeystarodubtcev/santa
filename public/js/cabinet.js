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
      const r = await Api.post('/api/register', { name: f.name.value, phone: f.phone.value, tg: f.tg.value, password: f.password.value, pdConsent: f.pdConsent.checked });
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
      if (first) FX.burst(innerWidth / 2, innerHeight / 3, { count: 60 });
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
    const mod = me.participation && me.participation.moderation;
    $('[data-sub]').textContent = !me.participation ? 'Вы ещё не заполнили анкету участника.'
      : me.assignment ? 'Жеребьёвка проведена — пора собирать посылку!'
      : mod === 'approved' ? 'Анкета одобрена ✅ Ждём жеребьёвку ☕'
      : mod === 'rejected' ? 'Анкета не прошла модерацию — исправьте её или напишите организаторам.'
      : 'Анкета на модерации ⏳ Организаторы проверят её перед жеребьёвкой.';
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
    renderTg();
    $('[data-delete-me]').hidden = false;
  }

  function renderGive() {
    const host = $('[data-give]');
    const a = me.assignment;
    if (!me.participation) {
      host.innerHTML = `<div class="sealed"><div class="env">✉️</div><p class="muted">Заполните анкету, чтобы участвовать в жеребьёвке.</p><button class="btn btn-primary" data-open-part>Заполнить анкету</button></div>`;
    } else if (!a && me.participation.moderation === 'pending') {
      host.innerHTML = `<div class="sealed"><div class="env">🕵️</div><p><b>Анкета на модерации</b></p><p class="muted">Перед жеребьёвкой организаторы проверяют всех участников. Как только анкету одобрят, вы попадёте в раздачу.</p></div>`;
    } else if (!a && me.participation.moderation === 'rejected') {
      host.innerHTML = `<div class="sealed"><div class="env">🚫</div><p><b>Анкета не прошла модерацию</b></p><p class="muted">${esc(me.participation.moderationNote) || 'Исправьте анкету или напишите организаторам.'}</p><button class="btn btn-primary" data-open-part>Исправить анкету</button></div>`;
    } else if (!a) {
      host.innerHTML = `<div class="sealed"><div class="env">🔒</div><p class="muted">Анкета одобрена ✅ Конверт запечатан. Как только организаторы перемешают участников, здесь появится имя, ПВЗ и пожелания вашего получателя.</p></div>`;
    } else {
      const r = a.recipient;
      const statusTxt = { assigned: '⏳ ждёт отправки', sent: '🚚 отправлено', received: '✅ получено' }[a.status];
      host.innerHTML = `
        <div class="${revealedOnce ? '' : 'flip'}">
          <p style="margin-bottom:14px">Вы — Тайный Санта для <b class="grad" style="font-size:20px">${esc(r.name)}</b> <span class="status ${a.status}">${statusTxt}</span></p>
          <dl class="kv">
            <dt>ФИО</dt><dd><span class="copy" data-copy="${esc(r.fullName)}">${esc(r.fullName)}</span></dd>
            <dt>ПВЗ Ozon</dt><dd><span class="copy" data-copy="${esc(r.address)}" title="Скопировать">${esc(r.address)}</span> 📋</dd>
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
          FX.burst(innerWidth / 2, innerHeight / 2, { count: 60, power: 15 });
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
          FX.burst(innerWidth / 2, innerHeight / 2, { count: 70, power: 16, emojiRatio: 0.25 });
        } catch (ex) { FX.toast(ex.message, 'error'); e.target.disabled = false; }
      });
      if (!sessionStorage.getItem('giftBurst')) {
        sessionStorage.setItem('giftBurst', '1');
        setTimeout(() => FX.burstFrom(host, { count: 50 }), 400);
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
      const MOD = { pending: '<span class="status assigned">⏳ на модерации</span>', approved: '<span class="status received">✅ одобрена</span>', rejected: '<span class="status banned">🚫 отклонена</span>' };
      host.innerHTML = `<dl class="kv">
        <dt>Статус</dt><dd>${MOD[p.moderation] || ''}${p.moderation === 'rejected' && p.moderationNote ? `<small class="important" style="display:block">${esc(p.moderationNote)}</small>` : ''}</dd>
        <dt>ФИО</dt><dd>${esc(p.fullName) || '<span class="important">не указано — заполните!</span>'}</dd>
        <dt>Телефон</dt><dd>${esc(me.user.phone)}</dd>
        <dt>ПВЗ Ozon</dt><dd>${esc(p.address)}</dd>
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

  // ---------- Telegram ----------
  let tgLink = null; // null — ещё не спрашивали, false — бот не подключён
  async function renderTg() {
    const card = $('[data-tg]');
    if (tgLink === null) {
      try { tgLink = await Api.get('/api/tg/link'); } catch (e) { tgLink = false; }
    }
    if (!tgLink) { card.hidden = true; return; }
    card.hidden = false;
    const linked = me.user.tgLinked;
    card.classList.toggle('on', linked);
    $('[data-tg-title]').textContent = linked ? '✅ Уведомления в Telegram включены' : 'Уведомления в Telegram';
    $('[data-tg-sub]').textContent = linked
      ? `Бот @${tgLink.username} пришлёт напоминания и подскажет, кому дарить.`
      : 'Бот напомнит о жеребьёвке, подскажет, кому дарить, и не даст пропустить сроки отправки.';
    $('[data-tg-btn]').textContent = linked ? 'Открыть бота' : '🔔 Подписаться на уведомления';
  }
  $('[data-tg-btn]').addEventListener('click', () => {
    if (tgLink) window.open(tgLink.url, '_blank', 'noopener');
    // после возврата из Telegram обновим статус привязки
    setTimeout(() => Api.get('/api/me').then((m) => { me = m; renderTg(); }).catch(() => {}), 8000);
  });

  // ---------- исправление профиля ----------
  const pm = $('[data-prof-modal]');
  const pfm = $('[data-form=profile]');
  const profClose = () => { pm.classList.remove('open'); setTimeout(() => (pm.hidden = true), 250); };
  $$('[data-prof-close]', pm).forEach((b) => b.addEventListener('click', profClose));
  $('[data-edit-profile]').addEventListener('click', () => {
    pfm.name.value = me.user.name;
    pfm.tg.value = '@' + me.user.tg;
    pfm.phone.value = me.user.phone;
    $('[data-err]', pfm).textContent = '';
    pm.hidden = false;
    requestAnimationFrame(() => pm.classList.add('open'));
    setTimeout(() => pfm.tg.focus(), 60);
  });
  pfm.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(pfm, async () => {
      me = await Api.post('/api/profile', { name: pfm.name.value, tg: pfm.tg.value, phone: pfm.phone.value });
      profClose();
      render();
      FX.toast('Данные сохранены ✅', 'success');
    });
  });

  // ---------- удаление аккаунта (отзыв согласия на обработку ПДн) ----------
  const dm = $('[data-del-modal]');
  const delStep = (n) => $$('[data-del-step]', dm).forEach((el) => (el.hidden = el.dataset.delStep !== String(n)));
  function delOpen() { dm.hidden = false; requestAnimationFrame(() => dm.classList.add('open')); }
  function delClose() { dm.classList.remove('open'); setTimeout(() => (dm.hidden = true), 250); }
  $$('[data-del-close]', dm).forEach((b) => b.addEventListener('click', delClose));
  function showNeedAdmin(text) {
    if (text) $('[data-del-admin-text]').textContent = text;
    const a = $('[data-del-help]');
    if (tgLink && tgLink.helpUrl) a.href = tgLink.helpUrl;
    else { a.href = (me.settings && me.settings.chatUrl) || 'https://t.me/coffeemaniacs_channel'; a.textContent = 'Написать организаторам в Telegram'; }
    delStep('admin');
  }
  $('[data-delete-me]').addEventListener('click', async () => {
    if (tgLink === null) { try { tgLink = await Api.get('/api/tg/link'); } catch (e) { tgLink = false; } }
    $('[data-del-ack]').checked = false;
    $('[data-del-next]').disabled = true;
    $('[data-del-word]').value = '';
    $('[data-del-go]').disabled = true;
    $('[data-del-err]').textContent = '';
    const a = me.assignment;
    const g = me.incoming;
    delOpen();
    if ((a && a.status !== 'assigned') || (g && g.status !== 'assigned')) {
      showNeedAdmin(a && a.status !== 'assigned'
        ? 'Вы уже отправили подарок, поэтому удалить аккаунт самостоятельно нельзя.'
        : 'Ваш Тайный Санта уже отправил вам посылку — если удалить аккаунт, подарок потеряется.');
      return;
    }
    const inDraw = !!(a || g);
    $('[data-del-text]').innerHTML = inDraw
      ? '<p><b>Жеребьёвка уже прошла.</b> Если вы удалите аккаунт:</p>' +
        '<ul>' +
        '<li>вы выйдете из Тайного Санты и <b>не получите подарок</b>;</li>' +
        '<li>ваш Тайный Санта получит <b>другого получателя</b> — ему придётся собирать посылку заново;</li>' +
        '<li>ваш получатель получит подарок от другого участника;</li>' +
        '<li>организаторы увидят, что вы вышли из игры;</li>' +
        '<li>все ваши данные (имя, телефон, ФИО, адрес ПВЗ) будут удалены навсегда.</li>' +
        '</ul>' +
        '<p class="muted">Если что-то случилось — лучше сначала <a href="#" data-del-to-admin>напишите администратору</a>, он поможет.</p>'
      : '<p>Будут удалены навсегда ваш аккаунт, анкета и все данные (имя, телефон, ФИО, адрес ПВЗ). Вы выйдете из Тайного Санты.</p>';
    const toAdmin = $('[data-del-to-admin]');
    if (toAdmin) toAdmin.addEventListener('click', (e) => { e.preventDefault(); showNeedAdmin('Опишите ситуацию администратору — возможно, выходить из игры не придётся.'); });
    delStep(1);
  });
  $('[data-del-ack]').addEventListener('change', (e) => { $('[data-del-next]').disabled = !e.target.checked; });
  $('[data-del-next]').addEventListener('click', () => { delStep(2); setTimeout(() => $('[data-del-word]').focus(), 50); });
  $('[data-del-word]').addEventListener('input', (e) => { $('[data-del-go]').disabled = e.target.value.trim().toUpperCase() !== 'УДАЛИТЬ'; });
  $('[data-del-go]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      await Api.post('/api/account/delete', { confirm: 'УДАЛИТЬ' });
      Api.logout();
      delClose();
      alert('Аккаунт и данные удалены. Спасибо, что были с нами ☕');
      location.href = './';
    } catch (ex) {
      if (ex.code === 'need_admin') showNeedAdmin(ex.message);
      else $('[data-del-err]').textContent = ex.message;
    }
    btn.disabled = false;
    btn.classList.remove('loading');
  });

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
