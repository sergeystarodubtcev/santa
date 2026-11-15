'use strict';
/*
 * Telegram-бот Тайного Санты Кофеманьяков.
 *
 * Работает внутри облачной функции: Telegram шлёт обновления на /api/tg/webhook,
 * а таймер раз в день вызывает напоминания. Бот ничего не отправляет сам — он складывает
 * исходящие сообщения в массив `out`; функция сначала сохраняет базу, потом отправляет их.
 *
 * Всё про участников (регистрация, анкета, отправка) идёт через core.handle — те же проверки, что на сайте.
 */
const crypto = require('node:crypto');
let Cities = null;
try { Cities = require('./cities.js'); } catch (e) { try { Cities = require('../public/js/cities.js'); } catch (e2) { /* без проверки города */ } }

const DAY = 24 * 60 * 60 * 1000;
const MSK = 3 * 60 * 60 * 1000;
const mskDay = (t) => Math.floor((t + MSK) / DAY);
const fmtDay = (iso) => new Date(Date.parse(iso)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plural = (n, a, b, c) => { const x = Math.abs(n) % 100, y = x % 10; return x > 10 && x < 20 ? c : y > 1 && y < 5 ? b : y === 1 ? a : c; };

const BTN = {
  whom: '🎅 Кому я дарю',
  sent: '📦 Я отправил подарок',
  form: '📝 Моя анкета',
  got: '🎉 Я получил подарок',
  help: '🆘 Помощь администратора',
  wave: '🌊 Следующие волны',
  chat: '💬 Переписка',
  done: '✅ Готово',
};
const MAIN_KB = { keyboard: [[{ text: BTN.whom }, { text: BTN.sent }], [{ text: BTN.form }, { text: BTN.got }], [{ text: BTN.chat }, { text: BTN.wave }], [{ text: BTN.help }]], resize_keyboard: true };
const ADM = { status: '📊 Статус', send: '📣 Рассылка', who: '🔎 Досье' };
const ADMIN_KB = { keyboard: MAIN_KB.keyboard.concat([[{ text: ADM.status }, { text: ADM.send }], [{ text: '🛡 Модерация' }, { text: ADM.who }]]), resize_keyboard: true };
const HELP_KB = { keyboard: [[{ text: BTN.done }]], resize_keyboard: true };
const ib = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => (/^https?:/.test(data) ? { text, url: data } : { text, callback_data: data }))) });
const WHOM_BTN = ib([[['🎁 Узнать кому', 'whom']]]);
const WHOM_WAVE_BTN = ib([[['🎁 Узнать кому', 'whom']], [['🌊 Следующие волны', 'wave']]]);
const WAVEJOIN_BTN = ib([[['🌊 Записаться в новую волну', 'wave']]]);
const PREFS_BTN = ib([[['☕ Кофейное', 'prefs:coffee'], ['🧸 Некофейное', 'prefs:noncoffee']], [['🎲 Удивите меня', 'prefs:any']]]);
const SKIP_BTN = ib([[['Пропустить →', 'skip']]]);
const W2_BTN = ib([[['✅ Да, участвую в новой волне', 'w2:yes']], [['🙅 Нет, не буду', 'w2:no']]]);

function createBot({ core, secret, siteUrl, username }) {
  const sign = (s) => crypto.createHmac('sha256', secret).update('tg:' + s).digest('base64url').slice(0, 16);

  // Ссылка для кнопки «Подписаться» в личном кабинете: t.me/bot?start=<uid>_<подпись>
  function linkUrl(uid, help) {
    return `https://t.me/${username}?start=${help ? 'help-' : ''}${uid}_${sign(uid)}`;
  }
  function verifyStart(param) {
    param = String(param || '').replace(/^help-/, '');
    const i = String(param || '').indexOf('_');
    if (i < 1) return null;
    const uid = param.slice(0, i);
    return param.slice(i + 1) === sign(uid) ? uid : null;
  }

  const userByChat = (db, chatId) => db.users.find((u) => u.tgChatId === chatId);
  const isAdmin = (db, chatId) => (db.tgAdmins || []).includes(chatId);

  function call(db, ctx, method, path, body, as) {
    return core.handle(db, Object.assign({}, ctx, as), method, path, body).data;
  }

  function statusLine(db, u) {
    const p = db.participations[u.id];
    if (!p) return 'Анкета ещё не заполнена — без неё в жеребьёвку не попасть.';
    const m = core.modStatus(p);
    if (m === 'approved') return 'Анкета одобрена ✅ Вы в жеребьёвке.';
    if (m === 'rejected') return 'Анкета не прошла модерацию 🚫' + (p.moderationNote ? ' Причина: ' + esc(p.moderationNote) : '') + ' Исправьте её.';
    return 'Анкета на модерации ⏳ Организаторы проверят её перед жеребьёвкой.';
  }

  // ---------- панель организатора: статус по волнам, списки, напоминания, рассылка ----------
  const ADM_CATS = {
    noack: { label: '🤷 Не подтвердили, что собирают', text: '{имя}, жеребьёвка прошла! 🎅 Подтвердите, пожалуйста, что участвуете и собираете посылку: «Кому я дарю» → «✅ Участвую, собираю посылку» (здесь в боте или в личном кабинете на santa.speccof.ru).' },
    notsent: { label: '📦 Не отправили', text: '{имя}, напоминаем: подарок нужно отправить до {срок} ({осталось}). Когда отправите — нажмите «📦 Я отправил подарок» и добавьте трек или фото QR-кода 🎁' },
    notgot: { label: '🎁 Не отметили получение', text: '{имя}, ваш Тайный Санта уже отправил подарок 🎁 Когда получите посылку — отметьте «🎉 Я получил подарок». Спасибо!' },
    invited: { label: '⏳ Не подтвердили участие в волне', text: '{имя}, подтвердите, пожалуйста, участие в новой волне Тайного Санты — кнопка «🌊 Следующие волны» здесь в боте или карточка в личном кабинете на santa.speccof.ru.' },
    noform: { label: '📝 Без анкеты', text: '{имя}, вы зарегистрировались в Тайном Санте Кофеманьяков, но не заполнили анкету — без неё в жеребьёвку не попасть 🎅 Заполните её здесь в боте («📝 Моя анкета») или на santa.speccof.ru.' },
    nobot: { label: '🔕 Без бота', text: '{имя}, подключите, пожалуйста, бота Тайного Санты — он напомнит о сроках и подскажет, кому дарить: личный кабинет на santa.speccof.ru → «🔔 Подписаться на уведомления».' },
    all: { label: '👥 Все участники', text: '' },
  };
  const admState = (db, ctx) => call(db, ctx, 'GET', '/api/admin/state', null, { isAdmin: true });
  // кто попадает в категорию (n — номер волны; для nobot/noform/all волна не важна)
  function admPeople(st, cat, n) {
    const pr = (p) => (p.round > 1 ? p.round : 1);
    const wave = (st.waves || []).find((w) => w.n === n) || {};
    const live = wave.confirmedAt ? st.pairs.filter((p) => pr(p) === n && !p.failed) : [];
    const ids = cat === 'noack' ? live.filter((p) => p.status === 'assigned' && !p.ackAt).map((p) => p.santaId)
      : cat === 'notsent' ? live.filter((p) => p.status === 'assigned').map((p) => p.santaId)
      : cat === 'notgot' ? live.filter((p) => p.status === 'sent').map((p) => p.recipientId)
      : cat === 'invited' ? (st.wave2 || []).filter((w) => w.round === n && w.status === 'invited').map((w) => w.userId)
      : cat === 'noform' ? st.users.filter((u) => !u.participation && !u.banned).map((u) => u.id)
      : cat === 'nobot' ? st.users.filter((u) => u.participation && !u.banned && !u.tgLinked).map((u) => u.id)
      : st.users.filter((u) => u.participation && !u.banned).map((u) => u.id);
    return [...new Set(ids)].map((id) => st.users.find((u) => u.id === id)).filter(Boolean);
  }
  // ---------- «🔎 Досье»: организатор присылает @ник (или телефон / имя) — бот отвечает всем, что знает о человеке ----------
  const fmtDT = (ms) => (ms ? new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '');
  function findUsers(db, q) {
    const raw = String(q || '').trim();
    const t = raw.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase();
    if (!t) return [];
    const exact = db.users.filter((u) => (u.tg || '').toLowerCase() === t);
    if (exact.length) return exact;
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 6) {
      const byPhone = db.users.filter((u) => (u.phone || '').replace(/\D/g, '').endsWith(digits.slice(-10)));
      if (byPhone.length) return byPhone;
    }
    return db.users.filter((u) => {
      const p = db.participations[u.id] || {};
      return [(u.tg || ''), (u.name || ''), (p.fullName || '')].some((x) => x.toLowerCase().includes(t));
    });
  }
  function dossier(db, uid) {
    const u = db.users.find((x) => x.id === uid);
    if (!u) return 'Не нашёл такого участника.';
    const who = (id) => { const x = db.users.find((y) => y.id === id); if (!x) return '(аккаунт удалён)'; const pp = db.participations[x.id]; return `${esc(x.name)} @${esc(x.tg)}` + (pp && pp.fullName ? ` (${esc(pp.fullName)})` : ''); };
    const p = db.participations[uid];
    const L = [`🔎 <b>Досье: ${esc(u.name)}</b> @${esc(u.tg)}`,
      `📱 ${esc(u.phone || '—')} · ${u.tgChatId ? '✈️ бот подключён' : '🔕 бот не подключён'}` + (u.banned ? ' · 🛑 в чёрном списке' : ''),
      `🗓 Зарегистрирован: ${fmtDT(u.createdAt) || '—'}`];
    if (!p) L.push('', '📝 Анкета не заполнена.');
    else {
      const mod = core.modStatus(p);
      L.push('', `📝 <b>Анкета</b> (${mod === 'approved' ? '✅ одобрена' : mod === 'rejected' ? '🚫 отклонена' : '⏳ на модерации'}${p.round > 1 ? `, записался в ${p.round}-ю волну` : ''})`,
        `ФИО: ${esc(p.fullName || '—')}`, `ПВЗ: ${esc(p.address || '—')}`, `Тематика: ${esc(core.PREFS[p.prefs] || p.prefs || '—')}`,
        `Пожелания: ${esc(p.wishes || '—')}`, `Пометки: ${esc(p.notes || '—')}`);
      if (p.moderationNote) L.push(`Комментарий модерации: ${esc(p.moderationNote)}`);
      for (const [n, a] of Object.entries((db.waveAnketas || {})[uid] || {})) {
        if (!a || (a.wishes === p.wishes && a.address === p.address && a.notes === p.notes)) continue;
        L.push(`↳ анкета ${n === 'next' ? 'следующей' : n + '-й'} волны: ПВЗ ${esc(a.address || '—')}; пожелания: ${esc(a.wishes || '—')}` + (a.notes ? `; пометки: ${esc(a.notes)}` : ''));
      }
    }
    const w2 = (db.wave2 || {})[uid];
    if (w2) L.push('', `🌊 Следующая волна: ${{ waiting: 'в листе ожидания', invited: 'приглашён, не подтвердил', confirmed: 'подтвердил участие', declined: 'отказался' }[w2.status] || w2.status}` + (w2.round ? ` (${w2.round}-я)` : '') + (w2.reason === 'victim' ? ' · ⭐ приоритет: Санта не отправил ему подарок' : ''));
    const wst = (n) => { const w = (db.waves || []).find((x) => x.n === n); return w && w.status === 'drawing' ? ' · 🎲 черновик, не подтверждён' : ''; };
    const pst = (x) => x.failed ? '❌ не отправлено, пара снята'
      : x.status === 'received' ? `🥳 получено ${fmtDT(x.receivedAt)}`
      : x.status === 'sent' ? `🚚 отправлено ${fmtDT(x.sentAt)}` + (x.track ? `, трек ${esc(x.track)}` : '') + (x.photoId || x.tgPhoto ? ', 📷 есть фото' : '')
      : x.ackAt ? `✅ подтвердил сборы ${fmtDT(x.ackAt)}, ещё не отправил` : '⏳ не подтвердил сборы, не отправил';
    const outs = db.pairs.filter((x) => x.santaId === uid), ins = db.pairs.filter((x) => x.recipientId === uid);
    const rn = (x) => core.pairRound(x);
    if (!outs.length && !ins.length) L.push('', '🎲 Пар пока нет.');
    for (const x of outs) {
      const rp = db.participations[x.recipientId] || {};
      L.push('', `🎅 <b>Дарит</b> (${rn(x)}-я волна${wst(rn(x))}): ${who(x.recipientId)}`, `   ПВЗ: ${esc(rp.address || '—')} · 📱 ${esc((db.users.find((y) => y.id === x.recipientId) || {}).phone || '—')}`,
        `   Пожелания: ${esc(rp.wishes || '—')}`, `   Статус: ${pst(x)}`);
    }
    for (const x of ins) L.push('', `🎁 <b>Ему дарит</b> (${rn(x)}-я волна${wst(rn(x))}): ${who(x.santaId)}`, `   Статус: ${pst(x)}`);
    const msgs = (db.messages || []).filter((m) => m.santaId === uid || m.recipientId === uid);
    if (msgs.length) L.push('', `💬 Анонимная переписка: ${msgs.length} ${core.plural(msgs.length, 'сообщение', 'сообщения', 'сообщений')}`);
    const t = L.join('\n');
    return t.length > 4000 ? t.slice(0, 3990) + '…' : t;
  }
  function admWho(db, out, chatId, q) {
    const list = findUsers(db, q);
    if (!list.length) { out.push({ chat_id: chatId, text: `Никого не нашёл по «${esc(q)}». Пришлите @ник, телефон или имя. /cancel — выход.` }); return; }
    if (list.length > 1) {
      out.push({ chat_id: chatId, text: `Нашёл ${list.length}. Кого показать?`, reply_markup: ib(list.slice(0, 10).map((u) => [[`${u.name} @${u.tg}`, 'adm:who:' + u.id]])) });
      return;
    }
    out.push({ chat_id: chatId, text: dossier(db, list[0].id) });
  }

  const WST = { open: '📝 идёт запись', drawing: '🎲 ждёт вашего подтверждения', drawn: '✅ пары у участников', closed: '⏹ остановлена' };
  function admStatus(db, ctx, out, chatId, n) {
    const st = admState(db, ctx);
    const waves = st.waves || [];
    const w = waves.find((x) => x.n === n) || waves.filter((x) => x.status !== 'closed').pop() || waves[waves.length - 1];
    const cnt = (cat) => admPeople(st, cat, w.n).length;
    const lines = [
      `📊 <b>Волна ${w.n}</b> · ${WST[w.status] || w.status}`,
      `Отправка: ${fmtDay(w.start)} — ${fmtDay(w.end)}`,
      `Участников: ${w.members}` + (w.pending ? ` · на модерации: ${w.pending}` : '') + (w.invited ? ` · ждут подтверждения: ${w.invited}` : ''),
    ];
    if (w.confirmedAt) lines.push(`Пар: ${w.pairs} · 🤷 не подтвердили: ${w.noAck} · 📦 не отправили: ${w.notSent} · 🚚 отправили: ${w.sent} · ✅ получили: ${w.received}` + (w.failed ? ` · 😢 ${w.failed}` : ''));
    else if (w.status === 'drawing') lines.push('🎲 Пары готовы — проверьте и подтвердите в админке на сайте.');
    lines.push('', `Всего аккаунтов: ${st.stats.users} · без анкеты: ${cnt('noform')} · без бота: ${cnt('nobot')}` + (st.waitlist ? ` · лист ожидания: ${st.waitlist}` : ''));
    const rows = [];
    const add = (cat) => { const c = cnt(cat); if (c) rows.push([[`${ADM_CATS[cat].label} (${c})`, `adm:l:${cat}:${w.n}`]]); };
    if (w.confirmedAt) ['noack', 'notsent', 'notgot'].forEach(add);
    if (w.n > 1) add('invited');
    add('noform'); add('nobot');
    if (waves.length > 1) rows.push(waves.map((x) => [(x.n === w.n ? '• ' : '') + `Волна ${x.n}`, `adm:st:${x.n}`]));
    rows.push([['🔄 Обновить', `adm:st:${w.n}`], ['📣 Рассылка', 'adm:send']]);
    out.push({ chat_id: chatId, text: lines.join('\n'), reply_markup: ib(rows) });
  }
  function admList(db, ctx, out, chatId, cat, n) {
    const st = admState(db, ctx);
    const people = admPeople(st, cat, n);
    const C = ADM_CATS[cat];
    if (!people.length) { out.push({ chat_id: chatId, text: `${C.label}: никого 🎉` }); return; }
    const shown = people.slice(0, 60).map((u) => `@${esc(u.tg)} — ${esc(u.name)}${u.tgLinked ? '' : ' 🔕'}`);
    const withBot = people.filter((u) => u.tgLinked).length;
    out.push({
      chat_id: chatId,
      text: `<b>${C.label}</b>${['all', 'noform', 'nobot'].includes(cat) ? '' : ` · волна ${n}`} — ${people.length}:\n` + shown.join('\n') + (people.length > 60 ? `\n…и ещё ${people.length - 60}` : '') + (withBot < people.length ? '\n\n🔕 — бот не подключён (увидит только на сайте)' : ''),
      reply_markup: ib([
        [[`📣 Напомнить (${people.length})`, `adm:r:${cat}:${n}`], ['✏️ Свой текст', `adm:o:${cat}:${n}`]],
        [['📋 Текст для общего чата', `adm:c:${cat}:${n}`]],
        [['⬅️ К статусу', `adm:st:${n}`]],
      ]),
    });
  }
  // подтверждение рассылки: показываем текст и кому, отправка — только по кнопке
  function admConfirm(db, ctx, out, chatId, cat, n, text) {
    const st = admState(db, ctx);
    const people = admPeople(st, cat, n);
    if (!people.length) { out.push({ chat_id: chatId, text: 'Отправлять некому 🎉' }); return; }
    db.tgState[chatId] = { flow: 'admsend', cat, n, text, ids: people.map((u) => u.id) };
    const acc = st.userAcc || {};
    const canUser = acc.enabled !== false && ['ready', 'limited'].includes(acc.status) && people.some((u) => !u.tgLinked);
    const rows = [[['✅ Отправить: сайт + бот', 'adm:go']]];
    if (canUser) rows.push([['✅ Отправить + 👤 с аккаунта тем, у кого нет бота', 'adm:gou']]);
    rows.push([['✏️ Изменить текст', `adm:o:${cat}:${n}`], ['✖️ Отмена', 'adm:x']]);
    out.push({
      chat_id: chatId,
      text: `📣 <b>Проверьте рассылку</b>\nКому: ${ADM_CATS[cat].label}${['all', 'noform', 'nobot'].includes(cat) ? '' : ` · волна ${n}`} — ${people.length} чел. (с ботом — ${people.filter((u) => u.tgLinked).length})\n\n<i>${esc(text)}</i>\n\n{имя}, {срок}, {осталось} подставятся каждому свои.`,
      reply_markup: ib(rows),
    });
  }
  function admSendMenu(out, chatId) {
    out.push({
      chat_id: chatId,
      text: '📣 <b>Рассылка</b> — кому написать? Дальше можно взять готовый текст или написать свой.\nПо отдельной волне — через «📊 Статус».',
      reply_markup: ib([[[ADM_CATS.all.label, 'adm:o:all:0']], [[ADM_CATS.noform.label, 'adm:l:noform:0']], [[ADM_CATS.nobot.label, 'adm:l:nobot:0']], [['📊 По волнам — через статус', 'adm:st']]]),
    });
  }
  function admCallback(db, ctx, out, chatId, d) {
    const [, act, cat, nRaw] = d.split(':');
    const n = Number(nRaw) || 0;
    const st0 = db.tgState[chatId];
    if (act === 'st') return admStatus(db, ctx, out, chatId, Number(cat) || 0);
    if (act === 'who') { out.push({ chat_id: chatId, text: dossier(db, cat) }); return; }
    if (act === 'send') return admSendMenu(out, chatId);
    if (act === 'l') return admList(db, ctx, out, chatId, cat, n);
    if (act === 'r') return admConfirm(db, ctx, out, chatId, cat, n, ADM_CATS[cat].text);
    if (act === 'o') {
      db.tgState[chatId] = { flow: 'admtext', cat, n };
      out.push({ chat_id: chatId, text: `✏️ Напишите текст для «${ADM_CATS[cat].label}» одним сообщением. Можно использовать {имя}, {срок}, {осталось}. /cancel — отмена.` });
      return;
    }
    if (act === 'c') {
      const people = admPeople(admState(db, ctx), cat, n);
      const tail = ADM_CATS[cat].text.replace(/^\{имя\}, /, '').replace(/\{срок\}|\{осталось\}|\{имя\}/g, (m) => (m === '{срок}' ? 'конца отправки' : ''));
      const body = tail ? tail[0].toUpperCase() + tail.slice(1) : 'Ваш текст';
      out.push({ chat_id: chatId, text: people.length ? `Ребята! 👋\n${people.map((u) => '@' + u.tg).join('\n')}\n\n${body}` : 'Никого 🎉' });
      out.push({ chat_id: chatId, text: '☝️ Перешлите или скопируйте это сообщение в общий чат.' });
      return;
    }
    if (act === 'x') { delete db.tgState[chatId]; out.push({ chat_id: chatId, text: 'Отменил.', reply_markup: ADMIN_KB }); return; }
    if ((act === 'go' || act === 'gou') && st0 && st0.flow === 'admsend') {
      delete db.tgState[chatId];
      try {
        const BTN_FOR = { noack: 'whom', notsent: 'sent', notgot: 'received', invited: 'wave', noform: 'form', nobot: 'site' };
        const r = call(db, ctx, 'POST', '/api/admin/broadcast', { text: st0.text, userIds: st0.ids, site: true, tg: true, userTg: act === 'gou',
          buttons: BTN_FOR[st0.cat] ? [{ kind: BTN_FOR[st0.cat] }] : [] }, { isAdmin: true });
        out.push({ chat_id: chatId, text: `✅ Отправлено: ${r.sent} чел.` + (r.viaUser ? ` С аккаунта организатора в очереди: ${r.viaUser}.` : '') + ' Рассылка видна в админке в «Отправленных».', reply_markup: ADMIN_KB });
      } catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) }); }
      return;
    }
    out.push({ chat_id: chatId, text: 'Эта кнопка устарела — откройте «📊 Статус» заново.' });
  }

  function modPanel(db, out, chatId) {
    const on = !!db.settings.moderation;
    const pending = db.users.filter((u) => !u.banned && db.participations[u.id] && core.modStatus(db.participations[u.id]) === 'pending').length;
    out.push({
      chat_id: chatId,
      text: `🛡 <b>Модерация анкет: ${on ? 'ВКЛЮЧЕНА' : 'ВЫКЛЮЧЕНА'}</b>\n` + (on
        ? `Новые анкеты ждут вашего решения — я пришлю их с кнопками «Одобрить / Отклонить».${pending ? `\nСейчас ждут: ${pending}.` : ''}`
        : 'Все анкеты сразу попадают в игру. О каждой новой я всё равно напишу — с кнопкой «Отклонить», если что-то не так.'),
      reply_markup: ib([[on ? ['🔓 Выключить модерацию', 'modset:off'] : ['🔒 Включить модерацию', 'modset:on']]]),
    });
  }

  function greet(out, db, chatId, u) {
    const p = db.participations[u.id];
    out.push({
      chat_id: chatId,
      text: `Привет, <b>${esc(u.name)}</b>! ☕\nЯ бот Тайного Санты Кофеманьяков. Напомню, когда начнётся жеребьёвка, подскажу, кому дарить, и не дам пропустить сроки отправки.\n\n${statusLine(db, u)}`,
      reply_markup: isAdmin(db, chatId) ? ADMIN_KB : MAIN_KB,
    });
    if (!p) out.push({ chat_id: chatId, text: 'Заполним анкету прямо здесь?', reply_markup: ib([[['🎁 Заполнить анкету', 'form']]]) });
  }

  function link(db, out, chatId, u) {
    db.users.forEach((x) => { if (x.tgChatId === chatId && x.id !== u.id) delete x.tgChatId; });
    u.tgChatId = chatId;
    greet(out, db, chatId, u);
  }

  // ---------- помощь администратора ----------
  const nickOf = (db, id) => { const u = db.users.find((x) => x.id === id); return u ? '@' + u.tg : '—'; };
  const ST = { assigned: 'ждёт отправки', sent: 'отправлено', received: 'получено' };
  function pairInfo(db, u) {
    if (!u) return 'аккаунта на сайте нет';
    const out = db.pairs.find((p) => p.santaId === u.id);
    const inc = db.pairs.find((p) => p.recipientId === u.id);
    return `дарит: ${out ? nickOf(db, out.recipientId) + ' (' + ST[out.status] + ')' : '—'}; его Санта: ${inc ? nickOf(db, inc.santaId) + ' (' + ST[inc.status] + ')' : '—'}`;
  }
  function helpKey(u, from) { return u ? u.tg : String(from.username || 'id' + from.id).toLowerCase(); }
  function startHelp(db, out, chatId, from) {
    const u = userByChat(db, chatId);
    const key = helpKey(u, from);
    db.tgState[chatId] = { flow: 'help', uid: u && u.id };
    db.tgHelpChats = db.tgHelpChats || {};
    db.tgHelpChats[key] = chatId;
    out.push({ chat_id: chatId, text: '🆘 Напишите, что случилось, одним или несколькими сообщениями — я передам всё организатору, он ответит здесь же. Можно прислать фото. Когда закончите, нажмите «✅ Готово».', reply_markup: HELP_KB });
    toAdmins(db, out, `🆘 <b>@${esc(key)}</b> открыл «Помощь администратора»\n${u ? esc(u.name) + ' · ' + esc(u.phone) + '\n' : ''}${esc(pairInfo(db, u))}\n\nОтветить: <code>/reply @${esc(key)} текст</code>`);
  }
  function helpMessage(db, out, chatId, msg, from) {
    const u = userByChat(db, chatId);
    const key = helpKey(u, from);
    if (msg.text) toAdmins(db, out, `🆘 <b>@${esc(key)}</b>${u ? ' (' + esc(u.name) + ')' : ''}:\n${esc(msg.text)}\n\n<code>/reply @${esc(key)} </code>`);
    else {
      toAdmins(db, out, `🆘 <b>@${esc(key)}</b> прислал вложение 👇`);
      (db.tgAdmins || []).forEach((a) => out.push({ method: 'forwardMessage', chat_id: a, from_chat_id: chatId, message_id: msg.message_id }));
    }
    out.push({ chat_id: chatId, text: '📨 Передал организатору.' });
  }
  function toAdmins(db, out, text) {
    (db.tgAdmins || []).forEach((a) => out.push({ chat_id: a, text }));
  }

  // ---------- сценарии ----------
  const FORM_STEPS = {
    fullName: '<b>ФИО получателя</b> — как в паспорте, для выдачи в ПВЗ:',
    address: '<b>Адрес ближайшего пункта выдачи Ozon.</b>\n🔒 Только адрес ПВЗ — не домашний адрес. Например: «ПВЗ Ozon, Москва, Тверская 7»',
    wishes: '<b>Что хочется получить?</b> Зерно, дрипы, свечи, подставки… Или нажмите «Пропустить».',
    prefs: '<b>Тематика подарка:</b>',
    notes: '<b>Особые пометки</b> (например: «аллергия на инфьюзы»). Или «Пропустить».',
    agree: 'Подтверждаете участие и дальнейшую отправку подарка? Ваше имя попадёт в случайное распределение.',
  };
  const FORM_ORDER = ['fullName', 'address', 'wishes', 'prefs', 'notes', 'agree'];

  function askForm(out, chatId, step, db) {
    const st0 = db && db.tgState && db.tgState[chatId];
    if (st0 && st0.waveJoin) return askWaveForm(out, chatId, step, st0);
    const wave2 = step === 'agree' && db && db.drawnAt && !db.participations[(userByChat(db, chatId) || {}).id];
    const ow = wave2 ? core.openWave(db) : null;
    const markup = step === 'prefs' ? PREFS_BTN
      : step === 'agree' ? ib([[[wave2 ? (ow ? `✅ Участвую в ${ow.n}-й волне` : '✅ Участвую в следующей волне') : '✅ Подтверждаю участие', 'agree']]])
      : step === 'wishes' || step === 'notes' ? SKIP_BTN : { remove_keyboard: true };
    const d = ow ? core.datesFor(db, ow.n) : null;
    const text = !wave2 ? FORM_STEPS[step]
      : ow ? `Первая жеребьёвка уже прошла — вы записываетесь в <b>${ow.n}-ю волну</b> 🎄\nОтправка подарков: ${fmtDay(d.start)} — ${fmtDay(d.end)}.\n\nПодтверждаете участие в ${ow.n}-й волне и дальнейшую отправку подарка?`
      : 'Первая жеребьёвка уже прошла — вы попадёте в <b>лист ожидания следующей волны</b> 🎄 Когда организаторы её откроют, я пришлю даты и попрошу подтвердить участие.\n\nПодтверждаете участие и дальнейшую отправку подарка?';
    out.push({ chat_id: chatId, text, reply_markup: markup });
  }

  // Анкета для следующей волны: каждый шаг показывает прошлое значение и кнопку «Оставить как есть»
  function askWaveForm(out, chatId, step, st) {
    const pre = st.prefill || {};
    const KEEP = [['✅ Оставить как есть', 'keep']];
    if (step === 'agree') {
      out.push({
        chat_id: chatId,
        text: (st.waveN ? `Записываю вас в <b>${st.waveN}-ю волну</b> 🌊` : 'Записываю вас в <b>лист ожидания следующей волны</b> 🌊')
          + '\nВы дарите ещё один подарок новому получателю и получаете ещё один.\n\nПодтверждаете участие?',
        reply_markup: ib([[[st.waveN ? `✅ Участвую в ${st.waveN}-й волне` : '✅ Записаться в лист ожидания', 'agree']]]),
      });
      return;
    }
    const cur = step === 'prefs' ? core.PREFS[pre.prefs] : pre[step];
    const markup = step === 'prefs' ? { inline_keyboard: PREFS_BTN.inline_keyboard.concat(pre.prefs ? [KEEP.map(([t, d]) => ({ text: t, callback_data: d }))] : []) }
      : cur ? ib([KEEP].concat(step === 'wishes' || step === 'notes' ? [[['Очистить', 'skip']]] : []))
      : step === 'wishes' || step === 'notes' ? SKIP_BTN : { remove_keyboard: true };
    out.push({ chat_id: chatId, text: FORM_STEPS[step] + (cur ? `\n\nСейчас: «${esc(cur)}»` : ''), reply_markup: markup });
  }

  function startWaveForm(db, out, chatId, nw, edit) {
    db.tgState[chatId] = { flow: 'form', step: edit ? 'fullName' : 'agree', data: Object.assign({}, nw.anketa), prefill: nw.anketa, waveJoin: true, waveN: nw.n || null };
    if (edit) out.push({ chat_id: chatId, text: '✏️ Анкета для новой волны. На каждом шаге можно оставить прошлое значение. /cancel — отменить.' });
    askWaveForm(out, chatId, edit ? 'fullName' : 'agree', db.tgState[chatId]);
  }

  // «💬 Переписка»: анонимно написать своему получателю или своему Санте (по каждой волне)
  function chatMenu(db, ctx, out, chatId) {
    const u = userByChat(db, chatId);
    if (!u) return notLinked(out, chatId);
    const me = call(db, ctx, 'GET', '/api/me', null, { userId: u.id });
    const outs = me.assignments || [];
    const ins = (me.incomings || []).filter((x) => !x.failed);
    if (!outs.length && !ins.length) {
      out.push({ chat_id: chatId, text: '💬 Переписка откроется после жеребьёвки: можно будет анонимно написать своему получателю (уточнить, что он хочет) и своему Тайному Санте.' });
      return;
    }
    const many = outs.length + ins.length > 2;
    const last = (list) => (list && list.length ? '\n' + list.slice(-3).map((m) => `${m.mine ? '🫵 Вы' : m.who}: ${esc(m.text)}`).join('\n') : '');
    const lines = ['💬 <b>Анонимная переписка</b> — никто не узнает, кто вы.'];
    const rows = [];
    for (const a of outs) {
      lines.push('', `🎅 <b>Ваш получатель</b>${many ? ` · ${a.round}-я волна` : ''}` + last((a.messages || []).map((m) => ({ mine: m.from === 'santa', who: '🎁 Получатель', text: m.text }))));
      rows.push([[`💬 Написать получателю${many ? ` (${a.round}-я волна)` : ''}`, 'msg:r:' + a.round]]);
    }
    for (const g of ins) {
      lines.push('', `🎁 <b>Ваш Тайный Санта</b>${many ? ` · ${g.round}-я волна` : ''}` + last((g.messages || []).map((m) => ({ mine: m.from === 'recipient', who: '🎅 Санта', text: m.text }))));
      rows.push([[`💬 Написать своему Санте${many ? ` (${g.round}-я волна)` : ''}`, 'msg:s:' + g.round]]);
    }
    out.push({ chat_id: chatId, text: lines.join('\n'), reply_markup: ib(rows) });
  }

  // «🌊 Следующие волны»: записаться (анкета из прошлой волны), лист ожидания, статус
  function waveMenu(db, ctx, out, chatId) {
    const u = userByChat(db, chatId);
    if (!u) return notLinked(out, chatId);
    const me = call(db, ctx, 'GET', '/api/me', null, { userId: u.id });
    const nw = me.nextWave;
    const w = me.wave2;
    if (!me.participation) {
      out.push({ chat_id: chatId, text: 'Сначала заполните анкету участника 🎁', reply_markup: ib([[['🎁 Заполнить анкету', 'form']]]) });
      return;
    }
    if (!nw) {
      const w1 = (me.settings.waves || [])[0] || {};
      out.push({ chat_id: chatId, text: w1.status === 'open'
        ? '🌊 Сейчас идёт запись в первую волну — вы уже в ней! Следующие волны откроются после жеребьёвки.'
        : '🌊 Запись в следующие волны сейчас закрыта. Я напишу, когда она откроется.' });
      return;
    }
    const a = nw.anketa || {};
    const summary = `\n\n📋 <b>Анкета</b> (как в прошлый раз):\nФИО: ${esc(a.fullName)}\nПВЗ: ${esc(a.address)}\nПожелания: ${esc(a.wishes) || '—'}\nТематика: ${esc(core.PREFS[a.prefs] || '—')}`;
    if (nw.joined) {
      out.push({
        chat_id: chatId,
        text: (nw.n ? `✅ Вы участвуете в <b>${nw.n}-й волне</b> (отправка ${fmtDay(nw.start)} — ${fmtDay(nw.end)}). Я напишу, когда пройдёт её жеребьёвка.`
          : '✅ Вы в листе ожидания следующей волны. Как только организаторы её откроют, я пришлю даты.') + summary,
        reply_markup: ib([[['✏️ Изменить анкету для волны', 'wj:edit']], [['🙅 Отказаться', 'wj:no']]]),
      });
      return;
    }
    out.push({
      chat_id: chatId,
      text: (nw.n ? `🌊 Открыта запись в <b>${nw.n}-ю волну</b>! Отправка подарков ${fmtDay(nw.start)} — ${fmtDay(nw.end)}.`
        : '🌊 Следующая волна ещё не открыта, но можно записаться в лист ожидания — я напишу, когда она начнётся.')
        + '\nВы дарите ещё один подарок и получаете ещё один (новая жеребьёвка).' + summary,
      reply_markup: ib([[[nw.n ? '✅ Записаться с этими данными' : '✅ В лист ожидания с этими данными', 'wj:yes']], [['✏️ Изменить данные и записаться', 'wj:edit']]]),
    });
  }

  function startForm(db, out, chatId) {
    db.tgState[chatId] = { flow: 'form', step: 'fullName', data: {} };
    out.push({ chat_id: chatId, text: '📝 Заполняем анкету. В любой момент можно написать /cancel.' });
    askForm(out, chatId, 'fullName', db);
  }

  function formInput(db, ctx, out, chatId, st, value) {
    if (st.step === 'address' && Cities && !Cities.hasLocality(value) && !st.addrConfirmed) {
      st.pendingAddress = value;
      out.push({
        chat_id: chatId,
        text: `🏙️ <b>Вы точно указали город?</b>\nНе нашёл название города в адресе: «${esc(value)}».\nБез города Санта не сможет отправить посылку. Например: «ПВЗ Ozon, Казань, ул. Баумана 1».`,
        reply_markup: ib([[['✏️ Добавить город', 'addr_fix'], ['✅ Всё верно', 'addr_ok']]]),
      });
      return;
    }
    st.addrConfirmed = false;
    st.data[st.step] = value;
    const next = FORM_ORDER[FORM_ORDER.indexOf(st.step) + 1];
    if (next) { st.step = next; askForm(out, chatId, next, db); return; }
    const u = userByChat(db, chatId);
    if (st.waveJoin) {
      try {
        call(db, ctx, 'POST', '/api/wave-join', Object.assign({}, st.data, { agree: true }), { userId: u.id });
        delete db.tgState[chatId];
        out.push({ chat_id: chatId, text: st.waveN ? `🌊 Готово! Вы в ${st.waveN}-й волне. Я напишу, когда пройдёт её жеребьёвка.` : '🌊 Готово! Вы в листе ожидания следующей волны — я напишу, когда она откроется.', reply_markup: MAIN_KB });
      } catch (e) {
        if (!(e instanceof core.SantaError)) throw e;
        const back = /ПВЗ|адрес|пункта/i.test(e.message) ? 'address' : /ФИО/i.test(e.message) ? 'fullName' : null;
        out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) });
        if (back) { st.step = back; askWaveForm(out, chatId, back, st); } else delete db.tgState[chatId];
      }
      return;
    }
    try {
      call(db, ctx, 'POST', '/api/participate', Object.assign({ phone: u.phone }, st.data, { agree: true, wave2: !!db.drawnAt }), { userId: u.id });
      delete db.tgState[chatId];
      out.push({ chat_id: chatId, text: '🎉 Анкета сохранена!\n\n' + statusLine(db, u), reply_markup: MAIN_KB });
    } catch (e) {
      if (!(e instanceof core.SantaError)) throw e;
      // вернуться к шагу, где ошибка
      const back = /ПВЗ|адрес|пункта/i.test(e.message) ? 'address' : /ФИО/i.test(e.message) ? 'fullName' : null;
      out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) });
      if (back) { st.step = back; askForm(out, chatId, back, db); } else delete db.tgState[chatId];
    }
  }

  function regInput(db, ctx, out, chatId, st, value, from) {
    if (st.step === 'name') {
      st.data.name = value;
      st.step = 'phone';
      out.push({ chat_id: chatId, text: 'Ваш номер телефона? Нажмите кнопку ниже или напишите номер.', reply_markup: { keyboard: [[{ text: '📱 Отправить мой номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
      return;
    }
    if (st.step === 'phone') {
      st.data.phone = value;
      st.step = 'consent';
      out.push({
        chat_id: chatId,
        text: `Последний шаг: согласие на обработку персональных данных (имя, телефон, Telegram, ФИО и адрес ПВЗ) для участия в Тайном Санте.\n<a href="${siteUrl}/privacy.html">Политика обработки данных</a>`,
        reply_markup: ib([[['✅ Даю согласие', 'consent']]]),
      });
      return;
    }
    if (st.step === 'consent') {
      const password = crypto.randomBytes(6).toString('base64url');
      try {
        const r = call(db, ctx, 'POST', '/api/register', {
          name: st.data.name, phone: st.data.phone, tg: from.username || 'tg' + from.id, password, pdConsent: true,
        });
        const u = db.users.find((x) => x.id === r.user.id);
        u.tgChatId = chatId;
        delete db.tgState[chatId];
        out.push({ chat_id: chatId, text: `✅ Готово, ${esc(u.name)}! Аккаунт создан.\nДля входа на сайт (${siteUrl}/cabinet.html): логин <code>@${esc(u.tg)}</code>, пароль <code>${esc(password)}</code>`, reply_markup: MAIN_KB });
        startForm(db, out, chatId);
      } catch (e) {
        if (!(e instanceof core.SantaError)) throw e;
        out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) + (/телефон/i.test(e.message) ? '\nНапишите другой номер:' : '') });
        if (/телефон/i.test(e.message)) st.step = 'phone';
        else if (/Как вас зовут/i.test(e.message)) { st.step = 'name'; out.push({ chat_id: chatId, text: 'Как вас зовут?' }); } else delete db.tgState[chatId];
      }
    }
  }

  function whom(db, ctx, out, chatId) {
    const u = userByChat(db, chatId);
    if (!u) return notLinked(out, chatId);
    const me = call(db, ctx, 'GET', '/api/me', null, { userId: u.id });
    const list = me.assignments && me.assignments.length ? me.assignments : me.assignment ? [me.assignment] : [];
    if (!list.length) {
      out.push({ chat_id: chatId, text: me.drawing ? '🎲 Идёт жеребьёвка — организаторы проверяют пары. Я напишу, как только всё будет готово!'
        : me.drawn ? 'Вас нет в жеребьёвке этого года.' : '🔒 Жеребьёвки ещё не было. Я напишу, как только организаторы раскидают участников!\n\n' + statusLine(db, u) });
      return;
    }
    const many = list.length > 1;
    for (const a of list) {
    const r = a.recipient;
    const st = { assigned: '⏳ ждёт отправки', sent: '🚚 отправлено', received: '✅ получено' }[a.status];
    out.push({
      chat_id: chatId,
      // сначала пожелания, данные для отправки — под спойлером (нажать, чтобы показать)
      text: (many ? `🌊 <b>${a.round}-я волна</b>\n` : '') + `🎅 <b>Вы — Тайный Санта</b> (${st})\n\n` +
        `🎁 <b>Что хочет получить:</b>\n${esc(r.wishes) || 'не написал(а) — сюрприз на ваш вкус!'}\n🎯 Тематика: ${esc(core.PREFS[r.prefs] || '—')}` +
        (r.notes ? `\n⚠️ <b>Важно: ${esc(r.notes)}</b>` : '') +
        `\n\n📦 <b>Данные для отправки</b> (нажмите, чтобы показать):\n` +
        `📍 ПВЗ Ozon: <tg-spoiler>${esc(r.address)}</tg-spoiler>\n📱 Телефон: <tg-spoiler>${esc(r.phone)}</tg-spoiler>` +
        (a.priority ? '\n\n⭐ <b>Получатель в приоритете:</b> в прошлой волне он остался без подарка. Пожалуйста, отправьте посылку в первую очередь!' : '') +
        `\n\n📅 Отправка: до ${fmtDay((a.dates && a.dates.end) || (me.dates && me.dates.end) || me.settings.sendEnd)}`,
      reply_markup: a.status === 'assigned' ? ib((a.ackAt ? [] : [[['✅ Участвую, собираю посылку', 'ack:' + a.round]]]).concat([[['📦 Я отправил подарок', 'sentw:' + a.round]], [['💬 Написать получателю', 'msg:r:' + a.round]], [['❓ Уточнить данные у организатора', 'ask:' + a.round]]])) : ib([[['💬 Написать получателю', 'msg:r:' + a.round]]]),
    });
    }
    if (me.nextWave && !me.nextWave.joined) out.push({ chat_id: chatId, text: me.nextWave.n ? `🌊 Кстати, открыта запись в ${me.nextWave.n}-ю волну — можно подарить ещё один подарок.` : '🌊 Хотите участвовать и в следующей волне? Можно записаться в лист ожидания.', reply_markup: WAVEJOIN_BTN });
  }

  // «Я отправил»: если ждут отправки подарки из нескольких волн — спросить, какой
  function askSent(db, ctx, out, chatId, u) {
    const me = call(db, ctx, 'GET', '/api/me', null, { userId: u.id });
    const pending = (me.assignments || []).filter((a) => a.status === 'assigned');
    if (pending.length > 1) {
      out.push({ chat_id: chatId, text: 'Какой подарок вы отправили?', reply_markup: ib(pending.map((a) => [[`🌊 Подарок ${a.round}-й волны`, 'sentw:' + a.round]])) });
      return;
    }
    db.tgState[chatId] = { flow: 'sent', step: 'track', data: {}, round: pending[0] ? pending[0].round : null };
    out.push({ chat_id: chatId, text: 'Пришлите трек-номер посылки или фото (например, QR-код) — или нажмите «Пропустить»:', reply_markup: SKIP_BTN });
  }

  function notLinked(out, chatId) {
    out.push({
      chat_id: chatId,
      text: 'Я пока не знаю, кто вы 🙂 Зарегистрируйтесь здесь или привяжите аккаунт сайта (кнопка «Подписаться на уведомления» в личном кабинете).',
      reply_markup: ib([[['📝 Зарегистрироваться', 'reg']], [['🌐 Открыть сайт', siteUrl + '/cabinet.html']]]),
    });
  }

  function markSent(db, ctx, out, chatId, track, round, tgPhoto) {
    const u = userByChat(db, chatId);
    try {
      call(db, ctx, 'POST', '/api/sent', { track: track || '', round: round || undefined, tgPhoto: tgPhoto || undefined }, { userId: u.id });
      out.push({ chat_id: chatId, text: '🎉 Хо-хо-хо! Отметил: подарок отправлен. Получатель увидит, что посылка в пути. Спасибо, Санта!', reply_markup: MAIN_KB });
    } catch (e) {
      if (!(e instanceof core.SantaError)) throw e;
      out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message), reply_markup: MAIN_KB });
    }
  }

  // ---------- обработка обновления ----------
  function handleUpdate(db, ctx, update) {
    const out = [];
    db.tgState = db.tgState || {};
    db.tgAdmins = db.tgAdmins || [];
    const cb = update.callback_query;
    const msg = update.message || (cb && cb.message);
    if (!msg || !msg.chat || msg.chat.type !== 'private') return { out, actingUid: null };
    const chatId = msg.chat.id;
    const from = (cb ? cb.from : update.message.from) || {};
    if (cb) out.push({ method: 'answerCallbackQuery', callback_query_id: cb.id });
    const u0 = userByChat(db, chatId);
    const actingUid = u0 ? u0.id : null;
    const st = db.tgState[chatId];
    const text = update.message && typeof update.message.text === 'string' ? update.message.text.trim() : '';

    // ----- кнопки под сообщениями -----
    if (cb) {
      const d = cb.data || '';
      if (d === 'reg') {
        if (u0) { greet(out, db, chatId, u0); return { out, actingUid }; }
        db.tgState[chatId] = { flow: 'reg', step: 'name', data: {} };
        out.push({ chat_id: chatId, text: 'Отлично! Как вас зовут? (Только имя, например «Сергей»)', reply_markup: { remove_keyboard: true } });
      } else if (d === 'form') {
        if (!u0) notLinked(out, chatId); else startForm(db, out, chatId);
      } else if (d === 'whom') {
        whom(db, ctx, out, chatId);
      } else if (d === 'wave') {
        waveMenu(db, ctx, out, chatId);
      } else if (d === 'wj:yes' || d === 'wj:edit') {
        if (!u0) notLinked(out, chatId);
        else {
          const me = call(db, ctx, 'GET', '/api/me', null, { userId: u0.id });
          if (!me.nextWave) out.push({ chat_id: chatId, text: 'Запись в следующие волны сейчас закрыта.' });
          else startWaveForm(db, out, chatId, me.nextWave, d === 'wj:edit');
        }
      } else if (d === 'wj:no') {
        if (!u0) notLinked(out, chatId);
        else {
          try { call(db, ctx, 'POST', '/api/wave2', { join: false }, { userId: u0.id }); out.push({ chat_id: chatId, text: 'Понял, в этой волне вас не будет. Если передумаете — «🌊 Следующие волны».' }); }
          catch (e) {
            if (!(e instanceof core.SantaError)) throw e;
            // лист ожидания: просто убираем запись
            const w = (db.wave2 || {})[u0.id];
            if (w && w.status === 'waiting') { w.status = 'declined'; out.push({ chat_id: chatId, text: 'Убрал вас из листа ожидания.' }); }
            else out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) });
          }
        }
      } else if (d === 'keep' && st && st.flow === 'form' && st.waveJoin) {
        if (st.step === 'address') st.addrConfirmed = true;
        formInput(db, ctx, out, chatId, st, (st.prefill || {})[st.step] || '');
      } else if (d.startsWith('msg:')) {
        // написать получателю (r) или своему Санте (s) — следующее сообщение уйдёт анонимно
        if (!u0) notLinked(out, chatId);
        else {
          const [, who, n] = d.split(':');
          db.tgState[chatId] = { flow: 'msg', to: who === 's' ? 'santa' : 'recipient', round: Number(n) || null };
          out.push({ chat_id: chatId, text: who === 's'
            ? '💬 Напишите сообщение своему Тайному Санте — он не узнает, кто вы, и не увидит ваш ник. /cancel — отмена.'
            : '💬 Напишите сообщение своему получателю — например, уточните, что он хочет. Он не узнает, кто вы. /cancel — отмена.' });
        }
      } else if (d === 'addwish') {
        if (!u0) notLinked(out, chatId);
        else {
          db.tgState[chatId] = { flow: 'addwish' };
          out.push({ chat_id: chatId, text: '➕ Что добавить к пожеланиям? Напишите одним сообщением — ваш Санта сразу увидит. /cancel — отмена.' });
        }
      } else if (d.startsWith('ask:')) {
        // «Уточнить данные»: организаторы сразу получают данные пары, дальше — переписка через «Помощь»
        if (!u0) notLinked(out, chatId);
        else {
          try {
            call(db, ctx, 'POST', '/api/ask-organizer', { round: Number(d.slice(4)) || undefined }, { userId: u0.id });
            const key = helpKey(u0, from);
            db.tgState[chatId] = { flow: 'help', uid: u0.id };
            db.tgHelpChats = db.tgHelpChats || {};
            db.tgHelpChats[key] = chatId;
            out.push({ chat_id: chatId, text: '❓ Организатор уже знает, о каком получателе речь. Напишите, каких данных не хватает для доставки, — он уточнит и ответит здесь же. Когда закончите, нажмите «✅ Готово».', reply_markup: HELP_KB });
          } catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) }); }
        }
      } else if (d.startsWith('sentw:')) {
        if (!u0) notLinked(out, chatId);
        else {
          db.tgState[chatId] = { flow: 'sent', step: 'track', data: {}, round: Number(d.slice(6)) || null };
          out.push({ chat_id: chatId, text: 'Пришлите трек-номер посылки или фото (например, QR-код) — или нажмите «Пропустить»:', reply_markup: SKIP_BTN });
        }
      } else if (d.startsWith('ack:') || d.startsWith('received:')) {
        if (!u0) notLinked(out, chatId);
        else {
          const [kind, n] = d.split(':');
          try {
            call(db, ctx, 'POST', kind === 'ack' ? '/api/ack' : '/api/received', { round: Number(n) || undefined }, { userId: u0.id });
            out.push({ chat_id: chatId, text: kind === 'ack' ? '👍 Отлично! Отметил, что вы собираете посылку. Когда отправите — нажмите «📦 Я отправил подарок».' : '🥳 Ура! Отметил, что подарок получен. С наступающим!' });
          } catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) }); }
        }
      } else if (d === 'consent' && st && st.flow === 'reg') {
        regInput(db, ctx, out, chatId, st, true, from);
      } else if (d === 'addr_ok' && st && st.flow === 'form' && st.step === 'address' && st.pendingAddress) {
        st.addrConfirmed = true;
        formInput(db, ctx, out, chatId, st, st.pendingAddress);
      } else if (d === 'addr_fix' && st && st.flow === 'form' && st.step === 'address') {
        out.push({ chat_id: chatId, text: 'Пришлите адрес ПВЗ ещё раз — вместе с городом:' });
      } else if (d === 'skip' && st && st.flow === 'form') {
        formInput(db, ctx, out, chatId, st, '');
      } else if (d.startsWith('prefs:') && st && st.flow === 'form' && st.step === 'prefs') {
        formInput(db, ctx, out, chatId, st, d.slice(6));
      } else if (d === 'agree' && st && st.flow === 'form' && st.step === 'agree') {
        formInput(db, ctx, out, chatId, st, true);
      } else if (d === 'sent') {
        if (!u0) notLinked(out, chatId);
        else askSent(db, ctx, out, chatId, u0);
      } else if (d === 'skip' && st && st.flow === 'sent') {
        delete db.tgState[chatId];
        markSent(db, ctx, out, chatId, '', st.round);
      } else if (d === 'ack') {
        if (!u0) notLinked(out, chatId);
        else {
          try { call(db, ctx, 'POST', '/api/ack', {}, { userId: u0.id }); out.push({ chat_id: chatId, text: '👍 Отлично! Отметил, что вы собираете посылку. Когда отправите — нажмите «📦 Я отправил подарок».' }); }
          catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) }); }
        }
      } else if (d === 'w2:yes' || d === 'w2:no') {
        if (!u0) notLinked(out, chatId);
        else {
          try {
            call(db, ctx, 'POST', '/api/wave2', { join: d === 'w2:yes' }, { userId: u0.id });
            out.push({ chat_id: chatId, text: d === 'w2:yes'
              ? `🎄 Отлично, вы в ${((db.wave2 || {})[u0.id] || {}).round || 'новой'}-й волне! Я напишу, когда пройдёт её жеребьёвка.`.replace('новой-й', 'новой')
              : 'Понял, в этой волне вас не будет. Спасибо, что были с нами ☕' });
          } catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) }); }
        }
      } else if (d === 'noform_del') {
        if (!u0) notLinked(out, chatId);
        else if (db.participations[u0.id]) out.push({ chat_id: chatId, text: 'У вас уже есть анкета — вы в игре 🎅 Удалить аккаунт можно в личном кабинете на сайте.' });
        else out.push({
          chat_id: chatId,
          text: '⚠️ <b>Точно удалить аккаунт?</b>\nИмя, телефон и ник будут стёрты навсегда. Вернуться можно в любой момент — просто зарегистрируйтесь заново.',
          reply_markup: ib([[['🗑 Да, удалить и стереть данные', 'noform_del_yes']], [['🎁 Нет, заполню анкету', 'form']]]),
        });
      } else if (d === 'noform_del_yes') {
        if (!u0) notLinked(out, chatId);
        else if (db.participations[u0.id]) out.push({ chat_id: chatId, text: 'У вас уже есть анкета — удалить аккаунт можно в личном кабинете на сайте.' });
        else {
          call(db, ctx, 'POST', '/api/account/delete', { reason: 'noform' }, { userId: u0.id });
          delete db.tgState[chatId];
          out.push({ chat_id: chatId, text: '🗑 Готово: аккаунт удалён, данные стёрты. Спасибо, что заглянули к Кофеманьякам ☕ Если передумаете — нажмите /start.', reply_markup: { remove_keyboard: true } });
        }
      } else if (d === 'received') {
        if (!u0) notLinked(out, chatId);
        else {
          try { call(db, ctx, 'POST', '/api/received', {}, { userId: u0.id }); out.push({ chat_id: chatId, text: '🥳 Ура! Отметил, что подарок получен. С наступающим!' }); }
          catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) }); }
        }
      } else if (d.startsWith('adm:') && isAdmin(db, chatId)) {
        admCallback(db, ctx, out, chatId, d);
      } else if (d.startsWith('modset:') && isAdmin(db, chatId)) {
        call(db, ctx, 'POST', '/api/admin/moderation', { enabled: d === 'modset:on' }, { isAdmin: true });
        modPanel(db, out, chatId);
      } else if (d.startsWith('mod:') && isAdmin(db, chatId)) {
        const [, status, uid] = d.split(':');
        try {
          call(db, ctx, 'POST', '/api/admin/moderate', { userId: uid, status }, { isAdmin: true });
          const t = db.users.find((x) => x.id === uid);
          out.push({ chat_id: chatId, text: `${status === 'approved' ? '✅ Одобрено' : '🚫 Отклонено'}: @${esc(t && t.tg)}` });
        } catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message) }); }
      }
      return { out, actingUid };
    }

    // ----- команды -----
    if (text.startsWith('/start')) {
      delete db.tgState[chatId];
      const startParam = text.split(/\s+/)[1] || '';
      const uid = verifyStart(startParam);
      const byLink = uid && db.users.find((x) => x.id === uid);
      const uname = String(from.username || '').toLowerCase();
      const byName = !byLink && uname && db.users.find((x) => x.tg === uname);
      const u = byLink || byName || u0;
      if (u) {
        if (startParam.startsWith('help-')) { u.tgChatId = chatId; startHelp(db, out, chatId, from); }
        else link(db, out, chatId, u);
      } else if (startParam === 'help') startHelp(db, out, chatId, from);
      else {
        out.push({
          chat_id: chatId,
          text: `Привет! ☕ Я бот Тайного Санты Кофеманьяков.\n\nНе нашёл на сайте аккаунт${uname ? ' с ником @' + esc(uname) : ''}. Зарегистрируйтесь прямо здесь — это займёт минуту. Если аккаунт уже есть с другим ником, нажмите «Подписаться на уведомления» в личном кабинете на сайте.`,
          reply_markup: ib([[['📝 Зарегистрироваться', 'reg']], [['🌐 Открыть сайт', siteUrl]]]),
        });
      }
      return { out, actingUid: (u && u.id) || null };
    }
    if (text.startsWith('/admin')) {
      const pw = text.split(/\s+/).slice(1).join(' ');
      if (ctx.checkAdmin(pw)) {
        if (!db.tgAdmins.includes(chatId)) db.tgAdmins.push(chatId);
        out.push({ chat_id: chatId, reply_markup: ADMIN_KB, text: '🔐 Готово, вы админ. Буду присылать сюда новые анкеты на модерацию, всё про удаление аккаунтов и перестройку пар, обращения в «Помощь администратора» и тех, кто не успевает отправить подарок.\nОтветить человеку: /reply @ник текст' });
      } else out.push({ chat_id: chatId, text: 'Неверный пароль администратора.' });
      return { out, actingUid };
    }
    if (text.startsWith('/reply') && isAdmin(db, chatId)) {
      const m = text.match(/^\/reply\s+@?(\S+)\s+([\s\S]+)/);
      if (!m) { out.push({ chat_id: chatId, text: 'Формат: /reply @ник текст ответа' }); return { out, actingUid }; }
      const key = m[1].toLowerCase();
      const target = (db.tgHelpChats || {})[key] || (db.users.find((x) => x.tg === key) || {}).tgChatId;
      if (!target) { out.push({ chat_id: chatId, text: `Не знаю чат @${esc(key)}: человек не писал в бот.` }); return { out, actingUid }; }
      out.push({ chat_id: target, text: '💬 <b>Ответ организатора:</b>\n' + esc(m[2]) });
      out.push({ chat_id: chatId, text: `✅ Отправил @${esc(key)}.` });
      return { out, actingUid };
    }
    if ((text === '🛡 Модерация' || text === '/moderation') && isAdmin(db, chatId)) { modPanel(db, out, chatId); return { out, actingUid }; }
    if ((text === ADM.status || text === '/status') && isAdmin(db, chatId)) { delete db.tgState[chatId]; admStatus(db, ctx, out, chatId, 0); return { out, actingUid }; }
    if ((text === ADM.who || /^\/who(\s|$)/.test(text)) && isAdmin(db, chatId)) {
      const q = text.startsWith('/who') ? text.slice(4).trim() : '';
      if (q) { delete db.tgState[chatId]; admWho(db, out, chatId, q); return { out, actingUid }; }
      db.tgState[chatId] = { flow: 'admwho' };
      out.push({ chat_id: chatId, text: '🔎 Пришлите @ник участника (можно телефон или имя) — покажу всё досье: анкету, кому дарит, кто дарит ему, статусы отправки. Можно присылать по одному нику подряд. /cancel — выход.' });
      return { out, actingUid };
    }
    if (st && st.flow === 'admwho' && isAdmin(db, chatId) && text && text !== '/cancel' && !Object.values(BTN).includes(text) && !Object.values(ADM).includes(text) && !text.startsWith('/')) {
      admWho(db, out, chatId, text);
      return { out, actingUid };
    }
    if ((text === ADM.send || text === '/send') && isAdmin(db, chatId)) { delete db.tgState[chatId]; admSendMenu(out, chatId); return { out, actingUid }; }
    if (st && st.flow === 'admtext' && isAdmin(db, chatId) && text && text !== '/cancel') {
      admConfirm(db, ctx, out, chatId, st.cat, st.n, text.slice(0, 1000));
      return { out, actingUid };
    }
    if (text === '/help' || text === BTN.help) { startHelp(db, out, chatId, from); return { out, actingUid }; }
    if (st && st.flow === 'help') {
      if (text === BTN.done || text === '/cancel') {
        delete db.tgState[chatId];
        out.push({ chat_id: chatId, text: 'Спасибо! Организатор ответит здесь. Если появится что-то ещё — снова нажмите «🆘 Помощь администратора».', reply_markup: u0 ? MAIN_KB : { remove_keyboard: true } });
        return { out, actingUid };
      }
      helpMessage(db, out, chatId, update.message, from);
      return { out, actingUid };
    }
    if (text === '/cancel' || text.toLowerCase() === 'отмена') {
      delete db.tgState[chatId];
      out.push({ chat_id: chatId, text: 'Ок, отменил.', reply_markup: u0 ? MAIN_KB : { remove_keyboard: true } });
      return { out, actingUid };
    }

    // ----- ввод внутри сценария -----
    if (st) {
      if (st.flow === 'reg' && st.step === 'consent') {
        out.push({ chat_id: chatId, text: 'Чтобы продолжить, нажмите кнопку «✅ Даю согласие» выше 👆 (или /cancel).' });
        return { out, actingUid };
      }
      if (st.flow === 'reg') {
        const value = update.message.contact ? update.message.contact.phone_number : text;
        if (!value) { out.push({ chat_id: chatId, text: 'Напишите ответ текстом 🙂' }); return { out, actingUid }; }
        regInput(db, ctx, out, chatId, st, value, from);
        return { out, actingUid };
      }
      if (st.flow === 'form' && text && !['prefs', 'agree'].includes(st.step) && !Object.values(BTN).includes(text)) {
        formInput(db, ctx, out, chatId, st, text);
        return { out, actingUid };
      }
      if (st.flow === 'msg' && text && !Object.values(BTN).includes(text)) {
        delete db.tgState[chatId];
        try {
          call(db, ctx, 'POST', '/api/msg', { to: st.to, round: st.round || undefined, text }, { userId: u0.id });
          out.push({ chat_id: chatId, text: st.to === 'santa' ? '✅ Отправлено вашему Санте — анонимно. Ответ придёт сюда.' : '✅ Отправлено вашему получателю — анонимно. Ответ придёт сюда.', reply_markup: MAIN_KB });
        } catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message), reply_markup: MAIN_KB }); }
        return { out, actingUid };
      }
      if (st.flow === 'addwish' && text && !Object.values(BTN).includes(text)) {
        delete db.tgState[chatId];
        try {
          call(db, ctx, 'POST', '/api/wishes-add', { text }, { userId: u0.id });
          out.push({ chat_id: chatId, text: '✅ Добавил к вашим пожеланиям. Ваш Санта уже получил уведомление.', reply_markup: MAIN_KB });
        } catch (e) { if (!(e instanceof core.SantaError)) throw e; out.push({ chat_id: chatId, text: '⚠️ ' + esc(e.message), reply_markup: MAIN_KB }); }
        return { out, actingUid };
      }
      // фото (например, QR-код) вместо трек-номера: подпись к фото — трек
      if (st.flow === 'sent' && update.message.photo && update.message.photo.length) {
        delete db.tgState[chatId];
        const ph = update.message.photo[update.message.photo.length - 1];
        markSent(db, ctx, out, chatId, update.message.caption || '', st.round, ph.file_id);
        return { out, actingUid };
      }
      if (st.flow === 'sent' && text && !Object.values(BTN).includes(text)) {
        delete db.tgState[chatId];
        markSent(db, ctx, out, chatId, text, st.round);
        return { out, actingUid };
      }
    }

    // ----- кнопки меню -----
    if (!u0) { notLinked(out, chatId); return { out, actingUid }; }
    if (text === BTN.whom) whom(db, ctx, out, chatId);
    else if (text === BTN.form) {
      const p = db.participations[u0.id];
      out.push({
        chat_id: chatId,
        text: p
          ? `📝 <b>Ваша анкета</b>\n${statusLine(db, u0)}\n\nФИО: ${esc(p.fullName)}\nТелефон: ${esc(u0.phone)}\nПВЗ: ${esc(p.address)}\nТематика: ${esc(core.PREFS[p.prefs])}\nПожелания: ${esc(p.wishes) || '—'}\nПометки: ${esc(p.notes) || '—'}`
          : 'Анкета ещё не заполнена.',
        reply_markup: ib((p ? [[['➕ Дополнить пожелания', 'addwish']]] : []).concat([[[p ? '✏️ Изменить анкету' : '🎁 Заполнить анкету', 'form']]])),
      });
    } else if (text === BTN.sent) {
      askSent(db, ctx, out, chatId, u0);
    } else if (text === BTN.wave) {
      waveMenu(db, ctx, out, chatId);
    } else if (text === BTN.chat) {
      chatMenu(db, ctx, out, chatId);
    } else if (text === BTN.got) {
      const me = call(db, ctx, 'GET', '/api/me', null, { userId: u0.id });
      const coming = (me.incomings || []).filter((x) => x.status === 'sent');
      out.push({ chat_id: chatId, text: 'Подтверждаете, что получили подарок от Тайного Санты?', reply_markup: coming.length > 1
        ? ib(coming.map((x) => [[`🎉 Получил подарок ${x.round}-й волны`, 'received:' + x.round]]))
        : ib([[['🎉 Да, получил!', 'received']]]) });
    } else greet(out, db, chatId, u0);
    return { out, actingUid };
  }

  // кнопки рассылки → кнопки Telegram (действия бота или ссылки)
  function notifButtons(list) {
    const CB = { whom: 'whom', sent: 'sent', received: 'received', wave: 'wave', form: 'form' };
    return { inline_keyboard: list.map((b) => [b.url ? { text: b.text, url: b.url }
      : b.kind === 'site' ? { text: b.text, url: siteUrl + '/cabinet.html' } : { text: b.text, callback_data: CB[b.kind] }]) };
  }

  // ---------- уведомления с сайта → Telegram ----------
  function pushNotifications(db, list, exceptUid) {
    const out = [];
    for (const n of list) {
      if (n.noTg) continue;
      if (n.userId === '@admins') {
        (db.tgAdmins || []).forEach((a) => out.push({ chat_id: a, text: '📋 ' + esc(n.text) }));
        continue;
      }
      const u = db.users.find((x) => x.id === n.userId);
      if (!u) continue;
      if (u.tgChatId && u.id !== exceptUid) {
        out.push({
          chat_id: u.tgChatId,
          text: (n.action === 'msg' ? '' : '🔔 ') + esc(n.text),
          reply_markup: n.action === 'msg' && n.msg ? ib([[[n.msg.reply === 'santa' ? '↩️ Ответить Санте' : '↩️ Ответить получателю', `msg:${n.msg.reply === 'santa' ? 's' : 'r'}:${n.msg.round}`]]])
            : n.buttons && n.buttons.length ? notifButtons(n.buttons) : n.action === 'whom' ? WHOM_WAVE_BTN : n.action === 'gift' ? ib([[['🎉 Я получил подарок', 'received']]]) : n.action === 'wave2' ? W2_BTN : n.action === 'wavejoin' ? WAVEJOIN_BTN : undefined,
        });
        if (n.tgPhoto) out.push({ method: 'sendPhoto', chat_id: u.tgChatId, photo: n.tgPhoto, caption: '📷 Фото от вашего Тайного Санты' });
      }
      if (n.action === 'new-anketa') {
        const p = db.participations[u.id] || {};
        for (const a of db.tgAdmins || []) {
          out.push({
            chat_id: a,
            text: `📝 <b>Новая анкета</b> (модерация выключена — уже в игре)\n${esc(u.name)} · @${esc(u.tg)} · ${esc(u.phone)}\nФИО: ${esc(p.fullName)}\nПВЗ: ${esc(p.address)}${p.city ? '' : '\n⚠️ город не распознан'}`,
            reply_markup: ib([[['🚫 Отклонить', `mod:rejected:${u.id}`]]]),
          });
        }
      }
      if (n.action === 'moderation') {
        const p = db.participations[u.id] || {};
        for (const a of db.tgAdmins || []) {
          out.push({
            chat_id: a,
            text: `📝 <b>Новая анкета на модерации</b>\n${esc(u.name)} · @${esc(u.tg)} · ${esc(u.phone)}\nФИО: ${esc(p.fullName)}\nПВЗ: ${esc(p.address)}`,
            reply_markup: ib([[['✅ Одобрить', `mod:approved:${u.id}`], ['🚫 Отклонить', `mod:rejected:${u.id}`]]]),
          });
        }
      }
    }
    return out;
  }

  // Вопрос «Будете участвовать?» тем, кто создал аккаунт, но не заполнил анкету
  function noFormMsg(u) {
    return {
      chat_id: u.tgChatId,
      text: `Привет, ${esc(u.name)}! 🎅 Вы создали аккаунт в Тайном Санте Кофеманьяков, но не заполнили анкету — без неё в жеребьёвку не попасть.\n\n<b>Будете участвовать?</b>`,
      reply_markup: ib([[['🎁 Да, заполнить анкету', 'form']], [['🙅 Не буду — удалить аккаунт', 'noform_del']]]),
    };
  }
  // Кнопка в админке: спросить всех без анкеты прямо сейчас, не дожидаясь суток.
  // Отмечаем как отправленное — ежедневное напоминание этот вопрос уже не повторит.
  function askNoForm(db, ctx) {
    db.tgReminders = db.tgReminders || {};
    const noForm = db.users.filter((u) => !db.participations[u.id]);
    const withBot = noForm.filter((u) => u.tgChatId);
    withBot.forEach((u) => { db.tgReminders[`${u.id}:noform`] = ctx.now(); });
    return { out: withBot.map(noFormMsg), total: noForm.length, sent: withBot.length, users: withBot };
  }

  // ---------- ежедневные напоминания (таймер) ----------
  function runReminders(db, ctx) {
    const out = [];
    db.tgReminders = db.tgReminders || {};
    const now = ctx.now();
    const once = (key) => { if (db.tgReminders[key]) return false; db.tgReminders[key] = now; return true; };
    const toAdmins = (text) => (db.tgAdmins || []).forEach((a) => out.push({ chat_id: a, text }));

    // Аккаунт есть, анкеты нет (прошли сутки) — спросить, будет ли участвовать
    for (const u of db.users) {
      if (!u.tgChatId || db.participations[u.id] || now - (u.createdAt || 0) < DAY) continue;
      if (!once(`${u.id}:noform`)) continue;
      out.push(noFormMsg(u));
    }

    for (const pair of db.pairs) {
      if (pair.status !== 'assigned') continue;
      const wave = core.waveOf(db, core.pairRound(pair));
      if (wave && (wave.status === 'closed' || !wave.confirmedAt)) continue; // волна остановлена или жеребьёвка не подтверждена — не напоминаем
      const dates = core.datesFor(db, core.pairRound(pair));
      const toStart = mskDay(Date.parse(dates.start)) - mskDay(now);
      const toEnd = mskDay(Date.parse(dates.end)) - mskDay(now);
      const u = db.users.find((x) => x.id === pair.santaId);
      if (!u) continue;
      const chat = u.tgChatId;
      const who = `${esc(u.name)} · @${esc(u.tg)} · ${esc(u.phone)}`;
      if (toStart <= 0 && toEnd >= 0 && chat && once(`${u.id}:start`)) {
        out.push({ chat_id: chat, text: '🎄 Пора отправлять подарки! Отправка открыта — успейте собрать посылку.', reply_markup: WHOM_BTN });
      }
      if ([7, 5, 3, 2].includes(toEnd) && chat && once(`${u.id}:d${toEnd}`)) {
        out.push({
          chat_id: chat,
          text: toEnd === 7
            ? '⏰ До конца отправки подарков осталась <b>неделя</b>! Не забудьте отправить подарок.'
            : `⏰ У вас осталось <b>${toEnd} ${plural(toEnd, 'день', 'дня', 'дней')}</b>, чтобы отправить подарок!`,
          reply_markup: ib([[['🎁 Узнать кому', 'whom'], ['📦 Я отправил', 'sent']]]),
        });
      }
      if (toEnd === 0 && once(`${u.id}:last`)) {
        if (chat) {
          out.push({
            chat_id: chat,
            text: '🚨 <b>Сегодня последний день отправки!</b>\nЕсли не отправите подарок сегодня — попадёте в чёрный список. Отправили? Нажмите кнопку ниже.',
            reply_markup: ib([[['🎁 Узнать кому', 'whom'], ['📦 Я отправил', 'sent']]]),
          });
        }
        toAdmins(`⚠️ <b>Сегодня последний день</b>, а подарок ещё не отправлен:\n${who}${chat ? '' : '\n(бот не подключён — напомнить вручную)'}\nСвяжитесь, чтобы узнать, в чём дело.`);
      }
      if (toEnd < 0 && once(`${u.id}:late`)) {
        toAdmins(`❌ <b>Срок отправки прошёл</b>, подарок не отправлен:\n${who}\nКандидат в чёрный список.`);
      }
    }
    return out;
  }

  return { handleUpdate, pushNotifications, runReminders, askNoForm, linkUrl, verifyStart };
}

module.exports = { createBot, MAIN_KB };
