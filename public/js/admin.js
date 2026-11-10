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
    $('[data-tiles]').innerHTML = [
      [s.users, 'аккаунтов'], [s.pending, 'ждут модерации'], [s.approved, 'одобрено'], [s.banned, 'в чёрном списке'], [s.sent, 'отправили'], [s.received, 'получили'],
    ].map(([v, l]) => `<div class="card tile"><b>${v}</b><span>${l}</span></div>`).join('');

    $('[data-draw-info]').innerHTML = state.drawnAt
      ? `✅ Жеребьёвка проведена ${FX.fmtDateTime(state.drawnAt)}: <b>${state.pairs.length}</b> ${SantaCore.plural(state.pairs.length, 'пара', 'пары', 'пар')}.`
      : `Жеребьёвка ещё не проводилась. В раздачу попадут только одобренные: <b>${s.approved}</b>.` + (s.pending ? ` <span class="important">Ждут модерации: ${s.pending}</span> — проверьте их в таблице участников.` : '');
    $('[data-approve-all]').hidden = !s.pending;
    $('[data-approve-all]').textContent = `✅ Одобрить всех ожидающих (${s.pending})`;
    $('[data-shuffle]').textContent = state.drawnAt ? '🎲 Перемешать первый круг заново' : '🎲 Раскидать людей';
    $('[data-round2]').hidden = !state.drawnAt;
    if (state.drawnAt) {
      $('[data-round2-info]').innerHTML = state.drawn2At
        ? `✅ Жеребьёвка второго круга проведена ${FX.fmtDateTime(state.drawn2At)}: <b>${state.pairs.filter((p) => p.round === 2).length}</b> пар.`
        : `Подтвердили участие во втором круге: <b>${s.round2 || 0}</b>` + (s.wave2Invited ? ` · <span class="important">ждём подтверждения: ${s.wave2Invited}</span> (в жеребьёвку не попадут)` : '') + `. ${state.settings.round2Open ? 'Запись открыта — на сайте пишем «Первая жеребьёвка прошла, запишитесь во второй круг».' : 'Запись закрыта.'}`;
      $('[data-shuffle2]').textContent = state.drawn2At ? '🎲 Перемешать второй круг заново' : '🎲 Раскидать второй круг';
      const r2 = $('[data-round2-form]');
      if (!r2.contains(document.activeElement)) {
        r2.round2Open.checked = !!state.settings.round2Open;
        r2.round2SendStart.value = toLocalInput(state.settings.round2SendStart);
        r2.round2SendEnd.value = toLocalInput(state.settings.round2SendEnd);
      }
    }
    renderBroadcast();

    const st = state.settings;
    const f = $('[data-settings]');
    if (!f.contains(document.activeElement)) {
      f.sendStart.value = toLocalInput(st.sendStart);
      f.sendEnd.value = toLocalInput(st.sendEnd);
      f.budgetMin.value = st.budgetMin == null ? '' : st.budgetMin;
      f.budgetMax.value = st.budgetMax == null ? '' : st.budgetMax;
      f.announcement.value = st.announcement || '';
      f.chatUrl.value = st.chatUrl || '';
      f.regOpen.checked = !!st.regOpen;
      f.moderation.checked = !!st.moderation;
    }
    renderUsers();
    renderPairs();
    renderWave2();
  }

  // ---------- подтаблица второго круга ----------
  const W2_REASON = { new: '🆕 записался после 1-й жеребьёвки', victim: '😢 пострадавший: Санта не отправил', admin: '📨 пригласил организатор' };
  const W2_STATUS = { invited: '⏳ ждём подтверждения', confirmed: '✅ участвует', declined: '🙅 отказался' };
  function renderWave2() {
    const list = state.wave2 || [];
    $('[data-w2-card]').hidden = !state.drawnAt;
    const conf = list.filter((w) => w.status === 'confirmed').length;
    const inv = list.filter((w) => w.status === 'invited').length;
    const vic = list.filter((w) => w.reason === 'victim').length;
    $('[data-fold-w2]').innerHTML = `${conf} участвуют` + (inv ? ` · ⏳ ждём подтверждения: ${inv}` : '') + (vic ? ` · 😢 пострадавших: ${vic}` : '');
    const pst = (v) => (v ? STATUS[v] : '—');
    const locked = !!state.drawn2At;
    $('[data-w2-rows]').innerHTML = list.map((w) => `<tr>
      <td><b>${w.priority ? '⭐ ' : ''}${esc(w.name)}</b><small>@${esc(w.tg)}</small></td>
      <td>${W2_REASON[w.reason] || '—'}</td>
      <td><span class="status ${w.status === 'confirmed' ? 'received' : w.status === 'declined' ? 'banned' : 'assigned'}">${W2_STATUS[w.status] || w.status}</span>${w.byAdmin ? '<small>подтвердил организатор</small>' : ''}</td>
      <td>${w.hasAnketa ? '📝 есть' : '<span class="bad">нет анкеты</span>'}${w.tgLinked ? ' · ✈️' : ''}</td>
      <td>${w.status === 'confirmed' && locked ? `дарит: ${pst(w.giving)}<br>получает: ${pst(w.receiving)}` : '—'}</td>
      <td class="row-actions">
        ${!locked && w.status !== 'confirmed' && w.hasAnketa ? `<button class="btn btn-ghost btn-sm" data-w2="confirm" data-uid="${w.userId}" title="Участник подтвердил вам лично">✅ Подтвердить за него</button>` : ''}
        ${!locked && w.status === 'confirmed' ? `<button class="btn btn-ghost btn-sm" data-w2="decline" data-uid="${w.userId}">🙅 Отказ</button>` : ''}
        ${!locked ? `<button class="btn btn-ghost btn-sm" data-w2="priority" data-uid="${w.userId}">${w.priority ? '☆ Снять приоритет' : '⭐ Приоритет'}</button>` : ''}
        ${!locked && w.status === 'declined' ? `<button class="btn btn-ghost btn-sm" data-w2="invite" data-uid="${w.userId}">📨 Пригласить снова</button>` : ''}
        <button class="btn btn-danger btn-sm" data-w2="remove" data-uid="${w.userId}" title="Убрать из второго круга">✕</button>
      </td></tr>`).join('') || '<tr><td colspan="6" class="muted">Во втором круге пока никого.</td></tr>';
    const inW2 = new Set(list.map((w) => w.userId));
    const cand = state.users.filter((u) => u.participation && !u.banned && !inW2.has(u.id));
    $('[data-w2-invite-wrap]').hidden = locked || !cand.length;
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
      const p = state.pairs.find((x) => x.santaId === r.dataset.rescue && x.round !== 2);
      if (!p) return;
      if (!confirm(`${p.santa} не отправил подарок ${p.recipient}?\n\n${p.recipient} переводим во второй круг с наивысшим приоритетом ⭐: ему придёт приглашение, и после подтверждения при жеребьёвке второго круга ему достанется надёжный Санта.`)) return;
      return act('/api/admin/wave2-rescue', { santaId: p.santaId }, `${p.recipient} переведён во второй круг ⭐`);
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
    const rnd = (p) => (p.round === 2 ? 2 : 1);
    $('[data-pairs]').innerHTML = state.pairs.map((p) => `<tr${p.failed ? ' class="row-failed"' : ''}>
      <td>${rnd(p) === 2 ? '2️⃣' : '1️⃣'}</td><td>${esc(p.santa)}</td><td>🎁→</td><td><select data-pair-rec="${p.santaId}" data-round="${rnd(p)}">${opt(p.recipientId, p.santaId)}</select>${p.priority ? '<small>⭐ приоритет</small>' : ''}</td>
      <td><span class="status ${p.status}">${STATUS[p.status]}</span>${p.sentAt ? `<small>${FX.fmtDateTime(p.sentAt)}</small>` : ''}${p.failed ? '<small class="bad">😢 не отправил — получатель переведён во 2-й круг</small>' : ''}</td>
      <td>${esc(p.track) || '—'}</td>
      <td><select data-pair="${p.santaId}" data-round="${rnd(p)}">${Object.keys(STATUS).map((k) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${STATUS[k]}</option>`).join('')}</select>
        ${rnd(p) === 1 && p.status === 'assigned' && !p.failed && !state.drawn2At ? `<button class="btn btn-ghost btn-sm" data-rescue="${p.santaId}" title="Санта не отправил подарок: получателя — во второй круг с наивысшим приоритетом">😢 Не отправил → получателя во 2-й круг ⭐</button>` : ''}</td>
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
      if (santaId && recipientId) return act('/api/admin/pair-set', { santaId, recipientId }, 'Получатель назначен');
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

  $('[data-shuffle]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const again = !!state.drawnAt;
    if (!confirm(again ? 'Перемешать заново? Все текущие пары будут заменены.' : `Раскидать ${state.stats.approved} одобренных участников по парам? Все увидят своих получателей.` + (state.stats.pending ? `\n\n⚠️ ${state.stats.pending} анкет ещё на модерации — они в раздачу НЕ попадут.` : ''))) return;
    let force = false;
    if (again && state.pairs.some((p) => p.status !== 'assigned')) {
      if (!confirm('Кто-то уже отправил подарок! Всё равно перемешать?')) return;
      force = true;
    }
    btn.classList.add('shuffle-anim');
    const ok = await act('/api/admin/shuffle', { force }, 'Пары сформированы! 🎅');
    setTimeout(() => btn.classList.remove('shuffle-anim'), 1500);
    if (ok) FX.burstFrom(btn, { count: 60, power: 15 });
  });
  $('[data-reset]').addEventListener('click', () => {
    if (confirm('Сбросить все пары? Участники снова увидят «конверт запечатан».')) act('/api/admin/reset', {}, 'Пары сброшены');
  });

  $('[data-settings]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    act('/api/admin/settings', {
      sendStart: f.sendStart.value + ':00+03:00',
      sendEnd: f.sendEnd.value + ':59+03:00',
      budgetMin: f.budgetMin.value, budgetMax: f.budgetMax.value,
      announcement: f.announcement.value, chatUrl: f.chatUrl.value, regOpen: f.regOpen.checked, moderation: f.moderation.checked,
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
  // ---------- второй круг ----------
  $('[data-round2-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    act('/api/admin/settings', {
      round2Open: f.round2Open.checked,
      round2SendStart: f.round2SendStart.value + ':00+03:00',
      round2SendEnd: f.round2SendEnd.value + ':59+03:00',
    }, 'Настройки второго круга сохранены');
  });
  $('[data-shuffle2]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const again = !!state.drawn2At;
    if (!confirm(again ? 'Перемешать второй круг заново? Пары второго круга будут заменены.' : `Раскидать второй круг (${state.stats.round2 || 0} чел.)? Все увидят своих получателей.` + (state.stats.wave2Invited ? `\n\n⚠️ ${state.stats.wave2Invited} чел. ещё не подтвердили участие — в жеребьёвку они НЕ попадут.` : ''))) return;
    let force = false;
    if (again && state.pairs.some((p) => p.round === 2 && p.status !== 'assigned')) {
      if (!confirm('Во втором круге кто-то уже отправил подарок! Всё равно перемешать?')) return;
      force = true;
    }
    const ok = await act('/api/admin/shuffle', { round: 2, force }, 'Пары второго круга сформированы! 🎅');
    if (ok) FX.burstFrom(btn, { count: 60, power: 15 });
  });
  $('[data-reset2]').addEventListener('click', () => {
    if (confirm('Сбросить пары второго круга?')) act('/api/admin/reset', { round: 2 }, 'Пары второго круга сброшены');
  });

  // ---------- центр уведомлений ----------
  const BC_FILTERS = [
    ['form', '📝 С анкетой', (u) => !!u.participation],
    ['noform', '🚫 Без анкеты', (u) => !u.participation],
    ['pending', '⏳ На модерации', (u) => u.participation && u.participation.moderation === 'pending'],
    ['approved', '✅ Одобрены', (u) => u.participation && u.participation.moderation === 'approved'],
    ['r1', '1️⃣ Первый круг', (u) => u.participation && u.participation.round !== 2],
    ['r2', '2️⃣ Второй круг', (u) => u.participation && u.participation.round === 2],
    ['notsent', '📦 Ещё не отправили подарок', (u) => state.pairs.some((p) => p.santaId === u.id && p.status === 'assigned')],
    ['sent', '🚚 Уже отправили', (u) => state.pairs.some((p) => p.santaId === u.id && p.status !== 'assigned')],
    ['waiting', '🎁 Ждут свой подарок', (u) => state.pairs.some((p) => p.recipientId === u.id && p.status !== 'received')],
    ['got', '🥳 Получили подарок', (u) => state.pairs.some((p) => p.recipientId === u.id && p.status === 'received')],
    ['tg', '✈️ Подключили бота', (u) => u.tgLinked],
    ['notg', '🔕 Без бота', (u) => !u.tgLinked],
    ['banned', '🛑 В чёрном списке', (u) => u.banned],
  ];
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
      <td>${b.site ? '🌐' : ''} ${b.tg ? '✈️' : ''}</td>
      <td><button class="btn btn-danger btn-sm" data-bc-del="${b.id}" title="Удалить из кабинетов">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">Рассылок пока не было.</td></tr>';
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
    if (!f.site.checked && !f.tg.checked) return FX.toast('Выберите, куда отправить', 'error');
    const n = bcPicked.size;
    if (!confirm(`Отправить уведомление ${n} ${SantaCore.plural(n, 'человеку', 'людям', 'людям')}${f.site.checked ? ' на сайт' : ''}${f.site.checked && f.tg.checked ? ' и' : ''}${f.tg.checked ? ' в Telegram' : ''}?`)) return;
    try {
      const r = await Api.post('/api/admin/broadcast', { text, userIds: [...bcPicked], site: f.site.checked, tg: f.tg.checked }, A);
      FX.toast(`Отправлено: ${r.sent}`, 'success');
      f.text.value = '';
      await load();
    } catch (ex) { FX.toast(ex.message, 'error'); }
  });
  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-bc-del]');
    if (d && confirm('Удалить рассылку из личных кабинетов? (В Telegram уже доставленное не отзывается.)')) act('/api/admin/broadcast-delete', { id: d.dataset.bcDel }, 'Рассылка удалена');
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
