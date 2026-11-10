(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // reveal on scroll
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  $$('.reveal').forEach((el, i) => { el.style.transitionDelay = (i % 4) * 80 + 'ms'; io.observe(el); });

  FX.santas($('[data-santas]'), { maxTop: 45, every: 5200 });
  FX.santas($('[data-santas-join]'), { maxTop: 70, every: 2600 });

  // falling coffee beans in join section
  const beans = $('.beans');
  for (let i = 0; i < 18; i++) {
    const b = document.createElement('i');
    b.style.cssText = `left:${Math.random() * 100}%;--d:${8 + Math.random() * 10}s;--delay:-${Math.random() * 15}s;--s:${0.6 + Math.random() * 0.9}`;
    beans.appendChild(b);
  }

  // ---------- день → ночь: по мере прокрутки темнеет и начинается снег ----------
  const nightSnow = document.createElement('canvas');
  nightSnow.className = 'night-snow';
  document.body.appendChild(nightSnow);
  FX.snow(nightSnow, { density: 7000, dpr: 1, max: 160 });
  const stars = $('[data-stars]');
  for (let i = 0; i < 40; i++) {
    const st = document.createElement('i');
    st.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 100}%;--t:${2 + Math.random() * 3}s;opacity:${0.4 + Math.random() * 0.6}`;
    stars.appendChild(st);
  }
  const dusk = $('.dusk');
  function onScroll() {
    const r = dusk.getBoundingClientRect();
    // 0 — dusk ещё внизу экрана, 1 — dusk прокручен и началась ночь
    const t = Math.min(1, Math.max(0, (innerHeight * 0.6 - r.top) / (r.height * 0.8)));
    nightSnow.style.opacity = t.toFixed(3);
    document.body.classList.toggle('night', t > 0.65);
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  onScroll();

  let me = null;
  let lastCount = null;
  let cdTimers = [];

  async function loadPublic() {
    try {
      const p = await Api.get('/api/public');
      $$('[data-count]').forEach((el) => FX.animateNumber(el, p.count));
      $('[data-count-hint]').textContent = p.count ? 'присоединяйтесь!' : 'станьте первым!';
      if (lastCount !== null && p.count > lastCount) {
        const el = $('.big-count');
        el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
        FX.burstFrom(el, { count: 25, power: 8 });
        FX.toast('☕ +' + (p.count - lastCount) + ' в игре!');
      }
      lastCount = p.count;
      const names = p.recent.length ? p.recent : ['тут', 'будут', 'ваши', 'имена'];
      const html = names.map((n) => `<span>☕ ${FX.esc(n)}</span>`).join('');
      $('[data-recent]').innerHTML = html + html;
      applySettings(p.settings, p);
    } catch (e) { /* offline */ }
  }

  let settingsKey = '';
  function applySettings(s, p) {
    const key = JSON.stringify(s) + p.drawn;
    if (key === settingsKey) return;
    settingsKey = key;
    cdTimers.forEach(clearInterval);
    cdTimers = [FX.countdown($('[data-cd1]'), s.sendStart), FX.countdown($('[data-cd2]'), s.sendEnd)];
    $('[data-cd1-label]').textContent = 'До начала отправки подарков · ' + FX.fmtDate(s.sendStart);
    $('[data-cd2-label]').textContent = 'До конца отправки · ' + FX.fmtDate(s.sendEnd);
    $('[data-dates]').textContent = `Отправка подарков — с ${FX.fmtDate(s.sendStart)} по ${FX.fmtDate(s.sendEnd)}. Не успели — организаторы узнают.`;
    if (s.budgetMin || s.budgetMax) {
      const b = s.budgetMin && s.budgetMax ? `от ${s.budgetMin} до ${s.budgetMax} ₽` : s.budgetMin ? `от ${s.budgetMin} ₽` : `до ${s.budgetMax} ₽`;
      $('[data-budget]').innerHTML = `Сумма подарка: <b>${b}</b>. Главное — внимание и хороший кофе.`;
    }
    if (s.chatUrl) $$('[data-chat-link]').forEach((a) => (a.href = s.chatUrl));
    const round2 = p.drawn && !p.drawn2 && s.round2Open && s.regOpen;
    const closed = !s.regOpen || (p.drawn && !round2);
    if (round2 && !(me && me.participation)) {
      $('[data-join-label]').innerHTML = 'Записаться<br>во 2-й круг';
      $('.join-sub').innerHTML = `Первая жеребьёвка уже прошла — но ещё не поздно! Записывайтесь во <b>второй круг</b>: отправка подарков с ${FX.fmtDate(s.round2SendStart)} по ${FX.fmtDate(s.round2SendEnd)}.`;
      $('[data-join-note]').textContent = 'Участники второго круга дарят подарки друг другу — отдельная жеребьёвка.';
    } else if (closed && !(me && me.participation)) {
      $('[data-join-label]').innerHTML = p.drawn ? 'Жеребьёвка<br>проведена' : 'Регистрация<br>закрыта';
      $('[data-join-note]').textContent = p.drawn ? 'Пары сформированы! Участники — загляните в личный кабинет.' : 'Регистрация временно закрыта. Следите за чатом.';
    }
  }

  // ---------- modal ----------
  const modal = $('[data-modal]');
  const f1 = $('form[data-step="1"]', modal);
  const f2 = $('form[data-step="2"]', modal);
  const done = $('[data-step="3"]', modal);
  let authMode = 'register';

  function showStep(n) {
    [f1, f2, done].forEach((el, i) => (el.hidden = i + 1 !== n));
    $$('[data-dot]', modal).forEach((d) => d.classList.toggle('on', Number(d.dataset.dot) <= n));
    $('.stepper', modal).hidden = n === 3;
    const first = [f1, f2, done][n - 1].querySelector('input, textarea, a');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function openModal() {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('open'));
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    if (me) {
      $('#mTitle').textContent = me.participation ? 'Обновить анкету' : 'Анкета Тайного Санты';
      fillStep2(me.participation);
      showStep(2);
    } else showStep(1);
  }
  function closeModal() {
    modal.classList.remove('open');
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    setTimeout(() => (modal.hidden = true), 250);
  }
  function fillStep2(p) {
    if (me && me.user) {
      f2.phone.value = me.user.phone || '';
      if (!f2.fullName.value) f2.fullName.value = (p && p.fullName) || '';
    }
    if (!p) return;
    f2.fullName.value = p.fullName || f2.fullName.value;
    f2.address.value = p.address || '';
    f2.wishes.value = p.wishes || '';
    f2.notes.value = p.notes || '';
    const r = f2.querySelector(`input[name=prefs][value="${p.prefs}"]`);
    if (r) r.checked = true;
    f2.agree.checked = true;
  }
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
  $$('[data-auth]', modal).forEach((b) => b.addEventListener('click', () => {
    authMode = b.dataset.auth;
    $$('[data-auth]', modal).forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-auth-pane]', modal).forEach((p) => (p.hidden = p.dataset.authPane !== authMode));
  }));
  $('[data-back]', modal).addEventListener('click', () => { if (!me) showStep(1); else closeModal(); });

  function busy(form, on) {
    const b = form.querySelector('[type=submit]');
    b.disabled = on;
    b.classList.toggle('loading', on);
  }
  function err(form, msg) {
    const el = form.querySelector('[data-err]');
    el.textContent = msg || '';
    if (msg) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
  }

  f1.addEventListener('submit', async (e) => {
    e.preventDefault();
    err(f1);
    busy(f1, true);
    try {
      const r = authMode === 'register'
        ? await Api.post('/api/register', { name: f1.name.value, phone: f1.phone.value, tg: f1.tg.value, password: f1.password.value, pdConsent: f1.pdConsent.checked })
        : await Api.post('/api/login', { login: f1.login.value, password: f1.lpassword.value });
      Api.setToken(r.token);
      me = await Api.get('/api/me');
      fillStep2(me.participation);
      showStep(2);
    } catch (ex) { err(f1, ex.message); }
    busy(f1, false);
  });

  f2.addEventListener('submit', async (e) => {
    e.preventDefault();
    err(f2);
    if (!(await FX.checkCity(f2.address.value))) { f2.address.focus(); return; }
    busy(f2, true);
    try {
      const wasIn = me && me.participation;
      me = await Api.post('/api/participate', {
        fullName: f2.fullName.value, phone: f2.phone.value,
        address: f2.address.value, wishes: f2.wishes.value, notes: f2.notes.value,
        prefs: (f2.querySelector('input[name=prefs]:checked') || {}).value, agree: f2.agree.checked,
      });
      showStep(3);
      if (wasIn) $('h3', done).textContent = 'Анкета обновлена!';
      FX.burst(innerWidth / 2, innerHeight / 2, { count: 60, power: 15 });
      loadPublic();
      FX.chrome();
    } catch (ex) {
      if (ex.status === 401) {
        // сессия от старой базы — просим войти/зарегистрироваться заново
        Api.logout();
        me = null;
        busy(f2, false);
        showStep(1);
        err(f1, 'Аккаунт не найден — зарегистрируйтесь заново (анкету мы сохраним, когда войдёте)');
        return;
      }
      err(f2, ex.message);
    }
    busy(f2, false);
  });

  // ---------- the mega button ----------
  const megaBtn = $('[data-join-btn]');
  megaBtn.addEventListener('click', () => {
    if (megaBtn.classList.contains('pouring')) return;
    megaBtn.classList.add('pouring');
    document.body.classList.add('flash');
    FX.burstFrom(megaBtn, { count: 60, power: 16, emojiRatio: 0.2 });
    setTimeout(() => document.body.classList.remove('flash'), 400);
    setTimeout(() => { megaBtn.classList.remove('pouring'); openModal(); }, FX.reduced ? 0 : 550);
  });

  // ---------- init ----------
  (async () => {
    me = await FX.chrome();
    if (me && me.participation) {
      $('[data-join-label]').innerHTML = 'Вы уже<br>в игре ✓';
      $('[data-join-note]').textContent = 'Нажмите, чтобы обновить анкету, или загляните в личный кабинет.';
    }
    await loadPublic();
    setInterval(loadPublic, 15000);
    if (location.hash === '#join' && new URLSearchParams(location.search).has('open')) openModal();
  })();
})();
