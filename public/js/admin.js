(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = FX.esc;
  const A = { admin: true };
  let state = null;
  let stateRevision = 0;

  const STATUS = { assigned: '⏳ ждёт отправки', sent: '🚚 отправлено', received: '✅ получено' };

  function toLocalInput(v) {
    // поля дат в админке — всегда по Москве (UTC+3)
    return new Date(Date.parse(v) + 3 * 3600e3).toISOString().slice(0, 16);
  }

  async function act(path, body, okMsg) {
    try {
      state = await Api.post(path, body, A);
      stateRevision++;
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

  function reviewAction({ title, detail, label, apply }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'card pair-picker action-review';
    dialog.innerHTML = `<h3 data-review-title></h3><p data-review-detail></p>
      <p data-review-error class="form-err" role="alert"></p>
      <div class="actions">
        <button type="button" class="btn btn-ghost" data-review-cancel autofocus>Отмена</button>
        <button type="button" class="btn btn-primary" data-review-submit></button>
      </div>`;
    const cancel = $('[data-review-cancel]', dialog);
    const submit = $('[data-review-submit]', dialog);
    $('[data-review-title]', dialog).textContent = title;
    $('[data-review-detail]', dialog).textContent = detail;
    submit.textContent = label;
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', (event) => { if (submit.disabled) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    submit.addEventListener('click', async () => {
      cancel.disabled = submit.disabled = true;
      $('[data-review-error]', dialog).textContent = '';
      try {
        await apply();
        dialog.close();
      } catch (e) {
        $('[data-review-error]', dialog).textContent = e.message;
        cancel.disabled = submit.disabled = false;
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  const raffle = $('[data-raffle]');
  function renderRaffle(r) {
    const status = $('[data-raffle-status]');
    status.className = 'status ' + (r.draw ? 'received' : 'assigned');
    status.textContent = r.draw ? 'Завершён' : (r.eligible ? 'Готов к проведению' : 'Ждём отправок');
    $('[data-raffle-stats]').innerHTML = [
      [r.entries, 'Записались'], [r.eligible, 'С номерками'], [r.tickets, 'Номерков в розыгрыше'],
    ].map(([number, label]) => `<div class="card tile"><b>${Number(number)}</b><span>${label}</span></div>`).join('');
    $('[data-raffle-announce]').hidden = !!r.announcement || !!r.draw;
    $('[data-raffle-announcement]').textContent = r.announcement
      ? `Поставлено в рассылку: объявлений — ${r.announcement.users}.`
      : r.draw ? 'Розыгрыш завершён.' : 'Участники получат одно объявление с условиями, каналами организаторов и кнопкой участия.';
    $('[data-raffle-deadline]').textContent = r.deadline ? 'Отправки учитываются по ' + FX.fmtDate(r.deadline) + ' включительно, по Москве. Итоги — ' + r.resultsDay + '.' : '';
    $('[data-raffle-waves]').innerHTML = (state.waves || []).map((w) =>
      `<li><span>Волна ${w.n}</span><b>${Number((r.byRound || {})[w.n] || 0)}</b></li>`).join('');
    $('[data-raffle-heading]').textContent = r.draw ? 'Победители' : 'Провести розыгрыш';
    $('[data-raffle-hint]').textContent = r.draw ? 'Результат зафиксирован ' + FX.fmtDateTime(r.draw.at) + '.'
      : !r.eligible ? 'Розыгрыш станет доступен, когда появятся участники с номерками.'
        : 'Можно выбрать до ' + r.eligible + '. Каждый участник может выиграть один раз.';
    $('[data-raffle-results]').innerHTML = r.draw
      ? `<ol class="raffle-winners">${r.draw.winners.map((w) => `<li><b>${esc(w.nick)}</b><span>№${Number(w.number)} · волна ${Number(w.round)}</span></li>`).join('')}</ol>` : '';
    const participants = r.participants || [];
    const winnerNumbers = new Set(r.draw ? r.draw.winners.map((w) => w.number) : []);
    $('[data-raffle-roster-empty]').hidden = !!participants.length;
    $('[data-raffle-roster]').hidden = !participants.length;
    $('[data-raffle-participants]').innerHTML = participants.map((person) => `<tr>
      <th scope="row"><b>${esc(person.name)}</b><small>${esc(person.nick)}</small></th>
      <td>${person.tickets.length ? `<div class="raffle-ticket-list">${person.tickets.map((ticket) =>
        `<span class="raffle-ticket${winnerNumbers.has(ticket.number) ? ' raffle-ticket-winner' : ''}">
          <b>№${Number(ticket.number)}</b> · волна ${Number(ticket.round)}${winnerNumbers.has(ticket.number) ? ' · выиграл' : ''}
        </span>`).join('')}</div>` : '<span class="muted">Без номерка</span>'}</td>
    </tr>`).join('');
    const form = $('[data-raffle-draw]');
    form.hidden = !!r.draw || !r.eligible;
    form.elements.count.max = r.eligible;
    if (Number(form.elements.count.value) > r.eligible && r.eligible) form.elements.count.value = r.eligible;
  }

  async function loadRaffle() {
    $('[data-raffle-error]').textContent = '';
    try { renderRaffle(await Api.get('/api/admin/raffle', A)); }
    catch (e) { $('[data-raffle-error]').textContent = e.message; }
  }

  $('[data-raffle-announce]').addEventListener('click', () => reviewAction({
    title: 'Объявить розыгрыш?',
    detail: 'Бот поставит в очередь одно сообщение с условиями и кнопкой участия.',
    label: 'Отправить объявление',
    apply: async () => renderRaffle(await Api.post('/api/admin/raffle/announce', {}, A)),
  }));

  $('[data-raffle-draw]').addEventListener('submit', (event) => {
    event.preventDefault();
    const count = Number(event.currentTarget.elements.count.value);
    reviewAction({
      title: 'Провести общий розыгрыш?',
      detail: `Будет выбрано победителей: ${count}. Результат зафиксируется, приём номерков закроется. Итоги отправятся участникам в бот и личный кабинет.`,
      label: 'Провести розыгрыш',
      apply: async () => renderRaffle(await Api.post('/api/admin/raffle/draw', { count }, A)),
    });
  });

  const service = $('[data-service]');
  const moveForm = $('[data-service-move]');
  const move = moveForm.elements;
  let archive = [];
  let backupForms = null;
  let backupPairs = new Map();
  let backupVisible = [];
  let backupLimit = 50;
  let visibleRecords = [];
  const matchesService = (user, query) => [user.name, user.tg, user.phone, user.fullName, user.participation?.fullName]
    .some((value) => String(value || '').toLowerCase().includes(query.trim().toLowerCase().replace(/^@/, '')));
  const userLabel = (user) => `${user.name} · @${user.tg}`;
  const serviceUser = () => state.users.find((u) => u.id === move.userId.value);

  function serviceMessage(text) {
    const result = $('[data-service-result]');
    result.textContent = text;
    result.hidden = !text;
  }
  function fillSelect(select, options, placeholder) {
    const current = select.value;
    select.replaceChildren(new Option(placeholder, ''), ...options.map(([label, value]) => new Option(label, value)));
    if (options.some(([, value]) => String(value) === current)) select.value = current;
  }
  function renderServiceRecipients() {
    const n = Number(move.to.value);
    const q = $('[data-service-rec-search]').value;
    const options = state.users.filter((u) => u.id !== move.userId.value && !u.banned && u.participation?.moderation === 'approved'
      && (u.enrolledWaves || []).includes(n) && matchesService(u, q));
    fillSelect(move.recipientId, options.map((u) => [userLabel(u), u.id]), 'Без ручного назначения');
  }
  function renderServiceWaves() {
    const user = serviceUser();
    const enrolled = user?.serviceSourceRounds || [];
    const source = !user?.participation ? [] : enrolled.length ? enrolled : [0];
    fillSelect(move.from, source.map((n) => [n ? 'Волна ' + n : 'Анкета без волны', n]), 'Выберите исходную волну');
    if (source.length === 1) move.from.value = source[0];
    fillSelect(move.to, (state.waves || []).filter((w) => w.status !== 'closed' && !enrolled.includes(w.n))
      .map((w) => ['Волна ' + w.n, w.n]), 'Выберите целевую волну');
    $('[data-service-archive-user]').disabled = !user?.participation;
    $('[data-service-edit-form]').disabled = !user;
    renderServiceRecipients();
  }
  function renderUnassignedForms() {
    const q = $('[data-service-unassigned-search]').value;
    const users = state.users.filter((u) => u.participation && !(u.serviceSourceRounds || []).length && matchesService(u, q));
    $('[data-service-unassigned-empty]').hidden = !!users.length;
    const labels = { rejected: 'Отклонена', pending: 'На модерации', approved: 'Одобрена' };
    $('[data-service-unassigned]').innerHTML = users.map((u) => `<tr>
      <td><b>${esc(u.participation.fullName || u.name)}</b><small>@${esc(u.tg)}</small></td>
      <td>${esc(u.banned ? 'В чёрном списке' : labels[u.participation.moderation] || 'Без волны')}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-unassigned-user="${esc(u.id)}">Открыть</button></td>
    </tr>`).join('');
  }
  function renderServiceUsers() {
    const q = $('[data-service-search]').value;
    fillSelect(move.userId, state.users.filter((u) => matchesService(u, q)).map((u) => [userLabel(u), u.id]), 'Выберите аккаунт');
    renderServiceWaves();
    renderUnassignedForms();
    compareBackup();
  }
  function recordAccount(record) {
    return state.users.find((u) => u.id === record.userId);
  }
  function renderServiceRecordStatus() {
    const value = $('[data-service-record]').value;
    const record = value ? visibleRecords[Number(value) - 1] : null;
    const user = record && recordAccount(record);
    const blocked = !user ? 'Нужен действующий аккаунт с тем же ником и телефоном.' : user.participation
      ? 'У аккаунта уже есть действующая анкета.' : !user.pdConsentAt ? 'У аккаунта нет подтверждённого согласия.' : '';
    $('[data-service-record-status]').textContent = record ? (blocked || `Восстановление для @${user.tg}.`) : '';
    $('[data-service-restore]').disabled = !record || !!blocked;
  }
  function renderServiceArchive() {
    const q = $('[data-service-archive-search]').value;
    visibleRecords = archive.filter((r) => matchesService(r, q)).slice(0, 100);
    const select = $('[data-service-record]');
    select.replaceChildren(new Option(visibleRecords.length ? 'Выберите анкету' : 'Анкет не найдено', ''),
      ...visibleRecords.map((r, i) => new Option(`${r.fullName || r.name} · @${r.tg} · ${r.round ? 'волна ' + r.round : 'без волны'} · архив от ${FX.fmtDateTime(r.archivedAt)}`, i + 1)));
    renderServiceRecordStatus();
  }
  async function loadServiceArchive() {
    archive = await Api.get('/api/admin/service/archive', A);
    renderServiceArchive();
  }
  async function serviceSave(path, body, message) {
    state = await Api.post('/api/admin/service/' + path, body, A);
    stateRevision++;
    renderServiceUsers();
    try { await loadServiceArchive(); }
    catch (e) { message += ' Архив пока не обновился: ' + e.message; }
    serviceMessage(message);
  }

  $('[data-service-search]').addEventListener('input', renderServiceUsers);
  $('[data-service-unassigned-search]').addEventListener('input', renderUnassignedForms);
  $('[data-service-unassigned]').addEventListener('click', (event) => {
    const button = event.target.closest('[data-unassigned-user]');
    if (!button) return;
    $('[data-service-search]').value = '';
    renderServiceUsers();
    move.userId.value = button.dataset.unassignedUser;
    renderServiceWaves();
    move.userId.focus();
  });

  move.userId.addEventListener('change', renderServiceWaves);
  move.to.addEventListener('change', renderServiceRecipients);
  $('[data-service-rec-search]').addEventListener('input', renderServiceRecipients);
  $('[data-service-archive-search]').addEventListener('input', renderServiceArchive);
  $('[data-service-record]').addEventListener('change', renderServiceRecordStatus);
  const backupFields = { fullName: 'ФИО', address: 'ПВЗ', wishes: 'Пожелания', notes: 'Пометки', prefs: 'Предпочтения' };
  const moderationLabels = { approved: 'Одобрена', pending: 'На модерации', rejected: 'Отклонена' };
  const backupFormFields = (form) => Object.fromEntries(Object.keys(backupFields).map((key) => [key, form?.[key] || '']));
  const backupWaves = (rounds) => rounds?.length ? rounds.map((n) => 'Волна ' + n).join(', ') : 'Без волны';

  function compareBackup() {
    const host = $('[data-backup-comparison]');
    const summary = $('[data-backup-summary]');
    $('[data-backup-controls]').hidden = !backupForms;
    if (!backupForms) { host.replaceChildren(); return; }
    const q = $('[data-backup-search]').value;
    const changedOnly = $('[data-backup-changed]').checked;
    const byId = new Map(state.users.map((u) => [u.id, u]));
    const byIdentity = new Map(state.users.map((u) => [JSON.stringify([u.tg, u.phone]), u]));
    const assignments = new Map(state.pairs.map((p) => [JSON.stringify([p.santaId, SantaCore.pairRound(p)]), p]));
    const rows = backupForms.map((old) => {
      const user = byId.get(old.userId) || byIdentity.get(JSON.stringify([old.tg, old.phone]));
      const current = user?.participation || null;
      const rounds = user?.serviceSourceRounds || [];
      const availableRound = rounds.includes(old.round) ? old.round : rounds.length ? null : 0;
      const form = current && (availableRound === 0 ? current : user.waveAnketas?.[old.round] || current);
      const previous = backupFormFields(old.form);
      const actual = backupFormFields(form);
      const diffs = form ? Object.keys(backupFields).filter((key) => previous[key] !== actual[key]) : [];
      const oldRecipient = old.recipientId && backupPairs.get(old.recipientId);
      const currentRecipient = user && assignments.get(JSON.stringify([user.id, old.round]))?.recipient;
      const notes = [
        ...(!user ? ['Аккаунт отсутствует'] : !current ? ['Анкета отсутствует'] : []),
        ...(current && (old.moderation !== current.moderation || old.banned !== !!user.banned) ? ['Статус изменился'] : []),
        ...(current && backupWaves(old.rounds) !== backupWaves(rounds) ? ['Участие изменилось'] : []),
        ...(diffs.length ? ['Анкета изменилась'] : []),
        ...((oldRecipient || '') !== (currentRecipient || '') ? ['Получатель изменился'] : []),
      ];
      const expected = availableRound === 0 ? backupFormFields(current) : actual;
      const canRestore = !!user?.pdConsentAt && (!current || (availableRound !== null
        && Object.keys(previous).some((key) => previous[key] !== expected[key])));
      return { old, user, current, rounds, previous, actual, diffs, notes, availableRound, expected, canRestore, oldRecipient, currentRecipient };
    });
    const changes = rows.filter((row) => row.notes.length).length;
    const filtered = rows.filter((row) => (!changedOnly || row.notes.length)
        && (matchesService(row.old, q) || (row.user && matchesService(row.user, q))))
      .sort((a, b) => b.notes.length - a.notes.length);
    backupVisible = filtered.slice(0, backupLimit);
    summary.textContent = `Анкет в копии: ${rows.length}. С отличиями: ${changes}. Показано: ${backupVisible.length} из ${filtered.length}.`;
    const status = (part, banned) => banned ? 'В чёрном списке' : moderationLabels[part] || 'Без статуса';
    const showField = (key, value) => key === 'prefs' ? SantaCore.PREFS[value] || value || '—' : value || '—';
    host.innerHTML = backupVisible.map((row, i) => {
      const { old, user, current, rounds, previous, actual, diffs, notes, oldRecipient, currentRecipient } = row;
      return `<details class="backup-record">
        <summary><b>${esc(old.fullName || old.name)} · @${esc(old.tg)}</b>
          <span>${old.round ? 'Запись волны ' + old.round : 'Без волны'}</span>
          ${notes.map((note) => `<span class="backup-change">${esc(note)}</span>`).join('')}</summary>
        <div class="backup-detail">
          <p><b>В копии</b> · ${esc(status(old.moderation, old.banned))} · ${backupWaves(old.rounds)}${oldRecipient ? ` · Дарит ${esc(oldRecipient)}` : ''}</p>
          <p><b>Сейчас</b> · ${current ? `${esc(status(current.moderation, user.banned))} · ${backupWaves(rounds)}` : 'Анкеты нет'}${currentRecipient ? ` · Дарит ${esc(currentRecipient)}` : ''}</p>
          <dl>${(current ? diffs : Object.keys(backupFields)).map((key) => `<dt>${backupFields[key]}</dt><dd><b>В копии</b> ${esc(showField(key, previous[key]))}
            ${current ? `<br><b>Сейчас</b> ${esc(showField(key, actual[key]))}` : ''}</dd>`).join('')}</dl>
          <div class="actions">${row.canRestore ? `<button class="btn btn-primary btn-sm" type="button" data-backup-restore="${i}">Восстановить данные анкеты</button>` : ''}
            ${user ? `<button class="btn btn-ghost btn-sm" type="button" data-backup-open="${i}">Открыть участника</button>`
            : '<span class="muted">Для восстановления нужен действующий аккаунт участника.</span>'}</div>
        </div></details>`;
    }).join('') + (backupVisible.length < filtered.length ? '<button type="button" class="btn btn-ghost btn-sm" data-backup-more>Показать ещё</button>' : '');
  }

  for (const selector of ['[data-backup-search]', '[data-backup-changed]']) {
    $(selector).addEventListener('input', () => { backupLimit = 50; compareBackup(); });
  }
  $('[data-backup-comparison]').addEventListener('click', (event) => {
    if (event.target.closest('[data-backup-more]')) { backupLimit += 50; compareBackup(); return; }
    const open = event.target.closest('[data-backup-open]');
    const restore = event.target.closest('[data-backup-restore]');
    const row = open ? backupVisible[Number(open.dataset.backupOpen)] : restore ? backupVisible[Number(restore.dataset.backupRestore)] : null;
    if (!row?.user) return;
    if (open) {
      $('[data-service-search]').value = '';
      renderServiceUsers();
      move.userId.value = row.user.id;
      renderServiceWaves();
      move.userId.focus();
      return;
    }
    if (!row.canRestore) return;
    const body = { userId: row.user.id, backup: { userId: row.old.userId, tg: row.old.tg, phone: row.old.phone, form: row.previous },
      ...(row.current ? { round: row.availableRound, expected: row.expected } : {}) };
    reviewAction({
      title: 'Восстановить данные анкеты?',
      detail: `Данные из копии будут сохранены для @${row.user.tg}. Текущие волны и пары сохранятся.`,
      label: 'Восстановить',
      apply: () => serviceSave('restore', body, 'Данные анкеты восстановлены.'),
    });
  });
  $('[data-service-backup]').addEventListener('change', async (event) => {
    const input = event.target;
    const file = input.files[0];
    backupForms = null;
    backupLimit = 50;
    compareBackup();
    const summary = $('[data-backup-summary]');
    summary.textContent = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (input.files[0] !== file) return;
      backupForms = SantaCore.serviceBackupSnapshot(data);
      backupPairs = new Map(data.users.filter((u) => u?.tg).map((u) => [u.id, '@' + u.tg]));
      compareBackup();
    } catch (e) { if (input.files[0] === file) summary.textContent = e.message; }
  });
  $('[data-service-edit-form]').addEventListener('click', () => {
    const user = serviceUser();
    if (!user) return;
    if (user.participation && !move.from.value) return serviceMessage('Выберите волну редактируемой анкеты.');
    const round = Number(move.from.value);
    const current = user.waveAnketas?.[round] || user.participation || {};
    const dialog = document.createElement('dialog');
    dialog.className = 'card pair-picker';
    dialog.innerHTML = `<h3 data-form-title></h3>
      <form class="form">
        <label>ФИО <input name="fullName" required minlength="3" maxlength="120"></label>
        <label>Адрес ПВЗ Ozon <input name="address" required minlength="5" maxlength="400"></label>
        <label>Пожелания <textarea name="wishes" maxlength="1000"></textarea></label>
        <label>Пометки <textarea name="notes" maxlength="500"></textarea></label>
        <label>Предпочтения <select name="prefs"></select></label>
        <p class="form-err" role="alert"></p>
        <div class="actions"><button type="button" class="btn btn-ghost" data-close>Отмена</button>
          <button type="submit" class="btn btn-primary">Сохранить анкету</button></div>
      </form>`;
    $('[data-form-title]', dialog).textContent = `Анкета @${user.tg} · ${round ? 'волна ' + round : 'без волны'}`;
    const form = $('form', dialog);
    form.elements.prefs.replaceChildren(...Object.entries(SantaCore.PREFS).map(([key, label]) => new Option(label, key)));
    for (const key of ['fullName', 'address', 'wishes', 'notes', 'prefs']) form.elements[key].value = current[key] || (key === 'prefs' ? 'any' : '');
    $('[data-close]', dialog).addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('button[type=submit]', form);
      button.disabled = true;
      try {
        await serviceSave('form', { userId: user.id, round, form: Object.fromEntries(new FormData(form)) }, 'Анкета сохранена.');
        dialog.close();
      } catch (e) { $('[role=alert]', form).textContent = e.message; }
      finally { button.disabled = false; }
    });
    document.body.append(dialog);
    dialog.showModal();
  });

  $('[data-service-archive-user]').addEventListener('click', () => {
    const user = serviceUser();
    if (!user?.participation) return;
    reviewAction({
      title: 'Убрать анкету в архив?',
      detail: `Аккаунт @${user.tg} сохранится. Архивирование доступно для анкет без пар.`,
      label: 'Архивировать',
      apply: () => serviceSave('archive', { userId: user.id }, 'Анкета сохранена в архиве.'),
    });
  });
  $('[data-service-restore]').addEventListener('click', () => {
    const record = visibleRecords[Number($('[data-service-record]').value) - 1];
    const user = record && recordAccount(record);
    if (!user || user.participation) return;
    const body = { userId: user.id, archiveId: record.id };
    reviewAction({
      title: 'Восстановить анкету?',
      detail: `Для @${user.tg} будет восстановлена выбранная анкета. Волну можно выбрать после восстановления.`,
      label: 'Восстановить',
      apply: () => serviceSave('restore', body, 'Анкета восстановлена. Выберите участника и целевую волну.'),
    });
  });
  moveForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = { userId: move.userId.value, from: Number(move.from.value), to: Number(move.to.value), recipientId: move.recipientId.value };
    try {
      const plan = await Api.post('/api/admin/service/move', body, A);
      reviewAction({
        title: 'Подтвердить перевод?',
        detail: plan.summary,
        label: 'Перевести',
        apply: () => serviceSave('move', { ...body, revision: plan.revision }, plan.summary),
      });
    } catch (e) { serviceMessage(e.message); }
  });

  // ---------- render ----------
  function render() {
    $('[data-login]').hidden = true;
    $('[data-dash]').hidden = false;
    $('[data-logout]').hidden = false;
    renderWaveSwitch();
    const raffleView = curWave === 'raffle';
    raffle.hidden = !raffleView;
    const serviceView = curWave === 'service';
    service.hidden = !serviceView;
    $('[data-waves-view]').hidden = raffleView || serviceView;
    if (raffleView || serviceView) return;
    const noForm = state.users.filter((u) => !u.participation);
    const noFormBot = noForm.filter((u) => u.tgLinked).length;
    const pend = state.users.filter((u) => u.participation && u.participation.moderation === 'pending').length;
    const wv = wave();
    $('[data-fold-users]').textContent = wv ? `Волна ${wv.n}: ${waveUserIds(wv.n).size} чел. · все аккаунты — во вкладке «📊 Все волны»`
      : `${state.users.length} аккаунтов · ${state.users.length - noForm.length} с анкетой` + (pend ? ` · ⏳ на модерации: ${pend}` : '');
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
  const W2_REASON = { self: '🔁 участвует повторно (сам записался)', new: '🆕 записался после 1-й жеребьёвки', victim: '😢 пострадавший: Санта не отправил', admin: '📨 пригласил организатор' };
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
        ${w.round && w.status === 'confirmed'
          ? `<button class="btn btn-danger btn-sm" data-unpair="${w.userId}" data-round="${w.round}">Снять с волны ${w.round}</button>`
          : `<button class="btn btn-danger btn-sm" data-w2="remove" data-uid="${w.userId}">Убрать заявку</button>`}
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
      if (b.dataset.w2 === 'remove' && !confirm('Убрать эту заявку на участие?')) return;
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
      if (!ow && (state.waves || []).some((w) => w.n >= SantaCore.FINAL_WAVE)) {
        if (!confirm(`${p.santa} не отправил подарок ${p.recipient}? Получатель получит уведомление.`)) return;
        return act('/api/admin/wave2-rescue', { santaId: p.santaId, round: Number(r.dataset.round) }, 'Отмечено: подарок не отправлен');
      }
      if (!confirm(`${p.santa} не отправил подарок ${p.recipient}?\n\n${p.recipient} переводим ` + (ow ? `в ${ow.n}-ю волну` : 'в лист ожидания следующей волны (приглашение придёт, когда вы её создадите)') + ' с наивысшим приоритетом ⭐: при жеребьёвке ему достанется надёжный Санта.')) return;
      return act('/api/admin/wave2-rescue', { santaId: p.santaId, round: p.round > 1 ? p.round : 1 }, `${p.recipient} — в следующую волну ⭐`);
    }
  });

  // Кто относится к волне: в 1-й — основные анкеты, во 2-й и дальше — только записавшиеся в неё (и те, у кого там уже есть пара)
  function waveUserIds(n) {
    const ids = new Set();
    state.pairs.filter((p) => (p.round > 1 ? p.round : 1) === n).forEach((p) => { ids.add(p.santaId); ids.add(p.recipientId); });
    if (n === 1) state.users.forEach((u) => { if (u.participation && (u.participation.round == null || u.participation.round === 1)) ids.add(u.id); });
    else (state.wave2 || []).forEach((w) => { if (w.round === n && w.status !== 'declined') ids.add(w.userId); });
    for (const u of state.users) {
      if ((u.enrolledWaves || []).includes(n)) ids.add(u.id);
      if ((u.withdrawnWaves || []).includes(n)) ids.delete(u.id);
    }
    return ids;
  }
  function renderUsers() {
    const q = $('[data-search]').value.trim().toLowerCase();
    const w = wave();
    const inWave = w ? waveUserIds(w.n) : null;
    const w2 = Object.fromEntries((state.wave2 || []).map((x) => [x.userId, x]));
    const W2S = { invited: '⏳ ждём подтверждения', confirmed: '✅ участвует', waiting: '📝 лист ожидания' };
    const onlyPending = $('[data-only-pending]').checked;
    const rank = (u) => !u.participation ? 3 : ({ pending: 0, approved: 1, rejected: 2 })[u.participation.moderation];
    const users = state.users
      .filter((u) => !inWave || inWave.has(u.id))
      .filter((u) => !q || [u.name, u.phone, u.tg, u.participation && u.participation.fullName].join(' ').toLowerCase().includes(q))
      .filter((u) => !onlyPending || (u.participation && u.participation.moderation === 'pending' && !u.banned))
      .sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
    const title = $('[data-users-title]');
    if (title) title.textContent = w ? `👥 Участники · волна ${w.n}` : '👥 Участники';
    $('[data-users]').innerHTML = users.map((u) => {
      // во 2-й волне и дальше — анкета этой волны (если человек её поправлял при записи)
      const wa = w && u.waveAnketas && u.waveAnketas[w.n];
      const p = u.participation && wa ? Object.assign({}, u.participation, wa) : u.participation;
      const tag = w && w.n > 1 && w2[u.id] && w2[u.id].round === w.n ? `<small>${W2S[w2[u.id].status] || ''}${w2[u.id].reason === 'victim' ? ' · 😢 пострадавший' : w2[u.id].reason === 'self' ? ' · 🔁 повторно' : ''}${w2[u.id].priority ? ' · ⭐' : ''}</small>` : '';
      return `<tr class="${u.banned ? 'banned' : ''}">
        <td><b>${esc(u.name)}</b><small>${FX.fmtDateTime(u.createdAt)}</small>${tag}</td>
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
          ${w && inWave.has(u.id) ? `<button class="btn btn-ghost btn-sm" data-unpair="${u.id}" data-round="${w.n}">✂️ Снять с волны ${w.n}</button>` : ''}
          <button class="btn btn-danger btn-sm" data-del="${u.id}" title="Удалить">✕</button>
        </td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">Пока никого. Киньте ссылку в чат!</td></tr>';
  }

  // ---------- пары: фильтры, поиск и режим правки ----------
  let pairEdit = false;
  const pfActive = new Set();
  const isDraftPair = (p) => ((state.waves || []).find((w) => w.n === (p.round > 1 ? p.round : 1)) || {}).status === 'drawing';
  const PAIR_FILTERS = [
    ['noack', '🤷 Не подтвердили, что собирают', (p) => p.status === 'assigned' && !p.ackAt && !p.failed && !isDraftPair(p)],
    ['ack', '👍 Подтвердили', (p) => p.status === 'assigned' && !!p.ackAt && !p.failed && !isDraftPair(p)],
    ['notsent', '📦 Не отправили', (p) => p.status === 'assigned' && !p.failed && !isDraftPair(p)],
    ['sent', '🚚 Отправили, ждут получения', (p) => p.status === 'sent'],
    ['received', '✅ Получено', (p) => p.status === 'received'],
    ['failed', '😢 Санта не отправил', (p) => !!p.failed],
    ['priority', '⭐ Приоритет', (p) => !!p.priority],
    ['draft', '🎲 Черновик (не подтверждено)', (p) => isDraftPair(p)],
    ['notrack', '🔎 Отправили без трека', (p) => p.status !== 'assigned' && !p.track],
  ];
  const pairFilterGroups = [['noack', 'ack'], ['notsent', 'sent', 'received', 'failed', 'draft']];
  function matchesPairFilters(pair) {
    const active = PAIR_FILTERS.filter(([key]) => pfActive.has(key));
    return pairFilterGroups.every((group) => {
      const chosen = active.filter(([key]) => group.includes(key));
      return !chosen.length || chosen.some(([, , match]) => match(pair));
    }) && active.filter(([key]) => !pairFilterGroups.some((group) => group.includes(key))).every(([, , match]) => match(pair));
  }
  function pairTone(p) {
    if (p.failed) return 'row-failed';
    if (isDraftPair(p)) return 'row-draft';
    if (p.status !== 'assigned') return 'row-' + p.status;
    return p.ackAt ? 'row-confirmed' : 'row-unconfirmed';
  }
  $('[data-pf]').innerHTML = PAIR_FILTERS.map(([k, label]) => `<label class="chip"><input type="checkbox" data-pf-k="${k}"><span>${label}</span></label>`).join('');
  document.addEventListener('change', (e) => {
    const f = e.target.closest('[data-pf-k]');
    if (!f) return;
    if (f.checked) pfActive.add(f.dataset.pfK); else pfActive.delete(f.dataset.pfK);
    renderPairs();
  });
  $('[data-chain-wave]').addEventListener('change', (event) => setWave(event.target.value));
  $('[data-pair-search]').addEventListener('input', () => renderPairs());
  function clearPairFilters() {
    pfActive.clear();
    $$('[data-pf-k]').forEach((x) => { x.checked = false; });
    $('[data-pair-search]').value = '';
  }
  $('[data-pf-reset]').addEventListener('click', () => { clearPairFilters(); renderPairs(); });
  $('[data-pair-edit]').addEventListener('click', () => { pairEdit = !pairEdit; renderPairs(); });
  // «📬 Код получения»: прикрепить получателю код, ему — «заказ приехал, забирайте», Санте — что код передан
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pickup]');
    if (!b) return;
    const rnd = (x) => (x.round > 1 ? x.round : 1);
    const p = state.pairs.find((x) => x.santaId === b.dataset.pickup && rnd(x) === Number(b.dataset.round));
    if (p) openPickup(p, rnd(p));
  });
  // окно «📬 Код получения»: код и/или фото штрихкода / QR (несколько), уже прикреплённые — превью
  function openPickup(p, r) {
    const w = document.createElement('div');
    w.className = 'modal';
    const have = (p.pickupPhotos || []);
    w.innerHTML = `<div class="modal-backdrop" data-pk-close></div><div class="modal-card" role="dialog" aria-modal="true">
      <button class="modal-x" data-pk-close aria-label="Закрыть">✕</button>
      <div class="modal-head"><div class="modal-emoji">📬</div><h3>Заказ приехал — для ${esc(p.recipient || '')}${r > 1 ? ` (${r}-я волна)` : ''}</h3></div>
      <form class="form" data-pk-form>
        <p class="muted" style="margin:0">Получателю придёт «📬 подарок приехал, можно забирать» с кодом и фото (в бот и в личный кабинет), Санте — что код передан.</p>
        <label>Код получения (если есть)<input name="code" maxlength="100" autocomplete="off" value="${esc(p.pickupCode || '')}"></label>
        ${have.length ? `<div><small class="muted">Уже прикреплено (нажмите, чтобы открыть):</small><div class="pickup-photos">${have.map((id) => `<img class="pickup-thumb" data-photo-id="${id}" alt="">`).join('')}</div></div>` : ''}
        ${(p.pickupTgPhotos || []).length ? `<small class="muted">📷 Ещё фото из Telegram: ${(p.pickupTgPhotos || []).length} — появятся здесь в течение минуты</small>` : ''}
        <label class="btn btn-ghost photo-btn">📷 Добавить фото штрихкода / QR<input type="file" accept="image/*" multiple data-pk-files hidden></label>
        <div class="pickup-photos" data-pk-preview></div>
        <div class="form-err" data-err></div>
        <button class="btn btn-primary btn-block" type="submit">📬 ${p.pickupCode || have.length ? 'Отправить получателю (ещё раз — с новыми фото, если добавили)' : 'Отправить получателю'}</button>
      </form></div>`;
    document.body.appendChild(w);
    FX.hydratePhotos(w, A);
    requestAnimationFrame(() => w.classList.add('open'));
    const close = () => { w.classList.remove('open'); setTimeout(() => w.remove(), 250); };
    w.querySelectorAll('[data-pk-close]').forEach((x) => x.addEventListener('click', close));
    const f = w.querySelector('[data-pk-form]');
    const imgs = [];
    const draw = () => { f.querySelector('[data-pk-preview]').innerHTML = imgs.map((src, i) => `<span class="pick-prev"><img class="pickup-thumb" src="${src}" alt=""><button type="button" data-rm="${i}" aria-label="Убрать">✕</button></span>`).join(''); };
    f.querySelector('[data-pk-files]').addEventListener('change', async (e) => {
      for (const file of [...e.target.files].slice(0, 10 - imgs.length)) { try { imgs.push(await FX.compressImage(file)); } catch (ex) { FX.toast(ex.message, 'error'); } }
      e.target.value = '';
      draw();
    });
    f.addEventListener('click', (e) => { const x = e.target.closest('[data-rm]'); if (x) { imgs.splice(Number(x.dataset.rm), 1); draw(); } });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = f.querySelector('[data-err]');
      if (!f.code.value.trim() && !imgs.length && !have.length) { err.textContent = 'Напишите код или добавьте фото'; return; }
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const photoIds = [];
        for (const [i, image] of imgs.entries()) { btn.textContent = `Загружаю фото ${i + 1}/${imgs.length}…`; photoIds.push((await Api.post('/api/upload-photo', { image }, A)).photoId); }
        // уже прикреплённые фото тоже отправляются — получатель (и вы в боте) получают всё вместе; так можно и «отправить ещё раз»
        state = await Api.post('/api/admin/pickup', { santaId: p.santaId, round: r, code: f.code.value.trim(), photoIds: have.concat(photoIds) }, A);
        close();
        render();
        FX.toast('Прикреплено, получатель уведомлён 📬', 'success');
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = '📬 Отправить получателю'; }
    });
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-admin-photo]');
    if (!b) return;
    try { FX.lightbox((await Api.post('/api/photo', { id: b.dataset.adminPhoto }, A)).image); } catch (ex) { FX.toast(ex.message, 'error'); }
  });

  const searchWords = (value) => String(value || '').toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]+/g) || [];
  function typoDistance(a, b) {
    const rows = [Array.from({ length: b.length + 1 }, (_, i) => i)];
    for (let i = 1; i <= a.length; i++) {
      const row = rows[i] = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
      }
    }
    return rows[a.length][b.length];
  }
  function recipientSearchScore(query, words) {
    let total = 0;
    for (const token of query) {
      let best = Infinity;
      for (const word of words) {
        if (word === token) best = 0;
        else if (word.startsWith(token)) best = Math.min(best, 1);
        else if (word.includes(token)) best = Math.min(best, 2);
        else if (token.length >= 3 && best > 2) {
          const limit = token.length >= 6 ? 2 : 1;
          for (let n = Math.max(1, token.length - limit); n <= Math.min(word.length, token.length + limit); n++) {
            const distance = typoDistance(token, word.slice(0, n));
            if (distance <= limit) best = Math.min(best, 3 + distance);
          }
        }
      }
      if (!Number.isFinite(best)) return Infinity;
      total += best;
    }
    return total;
  }

  function openRecipientPicker(santaId, round) {
    const ids = waveUserIds(round);
    const pair = state.pairs.find((p) => p.santaId === santaId && SantaCore.pairRound(p) === round);
    if (!pair || pair.status !== 'assigned') return;
    const people = state.users.filter((u) => ids.has(u.id) && u.id !== santaId && u.id !== pair.recipientId
      && u.participation && u.participation.moderation === 'approved' && !u.banned);
    const taken = new Set(state.pairs.filter((p) => SantaCore.pairRound(p) === round && p.santaId !== santaId).map((p) => p.recipientId));
    const dialog = document.createElement('dialog');
    dialog.className = 'card pair-picker';
    dialog.innerHTML = `<form method="dialog"><button class="btn btn-ghost btn-sm" aria-label="Закрыть">Закрыть</button></form>
      <h3>Замена получателя · Волна ${round}</h3>
      <p>Санта: ${esc(pair.santa)} · Сейчас дарит: ${esc(pair.recipient)}</p>
      <label>Поиск по имени, ФИО или нику <input type="search" data-find autofocus autocomplete="off" maxlength="100"></label>
      <div class="recipient-suggestions" data-candidates aria-label="Подсказки получателя"></div>
      <p data-plan class="muted" aria-live="polite">Выберите получателя, чтобы увидеть изменения в цепочке.</p>
      <div class="actions"><button class="btn btn-primary" type="button" data-save>Подтвердить замену</button></div>`;
    const input = $('[data-find]', dialog);
    const suggestions = $('[data-candidates]', dialog);
    const save = $('[data-save]', dialog);
    const summary = $('[data-plan]', dialog);
    const indexed = people.map((u) => ({ u, words: searchWords(`${u.name} ${u.tg} ${u.participation.fullName || ''}`) }));
    let recipientId = '';
    let revision = null;
    let request = 0;
    function resetPlan() {
      save.disabled = true;
      revision = null;
      return ++request;
    }
    const body = () => ({ action: 'replace', userId: santaId, recipientId, round });
    async function choose(user) {
      const current = resetPlan();
      recipientId = user.id;
      input.value = userLabel(user);
      suggestions.replaceChildren();
      summary.textContent = 'Проверяем цепочку…';
      try {
        const plan = await Api.post('/api/admin/chain', body(), A);
        if (request !== current) return;
        revision = plan.revision;
        summary.textContent = plan.summary;
        save.disabled = false;
      } catch (e) { if (request === current) summary.textContent = e.message; }
    }
    function render() {
      resetPlan();
      recipientId = '';
      suggestions.replaceChildren();
      const query = searchWords(input.value);
      if (!query.length) {
        summary.textContent = 'Начните вводить имя, ФИО или ник.';
        return;
      }
      const matches = indexed.map(({ u, words }) => ({ u, score: recipientSearchScore(query, words) }))
        .filter(({ score }) => Number.isFinite(score)).sort((a, b) => a.score - b.score || a.u.name.localeCompare(b.u.name)).slice(0, 8);
      summary.textContent = matches.length ? 'Выберите подсказку для предпросмотра цепочки.' : 'Совпадений нет.';
      for (const { u } of matches) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost btn-sm';
        button.textContent = userLabel(u) + (taken.has(u.id) ? ' · уже есть Санта' : '');
        button.addEventListener('click', () => choose(u));
        suggestions.append(button);
      }
    }
    input.addEventListener('input', render);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' || !suggestions.firstElementChild) return;
      event.preventDefault();
      suggestions.firstElementChild.focus();
    });
    save.addEventListener('click', async () => {
      if (!revision) return;
      save.disabled = true;
      if (await act('/api/admin/chain', { ...body(), revision }, 'Цепочка обновлена')) dialog.close();
      else save.disabled = false;
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    render();
    document.body.append(dialog);
    dialog.showModal();
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
    $('[data-pair-add-wrap]').hidden = !pairEdit || !state.pairs.length || !free.length;
    $('[data-pair-edit]').textContent = pairEdit ? '✅ Готово' : '✏️ Управлять цепочкой';
    $('[data-pair-edit]').classList.toggle('btn-gold', !pairEdit);
    $('[data-pair-edit]').classList.toggle('btn-green', pairEdit);
    $('[data-pair-edit-hint]').hidden = !pairEdit;
    $('[data-pairs-head]').innerHTML = pairEdit
      ? '<tr><th>Волна</th><th>Санта</th><th></th><th>Получатель (можно изменить)</th><th>Статус</th><th>Трек</th><th>Статус вручную</th></tr>'
      : '<tr><th>Волна</th><th>Санта</th><th></th><th>Получатель</th><th>Статус</th><th>Трек</th></tr>';
    $('[data-pair-add-santa]').innerHTML = free.map((u) => `<option value="${u.id}">@${esc(u.tg)} · ${esc(u.name)}</option>`).join('');
    $('[data-pair-add-rec]').innerHTML = opt('', null);
    $('[data-adm-log]').innerHTML = (state.adminLog || []).map((n) => `<li>${esc(n.text)}<time>${FX.fmtDateTime(n.createdAt)}</time></li>`).join('') || '<li class="muted">Пока ничего не случилось.</li>';
    const rnd = (p) => (p.round > 1 ? p.round : 1);
    const chainWave = $('[data-chain-wave]');
    chainWave.replaceChildren(new Option('Все волны', 'all'), ...(state.waves || []).map((w) => new Option(`Волна ${w.n}`, w.n)));
    chainWave.value = wave() ? String(wave().n) : 'all';
    const byWave = wave() ? state.pairs.filter((p) => (p.round > 1 ? p.round : 1) === wave().n) : state.pairs;
    const who = (id) => { const u = state.users.find((x) => x.id === id); return u ? `@${u.tg} ${u.name}` : ''; };
    const q = $('[data-pair-search]').value.trim().toLowerCase().replace(/^@/, '');
    const shownPairs = byWave.filter((p) => matchesPairFilters(p)
      && (!q || (who(p.santaId) + ' ' + who(p.recipientId) + ' ' + (p.track || '')).toLowerCase().includes(q)));
    $('[data-pairs-count]').textContent = shownPairs.length === byWave.length ? `${byWave.length} ${SantaCore.plural(byWave.length, 'пара', 'пары', 'пар')}` : `Показано ${shownPairs.length} из ${byWave.length}`;
    const person = (id, nick) => { const u = state.users.find((x) => x.id === id); return `<b>${esc(nick)}</b>${u ? `<small>${esc(u.name)}</small>` : ''}`; };
    if (!pairEdit) {
      // просмотр: без селектов и кнопок
      $('[data-pairs]').innerHTML = shownPairs.map((p) => `<tr class="${pairTone(p)}">
        <td>🌊 ${rnd(p)}${isDraftPair(p) ? '<small>черновик</small>' : ''}</td><td>${person(p.santaId, p.santa)}</td><td>🎁→</td>
        <td>${person(p.recipientId, p.recipient)}${p.priority ? '<small>⭐ приоритет</small>' : ''}</td>
        <td><span class="status ${p.status}">${STATUS[p.status]}</span>${p.status === 'assigned' && !isDraftPair(p) ? `<small>${p.ackAt ? '👍 собирает посылку' : '🤷 не подтвердил'}</small>` : ''}${p.sentAt ? `<small>${FX.fmtDateTime(p.sentAt)}</small>` : ''}${p.failed ? '<small class="bad">😢 не отправил</small>' : ''}</td>
        <td>${esc(p.track) || '—'}${p.photoId ? ` <button class="btn btn-ghost btn-sm" type="button" data-admin-photo="${p.photoId}" title="Фото к посылке">📷</button>` : p.tgPhoto ? ' <small>📷 в боте</small>' : ''}
          ${p.pickupCode ? `<small>📬 код: ${esc(p.pickupCode)}</small>` : ''}
          ${(p.pickupPhotos || []).map((id, i) => `<button class="btn btn-ghost btn-sm" type="button" data-admin-photo="${id}" title="Штрихкод / QR ${i + 1}">📷${(p.pickupPhotos || []).length > 1 ? i + 1 : ''}</button>`).join('')}
          ${(p.pickupTgPhotos || []).length ? `<small>📷 из бота, загружаются: ${(p.pickupTgPhotos || []).length}</small>` : ''}
          ${!isDraftPair(p) && !p.failed && p.status !== 'received' ? `<button class="btn btn-ghost btn-sm" type="button" data-pickup="${p.santaId}" data-round="${rnd(p)}" title="Прикрепить получателю код получения и сообщить «заказ приехал»">📬 ${p.pickupCode ? 'Изменить код' : 'Код получения'}</button>` : ''}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="muted">${byWave.length ? 'По фильтрам никого нет.' : 'Пар пока нет — нажмите «Раскидать людей».'}</td></tr>`;
      return;
    }
    const draft = (p) => ((state.waves || []).find((w) => w.n === rnd(p)) || {}).status === 'drawing';
    const swapBtn = (p, side) => (draft(p) ? `<button class="swap-btn" type="button" data-swap="${side}" data-uid="${side === 'santa' ? p.santaId : p.recipientId}" data-round="${rnd(p)}" title="${side === 'santa' ? 'Сменить получателя у этого Санты' : 'Сменить Санту у этого получателя'} (случайно)">🔄</button>` : '');
    $('[data-pairs]').innerHTML = shownPairs.map((p) => `<tr class="${pairTone(p)} ${lastSwapped.has(p.santaId) ? 'row-swapped' : ''}">
      <td>🌊 ${rnd(p)}${draft(p) ? '<small>черновик</small>' : ''}</td><td>${esc(p.santa)} ${swapBtn(p, 'santa')}</td><td>🎁→</td><td><div class="rec-cell"><button type="button" class="btn btn-ghost btn-sm" data-replace-recipient="${p.santaId}" data-round="${rnd(p)}" ${p.status === 'assigned' ? '' : 'disabled'}>${esc(p.recipient)} · Заменить</button>${swapBtn(p, 'recipient')}</div>${p.priority ? '<small>⭐ приоритет</small>' : ''}</td>
      <td><span class="status ${p.status}">${STATUS[p.status]}</span>${p.status === 'assigned' && !draft(p) ? `<small>${p.ackAt ? '👍 собирает посылку' : '🤷 не подтвердил'}</small>` : ''}${p.sentAt ? `<small>${FX.fmtDateTime(p.sentAt)}</small>` : ''}${p.failed ? '<small class="bad">😢 не отправил</small>' : ''}</td>
      <td>${esc(p.track) || '—'}</td>
      <td>${draft(p) ? '<span class="muted">после подтверждения</span>' : `<select data-pair="${p.santaId}" data-round="${rnd(p)}">${Object.keys(STATUS).map((k) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${STATUS[k]}</option>`).join('')}</select>`}
        ${p.status === 'assigned' && !p.sentAt ? `<details class="pair-actions"><summary>Действия с цепочкой</summary>
          <button type="button" class="btn btn-ghost btn-sm" data-chain-exclude="${p.santaId}" data-round="${rnd(p)}">Исключить Санту</button>
          <button type="button" class="btn btn-ghost btn-sm" data-chain-exclude="${p.recipientId}" data-round="${rnd(p)}">Исключить получателя</button>
          ${!p.failed && !draft(p) ? `<button type="button" class="btn btn-ghost btn-sm" data-rescue="${p.santaId}" data-round="${rnd(p)}">Отметить неотправку</button>` : ''}
        </details>` : ''}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="muted">${byWave.length ? 'По фильтрам никого нет.' : 'Пар пока нет — нажмите «Раскидать людей».'}</td></tr>`;
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
    if (unpair && confirm(`Снять участника с волны ${unpair.dataset.round}? Будут перестроены только пары этой волны.`)) {
      return act('/api/admin/remove-from-draw', { userId: unpair.dataset.unpair, round: Number(unpair.dataset.round) }, 'Участник снят с волны');
    }
    const exclude = e.target.closest('[data-chain-exclude]');
    if (exclude) {
      const body = { action: 'exclude', userId: exclude.dataset.chainExclude, round: Number(exclude.dataset.round) };
      exclude.disabled = true;
      try {
        const plan = await Api.post('/api/admin/chain', body, A);
        const user = state.users.find((u) => u.id === body.userId);
        reviewAction({
          title: `Исключить @${user.tg} из волны ${body.round}?`,
          detail: `После исключения: ${plan.summary}`,
          label: 'Исключить участника',
          apply: async () => {
            state = await Api.post('/api/admin/chain', { ...body, revision: plan.revision }, A);
            stateRevision++;
            lastSwapped = new Set(plan.changedSantas || []);
            const result = $('[data-chain-result]');
            result.textContent = `@${user.tg} исключён из волны ${body.round}. ${plan.summary}`;
            result.hidden = false;
            clearPairFilters();
            setWave(body.round);
          },
        });
      } catch (e) {
        const result = $('[data-chain-result]');
        result.textContent = e.message;
        result.hidden = false;
      } finally { exclude.disabled = false; }
      return;
    }
    const replace = e.target.closest('[data-replace-recipient]');
    if (replace) return openRecipientPicker(replace.dataset.replaceRecipient, Number(replace.dataset.round));
    if (e.target.closest('[data-pair-add]')) {
      const santaId = $('[data-pair-add-santa]').value;
      const recipientId = $('[data-pair-add-rec]').value;
      if (santaId && recipientId) return act('/api/admin/pair-set', { santaId, recipientId, round: wave() ? wave().n : undefined }, 'Получатель назначен');
    }
  });
  document.addEventListener('change', (e) => {
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
  const WST = { open: '📝 идёт запись', drawing: '🎲 ждёт подтверждения', drawn: '✅ пары у участников', closed: '⏹ остановлена' };
  const stCls = (st) => (st === 'closed' ? 'banned' : st === 'drawn' ? 'sent' : 'assigned');
  let lastSwapped = new Set(); // подсветка пар, изменённых последней кнопкой 🔄
  const wave = () => (curWave === 'all' ? null : (state.waves || []).find((w) => String(w.n) === String(curWave)) || null);
  const fd = (iso) => FX.fmtDate(iso);
  function setWave(v) {
    curWave = String(v);
    try { localStorage.setItem('adm_wave', curWave); } catch (e) { /* ignore */ }
    render();
    if (curWave === 'raffle') loadRaffle();
    if (curWave === 'service') {
      renderServiceUsers();
      loadServiceArchive().catch((e) => serviceMessage(e.message));
    }
  }
  const pRound = (p) => (p.round > 1 ? p.round : 1);
  const wavePairs = (n) => state.pairs.filter((p) => pRound(p) === n);
  const nicks = (ids) => ids.map((id) => { const u = state.users.find((x) => x.id === id); return u ? '@' + esc(u.tg) : '—'; });
  function waveMembers(n) {
    if (n === 1) return state.users.filter((u) => u.participation && !u.banned && (u.participation.round == null || u.participation.round === 1)).map((u) => u.id);
    return (state.wave2 || []).filter((x) => x.round === n && x.status === 'confirmed').map((x) => x.userId);
  }
  function renderWaveSwitch() {
    if (!['all', 'raffle', 'service'].includes(curWave) && !wave()) curWave = 'all';
    const w = wave();
    const sw = $('[data-wave-switch]');
    const open = sw.querySelector('[data-ws-menu]') && !sw.querySelector('[data-ws-menu]').hidden;
    sw.hidden = false;
    const last = (state.waves || [])[state.waves.length - 1];
    const isFinal = last && last.n >= SantaCore.FINAL_WAVE;
    const blocked = last && (last.status === 'open' || last.status === 'drawing');
    sw.innerHTML = `<button class="ws-btn" type="button" data-ws-toggle>${curWave === 'service' ? 'Сервисное меню' : curWave === 'raffle' ? '🎁 Розыгрыш' : w ? `🌊 Волна ${w.n}` : '📊 Все волны'} <span class="ws-caret">▾</span></button>
      <div class="ws-menu" data-ws-menu ${open ? '' : 'hidden'}>
        <button type="button" data-ws="all" class="${curWave === 'all' ? 'on' : ''}">📊 Все волны<small>сводка: кто что не сделал</small></button>
        ${(state.waves || []).map((x) => `<button type="button" data-ws="${x.n}" class="${w && w.n === x.n ? 'on' : ''}">🌊 Волна ${x.n}<small>${fd(x.start)} — ${fd(x.end)} · ${WST[x.status] || x.status}</small></button>`).join('')}
        ${isFinal ? `<button type="button" data-ws="raffle" class="${curWave === 'raffle' ? 'on' : ''}">🎁 Розыгрыш<small>общий для всех волн</small></button>` : ''}
        ${isFinal ? '' : `<button type="button" data-ws-new ${blocked ? 'disabled' : ''}>➕ Новая волна${last ? ` (${last.n + 1}-я)` : ''}<small>${blocked ? 'сначала жеребьёвка или остановка текущей' : 'лист ожидания получит приглашение'}</small></button>`}
        <button type="button" data-ws="service" class="${curWave === 'service' ? 'on' : ''}">Сервисное меню<small>архив анкет и перевод между волнами</small></button>
      </div>`;
  }
  function tiles(list) { $('[data-tiles]').innerHTML = list.map(([v, l, cls]) => `<div class="card tile ${cls || ''}"><b>${v}</b><span>${l}</span></div>`).join(''); }
  function renderWavePanel() {
    const host = $('[data-wave-panel]');
    if (host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const s = state.stats;
    const w = wave();
    const last = (state.waves || [])[state.waves.length - 1];
    const isFinal = last && last.n >= SantaCore.FINAL_WAVE;
    const canNew = last && !isFinal && last.status !== 'open' && last.status !== 'drawing';
    if (!w) {
      tiles([[s.users, 'аккаунтов'], [s.approved, 'одобрено'], [s.pending, 'ждут модерации'], [s.banned, 'в чёрном списке'], [s.sent, 'отправили'], [s.received, 'получили']]);
      const rows = (state.waves || []).map((x) => `<tr class="ws-row" data-ws="${x.n}">
        <td><b>🌊 ${x.n}</b></td><td>${fd(x.start)} — ${fd(x.end)}</td><td><span class="status ${stCls(x.status)}">${WST[x.status]}</span></td>
        <td>${x.members}${x.invited ? `<small>⏳ ждут подтверждения: ${x.invited}</small>` : ''}${x.pending ? `<small>⏳ модерация: ${x.pending}</small>` : ''}</td>
        <td>${x.pairs ? x.noAck : '—'}</td><td>${x.pairs ? `<b class="${x.notSent ? 'bad' : ''}">${x.notSent}</b>` : '—'}</td><td>${x.pairs ? x.sent : '—'}</td><td>${x.pairs ? x.received : '—'}</td><td>${x.failed || '—'}</td></tr>`).join('');
      const drafts = (state.waves || []).filter((x) => x.status === 'drawing').map((x) => `<div class="wd"><span class="draft-note">🎲 <b>Волна ${x.n}</b>: пары готовы (${x.pairs}), участники их ещё не видят — <a href="#" data-ws="${x.n}">откройте волну</a>, проверьте и подтвердите.</span></div>`).join('');
      const details = drafts + (state.waves || []).filter((x) => x.pairs && x.confirmedAt).map((x) => {
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
        ${isFinal ? '<p class="muted">Третья волна — финальная.</p>' : `<div class="actions"><button class="btn btn-ghost btn-sm" data-ws-new ${canNew ? '' : 'disabled'}>➕ Новая волна${last ? ` (${last.n + 1}-я)` : ''}</button>${canNew ? '' : '<span class="muted" style="font-size:13px">новую волну можно создать после жеребьёвки или остановки текущей</span>'}</div>`}`;
      return;
    }
    const ps = wavePairs(w.n);
    tiles([[w.members, 'участников'], [w.n === 1 ? w.pending : w.invited, w.n === 1 ? 'ждут модерации' : 'ждут подтверждения'], [w.pairs ? w.noAck : '—', '🤷 не подтвердили'], [w.pairs ? w.notSent : '—', '📦 не отправили', w.notSent && Date.parse(w.end) < Date.now() ? 'tile-bad' : ''], [w.sent, '🚚 отправили'], [w.received, '✅ получили']]);
    const info = w.status === 'drawing'
      ? `<span class="draft-note">🎲 Жеребьёвка проведена ${FX.fmtDateTime(w.drawnAt)}: <b>${ps.length}</b> ${SantaCore.plural(ps.length, 'пара', 'пары', 'пар')}. <b>Участники их пока не видят.</b> Проверьте пары ниже: кнопка 🔄 у Санты меняет ему получателя, у получателя — Санту (случайная замена, без повторов и «самому себе»). Когда всё устроит — нажмите «✅ Подтвердить жеребьёвку».</span>`
      : w.drawnAt
      ? `✅ Жеребьёвка подтверждена ${FX.fmtDateTime(w.confirmedAt || w.drawnAt)}: <b>${ps.length}</b> ${SantaCore.plural(ps.length, 'пара', 'пары', 'пар')} — участники видят своих получателей.`
      : `Жеребьёвки ещё не было. В раздачу попадут: <b>${w.members}</b>` + (w.n === 1 ? ' (одобренные модерацией)' : ' (подтвердившие участие)') + '.'
        + (w.pending ? ` <span class="important">Ждут модерации: ${w.pending}</span>.` : '') + (w.invited ? ` <span class="important">Ждут подтверждения: ${w.invited}</span> — в жеребьёвку не попадут.` : '');
    const isLast = last && last.n === w.n;
    host.innerHTML = `<h3>🌊 Волна ${w.n} <span class="status ${stCls(w.status)}">${WST[w.status]}</span></h3>
      <form class="ua-row" data-wave-dates="${w.n}">
        <label>Начало отправки (МСК)<input type="datetime-local" name="start" value="${toLocalInput(w.start)}"></label>
        <label>Конец отправки (МСК)<input type="datetime-local" name="end" value="${toLocalInput(w.end)}"></label>
        ${w.status === 'open' ? `<label>🎲 Автожеребьёвка (МСК)<input type="datetime-local" name="drawAt" value="${w.drawAt ? toLocalInput(w.drawAt) : ''}"></label>` : ''}
        <button class="btn btn-gold btn-sm">Сохранить</button>
      </form>
      ${w.status === 'open' ? `<p class="muted" style="font-size:13px;margin:4px 0 0">${w.drawAt ? (w.drawAtDone ? '⚠️ Автожеребьёвка не прошла — смотрите журнал событий.' : `⏰ Жеребьёвка пройдёт автоматически ${FX.fmtDateTime(w.drawAt)}. Участники ничего не увидят, пока вы не подтвердите пары.`) : 'Время автожеребьёвки не задано — можно раскидать вручную кнопкой ниже.'}</p>` : ''}
      <p class="muted">${info}</p>
      <div class="actions">
        ${w.n === 1 && w.pending ? `<button class="btn btn-green" data-approve-all>✅ Одобрить всех ожидающих (${w.pending})</button>` : ''}
        ${w.status === 'drawing' ? `<button class="btn btn-green" data-wave-confirm="${w.n}">✅ Подтвердить жеребьёвку</button>` : ''}
        ${w.status !== 'closed' ? `<button class="btn ${w.status === 'drawing' ? 'btn-ghost' : 'btn-primary'} shuffle-btn" data-wave-shuffle="${w.n}">🎲 ${w.drawnAt ? 'Перемешать заново' : 'Раскидать людей'}</button>` : ''}
        ${w.drawnAt && isLast && w.status !== 'closed' ? `<button class="btn btn-danger btn-sm" data-wave-reset="${w.n}">Сбросить пары</button>` : ''}
        ${w.status === 'drawing' ? '' : w.status !== 'closed' ? `<button class="btn btn-ghost btn-sm" data-wave-act="close" data-n="${w.n}" title="Напоминания этой волны перестанут приходить, жеребьёвка недоступна">⏹ Остановить волну</button>`
          : `<button class="btn btn-ghost btn-sm" data-wave-act="reopen" data-n="${w.n}">▶️ Возобновить волну</button>`}
        ${isLast && !isFinal ? `<button class="btn btn-ghost btn-sm" data-ws-new ${canNew ? '' : 'disabled title="Сначала проведите жеребьёвку или остановите волну"'}>➕ Создать ${w.n + 1}-ю волну</button>` : ''}
      </div>
      <p class="muted" style="font-size:13px;margin-top:12px">Жеребьёвка в два шага: сначала пары видите только вы, после «Подтвердить» — участники (и им приходят уведомления). Раздача случайная, никто не дарит сам себе, забаненные не участвуют.${w.n > 1 ? ' Участникам с ⭐ приоритетом достаётся надёжный Санта (уже отправлял подарок раньше).' : ''} Пары и участники ниже показаны только для этой волны. «Остановить» — когда волна закончилась: напоминания по ней больше не приходят; потом создайте следующую.</p>`;
  }
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-ws-toggle]');
    const menu = $('[data-ws-menu]');
    if (t) { menu.hidden = !menu.hidden; return; }
    if (menu && !menu.hidden && !e.target.closest('[data-wave-switch]')) menu.hidden = true;
    const ws = e.target.closest('[data-ws]');
    if (ws) { if (menu) menu.hidden = true; setWave(ws.dataset.ws); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (e.target.closest('[data-ws-new]')) {
      if (menu) menu.hidden = true;
      openNewWave();
      return;
    }
    const cf = e.target.closest('[data-wave-confirm]');
    if (cf) {
      const n = Number(cf.dataset.waveConfirm);
      const w = (state.waves || []).find((x) => x.n === n);
      if (!confirm(`Подтвердить жеребьёвку ${n}-й волны?\n\nВсе ${w.pairs} Сант увидят своих получателей в кабинете и получат уведомления (на сайте и в Telegram). На сайте появится «Жеребьёвка проведена».`)) return;
      if (await act('/api/admin/wave-confirm', { n }, 'Жеребьёвка подтверждена — участники видят получателей 🎅')) FX.burstFrom(cf, { count: 60, power: 15 });
      return;
    }
    const sw = e.target.closest('[data-swap]');
    if (sw) {
      sw.disabled = true;
      try {
        const res = await Api.post('/api/admin/pair-swap', { round: Number(sw.dataset.round), userId: sw.dataset.uid, side: sw.dataset.swap }, A);
        lastSwapped = new Set((res.swapped || []).map((x) => x.santaId));
        state = res;
        render();
        const nick = (id) => { const u = state.users.find((x) => x.id === id); return u ? '@' + u.tg : '—'; };
        FX.toast('🔄 Новые пары: ' + (res.swapped || []).map((x) => `${nick(x.santaId)} → ${nick(x.recipientId)}`).join(', '), 'success');
        setTimeout(() => { lastSwapped = new Set(); renderPairs(); }, 6000);
      } catch (ex) { FX.toast(ex.message, 'error'); sw.disabled = false; }
      return;
    }
    const sh = e.target.closest('[data-wave-shuffle]');
    if (sh) {
      const n = Number(sh.dataset.waveShuffle);
      const w = (state.waves || []).find((x) => x.n === n);
      const again = !!w.drawnAt;
      if (!confirm(again ? `Перемешать ${n}-ю волну заново? Её пары будут заменены` + (w.status === 'drawn' ? ', участники перестанут видеть получателей до нового подтверждения.' : '.') : `Раскидать ${n}-ю волну (${w.members} чел.)? Пары увидите только вы — участникам они откроются после «Подтвердить».` + (w.pending ? `\n\n⚠️ ${w.pending} анкет на модерации — в раздачу НЕ попадут.` : '') + (w.invited ? `\n\n⚠️ ${w.invited} чел. не подтвердили участие — в раздачу НЕ попадут.` : ''))) return;
      let force = false;
      if (again && wavePairs(n).some((p) => p.status !== 'assigned')) {
        if (!confirm('В этой волне кто-то уже отправил подарок! Всё равно перемешать?')) return;
        force = true;
      }
      sh.classList.add('shuffle-anim');
      const ok = await act('/api/admin/shuffle', { round: n, force }, 'Пары готовы — проверьте и подтвердите 🎲');
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
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-wave-dates]');
    if (!f) return;
    e.preventDefault();
    const n = Number(f.dataset.waveDates);
    const before = (state.waves || []).find((w) => w.n === n) || {};
    const body = { n, start: f.start.value + ':00+03:00', end: f.end.value + ':59+03:00' };
    if (f.drawAt) body.drawAt = f.drawAt.value ? f.drawAt.value + ':00+03:00' : '';
    if (!(await act('/api/admin/wave-set', body, 'Сохранено — на сайте даты уже обновились'))) return;
    // сроки поменялись — предложить сразу сообщить участникам волны
    const changed = Date.parse(before.start) !== Date.parse(body.start) || Date.parse(before.end) !== Date.parse(body.end);
    const ids = [...waveUserIds(n)];
    if (changed && ids.length && confirm(`Сроки ${n}-й волны изменены. Сообщить об этом её участникам (${ids.length} чел.) — на сайт и в Telegram?\n\n«…сроки отправки подарков изменились 📅 Теперь отправка — с ${FX.fmtDate(body.start)} по ${FX.fmtDate(body.end)}…» + кнопка «🎁 Кому я дарю»`)) {
      try {
        const tpl = BC_TEMPLATES.find((t) => t.label.startsWith('📅'));
        const r = await Api.post('/api/admin/broadcast', { text: tpl.text, userIds: ids, site: true, tg: true, buttons: [{ kind: 'whom' }] }, A);
        FX.toast(`Уведомление о новых сроках отправлено: ${r.sent}`, 'success');
        load();
      } catch (ex) { FX.toast(ex.message, 'error'); }
    }
  });
  // новая волна: даты (и время автожеребьёвки) задаёт организатор
  function openNewWave() {
    const last = (state.waves || [])[state.waves.length - 1];
    const n = last ? last.n + 1 : 1;
    const w = document.createElement('div');
    w.className = 'modal';
    w.innerHTML = `<div class="modal-backdrop" data-nw-close></div><div class="modal-card" role="dialog" aria-modal="true">
      <button class="modal-x" data-nw-close aria-label="Закрыть">✕</button>
      <div class="modal-head"><div class="modal-emoji">🌊</div><h3>Новая волна — ${n}-я</h3></div>
      <form class="form" data-nw-form>
        <p class="muted" style="margin:0">Укажите сроки — без них волна не создаётся. Новые участники будут записываться в неё, лист ожидания и участники прошлых волн получат приглашение.</p>
        <div class="row2">
          <label>Начало отправки (МСК)<input type="datetime-local" name="start" required></label>
          <label>Конец отправки (МСК)<input type="datetime-local" name="end" required></label>
        </div>
        <label>🎲 Автожеребьёвка (МСК, необязательно)<input type="datetime-local" name="drawAt"></label>
        <div class="form-err" data-err></div>
        <button class="btn btn-primary btn-block" type="submit">🌊 Создать ${n}-ю волну</button>
      </form></div>`;
    document.body.appendChild(w);
    requestAnimationFrame(() => w.classList.add('open'));
    const close = () => { w.classList.remove('open'); setTimeout(() => w.remove(), 250); };
    w.querySelectorAll('[data-nw-close]').forEach((b) => b.addEventListener('click', close));
    const f = w.querySelector('[data-nw-form]');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = f.querySelector('[data-err]');
      if (!f.start.value || !f.end.value) { err.textContent = 'Укажите начало и конец отправки'; return; }
      try {
        state = await Api.post('/api/admin/wave-create', { start: f.start.value + ':00+03:00', end: f.end.value + ':59+03:00', drawAt: f.drawAt.value ? f.drawAt.value + ':00+03:00' : undefined }, A);
        close();
        setWave(n);
        FX.toast(`${n}-я волна создана 🌊`, 'success');
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  // ---------- центр уведомлений ----------
  const BC_FILTERS = [
    ['form', '📝 С анкетой', (u) => !!u.participation],
    ['noform', '🚫 Без анкеты', (u) => !u.participation],
    ['pending', '⏳ На модерации', (u) => u.participation && u.participation.moderation === 'pending'],
    ['approved', '✅ Одобрены', (u) => u.participation && u.participation.moderation === 'approved'],
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
    { label: '🎅 Новые функции + сроки 2-й волны', filters: ['tg'], buttons: ['whom'], text: '{имя}, в Тайном Санте Кофеманьяков новое 🎅\n\n⚠️ 2-я волна: ОБРАТИТЕ ВНИМАНИЕ НА СРОКИ, ОНИ ИЗМЕНИЛИСЬ — с 30.11 до 15.12.\n\n💬 Анонимная переписка. Теперь можно написать своему получателю и уточнить, что он хочет. Получатель может ответить, а ещё написать своему Санте. Никто не узнает, кто есть кто. На каждом входящем сообщении есть кнопка «↩️ Ответить».\n\n➕ Дополнить пожелания. Вспомнили что-то после жеребьёвки? «📝 Моя анкета» → «➕ Дополнить пожелания». Ваш Санта сразу получит уведомление. Если поменяете анкету целиком, он тоже узнает.\n\n📷 Фото или QR-код к посылке. Когда отмечаете «📦 Я отправил подарок», можно прикрепить фото или QR-код для получения. Получатель увидит его у себя.\n\n👉 Нажмите /start — тогда в панели кнопок появится «💬 Переписка».\nНа сайте всё это есть в личном кабинете: «Кому я дарю», «Мой подарок» и «Моя анкета».' },
    { label: '💸 Бюджет 1000–1500 ₽', filters: ['form'], buttons: ['form'], text: 'Ребята, привет! 🎅\n\nМногие указали в пожеланиях подарки намного дороже бюджета. Напомним: мы дарим не парами, а ПО ЦЕПОЧКЕ. Тот, кому дарите вы, и тот, кто дарит вам, — разные люди. Поэтому ваш Санта не обязан тратить больше, чем договорились: 1000–1500 ₽.\n\nЕсли вы написали кофемолку, весы или что-то такое же дорогое, загляните, пожалуйста, в анкету. Добавьте варианты, которые укладываются в бюджет, или напишите, что дорогая вещь — только мечта. Так Санте будет проще выбрать 🙏\n\nКак дополнить: «📝 Моя анкета» → «➕ Дополнить пожелания». Ваш Санта сразу увидит.' },
    { label: '📅 Сроки волны изменены', filters: [], buttons: ['whom'], text: '{имя}, внимание: сроки отправки подарков изменились 📅 Теперь отправка — с {начало} по {срок} ({осталось}). Пожалуйста, успейте отправить подарок вовремя!' },
    { label: '⏰ Напоминание о сроке', filters: ['notsent'], buttons: ['sent'], text: '{имя}, привет! Это организаторы Тайного Санты Кофеманьяков 🎅 Напоминаем: подарок нужно отправить до {срок} ({осталось}). Когда отправите — отметьте это в личном кабинете на santa.speccof.ru и добавьте трек-номер 🎁' },
    { label: '📦 Вы уже отправили?', filters: ['notsent'], buttons: ['sent'], text: '{имя}, привет! Вы уже отправили подарок своему получателю? Если да — пожалуйста, отметьте отправку в личном кабинете на santa.speccof.ru (можно с трек-номером), чтобы получатель знал, что посылка в пути. Если ещё нет — срок до {срок} ({осталось}).' },
    { label: '🔥 Срок прошёл', filters: ['notsent'], buttons: ['sent'], text: '{имя}, срок отправки подарка закончился {срок}, а отметки об отправке у нас нет 😟 Пожалуйста, отправьте подарок в ближайшие 2 дня и отметьте это в личном кабинете на santa.speccof.ru. Если что-то случилось — просто ответьте на это сообщение, мы поможем.' },
    { label: '🛑 Последнее предупреждение', filters: ['notsent'], text: '{имя}, это последнее напоминание: подарок так и не отправлен. Если до завтра отправки не будет, мы передадим вашего получателя другому Санте, а вы попадёте в чёрный список Тайного Санты Кофеманьяков 🛑 Если есть уважительная причина — ответьте на это сообщение.' },
    { label: '📝 Заполните анкету', filters: ['noform'], buttons: ['form'], text: '{имя}, привет! Вы зарегистрировались в Тайном Санте Кофеманьяков, но не заполнили анкету — без неё в жеребьёвку не попасть 🎅 Заполните её на santa.speccof.ru (раздел «Личный кабинет»).' },
    { label: '🎁 Отметьте получение', filters: ['waiting'], buttons: ['received'], text: '{имя}, привет! Ваш Тайный Санта уже отправил вам подарок 🎁 Когда получите посылку — отметьте это в личном кабинете на santa.speccof.ru. Спасибо!' },
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
    setBcButtons(t.buttons || []);
    // включаем подходящие фильтры «Кому»
    bcActive.clear();
    t.filters.forEach((k) => bcActive.add(k));
    $$('[data-bc-f]').forEach((x) => { x.checked = bcActive.has(x.dataset.bcF); });
    bcSyncFromFilters();
    renderBroadcast();
    FX.toast('Фраза вставлена, получатели отобраны по фильтру — проверьте список', 'success');
  });
  // кнопки под рассылкой
  const BC_BUTTONS = [['whom', '🎁 Кому я дарю'], ['sent', '📦 Я отправил подарок'], ['received', '🎉 Я получил подарок'], ['wave', '🌊 Следующие волны'], ['form', '📝 Моя анкета'], ['site', '🌐 Открыть сайт'], ['link', '🔗 Своя ссылка']];
  $('[data-bc-buttons]').innerHTML = BC_BUTTONS.map(([k, l]) => `<label class="chip"><input type="checkbox" data-bc-btn="${k}"><span>${l}</span></label>`).join('');
  const setBcButtons = (kinds) => { $$('[data-bc-btn]').forEach((x) => { x.checked = kinds.includes(x.dataset.bcBtn); }); $('[data-bc-link]').hidden = !kinds.includes('link'); };
  document.addEventListener('change', (e) => { if (e.target.closest('[data-bc-btn="link"]')) $('[data-bc-link]').hidden = !e.target.checked; });
  function bcButtons() {
    const f = $('[data-bc-form]');
    const list = $$('[data-bc-btn]:checked').map((x) => x.dataset.bcBtn).filter((k) => k !== 'link').map((kind) => ({ kind }));
    if ($('[data-bc-btn="link"]').checked) {
      const url = f.linkUrl.value.trim();
      if (!/^https:\/\//i.test(url)) throw new Error('Своя ссылка: укажите адрес, начинающийся с https://');
      list.push({ text: f.linkText.value.trim() || 'Открыть', url });
    }
    return list;
  }
  const bcActive = new Set();
  const bcPicked = new Set();
  let bcTouched = false; // пока галочки не трогали руками — список следует за фильтрами
  $('[data-bc-filters]').innerHTML = BC_FILTERS.map(([k, label]) => `<label class="chip"><input type="checkbox" data-bc-f="${k}"><span>${label}</span></label>`).join('');
  // в выбранной волне — только её участники; все — во вкладке «📊 Все волны»
  const bcPool = () => { const w = wave(); const ids = w ? waveUserIds(w.n) : null; return state.users.filter((u) => !ids || ids.has(u.id)); };
  const bcMatch = () => bcPool().filter((u) => BC_FILTERS.every(([k, , fn]) => !bcActive.has(k) || fn(u)));
  function bcSyncFromFilters() { bcPicked.clear(); bcMatch().forEach((u) => bcPicked.add(u.id)); bcTouched = false; }
  function renderBroadcast() {
    if (!bcTouched) bcSyncFromFilters();
    [...bcPicked].forEach((id) => { { const pool = bcPool(); if (!pool.some((u) => u.id === id)) bcPicked.delete(id); } });
    const q = $('[data-bc-search]').value.trim().toLowerCase();
    const match = new Set(bcMatch().map((u) => u.id));
    const list = bcPool()
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
      <td>${b.site ? '🌐' : ''} ${b.tg ? '✈️' : ''} ${b.userTg ? '👤' : ''}${(b.buttons || []).length ? `<small>кнопки: ${b.buttons.map((x) => esc(x.text)).join(', ')}</small>` : ''}</td>
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
      const r = await Api.post('/api/admin/broadcast', { text, userIds: [...bcPicked], site: f.site.checked, tg: f.tg.checked, userTg: f.userTg.checked, buttons: bcButtons() }, A);
      FX.toast(`Отправлено: ${r.sent}` + (r.viaUser ? ` · с аккаунта организатора в очереди: ${r.viaUser}` : ''), 'success');
      f.text.value = '';
      delete f.text.dataset.tpl;
      setBcButtons([]);
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
    if (location.hash === '#service') curWave = 'service';
    if (location.hash === '#raffle') curWave = 'raffle';
    if (location.hash === '#chains') {
      if (curWave === 'raffle') curWave = 'all';
      $('#chains').open = true;
    }
    render();
    if (curWave === 'raffle') await loadRaffle();
    if (curWave === 'service') {
      renderServiceUsers();
      await loadServiceArchive().catch((e) => serviceMessage(e.message));
    }
  }

  (async () => {
    await FX.chrome();
    if (!Api.adminToken()) return showLogin();
    try { await load(); } catch (e) { showLogin(); }
    setInterval(async () => {
      if ($('[data-dash]').hidden) return;
      if (curWave === 'raffle' || curWave === 'service') return;
      const revision = stateRevision;
      try {
        const next = await Api.get('/api/admin/state', A);
        if (revision !== stateRevision) return;
        state = next;
        render();
      } catch (e) { /* refresh on the next tick */ }
    }, 20000);
  })();
})();
