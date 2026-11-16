'use strict';
// Подменяем сеть для ретранслятора: имитация Telegram и облака. Отправленное печатаем в stdout.
let served = false;
let needServed = false;
global.fetch = async (url, opts = {}) => {
  const isForm = opts.body && typeof opts.body !== 'string';
  const b = opts.body && !isForm ? JSON.parse(opts.body) : {};
  // картинка с сайта (подписанная ссылка) и файл из Telegram
  if (url.startsWith('https://site/api/img?')) return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
  if (url.includes('api.telegram.org/file/')) return { ok: true, arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer };
  if (url.includes('api.telegram.org')) {
    const m = url.split('/').pop();
    if (m === 'sendPhoto' && isForm) { console.log('PHOTOFILE', opts.body.get('chat_id'), opts.body.get('caption'), opts.body.get('photo').size); return { json: async () => ({ ok: true, result: true }) }; }
    if (m === 'getFile') return { json: async () => ({ ok: true, result: { file_path: 'photos/f.jpg' } }) };
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
  if (url.endsWith('/api/tg/outbox')) return ok({ out: [{ chat_id: 9, text: 'Из очереди' }, { method: 'sendPhoto', chat_id: 9, photo: 'https://site/api/img?id=ab&s=cd', caption: 'QR' }] });
  if (url.endsWith('/api/tg/photos-need')) { const r = needServed ? [] : ['FILE1']; needServed = true; return ok({ fileIds: r }); }
  if (url.endsWith('/api/tg/photo-store')) { console.log('STORED', b.fileId, b.image.slice(0, 23)); return ok({ ok: true }); }
  if (url.endsWith('/api/tg/watch')) return ok({ out: b.test ? [{ chat_id: 1, text: 'Тест' }] : [], done: false, admins: 1 });
  throw new Error('unexpected ' + url);
};
