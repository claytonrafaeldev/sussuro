import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserWindow } from 'electron';
import { DEFAULT_OPTIONS, type SourceId } from '../src/shared/contracts';
import type { StreamFactory, StreamContext, StreamFrame } from '../src/main/transcription/stream';
const linux = vi.hoisted(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}), captures: [] as ((pcm: Uint8Array) => void)[] }));
vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, dialog: { showSaveDialog: vi.fn() } }));
vi.mock('../src/main/audio/linux', () => ({ systemDevices: vi.fn(async () => []), LinuxOutput: class {
  async start(_id: string, receive: (pcm: Uint8Array) => void) { linux.captures.push(receive); await linux.start(); }
  async stop() { await linux.stop(); }
} }));
import { dialog } from 'electron';
import { Coordinator } from '../src/main/coordinator';
import { SessionStore } from '../src/main/storage';
const options = { ...DEFAULT_OPTIONS, system: true, systemId: 'test-output' };
const pcm = () => { const a = new Uint8Array(3200); new Int16Array(a.buffer).fill(2000); return a; };
function connection(source: SourceId, context: StreamContext) {
  const t = { source, context, ready: true, bufferedBytes: 0,
    send: vi.fn((_f: StreamFrame) => {}),
    finish: vi.fn(async () => {}), abort: vi.fn(() => { t.ready = false; t.bufferedBytes = 0; }),
  }; return t;
}
type Connection = ReturnType<typeof connection>;
let connections: Connection[];
let factory: StreamFactory;
beforeEach(() => {
  vi.mocked(dialog.showSaveDialog).mockReset();
  connections = []; linux.captures.length = 0; linux.start.mockReset().mockResolvedValue(); linux.stop.mockReset().mockResolvedValue();
  factory = async (source, context) => { const t = connection(source, context); connections.push(t); return t; };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture(run: (c: Coordinator, store: SessionStore) => Promise<void>, custom?: StreamFactory) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sussurro-stream-coordinator-'));
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: path.join(directory, '..', path.basename(directory) + '.txt') });
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const store = new SessionStore(directory);
  const c = new Coordinator(window, store, custom ?? factory);
  try { await run(c, store); } finally { await c.dispose(true); await rm(directory, { recursive: true, force: true }); await rm(path.join(directory, '..', path.basename(directory) + '.txt'), { force: true }); }
}
async function mic(c: Coordinator, sequence = 0, startMs = sequence * 100) {
  const s = await c.getState();
  return c.audio({ sessionId: s.sessionId!, captureId: s.microphoneCaptureId!, sequence, startMs, pcm: pcm() });
}
it('blocks actual app capture until the provider exists while local preview remains available', async () => {
  const { unavailableStream } = await import('../src/main/transcription/stream');
  await fixture(async (c) => {
    await c.beginMicrophoneCheck(); expect(c.microphoneAllowed()).toBe(true); await c.endMicrophoneCheck();
    await expect(c.start(options)).rejects.toThrow('Deepgram');
    expect(await c.getState()).toMatchObject({ phase: 'error', microphoneCaptureId: null });
    expect(c.microphoneAllowed()).toBe(false); expect(linux.start).not.toHaveBeenCalled();
  }, unavailableStream);
});
it('sends both sources immediately including silence and stops without replay', async () => fixture(async (c) => {
  await c.start(options);
  expect(await mic(c)).toBe(true); linux.captures[0](new Uint8Array(3200));
  expect(connections.map((t) => [t.source, t.send.mock.calls.length])).toEqual([['microphone', 1], ['system', 1]]);
  const old = await c.getState();
  await c.pause(); expect(connections.every((t) => t.abort.mock.calls.length === 1)).toBe(true);
  expect(c.audio({ sessionId: old.sessionId!, captureId: old.microphoneCaptureId!, sequence: 1, startMs: 100, pcm: pcm() })).toBe(false);
  linux.captures[0](pcm()); expect(connections[1].send).toHaveBeenCalledOnce();
  await c.resume(); expect(connections).toHaveLength(4);
  expect(connections[2].send).not.toHaveBeenCalled(); expect(connections[3].send).not.toHaveBeenCalled();
}));
it('pauses both sources before transport overflow, releases resources and preserves final text', async () => fixture(async (c) => {
  await c.start(options);
  const t = connections[0];
  t.context.onFinal({ id: 'final-1', text: 'Synthetic final', startMs: 0, endMs: 50 });
  t.bufferedBytes = 60000;
  expect(await mic(c)).toBe(false);
  const state = await c.getState();
  expect(state).toMatchObject({ phase: 'paused', microphoneCaptureId: null, pendingSeconds: 0, levels: { microphone: 0, system: 0 } });
  expect(state.audioGapCount).toBeGreaterThan(0); expect(state.message).toContain('lacuna');
  expect(state.segments[0].text).toBe('Synthetic final'); expect(c.microphoneAllowed()).toBe(false);
  expect(t.send).not.toHaveBeenCalled(); expect(connections.every((x) => x.abort.mock.calls.length === 1)).toBe(true);
  await c.stop(false); expect((await c.readSession(state.sessionId!)).audioGapCount).toBeGreaterThan(0);
}));
it('samples both transports in the UI pending metric', async () => fixture(async (c) => {
  await c.start(options); connections[0].bufferedBytes = 32000; connections[1].bufferedBytes = 16000;
  expect(await c.getState()).toMatchObject({ pendingBytes: { microphone: 32000, system: 16000 }, pendingSeconds: 1.5 });
}));
it('detects closed network without a new frame and requires explicit resume', async () => fixture(async (c) => {
  await c.start(options); connections[1].ready = false;
  await vi.waitFor(async () => expect((await c.getState()).phase).toBe('paused'));
  expect(connections).toHaveLength(2);
  await c.resume(); expect(connections).toHaveLength(4);
}));
it('disables one source without closing or resending the other source', async () => fixture(async (c) => {
  const initial = await c.start(options); const first = connections[0], second = connections[1];
  await c.setSources({ microphone: false, system: true });
  expect(first.abort).toHaveBeenCalledOnce(); expect(second.abort).not.toHaveBeenCalled();
  linux.captures[0](pcm()); expect(second.send).toHaveBeenCalledOnce();
  await c.setSources({ microphone: true, system: false });
  expect(second.abort).toHaveBeenCalledOnce();
  expect((await c.getState()).microphoneCaptureId).not.toBe(initial.microphoneCaptureId);
  expect(await mic(c)).toBe(true); expect(connections[2].send).toHaveBeenCalledOnce();
  await c.setSources({ microphone: false, system: false });
  expect((await c.getState()).phase).toBe('paused'); await expect(c.resume()).rejects.toThrow('Ative pelo menos');
}));
it('changes only the selected connection and does not reconnect during pause', async () => fixture(async (c) => {
  await c.start(options); const mic1 = connections[0], system1 = connections[1];
  await c.setSources({ microphone: true, system: true, microphoneId: 'mic-b' });
  expect(mic1.abort).toHaveBeenCalledOnce(); expect(system1.abort).not.toHaveBeenCalled();
  mic1.context.onFailure(); expect((await c.getState()).phase).toBe('capturing');
  await c.pause(); await c.setSources({ microphone: true, system: true, systemId: 'output-b' });
  expect(connections).toHaveLength(3);
  await c.resume(); expect(connections).toHaveLength(5);
}));
it('does not open a microphone while its new connection is still pending', async () => {
  let resolve!: (t: Connection) => void, late!: Connection;
  await fixture(async (c) => {
    await c.start({ ...options, microphone: false });
    const changing = c.setSources({ microphone: true, system: true });
    await Promise.resolve(); await Promise.resolve();
    expect(c.microphoneAllowed()).toBe(false); expect((await c.getState()).microphoneCaptureId).toBeNull();
    await c.stop(true); await changing;
    resolve(late); await vi.waitFor(() => expect(late.abort).toHaveBeenCalledOnce());
    expect(late.abort).toHaveBeenCalledOnce(); expect((await c.getState()).phase).toBe('completed');
  }, async (source, context) => {
    const t = connection(source, context); connections.push(t);
    if (source === 'microphone') { late = t; return new Promise((done) => { resolve = done; }); }
    return t;
  });
});
it('bounds finalization; cancellation interrupts finish and ignores late finals', async () => fixture(async (c) => {
  await c.start(options); const first = connections[0]; first.finish.mockImplementation(() => new Promise(() => {}));
  const stopping = c.stop(false); await Promise.resolve(); await Promise.resolve();
  await c.stop(true); await stopping;
  first.context.onFinal({ id: 'late', text: 'Must be ignored', startMs: 0, endMs: 100 });
  expect((await c.getState()).phase).toBe('completed'); expect((await c.getState()).segments).toEqual([]);
  expect(first.abort).toHaveBeenCalled();
}));
it('keeps final events during graceful close and deduplicates within a connection', async () => fixture(async (c) => {
  await c.start(options); const t = connections[0];
  t.finish.mockImplementation(async () => {
    const final = { id: 'stable-id', text: 'Synthetic final', startMs: 0, endMs: 100 };
    t.context.onFinal(final); t.context.onFinal(final);
  });
  await c.stop(false); const s = await c.getState(); expect(s.segments).toHaveLength(1);
  expect((await c.readSession(s.sessionId!)).segments).toHaveLength(1);
}));
it('marks a timeout during finalization as a gap and releases both streams', async () => fixture(async (c) => {
  vi.useFakeTimers(); await c.start(options); connections[0].finish.mockImplementation(() => new Promise(() => {}));
  const stopping = c.stop(false); await vi.advanceTimersByTimeAsync(2000); await stopping;
  expect((await c.getState()).phase).toBe('completed'); expect((await c.getState()).audioGapCount).toBeGreaterThan(0);
  expect(connections.every((t) => t.abort.mock.calls.length > 0)).toBe(true);
}));
it('accepts sequence restart only with a new capture identity and flags a missing live frame', async () => fixture(async (c) => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  await c.start(options); clock.mockReturnValue(2000);
  expect(await mic(c, 0)).toBe(true); expect(await mic(c, 2, 200)).toBe(false);
  expect((await c.getState()).phase).toBe('paused'); await c.resume();
  expect(await mic(c, 0, 700)).toBe(true);
}));
it('cancels pending preparation and releases the late transport without opening capture', async () => {
  let done!: (t: Connection) => void, t!: Connection;
  await fixture(async (c) => {
    const starting = c.start(options);
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    await c.stop(true); await starting;
    done(t); await vi.waitFor(() => expect(t.abort).toHaveBeenCalled());
    expect(t.abort).toHaveBeenCalled(); expect(linux.start).not.toHaveBeenCalled(); expect(c.microphoneAllowed()).toBe(false);
  }, async (source, context) => { t = connection(source, context); return new Promise((resolve) => { done = resolve; }); });
});

it('replaces partials per source without persisting them, deduplicates finals by connection and discards stale partials', async () => fixture(async (c) => {
  await c.start(options);
  const [mic, system] = connections;
  mic.context.onPartial?.({ text: 'pre', startMs: 0, endMs: 100 });
  mic.context.onPartial?.({ text: 'parcial', startMs: 0, endMs: 200 });
  system.context.onPartial?.({ text: 'sistema', startMs: 0, endMs: 100 });
  expect((await c.getState()).partials).toMatchObject({ microphone: { text: 'parcial' }, system: { text: 'sistema' } });
  const result = { id: '0:.2', text: 'final', startMs: 0, endMs: 200 };
  mic.context.onPartial?.(null); mic.context.onFinal(result); mic.context.onFinal(result);
  expect((await c.getState()).segments).toHaveLength(1);
  const sessionId = (await c.getState()).sessionId!;
  await vi.waitFor(async () => expect((await c.readSession(sessionId)).segments).toHaveLength(1));
  expect(await c.readSession(sessionId)).not.toHaveProperty('partials');
  await c.pause(); mic.context.onPartial?.({ text: 'stale', startMs: 0, endMs: 100 });
  expect((await c.getState()).partials).toEqual({});
  await c.resume(); connections[2].context.onFinal({ ...result, startMs: 1000, endMs: 1200 });
  expect((await c.getState()).segments).toHaveLength(2);
}));
it('blocks key mutation while preparing/capturing/paused and preserves actionable provider failures', async () => fixture(async (c) => {
  await c.start(options);
  await expect(c.configureCredential({ key: 'synthetic', persist: false })).rejects.toThrow('Finalize');
  connections[0].context.onFailure('auth');
  expect(await c.getState()).toMatchObject({ phase: 'paused', message: expect.stringContaining('Chave Deepgram recusada') });
  await expect(c.removeCredential()).rejects.toThrow('Finalize');
}));

it.each(['en', 'multi'])('preserves selected language %s across both sources, resume and source replacement', async (language) => fixture(async (c) => {
  await c.start({ ...options, language });
  expect(connections.map((t) => t.context.language)).toEqual([language, language]);
  await c.pause(); await c.resume();
  expect(connections.map((t) => t.context.language)).toEqual([language, language, language, language]);
  await c.setSources({ microphone: true, system: true, microphoneId: 'replacement' });
  expect(connections[4].context.language).toBe(language);
  connections[4].context.onFinal({ id: 'english-final', text: 'Good morning.', startMs: 0, endMs: 100 });
  await c.stop(false);
  const state = await c.getState(), saved = await c.readSession(state.sessionId!);
  expect(state.options.language).toBe(language); expect(saved.options.language).toBe(language);
  expect(saved.segments[0].text).toBe('Good morning.');
}));

it('reports real connection stages, arrival timing, peak queues and rejects stale/duplicate metric events', async () => fixture(async (c) => {
  let now = 1000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  await c.start(options);
  expect((await c.getState()).performance?.sources.microphone.connection).toBe('open');
  now = 1100; await mic(c);
  now = 1500; connections[0].context.onPartial?.({ text: 'synthetic partial', startMs: 0, endMs: 100 });
  now = 1700;
  const final = { id: 'metric-final', text: 'synthetic final', startMs: 0, endMs: 100 };
  connections[0].context.onFinal(final); connections[0].context.onFinal(final);
  expect((await c.getState()).performance?.sources.microphone).toMatchObject({ firstPartialMs: 400, firstFinalMs: 600, lastPartialAtMs: 500, lastFinalAtMs: 700, lastPartialLagMs: 400, lastFinalLagMs: 600, finalCount: 1 });
  connections[0].bufferedBytes = 55000; await c.getState();
  expect((await c.getState()).performance?.peakTotalPendingBytes).toBe(55000);
  await c.pause(); connections[0].context.onFinal({ ...final, id: 'late' });
  expect((await c.getState()).performance?.sources.microphone).toMatchObject({ connection: 'closed', finalCount: 1 });
  now = 3000; await c.resume();
  expect((await c.getState()).performance?.sources.microphone).toMatchObject({ connection: 'open', connectionCount: 2, firstPartialMs: null, firstFinalMs: null });
  clock.mockRestore();
}));
it('counts pending transport audio while gracefully draining and reports confirmed closure', async () => fixture(async (c) => {
  await c.start(options); const connection = connections[0]; connection.bufferedBytes = 32000;
  let finish!: () => void;
  connection.finish.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const stopping = c.stop(false);
  await vi.waitFor(async () => expect((await c.getState()).performance?.sources.microphone.connection).toBe('closing'));
  expect((await c.getState()).pendingBytes.microphone).toBe(32000);
  connection.bufferedBytes = 0; finish(); await stopping;
  expect((await c.getState()).performance?.sources.microphone.connection).toBe('closed');
}));
it('starts numeric measurement without opening audio/provider and records only bounded whitelisted metrics', async () => {
  vi.useFakeTimers();
  await fixture(async (c) => {
  await c.beginMeasurement('one-source');
  expect(connections).toHaveLength(0); expect(linux.start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1200);
  expect((await c.getState()).performance?.measurement).toMatchObject({ active: true, samples: 1 });
  await expect(c.beginMeasurement('two-sources')).rejects.toThrow('Já há');
  await c.endMeasurement(); await vi.advanceTimersByTimeAsync(2000);
  expect((await c.getState()).performance?.measurement).toMatchObject({ active: false, samples: 1 });
  });
});

it('exports numeric reports without session text/options/IDs and never exports an active recording', async () => {
  vi.useFakeTimers();
  const directory = await mkdtemp(path.join(tmpdir(), 'sussurro-performance-export-'));
  const { dialog } = await import('electron');
  const file = path.join(directory, 'measurement.json');
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: file });
  try {
    await fixture(async (c) => {
      await c.beginMeasurement('one-source');
      await expect(c.exportMeasurement()).rejects.toThrow('Encerre');
      await c.start({ ...options, system: false });
      connections[0].context.onFinal({ id: 'sensitive-id', text: 'synthetic-private-transcript', startMs: 0, endMs: 100 });
      await vi.advanceTimersByTimeAsync(1200); await c.endMeasurement();
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: file });
      expect(await c.exportMeasurement()).toBe(true);
      const { readFile, stat } = await import('node:fs/promises');
      const json = await readFile(file, 'utf8'), report = JSON.parse(json);
      expect(report).toMatchObject({ schemaVersion: 1, scenario: 'one-source', sampleCount: 1, privacy: { audioIncluded: false, transcriptIncluded: false, keyIncluded: false } });
      for (const forbidden of ['synthetic-private-transcript', 'sensitive-id', 'sessionId', 'microphoneId', 'systemId', 'DEEPGRAM_API_KEY']) expect(json).not.toContain(forbidden);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('chooses a destination before any provider/capture and cancellation preserves the current session', async () => fixture(async (c) => {
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' });
  expect((await c.start(options)).sessionId).toBeNull();
  expect(connections).toHaveLength(0); expect(linux.start).not.toHaveBeenCalled();
  await c.start(options); await c.stop(false);
  const previous = await c.getState();
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' });
  expect((await c.start(options)).sessionId).toBe(previous.sessionId);
  expect(connections).toHaveLength(2);
}));
it('automatically saves accepted finals and pause/finish status to history and chosen TXT', async () => fixture(async (c) => {
  const { readFile } = await import('node:fs/promises');
  await c.start(options);
  const state = await c.getState();
  expect(await readFile(state.savePath!, 'utf8')).toBe('');
  connections[0].context.onFinal({ id: 'saved-final', text: 'Synthetic saved text', startMs: 1000, endMs: 2000 });
  await c.pause();
  expect(await readFile(state.savePath!, 'utf8')).toBe('[00:00:01] Microfone: Synthetic saved text');
  expect(await c.readSession(state.sessionId!)).toMatchObject({ status: 'paused', segments: [{ text: 'Synthetic saved text' }] });
  await c.stop(false);
  expect((await c.readSession(state.sessionId!)).status).toBe('completed');
}));
it('hides a saved session and refuses to open it after its TXT is removed', async () => fixture(async (c) => {
  const { unlink } = await import('node:fs/promises');
  await c.start(options); const state = await c.getState();
  await c.stop(false);
  expect((await c.listSessions()).some((item) => item.id === state.sessionId)).toBe(true);
  await unlink(state.savePath!);
  expect((await c.listSessions()).some((item) => item.id === state.sessionId)).toBe(false);
  await expect(c.readSession(state.sessionId!)).rejects.toThrow('não existe mais');
}));
it('keeps temporary sessions out of disk/history on finals, pause, finish and close while allowing explicit copy/export', async () => fixture(async (c) => {
  const { clipboard } = await import('electron');
  const { readFile } = await import('node:fs/promises');
  await c.start({ ...options, persistence: 'temporary' });
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  connections[0].context.onFinal({ id: 'temporary-final', text: 'Only in memory', startMs: 0, endMs: 100 });
  await c.pause(); await c.stop(false);
  expect(await c.listSessions()).toEqual([]);
  const id = (await c.getState()).sessionId!;
  await c.copySession(id); expect(clipboard.writeText).toHaveBeenCalledWith('[00:00:00] Microfone: Only in memory');
  const directory = await mkdtemp(path.join(tmpdir(), 'sussurro-explicit-export-'));
  try {
    const file = path.join(directory, 'explicit.txt');
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: file });
    expect(await c.exportSession(id)).toBe(true); expect(await readFile(file, 'utf8')).toContain('Only in memory');
    await c.dispose(); expect(await c.listSessions()).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));
it('flushes late finals before closing the application', async () => fixture(async (c) => {
  const { readFile } = await import('node:fs/promises');
  await c.start(options); const state = await c.getState();
  connections[0].finish.mockImplementationOnce(async () => {
    connections[0].context.onFinal({ id: 'closing-final', text: 'Final on close', startMs: 0, endMs: 100 });
  });
  await c.dispose();
  expect(await readFile(state.savePath!, 'utf8')).toContain('Final on close');
  expect((await c.readSession(state.sessionId!)).status).toBe('completed');
}));
it('refuses to capture when the chosen destination cannot be written', async () => fixture(async (c) => {
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: '/nonexistent-sussurro-parent/transcript.txt' });
  await expect(c.start(options)).rejects.toThrow('salvar automaticamente');
  expect(connections).toHaveLength(0); expect(linux.start).not.toHaveBeenCalled();
}));
it('keeps text available and rejects normal close after destination failure, then permits a retry', async () => fixture(async (c) => {
  const { mkdir, unlink, readFile } = await import('node:fs/promises');
  await c.start(options); const state = await c.getState();
  await unlink(state.savePath!); await mkdir(state.savePath!);
  connections[0].context.onFinal({ id: 'recoverable', text: 'Recoverable text', startMs: 0, endMs: 100 });
  await expect(c.dispose()).rejects.toThrow('salvar automaticamente');
  expect((await c.getState()).segments[0].text).toBe('Recoverable text');
  await rm(state.savePath!, { recursive: true });
  await c.dispose(); expect(await readFile(state.savePath!, 'utf8')).toContain('Recoverable text');
}));

it('does not recreate a deleted current history entry when closing and preserves the chosen TXT', async () => fixture(async (c) => {
  const { readFile } = await import('node:fs/promises');
  await c.start(options);
  connections[0].context.onFinal({ id: 'retained-txt', text: 'Keep chosen file', startMs: 0, endMs: 100 });
  await c.stop(false); const state = await c.getState();
  await c.deleteSession(state.sessionId!); await c.dispose();
  expect(await c.listSessions()).toEqual([]);
  expect(await readFile(state.savePath!, 'utf8')).toContain('Keep chosen file');
}));

it('revokes both captures when the renderer disappears and never resumes automatically on reload', async () => fixture(async (c) => {
  await c.start(options);
  connections[0].context.onFinal({ id: 'before-loss', text: 'Retained confirmed text', startMs: 0, endMs: 50 });
  const old = await c.getState(); c.rendererUnavailable();
  expect((await c.getState()).phase).toBe('paused'); expect(c.microphoneAllowed()).toBe(false);
  expect(connections.every(t => t.abort.mock.calls.length === 1)).toBe(true);
  expect(c.audio({ sessionId: old.sessionId!, captureId: old.microphoneCaptureId!, sequence: 0, startMs: 0, pcm: pcm() })).toBe(false);
  linux.captures[0](pcm()); expect(connections[1].send).not.toHaveBeenCalled();
  c.rendererReady(); expect((await c.getState()).phase).toBe('paused');
  expect((await c.getState()).segments[0].text).toBe('Retained confirmed text');
  expect(connections).toHaveLength(2); await c.resume(); expect(connections).toHaveLength(4);
}));
it('cancels a provider opening if the renderer disappears before capture', async () => {
  let ready!: (value: Connection) => void; let openingContext!: StreamContext;
  await fixture(async (c) => {
    const starting = c.start(options);
    await vi.waitFor(() => expect(openingContext).toBeDefined());
    c.rendererUnavailable(); c.rendererReady(); await starting;
    const late = connection('microphone', openingContext); ready(late);
    await vi.waitFor(() => expect(late.abort).toHaveBeenCalled());
    expect((await c.getState()).phase).toBe('error'); expect(c.microphoneAllowed()).toBe(false);
    expect(linux.start).not.toHaveBeenCalled();
  }, async (_source, context) => { openingContext = context; return new Promise(resolve => { ready = resolve; }); });
});
it('pauses and releases streams when output restart fails after provider connections opened', async () => fixture(async (c) => {
  await c.start(options); await c.pause();
  linux.start.mockRejectedValueOnce(new Error('private system details'));
  await expect(c.resume()).rejects.toThrow('Confira a conexão e as fontes');
  const state = await c.getState();
  expect(state).toMatchObject({ phase: 'paused', microphoneCaptureId: null });
  expect(state.message).not.toContain('private'); expect(c.microphoneAllowed()).toBe(false);
  expect(connections.every(t => t.abort.mock.calls.length === 1)).toBe(true);
}));
it('reads unfinished sessions from previous executions as interrupted while retaining confirmed text', async () => fixture(async (c, store) => {
  const { randomUUID } = await import('node:crypto'); const id = randomUUID();
  await store.save({ schemaVersion: 1, id, createdAt: new Date().toISOString(), status: 'capturing', options: { ...options },
    segments: [{ id: randomUUID(), source: 'system', startMs: 0, endMs: 100, text: 'Interrupted session text' }] }, path.join(path.dirname(store.directory), `${path.basename(store.directory)}.txt`));
  expect((await c.listSessions())[0]).toMatchObject({ id, status: 'error', count: 1 });
  expect(await c.readSession(id)).toMatchObject({ status: 'error', segments: [{ text: 'Interrupted session text' }] });
  expect((await store.read(id)).status).toBe('capturing'); // Recovery presentation does not rewrite old evidence.
}));

it('notifies the auxiliary UI of revoked capture even with the main renderer unavailable and tolerates popup failure', async () => fixture(async (c) => {
  const phases: string[] = [];
  const unsubscribe = c.subscribeState((state) => { phases.push(state.phase); });
  const failed = c.subscribeState(() => { throw new Error('synthetic optional popup failure'); });
  await c.start({ ...options, persistence: 'temporary' });
  expect(phases).toContain('capturing');
  c.rendererUnavailable();
  await vi.waitFor(async () => expect((await c.getState()).phase).toBe('paused'));
  expect(phases.at(-1)).toBe('paused');
  expect(c.microphoneAllowed()).toBe(false);
  unsubscribe(); failed(); const count = phases.length;
  c.rendererReady(); expect(phases).toHaveLength(count);
}));
