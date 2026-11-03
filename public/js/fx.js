/* Визуальные эффекты и общие штуки для всех страниц: снег, салюты, летающие Санты, тосты, шапка. */
(function () {
  'use strict';
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- snow ----------
  function snow(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    let w, h, flakes = [], dpr = opts.dpr || Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((w * h) / (opts.density || 9000));
      flakes = Array.from({ length: Math.min(n, opts.max || 260) }, () => mk(true));
    }
    function mk(any) {
      const r = Math.random() * 2.6 + 0.6;
      return { x: Math.random() * w, y: any ? Math.random() * h : -10, r, s: r * 0.35 + 0.2, d: Math.random() * Math.PI * 2, o: Math.random() * 0.6 + 0.3 };
    }
    let wind = 0, t = 0;
    function frame() {
      requestAnimationFrame(frame);
      if (document.hidden || document.body.classList.contains('modal-open')) return;
      t += 0.01;
      wind = Math.sin(t * 0.7) * 0.6;
      ctx.clearRect(0, 0, w, h);
      for (const f of flakes) {
        f.y += f.s; f.d += 0.02; f.x += Math.sin(f.d) * 0.4 + wind * f.r * 0.25;
        if (f.y > h + 5) Object.assign(f, mk(false));
        if (f.x > w + 5) f.x = -5; else if (f.x < -5) f.x = w + 5;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${opts.rgb || '255,255,255'},${f.o})`; ctx.fill();
      }
    }
    resize();
    window.addEventListener('resize', resize);
    if (!reduced) frame();
  }

  // ---------- particle burst (canvas overlay) ----------
  let burstCanvas, bctx, parts = [], running = false;
  function ensureBurst() {
    if (burstCanvas) return;
    burstCanvas = document.createElement('canvas');
    burstCanvas.className = 'fx-burst';
    document.body.appendChild(burstCanvas);
    bctx = burstCanvas.getContext('2d');
    const rs = () => { burstCanvas.width = innerWidth; burstCanvas.height = innerHeight; };
    rs(); window.addEventListener('resize', rs);
  }
  // Эмодзи рисуем один раз в маленькие картинки — fillText с эмодзи каждый кадр очень тормозит.
  const EMOJI = ['🎁', '☕', '❄️', '⭐'];
  const COLORS = ['#e63946', '#ffd166', '#ffffff', '#60a5fa', '#22c55e', '#ff7a00'];
  const sprites = {};
  function sprite(e) {
    if (!sprites[e]) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d');
      x.font = '48px serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(e, 32, 36);
      sprites[e] = c;
    }
    return sprites[e];
  }
  const MAX_PARTS = 140;
  // заранее готовим холст и картинки эмодзи, чтобы первое нажатие не подлагивало
  const warm = () => { ensureBurst(); EMOJI.forEach(sprite); };
  if (!reduced) (window.requestIdleCallback || ((f) => setTimeout(f, 800)))(warm);
  function burst(x, y, opts) {
    if (reduced) return;
    opts = opts || {};
    ensureBurst();
    const n = Math.min(opts.count || 50, 70, MAX_PARTS - parts.length);
    const ratio = Math.min(opts.emojiRatio == null ? 0.15 : opts.emojiRatio, 0.3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = Math.random() * (opts.power || 14) + 6;
      const emoji = Math.random() < ratio;
      parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3, g: 0.35,
        life: 1, decay: 0.022 + Math.random() * 0.018, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        size: emoji ? 26 + Math.random() * 12 : 6 + Math.random() * 6,
        img: emoji ? sprite(EMOJI[(Math.random() * EMOJI.length) | 0]) : null,
        color: COLORS[(Math.random() * COLORS.length) | 0],
      });
    }
    if (!running) { running = true; requestAnimationFrame(tick); }
  }
  function tick() {
    bctx.clearRect(0, 0, burstCanvas.width, burstCanvas.height);
    parts = parts.filter((p) => p.life > 0 && p.y < innerHeight + 40);
    for (const p of parts) {
      p.vy += p.g; p.vx *= 0.97; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= p.decay;
      bctx.globalAlpha = Math.max(0, p.life);
      if (p.img) {
        bctx.drawImage(p.img, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else {
        bctx.save(); bctx.translate(p.x, p.y); bctx.rotate(p.rot);
        bctx.fillStyle = p.color; bctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        bctx.restore();
      }
    }
    bctx.globalAlpha = 1;
    if (parts.length) requestAnimationFrame(tick);
    else { running = false; bctx.clearRect(0, 0, burstCanvas.width, burstCanvas.height); }
  }
  function burstFrom(el, opts) {
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, opts);
  }

  // ---------- flying santas ----------
  const DEER = (x) => `<g transform="translate(${x},0)" class="deer">
      <path class="leg" d="M9 41 l-7 11 M14 42 l-2 13 M27 42 l5 12 M31 40 l9 9"/>
      <ellipse cx="20" cy="37" rx="15" ry="7"/>
      <path class="leg" d="M31 33 l8 -11"/>
      <ellipse cx="42" cy="20" rx="6.5" ry="4" transform="rotate(-15 42 20)"/>
      <path class="ant" d="M39 17 l-4 -10 M37 11 l-6 -2 M43 16 l1 -10 M44 10 l5 -4"/>
      <circle cx="48" cy="19" r="2" fill="#e63946"/>
    </g>`;
  const SANTA = `<circle cx="30" cy="22" r="10" fill="#e63946"/>
      <circle cx="34" cy="13" r="5.5" fill="#f5d0b0"/>
      <path d="M29 15 q5 9 11 0 z" fill="#fff"/>
      <path d="M28 10 L37 1 L41 10 Z" fill="#e63946"/>
      <circle cx="37" cy="1.5" r="2.4" fill="#fff"/>`;
  // Зверёк Specialty Кофеёк в шапке Деда Мороза
  const CIVET = `<circle cx="30" cy="27" r="9" fill="#6b6259"/>
      <image href="img/civet-head.png" x="23" y="5" width="18" height="18"/>
      <path d="M24 8 L33 -3 L41 7 Z" fill="#e63946"/>
      <rect x="22.5" y="5.5" width="20" height="4" rx="2" fill="#fff"/>
      <circle cx="33" cy="-3" r="2.3" fill="#fff"/>`;
  const sleighSvg = (rider) => `<svg viewBox="-4 -4 190 66" width="190" height="66" aria-hidden="true">
      <path class="rein" d="M62 36 Q 90 30 112 30 Q 130 28 150 22"/>
      <path class="runner" d="M0 56 H60 q10 0 10 -9"/>
      <path class="leg" d="M14 52 v4 M50 52 v4"/>
      ${rider}
      <path class="sleigh" d="M6 50 L4 28 Q4 23 10 25 L36 33 Q58 28 64 38 L60 50 Z"/>
      <path d="M6 30 h20" stroke="#ffd166" stroke-width="2"/>
      ${DEER(70)}${DEER(118)}
    </svg>`;
  let sleighN = 0;

  function santas(container, opts) {
    opts = opts || {};
    if (reduced) return;
    const spawn = () => {
      if (document.hidden || document.body.classList.contains('modal-open')) return;
      const el = document.createElement('div');
      el.className = 'flying-santa';
      const rtl = Math.random() < 0.5;
      sleighN++;
      // раз в 10 саней едет зверёк Specialty Кофеёк — по клику открывается канал
      const civet = sleighN % 10 === 0;
      el.innerHTML = civet
        ? '<a class="fs-inner fs-link" href="https://t.me/speccof" target="_blank" rel="noopener" title="Specialty Кофеёк">' + sleighSvg(CIVET) + '</a>'
        : '<span class="fs-inner">' + sleighSvg(SANTA) + '</span>';
      const top = 5 + Math.random() * (opts.maxTop || 55);
      const dur = 9 + Math.random() * 8;
      const scale = 0.7 + Math.random() * 0.9;
      el.style.cssText = `top:${top}%;--dur:${dur}s;--scale:${scale};`;
      if (rtl) el.classList.add('rtl');
      if (civet) setupCivet(el, top);
      container.appendChild(el);
      // убираем, когда долетели (а не по таймеру — сани со зверьком могут остановиться)
      el.addEventListener('animationend', (e) => { if (e.target === el) el.remove(); });
    };
    spawn();
    setInterval(spawn, opts.every || 4500);
  }

  // Клик по зверьку: олени тормозят, всплывает окошко с приглашением в канал.
  function setupCivet(el, top) {
    const link = el.querySelector('.fs-link');
    link.addEventListener('click', (e) => {
      if (el.classList.contains('stopped')) return; // второй клик — просто открываем канал
      e.preventDefault();
      el.classList.add('stopped');
      const pop = document.createElement('div');
      pop.className = 'fs-pop ' + (top < 40 ? 'below' : 'above');
      pop.innerHTML = `
        <button class="fs-pop-x" type="button" aria-label="Закрыть">✕</button>
        <div class="fs-pop-head"><img src="img/civet-head.png" alt=""><b>Тпру-у! Вы поймали зверька ☕</b></div>
        <p>Загляните в канал <b>Specialty Кофеёк</b> — тут много интересного!</p>
        <a class="btn btn-primary btn-sm" href="https://t.me/speccof" target="_blank" rel="noopener">Открыть канал →</a>`;
      el.appendChild(pop);
      // не даём окошку уехать за край экрана
      const r = pop.getBoundingClientRect();
      const sky = el.closest('.sky').getBoundingClientRect();
      let shift = 0;
      if (r.right > sky.right - 10) shift = sky.right - 10 - r.right;
      if (r.left + shift < sky.left + 10) shift = sky.left + 10 - r.left;
      pop.style.left = shift + 'px';
      const close = () => {
        pop.classList.add('out');
        setTimeout(() => { pop.remove(); el.classList.remove('stopped'); }, 200);
      };
      pop.querySelector('.fs-pop-x').addEventListener('click', close);
      pop.querySelector('a').addEventListener('click', () => setTimeout(close, 300));
    });
  }

  // ---------- toast ----------
  function toast(text, kind) {
    let host = document.querySelector('.toasts');
    if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    host.appendChild(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 4800);
  }

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  function countdown(el, target) {
    const t = Date.parse(target);
    const upd = () => {
      let d = Math.max(0, t - Date.now());
      const days = Math.floor(d / 864e5); d -= days * 864e5;
      const hrs = Math.floor(d / 36e5); d -= hrs * 36e5;
      const min = Math.floor(d / 6e4); d -= min * 6e4;
      const sec = Math.floor(d / 1e3);
      el.innerHTML = [[days, SantaCore.plural(days, 'день', 'дня', 'дней')], [pad(hrs), 'часов'], [pad(min), 'минут'], [pad(sec), 'секунд']]
        .map(([v, l]) => `<div class="cd-cell"><b>${v}</b><span>${l}</span></div>`).join('');
    };
    upd();
    return setInterval(upd, 1000);
  }
  function animateNumber(el, to) {
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (reduced || from === to) { el.textContent = to; return; }
    const start = performance.now(), dur = 1200;
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (v) => new Date(typeof v === 'number' ? v : Date.parse(v)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
  const fmtDateTime = (v) => new Date(v).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

  // ---------- shared chrome: header, demo badge, banners ----------
  async function chrome() {
    document.querySelectorAll('canvas.snow').forEach((c) => snow(c, { rgb: '160,178,210', density: 14000 }));
    const mode = await Api.mode();
    if (mode === 'demo') {
      const b = document.createElement('div');
      b.className = 'demo-badge';
      b.innerHTML = 'Демо-режим: данные хранятся только в этом браузере · пароль админки <b>' + Api.demoAdminPassword + '</b>';
      document.body.appendChild(b);
    }
    const navUser = document.querySelector('[data-nav-user]');
    const banners = document.querySelector('[data-banners]');
    if (Api.token()) {
      try {
        const me = await Api.get('/api/me');
        if (navUser) navUser.textContent = '☕ ' + me.user.name.split(' ')[0];
        if (banners) renderBanners(banners, me);
        return me;
      } catch (e) {
        if (e.status === 401) Api.logout();
      }
    } else if (banners) {
      try { const p = await Api.get('/api/public'); renderBanners(banners, { settings: p.settings }); } catch (e) { /* ignore */ }
    }
    return null;
  }
  function renderBanners(host, me) {
    const items = [];
    if (me.settings && me.settings.announcement) items.push({ kind: 'admin', text: '📣 ' + me.settings.announcement });
    if (me.deadline) items.push({ kind: me.deadline.kind, text: '⏰ ' + me.deadline.text, href: 'cabinet.html#give' });
    if (me.incoming && me.incoming.status === 'sent') items.push({ kind: 'gift', text: '🎁 Вам подарок от Деда Мороза! Посылка уже в пути', href: 'cabinet.html#gift' });
    host.innerHTML = items.map((i) => `<a class="banner ${i.kind}" ${i.href ? `href="${i.href}"` : ''}>${esc(i.text)}</a>`).join('');
  }

  window.FX = { snow, burst, burstFrom, santas, toast, countdown, animateNumber, esc, fmtDate, fmtDateTime, chrome, renderBanners, reduced };
})();
