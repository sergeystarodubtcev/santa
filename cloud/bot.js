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
  done: '✅ Готово',
};
const MAIN_KB = { keyboard: [[{ text: BTN.whom }, { text: BTN.sent }], [{ text: BTN.form }, { text: BTN.got }], [{ text: BTN.help }]], resize_keyboard: true };
const ADMIN_KB = { keyboard: MAIN_KB.keyboard.concat([[{ text: '🛡 Модерация' }]]), resize_keyboard: true };
const HELP_KB = { keyboard: [[{ text: BTN.done }]], resize_keyboard: true };
const ib = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => (/^https?:/.test(data) ? { text, url: data } : { text, callback_data: data }))) });
const WHOM_BTN = ib([[['🎁 Узнать кому', 'whom']]]);
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
    const a = me.assignment;
    if (!a) {
      out.push({ chat_id: chatId, text: me.drawn ? 'Вас нет в жеребьёвке этого года.' : '🔒 Жеребьёвки ещё не было. Я напишу, как только организаторы раскидают участников!\n\n' + statusLine(db, u) });
      return;
    }
    const r = a.recipient;
    const st = { assigned: '⏳ ждёт отправки', sent: '🚚 отправлено', received: '✅ получено' }[a.status];
    out.push({
      chat_id: chatId,
      // сначала пожелания, данные для отправки — под спойлером (нажать, чтобы показать)
      text: `🎅 Вы — Тайный Санта для <b>${esc(r.name)}</b> (${st})\n\n` +
        `🎁 <b>Что хочет получить:</b>\n${esc(r.wishes) || 'не написал(а) — сюрприз на ваш вкус!'}\n🎯 Тематика: ${esc(core.PREFS[r.prefs] || '—')}` +
        (r.notes ? `\n⚠️ <b>Важно: ${esc(r.notes)}</b>` : '') +
        `\n\n📦 <b>Данные для отправки</b> (нажмите, чтобы показать):\n` +
        `👤 ФИО: <tg-spoiler>${esc(r.fullName)}</tg-spoiler>\n📍 ПВЗ Ozon: <tg-spoiler>${esc(r.address)}</tg-spoiler>\n📱 Телефон: <tg-spoiler>${esc(r.phone)}</tg-spoiler>\n💬 Telegram: <tg-spoiler>@${esc(r.tg)}</tg-spoiler>` +
        (a.priority ? '\n\n⭐ <b>Получатель в приоритете:</b> в прошлой волне он остался без подарка. Пожалуйста, отправьте посылку в первую очередь!' : '') +
        `\n\n📅 Отправка: до ${new Date(Date.parse((me.dates && me.dates.end) || me.settings.sendEnd)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })}`,
      reply_markup: a.status === 'assigned' ? ib((a.ackAt ? [] : [[['✅ Участвую, собираю посылку', 'ack']]]).concat([[['📦 Я отправил подарок', 'sent']]])) : undefined,
    });
  }

  function notLinked(out, chatId) {
    out.push({
      chat_id: chatId,
      text: 'Я пока не знаю, кто вы 🙂 Зарегистрируйтесь здесь или привяжите аккаунт сайта (кнопка «Подписаться на уведомления» в личном кабинете).',
      reply_markup: ib([[['📝 Зарегистрироваться', 'reg']], [['🌐 Открыть сайт', siteUrl + '/cabinet.html']]]),
    });
  }

  function markSent(db, ctx, out, chatId, track) {
    const u = userByChat(db, chatId);
    try {
      call(db, ctx, 'POST', '/api/sent', { track: track || '' }, { userId: u.id });
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
        else {
          db.tgState[chatId] = { flow: 'sent', step: 'track', data: {} };
          out.push({ chat_id: chatId, text: 'Пришлите трек-номер посылки (или нажмите «Пропустить»):', reply_markup: SKIP_BTN });
        }
      } else if (d === 'skip' && st && st.flow === 'sent') {
        delete db.tgState[chatId];
        markSent(db, ctx, out, chatId, '');
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
      if (st.flow === 'sent' && text && !Object.values(BTN).includes(text)) {
        delete db.tgState[chatId];
        markSent(db, ctx, out, chatId, text);
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
        reply_markup: ib([[[p ? '✏️ Изменить анкету' : '🎁 Заполнить анкету', 'form']]]),
      });
    } else if (text === BTN.sent) {
      db.tgState[chatId] = { flow: 'sent', step: 'track', data: {} };
      out.push({ chat_id: chatId, text: 'Пришлите трек-номер посылки (или нажмите «Пропустить»):', reply_markup: SKIP_BTN });
    } else if (text === BTN.got) {
      out.push({ chat_id: chatId, text: 'Подтверждаете, что получили подарок от Тайного Санты?', reply_markup: ib([[['🎉 Да, получил!', 'received']]]) });
    } else greet(out, db, chatId, u0);
    return { out, actingUid };
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
          text: '🔔 ' + esc(n.text),
          reply_markup: n.action === 'whom' ? WHOM_BTN : n.action === 'gift' ? ib([[['🎉 Я получил подарок', 'received']]]) : n.action === 'wave2' ? W2_BTN : undefined,
        });
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
      if (wave && wave.status === 'closed') continue; // волна остановлена — не напоминаем
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
