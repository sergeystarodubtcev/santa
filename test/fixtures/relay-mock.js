'use strict';
// Подменяем сеть для ретранслятора: имитация Telegram и облака. Отправленное печатаем в stdout.
let served = false;
global.fetch = async (url, opts = {}) => {
  const b = opts.body ? JSON.parse(opts.body) : {};
  if (url.includes('api.telegram.org')) {
    const m = url.split('/').pop();
    if (m === 'getMe') return { json: async () => ({ ok: true, result: { username: 'test_bot' } }) };
    if (m === 'getUpdates') {
      await new Promise((r) => setTimeout(r, 100));
      const res = served || b.timeout === 0 ? [] : [{ update_id: 10, message: { text: '/start', chat: { id: 5, type: 'private' } } }];
      served = true;
      return { json: async () => ({ ok: true, result: res }) };
    }
    if (m === 'sendMessage') console.log('SENT', JSON.stringify(b));
    return { json: async () => ({ ok: true, result: true }) };
  }
  const ok = (data) => ({ ok: true, json: async () => data });
  if (url.endsWith('/api/tg/relay')) return ok({ out: [{ chat_id: b.update.message.chat.id, text: 'Привет!' }] });
  if (url.endsWith('/api/tg/outbox')) return ok({ out: [{ chat_id: 9, text: 'Из очереди' }] });
  if (url.endsWith('/api/tg/watch')) return ok({ out: b.test ? [{ chat_id: 1, text: 'Тест' }] : [], done: false, admins: 1 });
  throw new Error('unexpected ' + url);
};
