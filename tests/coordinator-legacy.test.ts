import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BrowserWindow } from 'electron';
import { DEFAULT_OPTIONS } from '../src/shared/contracts';

const controls = vi.hoisted(() => ({
  inference: async (): Promise<{ text: string }> => ({ text: 'Teste local' }),
  startOutput: vi.fn(async () => {}), stopOutput: vi.fn(async () => {}),
  captures: [] as { id: string; receive: (pcm: Uint8Array) => void; fail: (message: string) => void }[],
}));
vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, dialog: { showSaveDialog: vi.fn() } }));
vi.mock('../src/main/transcription/whisper', () => ({ WhisperEngine: class {
  running = false;
  async start() { this.running = true; }
  async stop() { this.running = false; }
  transcribe() { return controls.inference(); }
} }));
vi.mock('../src/main/audio/linux', () => ({ systemDevices: async () => [{ id: 'test-output', label: 'Synthetic output' }], LinuxOutput: class {
  async start(id: string, receive: (pcm: Uint8Array) => void, fail: (message: string) => void) {
    controls.captures.push({ id, receive, fail }); await controls.startOutput();
  }
  async stop() { await controls.stopOutput(); }
} }));
import { Coordinator } from '../src/main/coordinator-legacy';
import { SessionStore } from '../src/main/storage';

beforeEach(() => {
  controls.inference = async () => ({ text: 'Teste local' });
  controls.captures.length = 0;
  controls.startOutput.mockReset().mockResolvedValue(); controls.stopOutput.mockReset().mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());
it('pauses when both sources are disabled and preserves session identity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sussurro-coordinator-'));
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const coordinator = new Coordinator(window, 'unused', new SessionStore(dir));
  try {
    const state = await coordinator.start({ ...DEFAULT_OPTIONS, systemId: 'test-output' });
    expect(state.phase).toBe('capturing');
    await coordinator.setSources({ microphone: false, system: false });
    expect((await coordinator.getState()).phase).toBe('paused');
    await expect(coordinator.resume()).rejects.toThrow('Ative pelo menos');
    await coordinator.stop(true);
    expect((await coordinator.getState()).phase).toBe('completed');
    expect((await coordinator.readSession(state.sessionId!)).segments).toEqual([]);
  } finally { await coordinator.dispose(); await rm(dir, { recursive: true, force: true }); }
});
it('discards stale frames and late inference results after cancellation', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  let finish!: (value: { text: string }) => void;
  controls.inference = () => new Promise((resolve) => { finish = resolve; });
  const dir = await mkdtemp(path.join(tmpdir(), 'sussurro-coordinator-'));
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const coordinator = new Coordinator(window, 'unused', new SessionStore(dir));
  try {
    const state = await coordinator.start(DEFAULT_OPTIONS); clock.mockReturnValue(13000);
    const pcm = new Uint8Array(32000); new Int16Array(pcm.buffer).fill(1000);
    coordinator.audio({ captureId: state.microphoneCaptureId!, sessionId: 'wrong', sequence: 0, startMs: 0, pcm });
    for (let i = 0; i < 10; i++) coordinator.audio({ captureId: state.microphoneCaptureId!, sessionId: state.sessionId!, sequence: i, startMs: i * 1000, pcm });
    expect(finish).toBeTypeOf('function');
    await coordinator.stop(true); finish({ text: 'This result must be ignored' });
    await Promise.resolve(); await Promise.resolve();
    expect((await coordinator.getState()).segments).toEqual([]);
    expect((await coordinator.getState()).phase).toBe('completed');
  } finally { await coordinator.dispose(); await rm(dir, { recursive: true, force: true }); }
});
it('grants a bounded local microphone check without starting a session or engine', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sussurro-check-'));
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const coordinator = new Coordinator(window, 'nonexistent-runtime', new SessionStore(dir));
  vi.useFakeTimers();
  try {
    expect(coordinator.microphoneAllowed()).toBe(false);
    await coordinator.beginMicrophoneCheck();
    expect(coordinator.microphoneAllowed()).toBe(true);
    expect(await coordinator.getState()).toMatchObject({ phase: 'idle', sessionId: null, microphoneChecking: true });
    await expect(coordinator.start(DEFAULT_OPTIONS)).rejects.toThrow('Encerre o teste');
    await expect(coordinator.beginMicrophoneCheck()).rejects.toThrow('já está ativo');
    await vi.advanceTimersByTimeAsync(30000);
    expect(coordinator.microphoneAllowed()).toBe(false);
    expect((await coordinator.getState()).microphoneChecking).toBe(false);
    expect(await coordinator.listSessions()).toEqual([]);
    await coordinator.beginMicrophoneCheck(); await coordinator.endMicrophoneCheck();
    expect(coordinator.microphoneAllowed()).toBe(false);
  } finally { vi.useRealTimers(); await coordinator.dispose(); await rm(dir, { recursive: true, force: true }); }
});
it('refuses a microphone check during a transcription session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sussurro-check-'));
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const coordinator = new Coordinator(window, 'unused', new SessionStore(dir));
  try {
    await coordinator.start(DEFAULT_OPTIONS);
    await expect(coordinator.beginMicrophoneCheck()).rejects.toThrow('Finalize a sessão');
    expect((await coordinator.getState()).microphoneChecking).toBe(false);
  } finally { await coordinator.dispose(); await rm(dir, { recursive: true, force: true }); }
});

const signal = () => { const pcm = new Uint8Array(3200); new Int16Array(pcm.buffer).fill(2000); return pcm; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function fixture(run: (coordinator: Coordinator) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sussurro-sources-'));
  const window = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const coordinator = new Coordinator(window, 'unused', new SessionStore(dir));
  try { await run(coordinator); }
  finally { await coordinator.dispose(); await rm(dir, { recursive: true, force: true }); }
}
it.each(['microphone', 'system'] as const)('captures only the enabled %s source', async (source) => fixture(async (c) => {
  const state = await c.start({ ...DEFAULT_OPTIONS, microphone: source === 'microphone', system: source === 'system', systemId: 'output-a' });
  c.audio({ sessionId: state.sessionId!, captureId: state.microphoneCaptureId || 'disabled', sequence: 0, startMs: 0, pcm: signal() });
  controls.captures[0]?.receive(signal());
  expect(controls.captures).toHaveLength(source === 'system' ? 1 : 0);
  expect(c.microphoneAllowed()).toBe(source === 'microphone');
  const current = await c.getState();
  expect(current.levels[source]).toBeGreaterThan(0);
  expect(current.levels[source === 'system' ? 'microphone' : 'system']).toBe(0);
}));
it('refuses to start without sources before opening any capture', async () => fixture(async (c) => {
  await expect(c.start({ ...DEFAULT_OPTIONS, microphone: false })).rejects.toThrow('Ative pelo menos');
  expect((await c.getState()).phase).toBe('idle');
  expect(controls.captures).toHaveLength(0); expect(c.microphoneAllowed()).toBe(false);
}));
it('keeps the other source running and clears levels when either source is disabled', async () => fixture(async (c) => {
  const state = await c.start({ ...DEFAULT_OPTIONS, system: true, systemId: 'output-a' });
  const system = controls.captures[0];
  system.receive(signal());
  c.audio({ sessionId: state.sessionId!, captureId: state.microphoneCaptureId!, sequence: 0, startMs: 0, pcm: signal() });
  const stops = controls.stopOutput.mock.calls.length;
  await c.setSources({ microphone: false, system: true });
  expect(controls.stopOutput).toHaveBeenCalledTimes(stops);
  system.receive(signal());
  expect(await c.getState()).toMatchObject({ phase: 'capturing', microphoneCaptureId: null, levels: { microphone: 0, system: expect.any(Number) } });
  expect((await c.getState()).levels.system).toBeGreaterThan(0);
  await c.setSources({ microphone: true, system: true });
  const mic = (await c.getState()).microphoneCaptureId!;
  await c.setSources({ microphone: true, system: false });
  expect((await c.getState()).microphoneCaptureId).toBe(mic);
  system.receive(signal()); system.fail('obsolete error');
  c.audio({ sessionId: state.sessionId!, captureId: mic, sequence: 0, startMs: 0, pcm: signal() });
  expect(await c.getState()).toMatchObject({ phase: 'capturing', levels: { microphone: expect.any(Number), system: 0 } });
  expect((await c.getState()).levels.microphone).toBeGreaterThan(0);
}));
it('changes microphone generation and rejects old frames without restarting system capture', async () => fixture(async (c) => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const state = await c.start({ ...DEFAULT_OPTIONS, system: true, systemId: 'output-a' });
  clock.mockReturnValue(2000);
  await c.setSources({ microphone: true, system: true, microphoneId: 'mic-b' });
  const next = await c.getState();
  expect(next.microphoneCaptureId).not.toBe(state.microphoneCaptureId);
  c.captureError('old microphone disconnected', state.microphoneCaptureId!);
  expect((await c.getState()).phase).toBe('capturing');
  expect(controls.captures).toHaveLength(1);
  c.audio({ sessionId: state.sessionId!, captureId: state.microphoneCaptureId!, sequence: 90, startMs: 500, pcm: signal() });
  expect((await c.getState()).levels.microphone).toBe(0);
  c.audio({ sessionId: state.sessionId!, captureId: next.microphoneCaptureId!, sequence: 0, startMs: 600, pcm: signal() });
  expect((await c.getState()).levels.microphone).toBeGreaterThan(0);
  expect((await c.readSession(state.sessionId!)).options.microphoneId).toBe('mic-b');
}));
it('replaces only system capture and ignores its obsolete PCM and error callbacks', async () => fixture(async (c) => {
  const state = await c.start({ ...DEFAULT_OPTIONS, system: true, systemId: 'output-a' });
  const previous = controls.captures[0];
  await c.setSources({ microphone: true, system: true, systemId: 'output-b' });
  expect(controls.captures.map((capture) => capture.id)).toEqual(['output-a', 'output-b']);
  expect((await c.getState()).microphoneCaptureId).toBe(state.microphoneCaptureId);
  previous.receive(signal()); previous.fail('old device failed');
  expect(await c.getState()).toMatchObject({ phase: 'capturing', levels: { system: 0 } });
  controls.captures[1].receive(signal());
  expect((await c.getState()).levels.system).toBeGreaterThan(0);
}));
it('does not reopen devices while paused and rotates microphone identity on resume', async () => fixture(async (c) => {
  const state = await c.start({ ...DEFAULT_OPTIONS, system: true, systemId: 'output-a' });
  const previous = controls.captures[0];
  await c.pause();
  await c.setSources({ microphone: true, system: true, microphoneId: 'mic-b', systemId: 'output-b' });
  previous.receive(signal());
  expect(await c.getState()).toMatchObject({ phase: 'paused', microphoneCaptureId: null, levels: { microphone: 0, system: 0 } });
  expect(controls.captures).toHaveLength(1); expect(c.microphoneAllowed()).toBe(false);
  await c.resume();
  expect((await c.getState()).microphoneCaptureId).not.toBe(state.microphoneCaptureId);
  expect(controls.captures[1].id).toBe('output-b');
}));
it('cannot restart a device after stop overtakes an in-flight device change', async () => fixture(async (c) => {
  await c.start({ ...DEFAULT_OPTIONS, system: true, systemId: 'output-a' });
  let release!: () => void;
  controls.stopOutput.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const changing = c.setSources({ microphone: true, system: true, systemId: 'output-b' });
  await expect(c.setSources({ microphone: false, system: true })).rejects.toThrow('Aguarde');
  await c.stop(true); release(); await changing;
  expect(controls.captures).toHaveLength(1);
  controls.captures[0].receive(signal()); controls.captures[0].fail('obsolete');
  expect(await c.getState()).toMatchObject({ phase: 'completed', microphoneCaptureId: null, levels: { microphone: 0, system: 0 } });
}));
it('pauses and releases capture when the replacement output fails', async () => fixture(async (c) => {
  await c.start({ ...DEFAULT_OPTIONS, system: true, systemId: 'output-a' });
  controls.startOutput.mockRejectedValueOnce(new Error('Saída indisponível.'));
  await expect(c.setSources({ microphone: true, system: true, systemId: 'missing' })).rejects.toThrow('Saída indisponível');
  await settle();
  expect(await c.getState()).toMatchObject({ phase: 'paused', microphoneCaptureId: null, levels: { microphone: 0, system: 0 } });
  expect(c.microphoneAllowed()).toBe(false);
}));
it('preserves source and common timeline across device changes and pause gaps', async () => fixture(async (c) => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const state = await c.start({ ...DEFAULT_OPTIONS, system: true, systemId: 'output-a' });
  clock.mockReturnValue(2000);
  // Three 100 ms frames per source exceed the legacy speech threshold.
  for (let i = 0; i < 3; i++) {
    c.audio({ sessionId: state.sessionId!, captureId: state.microphoneCaptureId!, sequence: i, startMs: 700 + i * 100, pcm: signal() });
    controls.captures[0].receive(signal());
  }
  await c.pause(); await settle();
  await vi.waitFor(async () => expect((await c.getState()).pendingSeconds).toBe(0));
  clock.mockReturnValue(11000);
  await c.resume();
  const micId = (await c.getState()).microphoneCaptureId!;
  for (let i = 0; i < 3; i++) {
    c.audio({ sessionId: state.sessionId!, captureId: micId, sequence: i, startMs: 9700 + i * 100, pcm: signal() });
    controls.captures[1].receive(signal());
  }
  await c.stop(false);
  await vi.waitFor(async () => expect((await c.getState()).phase).toBe('completed'));
  const result = await c.readSession(state.sessionId!);
  expect(result.segments.map((segment) => [segment.source, segment.startMs])).toEqual([
    ['microphone', 700], ['system', 900], ['microphone', 9700], ['system', 9900],
  ]);
}));
