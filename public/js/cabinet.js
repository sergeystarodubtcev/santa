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
  let partMode = 'main'; // 'main' — основная анкета, 'wave' — анкета для следующей волны (данные копируются из прошлой)
  function setPartMode(mode) {
    partMode = mode;
    const nw = me.nextWave || {};
    $('[data-part-title]').textContent = mode === 'wave' ? (nw.n ? `Анкета для ${nw.n}-й волны` : 'Анкета для следующей волны') : 'Анкета участника';
    $('[data-agree-text]').textContent = mode === 'wave'
      ? (nw.n ? `Участвую в ${nw.n}-й волне (отправка ${FX.fmtDate(nw.start)} — ${FX.fmtDate(nw.end)}): дарю ещё один подарок и получаю ещё один.` : 'Записываюсь в лист ожидания следующей волны: дарю ещё один подарок и получаю ещё один.')
      : 'Подтверждаю участие и дальнейшую отправку подарка.';
    $('[data-wave-hint]').hidden = mode !== 'wave';
  }
  function openWavePart() {
    const a = (me.nextWave && me.nextWave.anketa) || me.participation || {};
    setPartMode('wave');
    pf.fullName.value = a.fullName || '';
    pf.phone.value = me.user.phone || '';
    pf.address.value = a.address || '';
    pf.wishes.value = a.wishes || '';
    pf.notes.value = a.notes || '';
    const r = pf.querySelector(`input[name=prefs][value="${a.prefs || 'coffee'}"]`);
    if (r) r.checked = true;
    pf.agree.checked = false;
    $('[data-w2-wrap]', pf).hidden = true;
    pf.wave2.checked = false;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));
  }
  function openPart() {
    setPartMode('main');
    const p = me.participation || {};
    pf.fullName.value = p.fullName || '';
    pf.phone.value = me.user.phone || '';
    pf.address.value = p.address || '';
    pf.wishes.value = p.wishes || '';
    pf.notes.value = p.notes || '';
    const r = pf.querySelector(`input[name=prefs][value="${p.prefs || 'coffee'}"]`);
    if (r) r.checked = true;
    pf.agree.checked = !!me.participation;
    const needW2 = !me.participation && me.round !== 1 && !me.drawn;
    $('[data-w2-wrap]', pf).hidden = !needW2;
    pf.wave2.checked = false;
    if (needW2) $('[data-w2-text]', pf).innerHTML = me.round
      ? `Первая жеребьёвка уже прошла. Подтверждаю участие в <b>${me.round}-й волне</b>: отправка подарков с ${FX.fmtDate(me.dates.start)} по ${FX.fmtDate(me.dates.end)}.`
      : 'Первая жеребьёвка уже прошла. Подтверждаю участие в <b>следующей волне</b> — организаторы пришлют даты, когда она откроется.';
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));
    setTimeout(() => pf.address.focus(), 60);
  }
  function closePart() { modal.classList.remove('open'); setTimeout(() => (modal.hidden = true), 250); }
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closePart));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closePart(); });
  pf.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!(await FX.checkCity(pf.address.value))) { pf.address.focus(); return; }
    submit(pf, async () => {
      if (partMode === 'wave') {
        const nw = me.nextWave || {};
        me = await Api.post('/api/wave-join', {
          fullName: pf.fullName.value, phone: pf.phone.value,
          address: pf.address.value, wishes: pf.wishes.value, notes: pf.notes.value,
          prefs: (pf.querySelector('input[name=prefs]:checked') || {}).value, agree: pf.agree.checked,
        });
        closePart();
        render();
        FX.burst(innerWidth / 2, innerHeight / 3, { count: 60 });
        FX.toast(nw.n ? `Вы в ${nw.n}-й волне! 🌊` : 'Вы в листе ожидания следующей волны 🌊', 'success');
        return;
      }
      const first = !me.participation;
      me = await Api.post('/api/participate', {
        fullName: pf.fullName.value, phone: pf.phone.value,
        address: pf.address.value, wishes: pf.wishes.value, notes: pf.notes.value,
        prefs: (pf.querySelector('input[name=prefs]:checked') || {}).value, agree: pf.agree.checked, wave2: pf.wave2.checked,
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
      : me.wave2 && me.wave2.status === 'invited' && !me.wave2.drawn ? `Подтвердите участие в ${me.wave2.round}-й волне 👇`
      : me.wave2 && me.wave2.status === 'waiting' ? 'Вы в листе ожидания следующей волны — мы напишем, когда она откроется 🌊'
      : me.drawing && !me.assignment ? '🎲 Идёт жеребьёвка — организаторы проверяют пары. Скоро здесь появится ваш получатель!'
      : me.assignment ? (me.assignment.round > 1 ? `Жеребьёвка ${me.assignment.round}-й волны проведена — пора собирать посылку!` : 'Жеребьёвка проведена — пора собирать посылку!')
      : me.round > 1 && mod === 'approved' ? `Вы в ${me.round}-й волне ✅ Ждём её жеребьёвку. Отправка: ${FX.fmtDate(me.dates.start)} — ${FX.fmtDate(me.dates.end)}`
      : mod === 'approved' ? 'Анкета одобрена ✅ Ждём жеребьёвку ☕'
      : mod === 'rejected' ? 'Анкета не прошла модерацию — исправьте её или напишите организаторам.'
      : 'Анкета на модерации ⏳ Организаторы проверят её перед жеребьёвкой.';
    FX.renderBanners($('[data-banners]'), me);

    // big deadline notice
    const n = me.deadline;
    $('[data-notice]').innerHTML = wave2Card() + nextWaveCard() + (n
      ? `<div class="big-notice ${n.kind}">⏰ ${esc(n.text)}<small>Отправка: ${FX.fmtDate((me.dates || me.settings).start || me.settings.sendStart)} — ${FX.fmtDate((me.dates || me.settings).end || me.settings.sendEnd)}</small></div>`
      : (me.settings.announcement ? `<div class="big-notice info">📣 ${esc(me.settings.announcement)}</div>` : ''));

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

  // Запись в следующую волну тем, кто уже участвует: анкета подставляется из прошлой волны
  function nextWaveCard() {
    const nw = me.nextWave;
    if (!nw || nw.invited || (me.wave2 && me.wave2.status === 'invited' && !me.wave2.drawn)) return '';
    if (nw.joined) {
      return `<div class="card w2-card nw-card"><h3>🌊 ${nw.n ? `Вы в ${nw.n}-й волне` : 'Вы в листе ожидания следующей волны'} ✅</h3>
        <p class="muted">${nw.n ? `Отправка подарков: <b>${FX.fmtDate(nw.start)} — ${FX.fmtDate(nw.end)}</b>. Мы напишем, когда пройдёт её жеребьёвка — здесь появится ещё один получатель.` : 'Как только организаторы откроют следующую волну, мы пришлём даты и попросим подтвердить участие.'}</p>
        <div class="actions"><button class="btn btn-ghost btn-sm" data-wave-edit>✏️ Анкета для волны</button><button class="btn btn-ghost btn-sm" data-wave-leave>🙅 Отказаться</button></div></div>`;
    }
    return `<div class="card w2-card nw-card"><h3>🌊 ${nw.n ? `Открыта запись в ${nw.n}-ю волну!` : 'Хотите участвовать и в следующей волне?'}</h3>
      <p>${nw.n ? `Отправка подарков: <b>${FX.fmtDate(nw.start)} — ${FX.fmtDate(nw.end)}</b>. ` : ''}Вы дарите ещё один подарок новому получателю и получаете ещё один — отдельная жеребьёвка. Анкета подставится из прошлой волны, её можно поправить.</p>
      <div class="actions"><button class="btn btn-primary" data-wave-join>📝 ${nw.n ? `Записаться в ${nw.n}-ю волну` : 'Записаться в лист ожидания'}</button></div></div>`;
  }
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-wave-join]') || e.target.closest('[data-wave-edit]')) { openWavePart(); return; }
    const lv = e.target.closest('[data-wave-leave]');
    if (lv) {
      if (!confirm('Отказаться от участия в следующей волне?')) return;
      lv.disabled = true;
      try { me = await Api.post('/api/wave2', { join: false }); render(); FX.toast('Отметили: в следующей волне вас не будет', 'success'); }
      catch (ex) { FX.toast(ex.message, 'error'); lv.disabled = false; }
    }
  });

  // Приглашение в следующую волну: участие нужно подтвердить
  function wave2Card() {
    const w = me.wave2;
    if (!w || w.status !== 'invited' || w.drawn) return '';
    const why = w.reason === 'victim'
      ? `😢 Ваш Тайный Санта из прошлой волны так и не отправил подарок — нам очень жаль! В ${w.round}-й волне вам отправят подарок <b>в первую очередь ⭐</b>. Вы тоже дарите подарок одному участнику.`
      : w.reason === 'admin' ? `Организаторы приглашают вас в ${w.round}-ю волну Тайного Санты.`
      : `Открылась ${w.round}-я волна Тайного Санты — вы записывались после первой жеребьёвки.`;
    return `<div class="card w2-card"><h3>🌊 ${w.round}-я волна: подтвердите участие</h3><p>${why}</p>
      <p class="muted">Отправка подарков: <b>${FX.fmtDate(w.dates.start)} — ${FX.fmtDate(w.dates.end)}</b>. Без подтверждения в жеребьёвку этой волны вы не попадёте.</p>
      <div class="actions"><button class="btn btn-primary" data-w2-join="1">✅ Да, участвую</button><button class="btn btn-ghost" data-w2-join="0">🙅 Не буду</button></div></div>`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-w2-join]');
    if (!b) return;
    const join = b.dataset.w2Join === '1';
    if (join && me.nextWave && me.participation) { openWavePart(); return; }
    if (!join && !confirm('Точно отказаться от участия в этой волне?')) return;
    b.disabled = true;
    try {
      me = await Api.post('/api/wave2', { join });
      render();
      FX.toast(join ? 'Вы в новой волне! 🌊' : 'Отметили: в этой волне вас не будет', 'success');
      if (join) FX.burst(innerWidth / 2, innerHeight / 3, { count: 50 });
    } catch (ex) { FX.toast(ex.message, 'error'); b.disabled = false; }
  });

  const shipShown = new Set(); // в каких волнах участник раскрыл данные для отправки (до перезагрузки страницы)
  function renderGive() {
    const host = $('[data-give]');
    const a = me.assignment;
    if (!me.participation) {
      host.innerHTML = `<div class="sealed"><div class="env">✉️</div><p class="muted">Заполните анкету, чтобы участвовать в жеребьёвке.</p><button class="btn btn-primary" data-open-part>Заполнить анкету</button></div>`;
    } else if (!a && me.participation.moderation === 'pending') {
      host.innerHTML = `<div class="sealed"><div class="env">🕵️</div><p><b>Анкета на модерации</b></p><p class="muted">Перед жеребьёвкой организаторы проверяют всех участников. Как только анкету одобрят, вы попадёте в раздачу.</p></div>`;
    } else if (!a && me.participation.moderation === 'rejected') {
      host.innerHTML = `<div class="sealed"><div class="env">🚫</div><p><b>Анкета не прошла модерацию</b></p><p class="muted">${esc(me.participation.moderationNote) || 'Исправьте анкету или напишите организаторам.'}</p><button class="btn btn-primary" data-open-part>Исправить анкету</button></div>`;
    } else if (!a && me.drawing) {
      host.innerHTML = `<div class="sealed"><div class="env">🎲</div><p><b>Идёт жеребьёвка</b></p><p class="muted">Пары уже раскиданы — организаторы их проверяют. Как только подтвердят, здесь появятся пожелания и данные вашего получателя, а мы пришлём уведомление.</p></div>`;
    } else if (!a) {
      host.innerHTML = `<div class="sealed"><div class="env">🔒</div><p class="muted">Анкета одобрена ✅ Конверт запечатан. Как только организаторы перемешают участников, здесь появится имя, ПВЗ и пожелания вашего получателя.</p></div>`;
    } else {
      const list = me.assignments && me.assignments.length ? me.assignments : [a];
      host.innerHTML = `<div class="${revealedOnce ? '' : 'flip'}">${list.map((x) => giveBlock(x)).join('<hr class="wave-sep">')}</div>`;
      revealedOnce = true;
      $$('[data-ack]', host).forEach((ab) => ab.addEventListener('click', async () => {
        ab.disabled = true;
        try {
          me = await Api.post('/api/ack', { round: Number(ab.dataset.round) || undefined });
          render();
          FX.toast('Отлично! Собирайте посылку 🎁', 'success');
        } catch (ex) { FX.toast(ex.message, 'error'); ab.disabled = false; }
      }));
      $$('[data-sent]', host).forEach((sf) => sf.addEventListener('submit', (e) => {
        e.preventDefault();
        submit(sf, async () => {
          const file = sf.photo && sf.photo.files[0];
          const image = file ? await FX.compressImage(file) : null; // сначала проверяем картинку, потом отмечаем отправку
          me = await Api.post('/api/sent', { track: sf.track.value, round: Number(sf.dataset.round) || undefined });
          if (image) me = await Api.post('/api/track-photo', { round: Number(sf.dataset.round) || undefined, image });
          render();
          FX.burst(innerWidth / 2, innerHeight / 2, { count: 60, power: 15 });
          FX.toast('Хо-хо-хо! Получатель увидит, что подарок в пути 🎁', 'success');
        });
      }));
    }
    $$('[data-open-part]', host).forEach((b) => b.addEventListener('click', openPart));
    // фото к посылке: превью перед отправкой, загрузка/замена после
    $$('[data-sent] input[name=photo]', host).forEach((inp) => inp.addEventListener('change', async () => {
      const pv = $('[data-photo-preview]', inp.closest('form'));
      const nm = $('[data-photo-name]', inp.closest('form'));
      try { pv.src = await FX.compressImage(inp.files[0]); pv.hidden = false; nm.textContent = '📷 ' + inp.files[0].name + ' — заменить'; }
      catch (ex) { FX.toast(ex.message, 'error'); inp.value = ''; pv.hidden = true; nm.textContent = '📷 Выбрать картинку'; }
    }));
    $$('[data-photo-upload]', host).forEach((inp) => inp.addEventListener('change', async () => {
      if (!inp.files[0]) return;
      try {
        const image = await FX.compressImage(inp.files[0]);
        me = await Api.post('/api/track-photo', { round: Number(inp.dataset.round) || undefined, image });
        render();
        FX.toast('Фото прикреплено — получатель его увидит 📷', 'success');
      } catch (ex) { FX.toast(ex.message, 'error'); }
    }));
    FX.hydratePhotos(host);
    // «Уточнить у организатора»: короткий вопрос уходит организаторам вместе с данными пары
    $$('[data-ask-box]', host).forEach((box) => {
      const f = $('[data-ask-form]', box);
      $('[data-ask-open]', box).addEventListener('click', () => { f.hidden = false; $('[data-ask-open]', box).hidden = true; f.text.focus(); });
      $('[data-ask-cancel]', box).addEventListener('click', () => { f.hidden = true; $('[data-ask-open]', box).hidden = false; });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = f.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          await Api.post('/api/ask-organizer', { round: Number(box.dataset.round) || undefined, text: f.text.value });
          box.innerHTML = '<p class="muted ask-done">✅ Организатор получил ваш вопрос и ответит в Telegram' + (me.user.tgLinked ? ' (в бот)' : '') + '.</p>';
          FX.toast('Вопрос отправлен организатору 📨', 'success');
        } catch (ex) { FX.toast(ex.message, 'error'); btn.disabled = false; }
      });
    });
    // данные для отправки скрыты, как спойлер в Telegram: первое нажатие — показать, потом нажатие на строку — скопировать
    $$('[data-ship]', host).forEach((ship) => ship.addEventListener('click', (e) => {
      if (!ship.classList.contains('shown')) {
        ship.classList.add('shown');
        shipShown.add(ship.dataset.round);
        $('[data-ship-hint]', ship).textContent = 'нажмите на строку, чтобы скопировать';
        return;
      }
      const el = e.target.closest('[data-copy]');
      if (el && navigator.clipboard) navigator.clipboard.writeText(el.dataset.copy).then(() => FX.toast('Скопировано 📋'));
    }));
  }

  function giveBlock(a) {
    const r = a.recipient;
    const rn = a.round || 1;
    const shown = shipShown.has(String(rn));
    const statusTxt = { assigned: '⏳ ждёт отправки', sent: '🚚 отправлено', received: '✅ получено' }[a.status];
    return `<div class="give-block">
      <div class="wave-head">🌊 Волна ${rn}${a.dates ? ` · отправка до ${FX.fmtDate(a.dates.end)}` : ''}</div>
      <p style="margin-bottom:14px"><b>Вы — Тайный Санта</b> 🎅 <span class="status ${a.status}">${statusTxt}</span></p>
      ${a.priority && a.status === 'assigned' ? '<div class="big-notice warn" style="margin-bottom:14px">⭐ Получатель в приоритете: в прошлой волне он остался без подарка. Пожалуйста, отправьте посылку в первую очередь!</div>' : ''}
      <div class="wish-box">
        <div class="wish-head">🎁 Что хочет получить</div>
        <p class="wish-text">${esc(r.wishes) || '<span class="muted">Не написал(а) — сюрприз на ваш вкус!</span>'}</p>
        <div class="wish-meta"><span class="pill">${esc(PREFS[r.prefs] || '🎲 Удивите меня')}</span></div>
        ${r.notes ? `<div class="wish-note">⚠️ <b>Важно:</b> ${esc(r.notes)}</div>` : ''}
      </div>
      <div class="ship-box ${shown ? 'shown' : ''}" data-ship data-round="${rn}">
        <div class="ship-head">📦 Данные для отправки <small data-ship-hint>${shown ? 'нажмите на строку, чтобы скопировать' : 'скрыто — нажмите, чтобы показать'}</small></div>
        <dl class="kv ship-data">
          <dt>ПВЗ Ozon</dt><dd><span class="spoiler copy" data-copy="${esc(r.address)}">${esc(r.address)}</span></dd>
          <dt>Телефон</dt><dd><span class="spoiler copy" data-copy="${esc(r.phone)}">${esc(r.phone)}</span></dd>
          ${a.track ? `<dt>Трек</dt><dd>${esc(a.track)}</dd>` : ''}
        </dl>
      </div>
      ${chatBlock(a.messages, 'recipient', rn)}
      <div class="ask-box" data-ask-box data-round="${rn}">
        <button class="btn btn-ghost btn-sm btn-block" type="button" data-ask-open>❓ Не хватает данных для доставки? Уточнить у организатора</button>
        <form class="form" data-ask-form hidden>
          <label>Что уточнить?<textarea name="text" rows="2" placeholder="Например: не указан город ПВЗ / нужен другой пункт выдачи"></textarea></label>
          <div class="row2"><button class="btn btn-ghost btn-sm" type="button" data-ask-cancel>Отмена</button><button class="btn btn-primary btn-sm" type="submit">📨 Отправить организатору</button></div>
        </form>
      </div>
      ${a.status === 'assigned' && !a.ackAt ? `
      <div class="ack-box"><p><b>Подтвердите, что участвуете и собираете посылку</b> — так организаторы будут знать, что всё в порядке.</p>
        <button class="btn btn-primary btn-block" type="button" data-ack data-round="${rn}">✅ Участвую, собираю посылку</button></div>` : ''}
      ${a.status === 'assigned' && a.ackAt ? '<p class="muted" style="margin-top:12px">👍 Вы подтвердили, что собираете посылку.</p>' : ''}
      ${a.status === 'assigned' ? `
      <form class="form" data-sent data-round="${rn}" style="margin-top:16px">
        <label>Трек-номер (необязательно)<input name="track" placeholder="например, 0123456789-0001-1"></label>
        <label class="photo-pick">📷 Фото или QR-код (необязательно)<small>Например, QR-код для получения или фото чека — получатель увидит его в «Мой подарок»</small><span class="btn btn-ghost btn-sm photo-btn" data-photo-name>📷 Выбрать картинку</span><input type="file" name="photo" accept="image/*" hidden></label>
        <img class="photo-preview" data-photo-preview hidden alt="">
        <button class="btn btn-green btn-block" type="submit">📦 Я отправил подарок!</button>
        <div class="form-err" data-err></div>
      </form>` : `<p class="muted" style="margin-top:14px">Отправлено ${FX.fmtDateTime(a.sentAt)}. Спасибо, Санта! ${a.status === 'received' ? 'Подарок уже получен 💛' : ''}</p>
      ${a.status === 'sent' ? (() => { const done = a.pickupCode || (a.pickupPhotos || []).length || a.pickupTgCount; return `<div class="pickup-box">
        ${done ? `<p>📬 Получателю передано${a.pickupCode ? `: код <b>${esc(a.pickupCode)}</b>` : ''}${(a.pickupPhotos || []).length + (a.pickupTgCount || 0) ? ` · 📷 фото: ${(a.pickupPhotos || []).length + (a.pickupTgCount || 0)}` : ''}</p>${pickupThumbs(a.pickupPhotos)}` : '<p><b>📬 Заказ приехал в пункт выдачи?</b> Передайте получателю код и/или фото штрихкода / QR — он сразу узнает, что можно забирать.</p>'}
        <button class="btn ${done ? 'btn-ghost' : 'btn-primary'} btn-sm" type="button" data-pick-open>${done ? '✏️ Изменить / добавить фото' : '📬 Заказ приехал — передать код'}</button>
        ${pickForm(rn, a.pickupCode)}
      </div>`; })() : ''}
      <div class="photo-block">
        ${a.photoId ? `<div class="photo-label">📷 Прикреплённое фото</div><img class="photo-thumb" data-photo-id="${a.photoId}" alt="Фото к посылке">` : a.tgPhoto ? '<p class="muted">📷 Фото из Telegram загружается — обновите страницу через минуту 🔄</p>' : ''}
        <label class="btn btn-ghost btn-sm photo-btn">📷 ${a.photoId ? 'Заменить фото' : 'Прикрепить фото или QR-код'}<input type="file" accept="image/*" data-photo-upload data-round="${rn}" hidden></label>
      </div>`}
    </div>`;
  }

  // Анонимная переписка: to = 'recipient' (я Санта) или 'santa' (я получатель)
  function chatBlock(messages, to, round) {
    const mine = to === 'recipient' ? 'santa' : 'recipient';
    const list = messages || [];
    return `<div class="chat-box" data-chat="${to}:${round}">
      <div class="chat-head">💬 ${to === 'recipient' ? 'Переписка с получателем' : 'Переписка с вашим Сантой'} <small>анонимно — никто не видит, кто вы</small></div>
      ${list.length ? `<div class="chat-list">${list.map((m) => `<div class="chat-msg ${m.from === mine ? 'mine' : ''}"><span>${esc(m.text)}</span><time>${FX.fmtDateTime(m.at)}</time></div>`).join('')}</div>`
        : `<p class="muted chat-empty">${to === 'recipient' ? 'Не хватает деталей? Спросите получателя, что он хочет, — он не узнает, кто вы.' : 'Можно написать своему Санте — например, поблагодарить или подсказать что-то о подарке.'}</p>`}
      <form class="chat-form" data-chat-form data-to="${to}" data-round="${round}">
        <textarea name="text" rows="1" maxlength="1000" placeholder="${to === 'recipient' ? 'Написать получателю…' : 'Написать Санте…'}"></textarea>
        <button class="btn btn-primary btn-sm" type="submit">Отправить</button>
      </form>
    </div>`;
  }
  // отправка сообщения (делегирование: блоки перерисовываются)
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-chat-form]');
    if (!f) return;
    e.preventDefault();
    const text = f.text.value.trim();
    if (!text) return;
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      me = await Api.post('/api/msg', { to: f.dataset.to, round: Number(f.dataset.round) || undefined, text });
      render();
      FX.toast('Отправлено анонимно 💬', 'success');
      const box = document.querySelector(`[data-chat="${f.dataset.to}:${f.dataset.round}"] .chat-list`);
      if (box) box.scrollTop = box.scrollHeight;
    } catch (ex) { FX.toast(ex.message, 'error'); btn.disabled = false; }
  });
  // «↩️ Ответить» из уведомления — к нужной переписке
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-reply-to]');
    if (!b) return;
    const box = document.querySelector(`[data-chat="${b.dataset.replyTo}:${b.dataset.round}"]`);
    if (!box) return FX.toast('Переписка недоступна', 'error');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => box.querySelector('textarea').focus(), 400);
  });
  // «📬 Подарок приехал»: код получения от Санты или организатора
  const pickupThumbs = (ids) => (ids && ids.length ? `<div class="pickup-photos">${ids.map((id) => `<img class="pickup-thumb" data-photo-id="${id}" alt="Штрихкод / QR — нажмите, чтобы увеличить">`).join('')}</div>` : '');
  function pickupBlock(g) {
    const ph = g.pickupPhotos || [];
    if (!g.pickupCode && !ph.length && !g.pickupTgCount) return '';
    return `<div class="pickup-ready"><div class="pickup-title">📬 Подарок приехал в пункт выдачи — можно забирать!</div>
      ${g.pickupCode ? `<div class="pickup-code" data-copy-code="${esc(g.pickupCode)}" title="Нажмите, чтобы скопировать">${esc(g.pickupCode)}</div><small>код получения · нажмите, чтобы скопировать</small>` : ''}
      ${ph.length ? `${pickupThumbs(ph)}<small>📷 штрихкод / QR · нажмите на фото, чтобы открыть на весь экран и показать в пункте выдачи</small>` : ''}
      ${g.pickupTgCount ? `<small>📷 ${ph.length ? 'Ещё фото' : 'Фото штрихкода / QR'} (${g.pickupTgCount}) — загружаются из Telegram, обновите страницу через минуту 🔄</small>` : ''}
    </div>`;
  }
  document.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy-code]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copyCode); FX.toast('Код скопирован 📋', 'success'); } catch (_) { /* нет доступа к буферу */ } return; }
    const o = e.target.closest('[data-pick-open]');
    if (o) { const f = o.parentElement.querySelector('[data-pick-form]'); f.hidden = false; o.hidden = true; f.code.focus(); }
  });
  // форма «Заказ приехал»: код и/или фото штрихкода / QR (несколько)
  function pickForm(rn, code) {
    return `<form class="pickup-form" data-pick-form data-round="${rn}" hidden>
      <input name="code" maxlength="100" placeholder="Код получения (если есть)" autocomplete="off" value="${esc(code || '')}">
      <label class="btn btn-ghost btn-sm photo-btn">📷 Фото штрихкода / QR<input type="file" accept="image/*" multiple data-pick-files hidden></label>
      <div class="pickup-photos" data-pick-preview></div>
      <button class="btn btn-primary btn-sm" type="submit">📬 Отправить получателю</button>
    </form>`;
  }
  const pickImages = new WeakMap(); // форма → сжатые картинки
  document.addEventListener('change', async (e) => {
    const inp = e.target.closest('[data-pick-files]');
    if (!inp) return;
    const f = inp.closest('form');
    const list = pickImages.get(f) || [];
    for (const file of [...inp.files].slice(0, 10 - list.length)) {
      try { list.push(await FX.compressImage(file)); } catch (ex) { FX.toast(ex.message, 'error'); }
    }
    pickImages.set(f, list);
    inp.value = '';
    f.querySelector('[data-pick-preview]').innerHTML = list.map((src, i) => `<span class="pick-prev"><img class="pickup-thumb" src="${src}" alt=""><button type="button" data-pick-rm="${i}" aria-label="Убрать">✕</button></span>`).join('');
  });
  document.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-pick-rm]');
    if (!rm) return;
    const f = rm.closest('form');
    const list = pickImages.get(f) || [];
    list.splice(Number(rm.dataset.pickRm), 1);
    rm.parentElement.remove();
    f.querySelectorAll('[data-pick-rm]').forEach((b, i) => { b.dataset.pickRm = i; });
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-pick-form]');
    if (!f) return;
    e.preventDefault();
    const imgs = pickImages.get(f) || [];
    if (!f.code.value.trim() && !imgs.length) return FX.toast('Напишите код или прикрепите фото штрихкода / QR', 'error');
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const photoIds = [];
      for (const [i, image] of imgs.entries()) { btn.textContent = `Загружаю фото ${i + 1}/${imgs.length}…`; photoIds.push((await Api.post('/api/upload-photo', { image })).photoId); }
      me = await Api.post('/api/pickup', { round: Number(f.dataset.round) || undefined, code: f.code.value, photoIds });
      render();
      FX.toast('Получатель узнал, что можно забирать 📬', 'success');
    } catch (ex) { FX.toast(ex.message, 'error'); btn.disabled = false; btn.textContent = '📬 Отправить получателю'; }
  });
  function giftPhoto(g) {
    return pickupBlock(g) + (g.photoId ? `<div class="photo-block center"><div class="photo-label">📷 Санта прикрепил фото (нажмите, чтобы увеличить)</div><img class="photo-thumb" data-photo-id="${g.photoId}" alt="Фото от Санты"></div>`
      : g.tgPhoto ? '<p class="muted" style="text-align:center">📷 Санта прислал фото в Telegram — оно загружается, обновите страницу через минуту 🔄</p>' : '');
  }
  function renderGift() {
    const host = $('[data-gift]');
    setTimeout(() => FX.hydratePhotos(host), 0);
    const list = (me.incomings || []).filter((x) => !x.failed);
    if (list.length > 1) {
      // повторный участник: подарки из нескольких волн
      host.innerHTML = list.map((g) => `<div class="gift-row">
        <div class="wave-head">🌊 ${g.round}-я волна</div>
        ${g.status === 'assigned' ? '<p>🛷 Ваш Тайный Санта собирает посылку.</p>'
          : g.status === 'sent' ? `<p>🎁 <b>Подарок уже в пути!</b> Отправлен ${FX.fmtDateTime(g.sentAt)}${g.track ? `, трек: <b>${esc(g.track)}</b>` : ''}</p>${giftPhoto(g)}<button class="btn btn-primary btn-block" data-received data-round="${g.round}">🎉 Я получил подарок!</button>`
          : `<p>🥳 Подарок получен ${FX.fmtDateTime(g.receivedAt)}.</p>`}
        ${chatBlock(g.messages, 'santa', g.round)}
      </div>`).join('<hr class="wave-sep">');
      $$('[data-received]', host).forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          me = await Api.post('/api/received', { round: Number(b.dataset.round) });
          render();
          FX.burst(innerWidth / 2, innerHeight / 2, { count: 70, power: 16, emojiRatio: 0.25 });
        } catch (ex) { FX.toast(ex.message, 'error'); b.disabled = false; }
      }));
      return;
    }
    const g = list.length ? list[0] : me.incoming;
    if (!g) {
      host.innerHTML = `<div class="sealed"><div class="env">🎄</div><p class="muted">${me.drawn ? 'Ваш Санта уже знает о вас. Ждём!' : 'После жеребьёвки кто-то станет вашим Тайным Сантой.'}</p></div>`;
    } else if (g.failed) {
      const w = me.wave2 || {};
      const rescue = w.reason === 'victim' && (w.round > g.round || (w.status === 'waiting' && me.settings.round2Open));
      const detail = !rescue ? 'Если нужна помощь, напишите организаторам.'
        : w.status === 'confirmed' ? `Вы в ${w.round}-й волне ⭐ — там вам отправят подарок в первую очередь.`
        : w.status === 'declined' ? 'Вы отказались от следующей волны. Если передумали — напишите организаторам.'
        : w.status === 'waiting' ? 'Мы записали вас в следующую волну с приоритетом ⭐ — когда она откроется, придёт приглашение.'
        : 'Мы пригласили вас в следующую волну — подтвердите участие выше, и вам отправят подарок в первую очередь ⭐';
      host.innerHTML = `<div class="sealed"><div class="env">😢</div><p><b>Ваш Санта не отправил подарок</b></p><p class="muted">${detail}</p></div>`;
    } else if (g.status === 'assigned') {
      host.innerHTML = `<div class="sealed"><div class="env">🛷</div><p>Ваш Тайный Санта собирает посылку.</p><p class="muted">Как только он отметит отправку — вы увидите это здесь.</p></div>`
        + chatBlock(g.messages, 'santa', g.round || 1);
    } else if (g.status === 'sent') {
      host.innerHTML = `<div class="gift-big">🎁</div>
        <h3 style="justify-content:center;text-align:center;font-size:22px">Вам подарок от Деда Мороза!</h3>
        <p class="muted" style="text-align:center">Отправлен ${FX.fmtDateTime(g.sentAt)}${g.track ? `<br>Трек: <b>${esc(g.track)}</b>` : ''}</p>
        ${giftPhoto(g)}
        ${chatBlock(g.messages, 'santa', g.round || 1)}
        <button class="btn btn-primary btn-block" data-received>🎉 Я получил подарок!</button>`;
      $('[data-received]', host).addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          me = await Api.post('/api/received', { round: g.round || undefined });
          render();
          FX.burst(innerWidth / 2, innerHeight / 2, { count: 70, power: 16, emojiRatio: 0.25 });
        } catch (ex) { FX.toast(ex.message, 'error'); e.target.disabled = false; }
      });
      if (!sessionStorage.getItem('giftBurst')) {
        sessionStorage.setItem('giftBurst', '1');
        setTimeout(() => FX.burstFrom(host, { count: 50 }), 400);
      }
    } else {
      host.innerHTML = `<div class="gift-big" style="animation:none">🥳</div><p style="text-align:center">Подарок получен ${FX.fmtDateTime(g.receivedAt)}. С наступающим!</p>`
        + chatBlock(g.messages, 'santa', g.round || 1);
    }
  }

  function renderPart() {
    const host = $('[data-part]');
    const p = me.participation;
    if (!p) {
      host.innerHTML = `<p class="muted">Анкета не заполнена.</p>${me.user.banned ? '' : '<button class="btn btn-primary" data-open-part>🎅 Участвовать</button>'}`;
    } else {
      const MOD = { pending: '<span class="status assigned">⏳ на модерации</span>', approved: '<span class="status received">✅ одобрена</span>', rejected: '<span class="status banned">🚫 отклонена</span>' };
      const forms = me.ownAnketas && me.ownAnketas.length ? me.ownAnketas : [{ ...p, round: null }];
      host.innerHTML = `<p>${MOD[p.moderation] || ''} ${p.moderation === 'rejected' && p.moderationNote ? `<small class="important">${esc(p.moderationNote)}</small>` : ''}</p>
      ${forms.map((a) => `<section class="give-block">
        <h4 class="wave-head">${a.round > 0 ? `🌊 Волна ${a.round}` : 'Основная анкета'}</h4>
        ${a.round > 0 && a.usesBase ? '<p class="muted">Для этой волны используется основная анкета.</p>' : ''}
        <dl class="kv">
        <dt>ФИО</dt><dd>${esc(a.fullName) || '<span class="important">не указано — заполните!</span>'}</dd>
        <dt>Телефон</dt><dd>${esc(me.user.phone)}</dd>
        <dt>ПВЗ Ozon</dt><dd>${esc(a.address)}</dd>
        <dt>Тематика</dt><dd>${esc(PREFS[a.prefs])}</dd>
        <dt>Пожелания</dt><dd>${esc(a.wishes) || '—'}</dd>
        <dt>Пометки</dt><dd>${esc(a.notes) || '—'}</dd>
      </dl>
      </section>`).join('')}
      <div class="actions">
        <button class="btn btn-ghost btn-sm" data-open-part>✏️ Изменить основную анкету</button>
        <button class="btn btn-ghost btn-sm" data-add-wish>➕ Дополнить пожелания</button>
        ${me.drawn ? '' : '<button class="btn btn-danger btn-sm" data-leave>Выйти из игры</button>'}
      </div>
      <form class="form add-wish" data-add-wish-form hidden>
        <label>Что добавить к пожеланиям?<small>Дополнение появится в анкетах всех ваших волн.</small><textarea name="text" rows="2" maxlength="500" placeholder="Например: люблю светлую обжарку, кружку не нужно"></textarea></label>
        <div class="row2"><button class="btn btn-ghost btn-sm" type="button" data-add-wish-cancel>Отмена</button><button class="btn btn-primary btn-sm" type="submit">➕ Добавить</button></div>
      </form>`;
      const aw = $('[data-add-wish-form]', host);
      $('[data-add-wish]', host).addEventListener('click', () => { aw.hidden = false; aw.text.focus(); });
      $('[data-add-wish-cancel]', host).addEventListener('click', () => { aw.hidden = true; });
      aw.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!aw.text.value.trim()) return;
        try { me = await Api.post('/api/wishes-add', { text: aw.text.value }); render(); FX.toast('Добавлено — Санта уже в курсе ➕', 'success'); }
        catch (ex) { FX.toast(ex.message, 'error'); }
      });
      const l = $('[data-leave]', host);
      if (l) l.addEventListener('click', async () => {
        if (!confirm('Точно выйти из Тайного Санты?')) return;
        try { me = await Api.post('/api/leave'); render(); } catch (e) { FX.toast(e.message, 'error'); }
      });
    }
    $$('[data-open-part]', host).forEach((b) => b.addEventListener('click', openPart));
  }

  // кнопки из рассылки организаторов
  function notifButtons(list) {
    if (!list || !list.length) return '';
    const HREF = { whom: '#give', sent: '#give', received: '#gift', track: '#gift', site: './', profile: '#profile', rules: './#rules',
      raffle: 'https://t.me/coffeemaniacs_bot?start=raffle', help: tgLink?.helpUrl || 'https://t.me/coffeemaniacs_bot?start=help' };
    const actions = ['chat', 'chatSanta', 'chatRecipient', 'wishes', 'wave', 'form'];
    return `<div class="notif-btns">${list.map((b) => b.url
      ? `<a class="btn btn-ghost btn-sm" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.text)}</a>`
      : actions.includes(b.kind) ? `<button class="btn btn-ghost btn-sm" type="button" data-notif-action="${b.kind}">${esc(b.text)}</button>`
      : Object.hasOwn(HREF, b.kind) ? `<a class="btn btn-ghost btn-sm" href="${esc(HREF[b.kind])}">${esc(b.text)}</a>` : '').join('')}</div>`;
  }
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-notif-action]')?.dataset.notifAction;
    if (!action) return;
    if (action === 'form') return openPart();
    if (action === 'wave') return me.nextWave ? openWavePart() : FX.toast('Запись в следующие волны сейчас закрыта', 'error');
    if (action === 'wishes') {
      const button = $('[data-add-wish]');
      return button ? button.click() : openPart();
    }
    const selector = action === 'chatSanta' ? '[data-chat^="santa:"]'
      : action === 'chatRecipient' ? '[data-chat^="recipient:"]' : '[data-chat]';
    const threads = $$(selector);
    if (!threads.length) return FX.toast('Сейчас нет доступной переписки', 'error');
    threads[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (threads.length === 1) threads[0].querySelector('textarea')?.focus({ preventScroll: true });
  });
  function renderNotifs() {
    const list = me.notifications;
    $('[data-notifs]').innerHTML = list.length
      ? list.map((n) => `<li class="${n.read ? '' : 'unread'} ${n.kind}">${esc(n.text)}${n.msg ? `<div class="notif-btns"><button class="btn btn-primary btn-sm" type="button" data-reply-to="${n.msg.reply === 'santa' ? 'santa' : 'recipient'}" data-round="${n.msg.round}">↩️ Ответить</button></div>` : n.action === 'raffle-start' ? '<div class="notif-btns"><a class="btn btn-ghost btn-sm" href="https://t.me/coffeemaniacs_bot?start=raffle" target="_blank" rel="noopener">🎁 Участвовать в розыгрыше</a></div>'
        : notifButtons(n.buttons)}<time>${FX.fmtDateTime(n.createdAt)}</time></li>`).join('')
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
    const helpLinks = $$('[data-notifs] a[href="https://t.me/coffeemaniacs_bot?start=help"]');
    if (tgLink.helpUrl) helpLinks.forEach((link) => { link.href = tgLink.helpUrl; });
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
