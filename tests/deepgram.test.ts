import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { deepgramFactory, deepgramUrl } from '../src/main/transcription/deepgram';
import { finishStream, openStream, type StreamContext } from '../src/main/transcription/stream';
class Socket extends EventEmitter {
  readyState = 0; bufferedAmount = 0;
  writes: (Uint8Array | string)[] = [];
  send(data: Uint8Array | string, _options: unknown, callback: (error?: Error) => void) { this.writes.push(data); callback(); }
  terminate = vi.fn(() => { this.readyState = 3; });
  open() { this.readyState = 1; this.emit('open'); }
  result(text: string, final = true, start = 0, duration = .1) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel_index: [0, 1], start, duration, is_final: final, channel: { alternatives: [{ transcript: text }] } })), false);
  }
}
function setup(language = 'pt-BR') {
  const socket = new Socket(), controller = new AbortController();
  const context: StreamContext = { sessionId: 'synthetic', language, signal: controller.signal, onFinal: vi.fn(), onPartial: vi.fn(), onFailure: vi.fn() };
  const create = vi.fn(() => socket as unknown as WebSocket);
  const factory = deepgramFactory({ getApiKey: () => 'synthetic-secret' }, create);
  return { socket, controller, context, create, factory };
}
const frame = (startMs = 2500) => ({ pcm: new Uint8Array(3200), startMs, endMs: startMs + 100 });
afterEach(() => vi.useRealTimers());
it('uses a fixed TLS endpoint/header, supported languages and disabled compression/redirects', async () => {
  const t = setup(); const pending = t.factory('system', t.context); t.socket.open(); const stream = await pending;
  const [url, options] = t.create.mock.calls[0] as unknown as [string, { headers: object; perMessageDeflate: boolean; followRedirects: boolean }];
  expect(url).toBe(deepgramUrl('pt-BR')); expect(url).not.toContain('synthetic-secret');
  expect(options).toMatchObject({ headers: { Authorization: 'Token synthetic-secret' }, perMessageDeflate: false, followRedirects: false, maxPayload: 131072 });
  expect(() => deepgramUrl('auto')).toThrow(); expect(deepgramUrl('multi')).toContain('language=multi');
  stream.abort();
});
it('sends silence immediately, counts socket bytes and maps partial/final onto the first frame timeline', async () => {
  const t = setup(); const pending = t.factory('microphone', t.context); t.socket.open(); const stream = await pending;
  stream.send(frame()); expect(t.socket.writes).toHaveLength(1); expect(t.socket.writes[0]).toBeInstanceOf(Uint8Array);
  t.socket.bufferedAmount = 3208; expect(stream.bufferedBytes).toBe(3208);
  t.socket.result('par', false); t.socket.result('parcial', false); t.socket.result('final');
  expect(t.context.onPartial).toHaveBeenNthCalledWith(1, { id: '0:0.1', text: 'par', startMs: 2500, endMs: 2600 });
  expect(t.context.onPartial).toHaveBeenLastCalledWith(null);
  expect(t.context.onFinal).toHaveBeenCalledWith({ id: '0:0.1', text: 'final', startMs: 2500, endMs: 2600 });
  stream.abort(); t.socket.result('stale'); expect(t.context.onFinal).toHaveBeenCalledOnce();
  expect(stream.bufferedBytes).toBe(0); expect(() => stream.send(frame())).toThrow(); stream.abort(); expect(t.socket.terminate).toHaveBeenCalledOnce();
});
it('keeps finals during CloseStream and completes only after metadata and normal closure', async () => {
  const t = setup(); const pending = t.factory('system', t.context); t.socket.open(); const stream = await pending; stream.send(frame());
  const done = stream.finish(); expect(t.socket.writes[1]).toBe('{"type":"CloseStream"}'); expect(stream.ready).toBe(false);
  t.socket.result('final'); t.socket.emit('message', Buffer.from('{"type":"Metadata"}'), false); t.socket.emit('close', 1000);
  await done; expect(t.context.onFinal).toHaveBeenCalledOnce(); expect(t.context.onFailure).not.toHaveBeenCalled();
});
it.each([401, 403, 402, 429, 500])('sanitizes HTTP %s without exposing response body/reason', async (statusCode) => {
  const t = setup(); const pending = t.factory('system', t.context);
  const rejection = expect(pending).rejects.toThrow(statusCode === 401 || statusCode === 403 ? 'Chave Deepgram recusada' : statusCode === 402 || statusCode === 429 ? 'Limite ou saldo' : 'Conexão Deepgram');
  t.socket.emit('unexpected-response', {}, { statusCode, body: 'synthetic-secret', destroy: vi.fn() });
  await rejection; expect(t.socket.terminate).toHaveBeenCalledOnce();
});
it('bounds opening, missing capture, finish, and aborts opening without a leaked socket', async () => {
  vi.useFakeTimers();
  const t = setup(); const pending = openStream(t.factory, 'system', t.context); const rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5001); await rejected; expect(t.socket.terminate).toHaveBeenCalledOnce();
  const a = setup(); const opening = a.factory('system', a.context); const aborted = expect(opening).rejects.toThrow(); a.controller.abort(); await aborted;
  const b = setup(); const p = b.factory('system', b.context); b.socket.open(); const stream = await p;
  await vi.advanceTimersByTimeAsync(5001); expect(b.context.onFailure).toHaveBeenCalledWith('network'); expect(stream.ready).toBe(false);
  const c = setup(); const q = c.factory('system', c.context); c.socket.open(); const s = await q;
  const finish = finishStream(s, c.controller.signal); await vi.advanceTimersByTimeAsync(2001); expect(await finish).toBe(false);
});
it('pauses on malformed/oversized results or timeline gaps and never forwards provider error text', async () => {
  const t = setup(); const p = t.factory('microphone', t.context); t.socket.open(); const stream = await p; stream.send(frame());
  expect(() => stream.send(frame(4000))).toThrow();
  t.socket.emit('message', Buffer.from('{"type":"Error","description":"synthetic-secret"}'), false);
  expect(t.context.onFailure).toHaveBeenCalledWith('protocol'); expect(t.context.onFinal).not.toHaveBeenCalled();
  const a = setup(); const q = a.factory('system', a.context); a.socket.open(); const s = await q; s.send(frame()); a.socket.result('future', true, 4000);
  expect(a.context.onFailure).toHaveBeenCalledWith('protocol');
});

it.each(['en', 'multi'])('delivers English partials and finals unchanged for selected language %s', async (language) => {
  const t = setup(language);
  const pending = t.factory('system', t.context); t.socket.open(); const stream = await pending;
  const [url] = t.create.mock.calls[0] as unknown as [string];
  expect(new URL(url).searchParams.get('language')).toBe(language);
  stream.send(frame());
  t.socket.result('Good', false); t.socket.result('Good morning.', true);
  expect(t.context.onPartial).toHaveBeenCalledWith({ id: '0:0.1', text: 'Good', startMs: 2500, endMs: 2600 });
  expect(t.context.onFinal).toHaveBeenCalledWith({ id: '0:0.1', text: 'Good morning.', startMs: 2500, endMs: 2600 });
  expect(t.context.onFailure).not.toHaveBeenCalled();
  stream.abort();
});
