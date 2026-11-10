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
    $('[data-shuffle]').textContent = state.drawnAt ? '🎲 Перемешать заново' : '🎲 Раскидать людей';

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
  }

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
    $('[data-pairs-warn]').innerHTML = warn.length ? `<div class="pairs-warn">${warn.join('<br>')}<br><small>Исправьте вручную: выберите получателя в таблице или назначьте ниже.</small></div>` : '';
    const givers = new Set(state.pairs.map((p) => p.santaId));
    const free = players.filter((u) => !givers.has(u.id));
    $('[data-pair-add-wrap]').hidden = !state.pairs.length || !free.length;
    $('[data-pair-add-santa]').innerHTML = free.map((u) => `<option value="${u.id}">@${esc(u.tg)} · ${esc(u.name)}</option>`).join('');
    $('[data-pair-add-rec]').innerHTML = opt('', null);
    $('[data-adm-log]').innerHTML = (state.adminLog || []).map((n) => `<li>${esc(n.text)}<time>${FX.fmtDateTime(n.createdAt)}</time></li>`).join('') || '<li class="muted">Пока ничего не случилось.</li>';
    $('[data-pairs]').innerHTML = state.pairs.map((p) => `<tr>
      <td>${esc(p.santa)}</td><td>🎁→</td><td><select data-pair-rec="${p.santaId}">${opt(p.recipientId, p.santaId)}</select></td>
      <td><span class="status ${p.status}">${STATUS[p.status]}</span>${p.sentAt ? `<small>${FX.fmtDateTime(p.sentAt)}</small>` : ''}</td>
      <td>${esc(p.track) || '—'}</td>
      <td><select data-pair="${p.santaId}">${Object.keys(STATUS).map((k) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${STATUS[k]}</option>`).join('')}</select></td>
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
      return act('/api/admin/pair-set', { santaId: rec.dataset.pairRec, recipientId: rec.value || null }, 'Пара изменена');
    }
    const sel = e.target.closest('[data-pair]');
    if (sel) act('/api/admin/pair-status', { santaId: sel.dataset.pair, status: sel.value }, 'Статус обновлён');
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
  $('[data-broadcast]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await Api.post('/api/admin/broadcast', { text: f.text.value, onlyParticipants: f.onlyParticipants.checked }, A);
      FX.toast(`Отправлено: ${r.sent}`, 'success');
      f.text.value = '';
    } catch (ex) { FX.toast(ex.message, 'error'); }
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
