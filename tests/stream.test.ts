import { afterEach, expect, it, vi } from 'vitest';
import { finishStream, openStream, StreamingAudio, STREAM_LIMITS, type StreamTransport, type StreamContext } from '../src/main/transcription/stream';
const frame = (startMs = 0, length = 3200) => ({ pcm: new Uint8Array(length), startMs, endMs: startMs + length / 32 });
function transport(drain = false) {
  const t = { ready: true, bufferedBytes: 0,
    send: vi.fn((f: { pcm: Uint8Array }) => { if (!drain) t.bufferedBytes += f.pcm.length; }),
    abort: vi.fn(() => { t.ready = false; t.bufferedBytes = 0; }), finish: vi.fn(async () => {}),
  };
  return t;
}
afterEach(() => vi.useRealTimers());
it('immediately forwards silence as well as speech with no VAD or application queue', () => {
  const fault = vi.fn(), p = new StreamingAudio(fault), a = transport(true), b = transport(true);
  p.attach('microphone', a); p.attach('system', b);
  const silence = frame();
  expect(p.offer('microphone', silence)).toBe(true); expect(a.send).toHaveBeenCalledWith(silence);
  new Int16Array(silence.pcm.buffer).fill(2000);
  expect(p.offer('system', silence)).toBe(true); expect(b.send).toHaveBeenCalledOnce();
  expect(p.pendingBytes).toEqual({ microphone: 0, system: 0 }); expect(fault).not.toHaveBeenCalled();
});
it('pauses before a source would exceed 64000 bytes including transport and upstream reservation', () => {
  const fault = vi.fn(), p = new StreamingAudio(fault), a = transport(); p.attach('microphone', a);
  let accepted = 0;
  while (p.offer('microphone', frame(accepted * 100))) accepted++;
  expect(accepted).toBeGreaterThan(0);
  expect(a.bufferedBytes + STREAM_LIMITS.upstreamBytes).toBeLessThanOrEqual(64000);
  expect(a.send).toHaveBeenCalledTimes(accepted); expect(fault).toHaveBeenCalledExactlyOnceWith('limit');
  expect(p.offer('microphone', frame(5000))).toBe(false); expect(a.send).toHaveBeenCalledTimes(accepted);
  p.abort(); expect(a.bufferedBytes).toBe(0);
});
it('accounts both simultaneous transports without double-counting payloads', () => {
  const p = new StreamingAudio(vi.fn()), a = transport(), b = transport();
  p.attach('microphone', a); p.attach('system', b);
  for (let i = 0; i < 17; i++) { expect(p.offer('microphone', frame(i * 100))).toBe(true); expect(p.offer('system', frame(i * 100))).toBe(true); }
  const bytes = p.pendingBytes;
  expect(bytes.microphone + bytes.system).toBe(108800);
  expect(bytes.microphone + bytes.system + 2 * STREAM_LIMITS.upstreamBytes).toBeLessThanOrEqual(128000);
  expect(p.offer('system', frame(1700))).toBe(false);
});
it('allows indefinitely many incremental frames when transport drains', () => {
  const fault = vi.fn(), p = new StreamingAudio(fault), a = transport(true); p.attach('system', a);
  for (let i = 0; i < 10000; i++) expect(p.offer('system', frame(i * 100))).toBe(true);
  expect(p.pendingBytes.system).toBe(0); expect(fault).not.toHaveBeenCalled();
});
it.each(['closed', 'throws', 'invalid-counter', 'oversized-frame', 'out-of-order'] as const)('halts without retries on %s', (mode) => {
  const fault = vi.fn(), p = new StreamingAudio(fault), a = transport(); p.attach('system', a);
  if (mode === 'closed') a.ready = false;
  if (mode === 'throws') a.send.mockImplementation(() => { throw new Error('private detail'); });
  if (mode === 'invalid-counter') a.bufferedBytes = NaN;
  if (mode === 'out-of-order') expect(p.offer('system', frame(100))).toBe(true);
  expect(p.offer('system', frame(0, mode === 'oversized-frame' ? 3202 : 3200))).toBe(false);
  expect(fault).toHaveBeenCalledOnce();
  const count = a.send.mock.calls.length;
  expect(p.offer('system', frame(1000))).toBe(false); expect(a.send).toHaveBeenCalledTimes(count);
});
it('detects closed transport without waiting for a new audio frame', () => {
  const fault = vi.fn(), p = new StreamingAudio(fault), a = transport(); p.attach('microphone', a);
  a.ready = false; expect(p.check()).toBe(false); expect(fault).toHaveBeenCalledWith('connection');
});
it('detaches a disabled source without sending any pending data later', () => {
  const p = new StreamingAudio(vi.fn()), a = transport(); p.attach('system', a); p.offer('system', frame());
  p.detach('system')!.abort(); expect(p.offer('system', frame(100))).toBe(false); expect(a.send).toHaveBeenCalledOnce();
});
it('aborts all sources even if one abort throws', () => {
  const p = new StreamingAudio(vi.fn()), a = transport(), b = transport(); p.attach('microphone', a); p.attach('system', b);
  a.abort.mockImplementation(() => { throw new Error('abort failed'); });
  p.abort(); expect(b.abort).toHaveBeenCalledOnce(); expect(p.pendingBytes).toEqual({ microphone: 0, system: 0 });
});
it('bounds graceful finalization and aborts a stalled transport', async () => {
  vi.useFakeTimers(); const a = transport(); a.finish.mockImplementation(() => new Promise(() => {}));
  const closing = finishStream(a, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2000); expect(await closing).toBe(false); expect(a.abort).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('cancellation interrupts an outstanding finish immediately', async () => {
  const a = transport(), control = new AbortController(); a.finish.mockImplementation(() => new Promise(() => {}));
  const closing = finishStream(a, control.signal); control.abort(); expect(await closing).toBe(false); expect(a.abort).toHaveBeenCalledOnce();
});
it('closes gracefully on success without a leftover timer', async () => {
  vi.useFakeTimers(); const a = transport(); expect(await finishStream(a, new AbortController().signal)).toBe(true);
  expect(a.finish).toHaveBeenCalledOnce(); expect(a.abort).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('cancels an uncooperative connection and releases its late transport', async () => {
  let resolve!: (value: StreamTransport) => void;
  const c = new AbortController(), a = transport();
  const context: StreamContext = { sessionId: 'session', language: 'pt', signal: c.signal, onFinal: vi.fn(), onFailure: vi.fn() };
  const opening = openStream(() => new Promise((done) => { resolve = done; }), 'system', context);
  await Promise.resolve(); c.abort(); await expect(opening).rejects.toThrow('cancelada');
  resolve(a); await Promise.resolve(); await Promise.resolve(); expect(a.abort).toHaveBeenCalledOnce();
});
it('times out opening without capturing or leaving a timer', async () => {
  vi.useFakeTimers(); const c = new AbortController();
  const opening = openStream(() => new Promise(() => {}), 'system', { sessionId: 'session', language: 'pt', signal: c.signal, onFinal: vi.fn(), onFailure: vi.fn() });
  const assertion = expect(opening).rejects.toThrow('cinco segundos');
  await vi.advanceTimersByTimeAsync(5000); await assertion; expect(vi.getTimerCount()).toBe(0);
});
