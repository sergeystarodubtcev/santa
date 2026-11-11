(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = FX.esc;
  const A = { admin: true };
  let state = null;

  const STATUS = { assigned: '⏳ ждёт отправки', sent: '🚚 отправлено', received: '✅ получено' };

  function toLocalInput(v) {
    // поля дат в админке — всегда по Москве (UTC+3)
    return new Date(Date.parse(v) + 3 * 3600e3).toISOString().slice(0, 16);
  }

  async function act(path, body, okMsg) {
    try {
      state = await Api.post(path, body, A);
      render();
      if (okMsg) FX.toast(okMsg, 'success');
      return true;
    } catch (e) {
      FX.toast(e.message, 'error');
      if (e.status === 401) showLogin();
      return false;
    }
  }

  function showLogin() {
    Api.setAdminToken(null);
    $('[data-login]').hidden = false;
    $('[data-dash]').hidden = true;
    $('[data-logout]').hidden = true;
  }

  $('[data-login] form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('[data-err]', f);
    err.textContent = '';
    try {
      const r = await Api.post('/api/admin/login', { password: f.password.value });
      Api.setAdminToken(r.token);
      await load();
    } catch (ex) { err.textContent = ex.message; f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); }
  });
  $('[data-logout]').addEventListener('click', showLogin);

  // ---------- render ----------
  function render() {
    $('[data-login]').hidden = true;
    $('[data-dash]').hidden = false;
    $('[data-logout]').hidden = false;
    const noForm = state.users.filter((u) => !u.participation);
    const noFormBot = noForm.filter((u) => u.tgLinked).length;
    const pend = state.users.filter((u) => u.participation && u.participation.moderation === 'pending').length;
    $('[data-fold-users]').textContent = `${state.users.length} аккаунтов · ${state.users.length - noForm.length} с анкетой` + (pend ? ` · ⏳ на модерации: ${pend}` : '');
    const pairs = state.pairs || [];
    const sentN = pairs.filter((x) => x.status && x.status !== 'assigned').length;
    $('[data-fold-pairs]').textContent = pairs.length ? `${pairs.length} пар · отправлено: ${sentN}` : 'Жеребьёвки ещё не было';
    $('[data-noform-count]').textContent = `${noForm.length} чел. (с ботом — ${noFormBot})`;
    const s = state.stats;
    const sto = state.storage;
    $('[data-storage]').innerHTML = !sto ? '' : sto.mode === 'yandex-object-storage'
      ? `<div class="storage ok">💾 База хранится в Yandex Object Storage (бакет ${esc(sto.repo)}), на серверах в России</div>`
      : sto.mode === 'github'
      ? (sto.lastError
        ? `<div class="storage bad">⚠️ Не удаётся сохранить базу в GitHub (${esc(sto.repo)}): ${esc(sto.lastError)}. Проверьте GITHUB_TOKEN и GITHUB_DATA_REPO в Render!</div>`
        : `<div class="storage ok">💾 База сохраняется в приватный репозиторий ${esc(sto.repo)}${sto.lastSave ? ' · последнее сохранение ' + FX.fmtDateTime(sto.lastSave) : ''}</div>`)
      : '<div class="storage bad">⚠️ База хранится только на диске сервера и сотрётся при перезапуске Render. Задайте GITHUB_DATA_REPO и GITHUB_TOKEN.</div>';
    renderWaveSwitch();
    renderWavePanel();
    renderBroadcast();

    const st = state.settings;
    const f = $('[data-settings]');
    if (!f.contains(document.activeElement)) {
      f.budgetMin.value = st.budgetMin == null ? '' : st.budgetMin;
      f.budgetMax.value = st.budgetMax == null ? '' : st.budgetMax;
      f.announcement.value = st.announcement || '';
      f.chatUrl.value = st.chatUrl || '';
      f.regOpen.checked = !!st.regOpen;
      f.round2Open.checked = !!st.round2Open;
      f.moderation.checked = !!st.moderation;
    }
    renderUsers();
    renderPairs();
    renderWave2();
  }

  // ---------- подтаблица второго круга ----------
  const W2_REASON = { new: '🆕 записался после 1-й жеребьёвки', victim: '😢 пострадавший: Санта не отправил', admin: '📨 пригласил организатор' };
  const W2_STATUS = { waiting: '📝 лист ожидания', invited: '⏳ ждём подтверждения', confirmed: '✅ участвует', declined: '🙅 отказался' };
  function renderWave2() {
    const w0 = wave();
    const list = (state.wave2 || []).filter((x) => !w0 || x.round === w0.n);
    $('[data-w2-card]').hidden = !state.drawnAt || (w0 && w0.n === 1);
    $('[data-w2-title]').textContent = w0 ? `🌊 Волна ${w0.n}: участники` : '🌊 Следующие волны: участники';
    const conf = list.filter((w) => w.status === 'confirmed').length;
    const inv = list.filter((w) => w.status === 'invited').length;
    const vic = list.filter((w) => w.reason === 'victim').length;
    const wl = list.filter((w) => w.status === 'waiting').length;
    $('[data-fold-w2]').innerHTML = `${conf} участвуют` + (inv ? ` · ⏳ ждём подтверждения: ${inv}` : '') + (wl ? ` · 📝 лист ожидания: ${wl}` : '') + (vic ? ` · 😢 пострадавших: ${vic}` : '');
    const pst = (v) => (v ? STATUS[v] : '—');
    const lockedFor = (x) => !x.round || !!((state.waves || []).find((w) => w.n === x.round) || {}).drawnAt;
    const ow = (state.waves || []).find((w) => w.status === 'open' && w.n > 1);
    $('[data-w2-rows]').innerHTML = list.map((w) => { const locked = lockedFor(w) && w.status !== 'waiting'; return `<tr>
      <td><b>${w.priority ? '⭐ ' : ''}${esc(w.name)}</b><small>@${esc(w.tg)}</small></td>
      <td>${w.round ? '🌊 ' + w.round : '—'}</td>
      <td>${W2_REASON[w.reason] || '—'}</td>
      <td><span class="status ${w.status === 'confirmed' ? 'received' : w.status === 'declined' ? 'banned' : 'assigned'}">${W2_STATUS[w.status] || w.status}</span>${w.byAdmin ? '<small>подтвердил организатор</small>' : ''}</td>
      <td>${w.hasAnketa ? '📝 есть' : '<span class="bad">нет анкеты</span>'}${w.tgLinked ? ' · ✈️' : ''}</td>
      <td>${w.status === 'confirmed' && lockedFor(w) ? `дарит: ${pst(w.giving)}<br>получает: ${pst(w.receiving)}` : '—'}</td>
      <td class="row-actions">
        ${!locked && w.round && w.status !== 'confirmed' && w.hasAnketa ? `<button class="btn btn-ghost btn-sm" data-w2="confirm" data-uid="${w.userId}" title="Участник подтвердил вам лично">✅ Подтвердить за него</button>` : ''}
        ${!locked && w.status === 'confirmed' ? `<button class="btn btn-ghost btn-sm" data-w2="decline" data-uid="${w.userId}">🙅 Отказ</button>` : ''}
        ${!locked ? `<button class="btn btn-ghost btn-sm" data-w2="priority" data-uid="${w.userId}">${w.priority ? '☆ Снять приоритет' : '⭐ Приоритет'}</button>` : ''}
        ${ow && (w.status === 'declined' || (w.status !== 'confirmed' && w.round !== ow.n)) ? `<button class="btn btn-ghost btn-sm" data-w2="invite" data-uid="${w.userId}">📨 Пригласить в ${ow.n}-ю</button>` : ''}
        <button class="btn btn-danger btn-sm" data-w2="remove" data-uid="${w.userId}" title="Убрать из следующих волн">✕</button>
      </td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">Пока никого.</td></tr>';
    const inW2 = new Set(list.map((w) => w.userId));
    const cand = state.users.filter((u) => u.participation && !u.banned && !inW2.has(u.id));
    $('[data-w2-invite-wrap]').hidden = !ow || !cand.length;
    $('[data-w2-invite]').innerHTML = cand.map((u) => `<option value="${u.id}">@${esc(u.tg)} · ${esc(u.name)}</option>`).join('');
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-w2]');
    if (b) {
      const msgs = { confirm: 'Подтверждено ✅', decline: 'Отмечен отказ', priority: 'Приоритет изменён', invite: 'Приглашение отправлено 📨', remove: 'Убран из второго круга' };
      if (b.dataset.w2 === 'remove' && !confirm('Убрать участника из второго круга?')) return;
      return act('/api/admin/wave2-set', { userId: b.dataset.uid, action: b.dataset.w2 }, msgs[b.dataset.w2]);
    }
    if (e.target.closest('[data-w2-invite-btn]')) {
      const uid = $('[data-w2-invite]').value;
      if (uid) return act('/api/admin/wave2-set', { userId: uid, action: 'invite' }, 'Приглашение отправлено 📨 — участник должен подтвердить');
    }
    const r = e.target.closest('[data-rescue]');
    if (r) {
      const p = state.pairs.find((x) => x.santaId === r.dataset.rescue && String(x.round > 1 ? x.round : 1) === r.dataset.round);
      if (!p) return;
      const ow = (state.waves || []).find((w) => w.status === 'open' && !w.drawnAt && w.n > (p.round > 1 ? p.round : 1));
      if (!confirm(`${p.santa} не отправил подарок ${p.recipient}?\n\n${p.recipient} переводим ` + (ow ? `в ${ow.n}-ю волну` : 'в лист ожидания следующей волны (приглашение придёт, когда вы её создадите)') + ' с наивысшим приоритетом ⭐: при жеребьёвке ему достанется надёжный Санта.')) return;
      return act('/api/admin/wave2-rescue', { santaId: p.santaId, round: p.round > 1 ? p.round : 1 }, `${p.recipient} — в следующую волну ⭐`);
    }
  });

  function renderUsers() {
    const q = $('[data-search]').value.trim().toLowerCase();
    const onlyPending = $('[data-only-pending]').checked;
    const rank = (u) => !u.participation ? 3 : ({ pending: 0, approved: 1, rejected: 2 })[u.participation.moderation];
    const users = state.users
      .filter((u) => !q || [u.name, u.phone, u.tg, u.participation && u.participation.fullName].join(' ').toLowerCase().includes(q))
      .filter((u) => !onlyPending || (u.participation && u.participation.moderation === 'pending' && !u.banned))
      .sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
    $('[data-users]').innerHTML = users.map((u) => {
      const p = u.participation;
      return `<tr class="${u.banned ? 'banned' : ''}">
        <td><b>${esc(u.name)}</b><small>${FX.fmtDateTime(u.createdAt)}</small></td>
        <td>${esc(u.phone)}<small><a href="https://t.me/${esc(u.tg)}" target="_blank" rel="noopener">@${esc(u.tg)}</a></small></td>
        <td>${p ? `${esc(p.address)}<small>${esc(p.fullName || '')}</small>${p.city ? `<small>🏙️ ${esc(p.city)}</small>` : '<small class="important">⚠️ город не распознан</small>'}` : '<span class="muted">анкета не заполнена</span>'}</td>
        <td>${p ? `${esc(SantaCore.PREFS[p.prefs])}<small>${esc(p.wishes) || '—'}</small>${p.notes ? `<small class="important">⚠️ ${esc(p.notes)}</small>` : ''}` : ''}</td>
        <td>${u.banned ? '<span class="status banned">🛑 бан</span>' : !p ? '<span class="status">без анкеты</span>'
          : p.moderation === 'approved' ? '<span class="status received">✅ одобрен</span>'
          : p.moderation === 'rejected' ? `<span class="status banned">🚫 отклонён</span>${p.moderationNote ? `<small>${esc(p.moderationNote)}</small>` : ''}`
          : '<span class="status assigned">⏳ модерация</span>'}
          <small title="Согласие на обработку ПДн">${u.pdConsentAt ? '🔒 согласие ПДн ' + FX.fmtDate(u.pdConsentAt) : '⚠️ нет согласия ПДн'}</small></td>
        <td style="white-space:nowrap">
          ${p && !u.banned && p.moderation !== 'approved' ? `<button class="btn btn-green btn-sm" data-mod="${u.id}" data-s="approved">✅ Одобрить</button>` : ''}
          ${p && !u.banned && p.moderation !== 'rejected' ? `<button class="btn btn-ghost btn-sm" data-mod="${u.id}" data-s="rejected">🚫 Отклонить</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-ban="${u.id}" data-v="${u.banned ? 0 : 1}">${u.banned ? 'Разбанить' : '🛑 В ЧС'}</button>
          <button class="btn btn-ghost btn-sm" data-edit-user="${u.id}" title="Изменить данные">✏️</button>
          ${state.pairs.some((x) => x.santaId === u.id || x.recipientId === u.id) ? `<button class="btn btn-ghost btn-sm" data-unpair="${u.id}" title="Убрать из жеребьёвки, аккаунт оставить">✂️ Из пар</button>` : ''}
          <button class="btn btn-danger btn-sm" data-del="${u.id}" title="Удалить">✕</button>
        </td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">Пока никого. Киньте ссылку в чат!</td></tr>';
  }

  function renderPairs() {
    const players = state.users.filter((u) => u.participation && u.participation.moderation === 'approved' && !u.banned);
    const opt = (sel, except) => '<option value="">— нет —</option>' + players.filter((u) => u.id !== except)
      .map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>@${esc(u.tg)} · ${esc(u.name)}</option>`).join('');
    const chk = state.pairsCheck || {};
    const warn = [];
    if ((chk.noRecipient || []).length) warn.push('🎁 Без получателя (никому не дарят): ' + chk.noRecipient.map(esc).join(', '));
    if ((chk.noSanta || []).length) warn.push('😢 Без Санты (им никто не дарит): ' + chk.noSanta.map(esc).join(', '));
    if ((chk.doubleSanta || []).length) warn.push('⚠️ Получают сразу от двух Сант: ' + chk.doubleSanta.map(esc).join(', '));
    if (warn.length) $('[data-fold-pairs]').innerHTML += ' · <b style="color:#c1121f">⚠️ есть проблемы — откройте</b>';
    $('[data-pairs-warn]').innerHTML = warn.length ? `<div class="pairs-warn">${warn.join('<br>')}<br><small>Исправьте вручную: выберите получателя в таблице или назначьте ниже.</small></div>` : '';
    const givers = new Set(state.pairs.map((p) => p.santaId));
    const free = players.filter((u) => !givers.has(u.id));
    $('[data-pair-add-wrap]').hidden = !state.pairs.length || !free.length;
    $('[data-pair-add-santa]').innerHTML = free.map((u) => `<option value="${u.id}">@${esc(u.tg)} · ${esc(u.name)}</option>`).join('');
    $('[data-pair-add-rec]').innerHTML = opt('', null);
    $('[data-adm-log]').innerHTML = (state.adminLog || []).map((n) => `<li>${esc(n.text)}<time>${FX.fmtDateTime(n.createdAt)}</time></li>`).join('') || '<li class="muted">Пока ничего не случилось.</li>';
    const rnd = (p) => (p.round > 1 ? p.round : 1);
    const shownPairs = wave() ? state.pairs.filter((p) => (p.round > 1 ? p.round : 1) === wave().n) : state.pairs;
    $('[data-pairs]').innerHTML = shownPairs.map((p) => `<tr${p.failed ? ' class="row-failed"' : ''}>
      <td>🌊 ${rnd(p)}</td><td>${esc(p.santa)}</td><td>🎁→</td><td><select data-pair-rec="${p.santaId}" data-round="${rnd(p)}">${opt(p.recipientId, p.santaId)}</select>${p.priority ? '<small>⭐ приоритет</small>' : ''}</td>
      <td><span class="status ${p.status}">${STATUS[p.status]}</span>${p.status === 'assigned' ? `<small>${p.ackAt ? '👍 собирает посылку' : '🤷 не подтвердил'}</small>` : ''}${p.sentAt ? `<small>${FX.fmtDateTime(p.sentAt)}</small>` : ''}${p.failed ? '<small class="bad">😢 не отправил — получатель переведён во 2-й круг</small>' : ''}</td>
      <td>${esc(p.track) || '—'}</td>
      <td><select data-pair="${p.santaId}" data-round="${rnd(p)}">${Object.keys(STATUS).map((k) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${STATUS[k]}</option>`).join('')}</select>
        ${p.status === 'assigned' && !p.failed ? `<button class="btn btn-ghost btn-sm" data-rescue="${p.santaId}" data-round="${rnd(p)}" title="Санта не отправил подарок: получателя — в следующую волну с наивысшим приоритетом">😢 Не отправил → получателя в следующую волну ⭐</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">Пар пока нет — нажмите «Раскидать людей».</td></tr>';
  }

  // ---------- правка данных участника ----------
  const um = $('[data-user-modal]');
  const uf = $('[data-form=user-edit]');
  let editingId = null;
  const umClose = () => { um.classList.remove('open'); setTimeout(() => (um.hidden = true), 250); };
  $$('[data-um-close]', um).forEach((b) => b.addEventListener('click', umClose));
  function openUserEdit(id) {
    const u = state.users.find((x) => x.id === id);
    if (!u) return;
    editingId = id;
    const p = u.participation;
    $('[data-um-title]').textContent = `${u.name} · @${u.tg}`;
    uf.name.value = u.name; uf.tg.value = '@' + u.tg; uf.phone.value = u.phone; uf.password.value = '';
    uf.withAnketa.checked = !!p;
    uf.fullName.value = p ? p.fullName || '' : '';
    uf.address.value = p ? p.address || '' : '';
    uf.wishes.value = p ? p.wishes || '' : '';
    uf.notes.value = p ? p.notes || '' : '';
    uf.prefs.value = p ? p.prefs || 'any' : 'any';
    $('[data-um-anketa]').hidden = !p;
    $('[data-err]', uf).textContent = '';
    um.hidden = false;
    requestAnimationFrame(() => um.classList.add('open'));
  }
  uf.withAnketa.addEventListener('change', () => { $('[data-um-anketa]').hidden = !uf.withAnketa.checked; });
  uf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('[data-err]', uf);
    err.textContent = '';
    const body = { userId: editingId, name: uf.name.value, tg: uf.tg.value, phone: uf.phone.value, password: uf.password.value || undefined };
    if (uf.withAnketa.checked) body.anketa = { fullName: uf.fullName.value, address: uf.address.value, wishes: uf.wishes.value, notes: uf.notes.value, prefs: uf.prefs.value };
    try {
      state = await Api.post('/api/admin/user-edit', body, A);
      render();
      umClose();
      FX.toast('Данные участника сохранены ✅', 'success');
    } catch (ex) { err.textContent = ex.message; }
  });

  // ---------- actions ----------
  $('[data-search]').addEventListener('input', renderUsers);
  $('[data-only-pending]').addEventListener('change', renderUsers);
  document.addEventListener('click', async (e) => {
    const mod = e.target.closest('[data-mod]');
    if (mod) {
      let note = '';
      if (mod.dataset.s === 'rejected') {
        note = prompt('Причина отклонения (участник её увидит). Можно оставить пустой:', '');
        if (note === null) return;
      }
      return act('/api/admin/moderate', { userId: mod.dataset.mod, status: mod.dataset.s, note }, mod.dataset.s === 'approved' ? 'Одобрено ✅' : 'Отклонено');
    }
    if (e.target.closest('[data-approve-all]')) {
      if (!confirm(`Одобрить всех ${state.stats.pending} ожидающих? Убедитесь, что просмотрели их анкеты.`)) return;
      return act('/api/admin/approve-all', {}, 'Все ожидающие одобрены');
    }
    const ban = e.target.closest('[data-ban]');
    if (ban) return act('/api/admin/ban', { userId: ban.dataset.ban, banned: ban.dataset.v === '1' }, ban.dataset.v === '1' ? 'Добавлен в чёрный список' : 'Разбанен');
    const del = e.target.closest('[data-del]');
    if (del) {
      const inDraw = state.pairs.some((x) => x.santaId === del.dataset.del || x.recipientId === del.dataset.del);
      if (!confirm(inDraw
        ? 'Удалить участника навсегда? Он в жеребьёвке: его Санта автоматически получит его получателя (и уведомление с новым адресом).'
        : 'Удалить пользователя навсегда?')) return;
      return act('/api/admin/delete', { userId: del.dataset.del }, 'Удалён, пары перестроены');
    }
    const editBtn = e.target.closest('[data-edit-user]');
    if (editBtn) return openUserEdit(editBtn.dataset.editUser);
    const unpair = e.target.closest('[data-unpair]');
    if (unpair && confirm('Убрать участника из жеребьёвки? Его Санта получит его получателя. Аккаунт останется.')) {
      return act('/api/admin/remove-from-draw', { userId: unpair.dataset.unpair }, 'Убран из пар, цепочка перестроена');
    }
    if (e.target.closest('[data-pair-add]')) {
      const santaId = $('[data-pair-add-santa]').value;
      const recipientId = $('[data-pair-add-rec]').value;
      if (santaId && recipientId) return act('/api/admin/pair-set', { santaId, recipientId, round: wave() ? wave().n : undefined }, 'Получатель назначен');
    }
  });
  document.addEventListener('change', (e) => {
    const rec = e.target.closest('[data-pair-rec]');
    if (rec) {
      const santa = state.users.find((u) => u.id === rec.dataset.pairRec);
      const to = state.users.find((u) => u.id === rec.value);
      if (!confirm(to ? `@${santa.tg} будет дарить @${to.tg}. Санта получит уведомление с новым адресом. Продолжить?` : `Убрать получателя у @${santa.tg}?`)) { renderPairs(); return; }
      return act('/api/admin/pair-set', { santaId: rec.dataset.pairRec, round: rec.dataset.round, recipientId: rec.value || null }, 'Пара изменена');
    }
    const sel = e.target.closest('[data-pair]');
    if (sel) act('/api/admin/pair-status', { santaId: sel.dataset.pair, round: sel.dataset.round, status: sel.value }, 'Статус обновлён');
  });


  $('[data-settings]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    act('/api/admin/settings', {
      budgetMin: f.budgetMin.value, budgetMax: f.budgetMax.value,
      announcement: f.announcement.value, chatUrl: f.chatUrl.value, regOpen: f.regOpen.checked, round2Open: f.round2Open.checked, moderation: f.moderation.checked,
    }, 'Настройки сохранены');
  });

  $('[data-run-reminders]').addEventListener('click', async () => {
    try {
      const r = await Api.post('/api/admin/run-reminders', {}, A);
      FX.toast(r.sent ? `Отправлено напоминаний: ${r.sent}` : 'Сегодня напоминать некому — всё по плану', 'success');
    } catch (e) { FX.toast(e.message, 'error'); }
  });
  $('[data-noform-ask]').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // запоминаем сразу: после await e.currentTarget уже null
    const noForm = state.users.filter((u) => !u.participation);
    const withBot = noForm.filter((u) => u.tgLinked).length;
    if (!withBot) { FX.toast(noForm.length ? 'У тех, кто без анкеты, не подключён бот — написать некому' : 'Все заполнили анкету 🎉', 'error'); return; }
    const okGo = await FX.confirmBox({
      emoji: '📨', title: 'Спросить сейчас?',
      html: `Бот напишет <b>${withBot}</b> из ${noForm.length} человек без анкеты: «Будете участвовать?» с кнопками «Заполнить анкету» и «Удалить аккаунт».` + (noForm.length > withBot ? `<br>У остальных ${noForm.length - withBot} бот не подключён.` : ''),
      no: 'Отмена', yes: '📨 Отправить',
    });
    if (!okGo) return;
    btn.disabled = true;
    try {
      const r = await Api.post('/api/admin/ask-noform', {}, A);
      FX.toast(`Отправлено: ${r.sent} в Telegram`, 'success');
      load();
    } catch (err) { FX.toast(err.message, 'error'); }
    btn.disabled = false;
  });
  // ---------- волны: переключатель, панель волны, сводка ----------
  let curWave = (() => { try { return localStorage.getItem('adm_wave') || 'all'; } catch (e) { return 'all'; } })();
  const WST = { open: '📝 идёт запись', drawn: '🎲 пары розданы', closed: '⏹ остановлена' };
  const wave = () => (curWave === 'all' ? null : (state.waves || []).find((w) => String(w.n) === String(curWave)) || null);
  const fd = (iso) => FX.fmtDate(iso);
  function setWave(v) { curWave = String(v); try { localStorage.setItem('adm_wave', curWave); } catch (e) { /* ignore */ } render(); }
  const pRound = (p) => (p.round > 1 ? p.round : 1);
  const wavePairs = (n) => state.pairs.filter((p) => pRound(p) === n);
  const nicks = (ids) => ids.map((id) => { const u = state.users.find((x) => x.id === id); return u ? '@' + esc(u.tg) : '—'; });
  function waveMembers(n) {
    if (n === 1) return state.users.filter((u) => u.participation && !u.banned && (u.participation.round == null || u.participation.round === 1)).map((u) => u.id);
    return (state.wave2 || []).filter((x) => x.round === n && x.status === 'confirmed').map((x) => x.userId);
  }
  function renderWaveSwitch() {
    if (curWave !== 'all' && !wave()) curWave = 'all';
    const w = wave();
    const sw = $('[data-wave-switch]');
    const open = sw.querySelector('[data-ws-menu]') && !sw.querySelector('[data-ws-menu]').hidden;
    sw.hidden = false;
    const last = (state.waves || [])[state.waves.length - 1];
    sw.innerHTML = `<button class="ws-btn" type="button" data-ws-toggle>${w ? `🌊 Волна ${w.n}` : '📊 Все волны'} <span class="ws-caret">▾</span></button>
      <div class="ws-menu" data-ws-menu ${open ? '' : 'hidden'}>
        <button type="button" data-ws="all" class="${w ? '' : 'on'}">📊 Все волны<small>сводка: кто что не сделал</small></button>
        ${(state.waves || []).map((x) => `<button type="button" data-ws="${x.n}" class="${w && w.n === x.n ? 'on' : ''}">🌊 Волна ${x.n}<small>${fd(x.start)} — ${fd(x.end)} · ${WST[x.status] || x.status}</small></button>`).join('')}
        <button type="button" data-ws-new ${last && last.status === 'open' ? 'disabled title="Сначала проведите жеребьёвку или остановите последнюю волну"' : ''}>➕ Новая волна${last ? ` (${last.n + 1}-я)` : ''}<small>${last && last.status === 'open' ? 'сначала жеребьёвка или остановка текущей' : 'лист ожидания получит приглашение'}</small></button>
      </div>`;
  }
  function tiles(list) { $('[data-tiles]').innerHTML = list.map(([v, l, cls]) => `<div class="card tile ${cls || ''}"><b>${v}</b><span>${l}</span></div>`).join(''); }
  function renderWavePanel() {
    const host = $('[data-wave-panel]');
    if (host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const s = state.stats;
    const w = wave();
    const last = (state.waves || [])[state.waves.length - 1];
    const canNew = last && last.status !== 'open';
    if (!w) {
      tiles([[s.users, 'аккаунтов'], [s.approved, 'одобрено'], [s.pending, 'ждут модерации'], [s.banned, 'в чёрном списке'], [s.sent, 'отправили'], [s.received, 'получили']]);
      const rows = (state.waves || []).map((x) => `<tr class="ws-row" data-ws="${x.n}">
        <td><b>🌊 ${x.n}</b></td><td>${fd(x.start)} — ${fd(x.end)}</td><td><span class="status ${x.status === 'closed' ? 'banned' : x.status === 'drawn' ? 'sent' : 'assigned'}">${WST[x.status]}</span></td>
        <td>${x.members}${x.invited ? `<small>⏳ ждут подтверждения: ${x.invited}</small>` : ''}${x.pending ? `<small>⏳ модерация: ${x.pending}</small>` : ''}</td>
        <td>${x.pairs ? x.noAck : '—'}</td><td>${x.pairs ? `<b class="${x.notSent ? 'bad' : ''}">${x.notSent}</b>` : '—'}</td><td>${x.pairs ? x.sent : '—'}</td><td>${x.pairs ? x.received : '—'}</td><td>${x.failed || '—'}</td></tr>`).join('');
      const details = (state.waves || []).filter((x) => x.pairs).map((x) => {
        const ps = wavePairs(x.n).filter((p) => !p.failed);
        const noAck = ps.filter((p) => p.status === 'assigned' && !p.ackAt).map((p) => p.santaId);
        const notSent = ps.filter((p) => p.status === 'assigned').map((p) => p.santaId);
        const notGot = ps.filter((p) => p.status === 'sent').map((p) => p.recipientId);
        const line = (label, ids, cls) => (ids.length ? `<div class="wd-line ${cls || ''}"><span>${label} (${ids.length}):</span> ${nicks(ids).join(' ')}</div>` : '');
        return `<div class="wd"><b>🌊 Волна ${x.n}</b> <span class="muted">· отправка до ${fd(x.end)}${Date.parse(x.end) < Date.now() ? ' — <span class="bad">срок прошёл</span>' : ''}</span>
          ${line('🤷 не подтвердили, что собирают', noAck)}${line('📦 не отправили', notSent, Date.parse(x.end) < Date.now() ? 'bad' : '')}${line('🎁 не отметили получение', notGot)}
          ${!noAck.length && !notSent.length && !notGot.length ? '<div class="wd-line">✅ все всё сделали</div>' : ''}</div>`;
      }).join('');
      const wl = (state.wave2 || []).filter((x) => x.status === 'waiting');
      host.innerHTML = `<h3>📊 Все волны</h3>
        <div class="table-wrap"><table class="waves-table"><thead><tr><th>Волна</th><th>Отправка</th><th>Статус</th><th>Участников</th><th>🤷 не подтв.</th><th>📦 не отпр.</th><th>🚚 отпр.</th><th>✅ получ.</th><th>😢</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="muted" style="font-size:13px">Нажмите на волну, чтобы открыть её админку. Ники должников удобно скопировать в «📣 Уведомления → 📋 Список для общего чата».</p>
        ${details || '<p class="muted">Жеребьёвок ещё не было — здесь появится, кто что не сделал.</p>'}
        ${wl.length ? `<div class="wd"><b>📝 Лист ожидания следующей волны (${wl.length})</b><div class="wd-line">${wl.map((x) => '@' + esc(x.tg) + (x.priority ? ' ⭐' : '')).join(' ')}</div></div>` : ''}
        <div class="actions"><button class="btn btn-ghost btn-sm" data-ws-new ${canNew ? '' : 'disabled'}>➕ Новая волна${last ? ` (${last.n + 1}-я)` : ''}</button>${canNew ? '' : '<span class="muted" style="font-size:13px">новую волну можно создать после жеребьёвки или остановки текущей</span>'}</div>`;
      return;
    }
    const ps = wavePairs(w.n);
    tiles([[w.members, 'участников'], [w.n === 1 ? w.pending : w.invited, w.n === 1 ? 'ждут модерации' : 'ждут подтверждения'], [w.pairs ? w.noAck : '—', '🤷 не подтвердили'], [w.pairs ? w.notSent : '—', '📦 не отправили', w.notSent && Date.parse(w.end) < Date.now() ? 'tile-bad' : ''], [w.sent, '🚚 отправили'], [w.received, '✅ получили']]);
    const info = w.drawnAt
      ? `✅ Жеребьёвка проведена ${FX.fmtDateTime(w.drawnAt)}: <b>${ps.length}</b> ${SantaCore.plural(ps.length, 'пара', 'пары', 'пар')}.`
      : `Жеребьёвки ещё не было. В раздачу попадут: <b>${w.members}</b>` + (w.n === 1 ? ' (одобренные модерацией)' : ' (подтвердившие участие)') + '.'
        + (w.pending ? ` <span class="important">Ждут модерации: ${w.pending}</span>.` : '') + (w.invited ? ` <span class="important">Ждут подтверждения: ${w.invited}</span> — в жеребьёвку не попадут.` : '');
    const isLast = last && last.n === w.n;
    host.innerHTML = `<h3>🌊 Волна ${w.n} <span class="status ${w.status === 'closed' ? 'banned' : w.status === 'drawn' ? 'sent' : 'assigned'}">${WST[w.status]}</span></h3>
      <form class="ua-row" data-wave-dates="${w.n}">
        <label>Начало отправки (МСК)<input type="datetime-local" name="start" value="${toLocalInput(w.start)}"></label>
        <label>Конец отправки (МСК)<input type="datetime-local" name="end" value="${toLocalInput(w.end)}"></label>
        <button class="btn btn-gold btn-sm">Сохранить даты</button>
      </form>
      <p class="muted">${info}</p>
      <div class="actions">
        ${w.n === 1 && w.pending ? `<button class="btn btn-green" data-approve-all>✅ Одобрить всех ожидающих (${w.pending})</button>` : ''}
        ${w.status !== 'closed' ? `<button class="btn btn-primary shuffle-btn" data-wave-shuffle="${w.n}">🎲 ${w.drawnAt ? 'Перемешать заново' : 'Раскидать людей'}</button>` : ''}
        ${w.drawnAt && isLast && w.status !== 'closed' ? `<button class="btn btn-danger btn-sm" data-wave-reset="${w.n}">Сбросить пары</button>` : ''}
        ${w.status !== 'closed' ? `<button class="btn btn-ghost btn-sm" data-wave-act="close" data-n="${w.n}" title="Напоминания этой волны перестанут приходить, жеребьёвка недоступна">⏹ Остановить волну</button>`
          : `<button class="btn btn-ghost btn-sm" data-wave-act="reopen" data-n="${w.n}">▶️ Возобновить волну</button>`}
        ${isLast ? `<button class="btn btn-ghost btn-sm" data-ws-new ${canNew ? '' : 'disabled title="Сначала проведите жеребьёвку или остановите волну"'}>➕ Создать ${w.n + 1}-ю волну</button>` : ''}
      </div>
      <p class="muted" style="font-size:13px;margin-top:12px">Раздача случайная, никто не дарит сам себе, забаненные не участвуют.${w.n > 1 ? ' Участникам с ⭐ приоритетом достаётся надёжный Санта (уже отправлял подарок раньше).' : ''} Пары и участники ниже показаны только для этой волны. «Остановить» — когда волна закончилась: напоминания по ней больше не приходят; потом создайте следующую.</p>`;
  }
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-ws-toggle]');
    const menu = $('[data-ws-menu]');
    if (t) { menu.hidden = !menu.hidden; return; }
    if (menu && !menu.hidden && !e.target.closest('[data-wave-switch]')) menu.hidden = true;
    const ws = e.target.closest('[data-ws]');
    if (ws) { if (menu) menu.hidden = true; setWave(ws.dataset.ws); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (e.target.closest('[data-ws-new]')) {
      const last = (state.waves || [])[state.waves.length - 1];
      if (menu) menu.hidden = true;
      if (!confirm(`Создать ${last.n + 1}-ю волну?\n\nДаты по умолчанию — сразу после окончания ${last.n}-й волны, 10 дней; их можно поменять. Новые участники будут записываться в эту волну, а лист ожидания получит приглашение подтвердить участие.`)) return;
      if (await act('/api/admin/wave-create', {}, `${last.n + 1}-я волна создана 🌊`)) setWave(last.n + 1);
      return;
    }
    const sh = e.target.closest('[data-wave-shuffle]');
    if (sh) {
      const n = Number(sh.dataset.waveShuffle);
      const w = (state.waves || []).find((x) => x.n === n);
      const again = !!w.drawnAt;
      if (!confirm(again ? `Перемешать ${n}-ю волну заново? Её пары будут заменены.` : `Раскидать ${n}-ю волну (${w.members} чел.)? Все увидят своих получателей.` + (w.pending ? `\n\n⚠️ ${w.pending} анкет на модерации — в раздачу НЕ попадут.` : '') + (w.invited ? `\n\n⚠️ ${w.invited} чел. не подтвердили участие — в раздачу НЕ попадут.` : ''))) return;
      let force = false;
      if (again && wavePairs(n).some((p) => p.status !== 'assigned')) {
        if (!confirm('В этой волне кто-то уже отправил подарок! Всё равно перемешать?')) return;
        force = true;
      }
      sh.classList.add('shuffle-anim');
      const ok = await act('/api/admin/shuffle', { round: n, force }, 'Пары сформированы! 🎅');
      if (ok) FX.burstFrom(sh, { count: 60, power: 15 });
      return;
    }
    const rs = e.target.closest('[data-wave-reset]');
    if (rs) {
      if (confirm('Сбросить пары этой волны? Её участники снова увидят «конверт запечатан».')) act('/api/admin/reset', { round: Number(rs.dataset.waveReset) }, 'Пары сброшены');
      return;
    }
    const wa = e.target.closest('[data-wave-act]');
    if (wa) {
      const n = Number(wa.dataset.n);
      if (wa.dataset.waveAct === 'close' && !confirm(`Остановить ${n}-ю волну?\n\nНапоминания по её парам перестанут приходить, жеребьёвка станет недоступна. Пары, статусы и пострадавшие останутся — их можно переводить в следующую волну. Возобновить можно в любой момент.`)) return;
      act('/api/admin/wave-set', { n, action: wa.dataset.waveAct }, wa.dataset.waveAct === 'close' ? `${n}-я волна остановлена ⏹` : `${n}-я волна возобновлена ▶️`);
    }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-wave-dates]');
    if (!f) return;
    e.preventDefault();
    act('/api/admin/wave-set', { n: Number(f.dataset.waveDates), start: f.start.value + ':00+03:00', end: f.end.value + ':59+03:00' }, 'Даты волны сохранены — на сайте они уже обновились');
  });

  // ---------- центр уведомлений ----------
  const BC_FILTERS = [
    ['form', '📝 С анкетой', (u) => !!u.participation],
    ['noform', '🚫 Без анкеты', (u) => !u.participation],
    ['pending', '⏳ На модерации', (u) => u.participation && u.participation.moderation === 'pending'],
    ['approved', '✅ Одобрены', (u) => u.participation && u.participation.moderation === 'approved'],
    ['wave', '🌊 Выбранная волна (переключатель сверху)', (u) => !wave() || waveMembers(wave().n).includes(u.id)],
    ['noack', '🤷 Не подтвердили, что собирают', (u) => state.pairs.some((p) => p.santaId === u.id && p.status === 'assigned' && !p.ackAt)],
    ['notsent', '📦 Ещё не отправили подарок', (u) => state.pairs.some((p) => p.santaId === u.id && p.status === 'assigned')],
    ['sent', '🚚 Уже отправили', (u) => state.pairs.some((p) => p.santaId === u.id && p.status !== 'assigned')],
    ['waiting', '🎁 Ждут свой подарок', (u) => state.pairs.some((p) => p.recipientId === u.id && p.status !== 'received')],
    ['got', '🥳 Получили подарок', (u) => state.pairs.some((p) => p.recipientId === u.id && p.status === 'received')],
    ['tg', '✈️ Подключили бота', (u) => u.tgLinked],
    ['notg', '🔕 Без бота', (u) => !u.tgLinked],
    ['banned', '🛑 В чёрном списке', (u) => u.banned],
  ];
  // Готовые фразы. filters — какие фильтры «Кому» включить
  const BC_TEMPLATES = [
    { label: '⏰ Напоминание о сроке', filters: ['notsent'], text: '{имя}, привет! Это организаторы Тайного Санты Кофеманьяков 🎅 Напоминаем: подарок нужно отправить до {срок} ({осталось}). Когда отправите — отметьте это в личном кабинете на santa.speccof.ru и добавьте трек-номер 🎁' },
    { label: '📦 Вы уже отправили?', filters: ['notsent'], text: '{имя}, привет! Вы уже отправили подарок своему получателю? Если да — пожалуйста, отметьте отправку в личном кабинете на santa.speccof.ru (можно с трек-номером), чтобы получатель знал, что посылка в пути. Если ещё нет — срок до {срок} ({осталось}).' },
    { label: '🔥 Срок прошёл', filters: ['notsent'], text: '{имя}, срок отправки подарка закончился {срок}, а отметки об отправке у нас нет 😟 Пожалуйста, отправьте подарок в ближайшие 2 дня и отметьте это в личном кабинете на santa.speccof.ru. Если что-то случилось — просто ответьте на это сообщение, мы поможем.' },
    { label: '🛑 Последнее предупреждение', filters: ['notsent'], text: '{имя}, это последнее напоминание: подарок так и не отправлен. Если до завтра отправки не будет, мы передадим вашего получателя другому Санте, а вы попадёте в чёрный список Тайного Санты Кофеманьяков 🛑 Если есть уважительная причина — ответьте на это сообщение.' },
    { label: '📝 Заполните анкету', filters: ['noform'], text: '{имя}, привет! Вы зарегистрировались в Тайном Санте Кофеманьяков, но не заполнили анкету — без неё в жеребьёвку не попасть 🎅 Заполните её на santa.speccof.ru (раздел «Личный кабинет»).' },
    { label: '🎁 Отметьте получение', filters: ['waiting'], text: '{имя}, привет! Ваш Тайный Санта уже отправил вам подарок 🎁 Когда получите посылку — отметьте это в личном кабинете на santa.speccof.ru. Спасибо!' },
  ];
  $('[data-bc-tpl]').innerHTML = BC_TEMPLATES.map((t, i) => `<button type="button" class="chip chip-btn" data-tpl="${i}"><span>${t.label}</span></button>`).join('');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tpl]');
    if (!b) return;
    const t = BC_TEMPLATES[Number(b.dataset.tpl)];
    const f = $('[data-bc-form]');
    if (f.text.value.trim() && f.text.value !== f.text.dataset.tpl && !confirm('Заменить написанный текст готовой фразой?')) return;
    f.text.value = t.text;
    f.text.dataset.tpl = t.text;
    // включаем подходящие фильтры «Кому»
    bcActive.clear();
    t.filters.forEach((k) => bcActive.add(k));
    $$('[data-bc-f]').forEach((x) => { x.checked = bcActive.has(x.dataset.bcF); });
    bcSyncFromFilters();
    renderBroadcast();
    FX.toast('Фраза вставлена, получатели отобраны по фильтру — проверьте список', 'success');
  });
  const bcActive = new Set();
  const bcPicked = new Set();
  let bcTouched = false; // пока галочки не трогали руками — список следует за фильтрами
  $('[data-bc-filters]').innerHTML = BC_FILTERS.map(([k, label]) => `<label class="chip"><input type="checkbox" data-bc-f="${k}"><span>${label}</span></label>`).join('');
  const bcMatch = () => state.users.filter((u) => BC_FILTERS.every(([k, , fn]) => !bcActive.has(k) || fn(u)));
  function bcSyncFromFilters() { bcPicked.clear(); bcMatch().forEach((u) => bcPicked.add(u.id)); bcTouched = false; }
  function renderBroadcast() {
    if (!bcTouched) bcSyncFromFilters();
    [...bcPicked].forEach((id) => { if (!state.users.some((u) => u.id === id)) bcPicked.delete(id); });
    const q = $('[data-bc-search]').value.trim().toLowerCase();
    const match = new Set(bcMatch().map((u) => u.id));
    const list = state.users
      .filter((u) => !q || (u.name + ' ' + u.tg).toLowerCase().includes(q))
      .sort((a, b) => (match.has(b.id) - match.has(a.id)) || a.name.localeCompare(b.name));
    $('[data-bc-people]').innerHTML = list.map((u) => `<label class="bc-person ${match.has(u.id) ? '' : 'dim'}">
      <input type="checkbox" data-bc-u="${u.id}" ${bcPicked.has(u.id) ? 'checked' : ''}>
      <span>${esc(u.name)} <small>@${esc(u.tg)}${u.tgLinked ? ' ✈️' : ''}</small></span></label>`).join('') || '<p class="muted">Никого нет</p>';
    const n = bcPicked.size;
    $('[data-bc-count]').textContent = `Выбрано: ${n} ${SantaCore.plural(n, 'человек', 'человека', 'человек')}`;
    $('[data-bc-send]').textContent = n ? `📣 Отправить ${n} ${SantaCore.plural(n, 'человеку', 'людям', 'людям')}` : 'Никто не выбран';
    $('[data-bc-send]').disabled = !n;
    $('[data-bc-history]').innerHTML = (state.broadcasts || []).map((b) => `<tr>
      <td style="white-space:nowrap">${FX.fmtDateTime(b.at)}</td>
      <td style="white-space:pre-line">${esc(b.text)}</td>
      <td>${b.count}<small>${esc((b.to || []).slice(0, 6).join(' '))}${(b.to || []).length > 6 ? ' …' : ''}</small></td>
      <td>${b.site ? '🌐' : ''} ${b.tg ? '✈️' : ''} ${b.userTg ? '👤' : ''}</td>
      <td>${b.userTg ? `${b.uSent || 0} из ${b.uTotal || 0}${b.uQueued ? `<small>⏳ в очереди: ${b.uQueued}</small>` : ''}${b.uFailed ? `<small class="bad" title="${esc((b.uErrors || []).join('\n'))}">не доставлено: ${b.uFailed}</small><small>${esc((b.uErrors || []).slice(0, 4).join('; '))}</small>` : ''}` : '—'}</td>
      <td><button class="btn btn-danger btn-sm" data-bc-del="${b.id}" title="Удалить из кабинетов">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">Рассылок пока не было.</td></tr>';
    renderUserAcc();
    if ($('[data-cl]').open) renderChatList();
  }
  document.addEventListener('change', (e) => {
    const f = e.target.closest('[data-bc-f]');
    if (f) { if (f.checked) bcActive.add(f.dataset.bcF); else bcActive.delete(f.dataset.bcF); bcSyncFromFilters(); renderBroadcast(); return; }
    const p = e.target.closest('[data-bc-u]');
    if (p) { bcTouched = true; if (p.checked) bcPicked.add(p.dataset.bcU); else bcPicked.delete(p.dataset.bcU); renderBroadcast(); }
  });
  $('[data-bc-search]').addEventListener('input', renderBroadcast);
  $('[data-bc-all]').addEventListener('click', () => { bcMatch().forEach((u) => bcPicked.add(u.id)); bcTouched = true; renderBroadcast(); });
  $('[data-bc-none]').addEventListener('click', () => { bcPicked.clear(); bcTouched = true; renderBroadcast(); });
  $('[data-bc-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const text = f.text.value.trim();
    if (!text) return FX.toast('Напишите текст уведомления', 'error');
    if (!f.site.checked && !f.tg.checked && !f.userTg.checked) return FX.toast('Выберите, куда отправить', 'error');
    const n = bcPicked.size;
    const noBot = state.users.filter((u) => bcPicked.has(u.id) && !u.tgLinked).length;
    const where = [f.site.checked && 'на сайт', f.tg.checked && 'в Telegram-бот', f.userTg.checked && `с аккаунта организатора (${noBot} без бота)`].filter(Boolean).join(', ');
    if (!confirm(`Отправить уведомление ${n} ${SantaCore.plural(n, 'человеку', 'людям', 'людям')}: ${where}?` + (f.userTg.checked && noBot ? `\n\nС личного аккаунта сообщения уходят по одному раз в 30–60 секунд (до 40 в сутки), чтобы Telegram не заблокировал аккаунт.` : ''))) return;
    try {
      const r = await Api.post('/api/admin/broadcast', { text, userIds: [...bcPicked], site: f.site.checked, tg: f.tg.checked, userTg: f.userTg.checked }, A);
      FX.toast(`Отправлено: ${r.sent}` + (r.viaUser ? ` · с аккаунта организатора в очереди: ${r.viaUser}` : ''), 'success');
      f.text.value = '';
      delete f.text.dataset.tpl;
      await load();
    } catch (ex) { FX.toast(ex.message, 'error'); }
  });
  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-bc-del]');
    if (d && confirm('Удалить рассылку из личных кабинетов? (В Telegram уже доставленное не отзывается.)')) act('/api/admin/broadcast-delete', { id: d.dataset.bcDel }, 'Рассылка удалена');
  });

  // ---------- список для общего чата ----------
  const players = () => state.users.filter((u) => u.participation && !u.banned && u.participation.moderation !== 'rejected');
  const inSel = (p) => !wave() || (p.round > 1 ? p.round : 1) === wave().n;
  const pendingPairs = () => state.pairs.filter((p) => p.status === 'assigned' && !p.failed && inSel(p));
  const curEnd = () => { const w = wave() || (state.waves || []).find((x) => x.status !== 'closed' && Date.parse(x.end) > Date.now()) || (state.waves || [])[0]; return w ? w.end : state.settings.sendEnd; };
  const CL_SCEN = [
    { key: 'nobot', label: '🤖 Не подключили бота',
      who: () => players().filter((u) => !u.tgLinked),
      text: () => `Вы не включили уведомления в боте — сделайте это, пожалуйста, чтобы мы могли напоминать вам о сроках 🙏\nДля этого перейдите в бота @${state.bot || 'coffeemaniacs_bot'} и нажмите «Старт» (или кнопку «🔔 Подписаться на уведомления» в личном кабинете на santa.speccof.ru). Спасибо!` },
    { key: 'noack', label: '🎲 Подтвердите участие после жеребьёвки',
      who: () => state.users.filter((u) => pendingPairs().some((p) => p.santaId === u.id && !p.ackAt)),
      text: () => `Жеребьёвка прошла! 🎅 Подтвердите, пожалуйста, в личном кабинете на santa.speccof.ru, что вы участвуете и собираете посылку: раздел «Кому я дарю» → кнопка «✅ Участвую, собираю посылку» (или то же самое в боте @${state.bot || 'coffeemaniacs_bot'}). Спасибо!` },
    { key: 'notsent', label: '📦 Не отметили отправку',
      who: () => state.users.filter((u) => pendingPairs().some((p) => p.santaId === u.id)),
      text: () => `Отметьте, пожалуйста, в личном кабинете на santa.speccof.ru, что вы отправили подарок: «Кому я дарю» → «📦 Я отправил подарок» (можно добавить трек-номер). Отправка — до ${FX.fmtDate(curEnd())}. Если ещё не отправили — самое время! 🎁` },
    { key: 'notgot', label: '🎁 Не отметили получение',
      who: () => state.users.filter((u) => state.pairs.some((p) => p.recipientId === u.id && p.status === 'sent' && inSel(p))),
      text: () => 'Вам уже отправили подарки! 🎁 Когда получите посылку, отметьте это, пожалуйста, в личном кабинете на santa.speccof.ru: «Мой подарок» → «🎉 Я получил подарок». Санте будет приятно знать, что посылка дошла. Спасибо!' },
    { key: 'picked', label: '👥 Кто отмечен ниже',
      who: () => state.users.filter((u) => bcPicked.has(u.id)),
      text: () => ($('[data-bc-form]').text.value.trim() || 'Ваш текст') },
  ];
  let clScen = 'nobot';
  $('[data-cl-scen]').innerHTML = CL_SCEN.map((c) => `<label class="chip"><input type="radio" name="cl" value="${c.key}" ${c.key === clScen ? 'checked' : ''}><span>${c.label}</span></label>`).join('');
  function renderChatList(force) {
    const ta = $('[data-cl-text]');
    if (!force && document.activeElement === ta) return; // не затираем ручную правку
    const c = CL_SCEN.find((x) => x.key === clScen);
    const people = c.who();
    $('[data-cl-count]').textContent = `${people.length} ${SantaCore.plural(people.length, 'человек', 'человека', 'человек')}`;
    ta.value = people.length ? `Ребята! 👋\n${people.map((u) => '@' + u.tg).join('\n')}\n\n${c.text()}` : 'Таких сейчас нет 🎉';
  }
  document.addEventListener('change', (e) => {
    if (e.target.name === 'cl' && e.target.closest('[data-cl-scen]')) { clScen = e.target.value; renderChatList(true); }
  });
  $('[data-cl]').addEventListener('toggle', () => renderChatList(true));
  $('[data-cl-copy]').addEventListener('click', async () => {
    const ta = $('[data-cl-text]');
    try { await navigator.clipboard.writeText(ta.value); } catch (e) { ta.select(); document.execCommand('copy'); }
    FX.toast('Скопировано — вставьте в общий чат 📋', 'success');
  });

  // ---------- аккаунт организатора (личный Telegram) ----------
  const UA_STATUS = {
    off: 'не подключён', code_requested: 'отправляем код…', code_sending: 'отправляем код…', code_sent: 'код отправлен в Telegram',
    code_entered: 'проверяем код…', signing_in: 'входим…', need_password: 'нужен облачный пароль', password_entered: 'проверяем пароль…',
    ready: 'подключён ✅', limited: 'ограничен Telegram (спам-блок) ⚠️', logout_requested: 'отключаем…',
  };
  let uaTimer = null;
  function renderUserAcc() {
    const a = state.userAcc || { status: 'off' };
    const host = $('[data-ua]');
    if (host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // не мешаем вводу
    const st = a.status;
    const me = a.me ? `${esc(a.me.name || '')}${a.me.username ? ' @' + esc(a.me.username) : ''}` : '';
    let body = '';
    if (st === 'off') body = `<form class="ua-row" data-ua-form="phone"><input name="value" type="tel" placeholder="+7 900 000-00-00" autocomplete="off"><button class="btn btn-gold btn-sm">📲 Получить код</button></form>
      <p class="muted">Телефон отдельного Telegram-аккаунта для рассылок. Код придёт в Telegram на этом аккаунте — введите его здесь. Не пересылайте код никому.</p>`;
    else if (st === 'code_sent') body = `<form class="ua-row" data-ua-form="code"><input name="value" inputmode="numeric" placeholder="Код из Telegram" autocomplete="one-time-code"><button class="btn btn-gold btn-sm">Войти</button><button type="button" class="btn btn-ghost btn-sm" data-ua-act="cancel">Отмена</button></form>`;
    else if (st === 'need_password') body = `<form class="ua-row" data-ua-form="password"><input name="value" type="password" placeholder="Облачный пароль (двухэтапная проверка)" autocomplete="off"><button class="btn btn-gold btn-sm">Войти</button><button type="button" class="btn btn-ghost btn-sm" data-ua-act="cancel">Отмена</button></form>`;
    else if (st === 'ready' || st === 'limited') body = `<div class="ua-row"><span>${me}</span>${a.queued ? `<span class="muted">⏳ в очереди: ${a.queued}</span>` : ''}
      ${st === 'limited' || a.pausedUntil > Date.now() ? '<button class="btn btn-ghost btn-sm" data-ua-act="resume">▶️ Продолжить</button>' : ''}
      ${a.queued ? '<button class="btn btn-ghost btn-sm" data-ua-act="clear-queue">Очистить очередь</button>' : ''}
      <button class="btn btn-danger btn-sm" data-ua-act="logout">Отключить</button></div>`;
    else body = `<div class="ua-row"><span class="muted">⏳ Подождите, ретранслятор выполняет шаг (до 20 секунд)…</span><button type="button" class="btn btn-ghost btn-sm" data-ua-act="cancel">Отмена</button></div>`;
    const on = a.enabled !== false;
    host.innerHTML = `<div class="ua-head"><label class="switch" title="Включить или выключить рассылку с личного аккаунта"><input type="checkbox" data-ua-toggle ${on ? 'checked' : ''}><span></span></label>
      <b>👤 Аккаунт организатора</b> ${on ? `<span class="status ${st === 'ready' ? 'received' : st === 'limited' || a.error ? 'banned' : 'assigned'}">${UA_STATUS[st] || st}</span>` : '<span class="status">выключено</span>'}
      <span class="muted">— пишет тем, у кого не подключён бот</span></div>
      ${on ? `${a.error ? `<div class="bad">⚠️ ${esc(a.error)}</div>` : ''}${a.pausedUntil > Date.now() ? `<div class="muted">Пауза до ${FX.fmtDateTime(a.pausedUntil)}</div>` : ''}${body}`
        : `<p class="muted">Выключено: сообщения с личного аккаунта не отправляются${a.queued ? `, очередь (${a.queued}) на паузе` : ''}.${a.me ? ' Аккаунт остаётся подключён.' : ''}</p>`}`;
    const chip = $('[data-ua-chip]');
    chip.hidden = !on;
    if (!on) chip.querySelector('input').checked = false;
    chip.classList.toggle('dim', !(st === 'ready' || st === 'limited'));
    // пока идёт вход — чаще обновляем статус
    clearTimeout(uaTimer);
    if (!['off', 'ready', 'limited'].includes(st)) uaTimer = setTimeout(() => load(), 4000);
  }
  document.addEventListener('change', (e) => {
    const t = e.target.closest('[data-ua-toggle]');
    if (t) act('/api/admin/settings', { userTg: t.checked }, t.checked ? 'Рассылка с аккаунта организатора включена' : 'Рассылка с аккаунта организатора выключена');
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-ua-form]');
    if (!f) return;
    e.preventDefault();
    const value = f.value.value.trim();
    if (!value) return;
    f.value.blur();
    act('/api/admin/useracc', { action: f.dataset.uaForm, value }, f.dataset.uaForm === 'phone' ? 'Запросили код — он придёт в Telegram через несколько секунд' : 'Проверяем…');
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ua-act]');
    if (!b) return;
    const a = b.dataset.uaAct;
    if (a === 'logout' && !confirm('Отключить аккаунт организатора? Сессия будет завершена, очередь сообщений останется.')) return;
    if (a === 'clear-queue' && !confirm('Отменить все сообщения, которые ещё ждут отправки с аккаунта организатора?')) return;
    act('/api/admin/useracc', { action: a }, { logout: 'Аккаунт отключается', resume: 'Продолжаем отправку', cancel: 'Отменено', 'clear-queue': 'Очередь очищена' }[a]);
  });

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('[data-export]').addEventListener('click', async () => {
    try {
      const db = await Api.get('/api/admin/export', A);
      download(`santa-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db, null, 1), 'application/json');
    } catch (e) { FX.toast(e.message, 'error'); }
  });
  $('[data-csv]').addEventListener('click', () => {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['Имя', 'ФИО', 'Телефон', 'Telegram', 'Адрес', 'Тематика', 'Пожелания', 'Пометки', 'Бан', 'Дарит кому (Telegram)']];
    const byId = Object.fromEntries(state.users.map((u) => [u.id, u]));
    state.users.forEach((u) => {
      const p = u.participation || {};
      const pair = state.pairs.find((x) => x.santaId === u.id);
      rows.push([u.name, p.fullName, u.phone, '@' + u.tg, p.address, SantaCore.PREFS[p.prefs] || '', p.wishes, p.notes, u.banned ? 'да' : '', pair && byId[pair.recipientId] ? '@' + byId[pair.recipientId].tg : '']);
    });
    download('santa-participants.csv', '﻿' + rows.map((r) => r.map(q).join(';')).join('\n'), 'text/csv');
  });
  $('[data-import]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !confirm('Заменить ВСЮ базу содержимым файла?')) return;
    try {
      const db = JSON.parse(await file.text());
      act('/api/admin/import', { db }, 'База восстановлена');
    } catch (ex) { FX.toast('Не удалось прочитать файл', 'error'); }
    e.target.value = '';
  });

  async function load() {
    state = await Api.get('/api/admin/state', A);
    render();
  }

  (async () => {
    await FX.chrome();
    if (!Api.adminToken()) return showLogin();
    try { await load(); } catch (e) { showLogin(); }
    setInterval(() => { if (!$('[data-dash]').hidden) Api.get('/api/admin/state', A).then((s) => { state = s; render(); }).catch(() => {}); }, 20000);
  })();
})();
