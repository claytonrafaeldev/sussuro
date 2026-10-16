import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Microphone } from '../src/renderer/microphone';
import type { SussurroApi } from '../src/shared/runtime';
import { DEFAULT_OPTIONS } from '../src/shared/contracts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const contexts: FakeContext[] = [], worklets: FakeWorklet[] = [];
let mic: Microphone;
let getUserMedia: ReturnType<typeof vi.fn>;
let loadModule: () => Promise<void>;
function media() {
  const track = new EventTarget() as EventTarget & { stop: ReturnType<typeof vi.fn> };
  track.stop = vi.fn();
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
class FakeNode { connect = vi.fn(); disconnect = vi.fn(); }
class FakeContext {
  sampleRate = 16000; state = 'running'; destination = {};
  audioWorklet = { addModule: vi.fn(() => loadModule()) };
  source = new FakeNode(); gain = Object.assign(new FakeNode(), { gain: { value: 1 } });
  constructor() { contexts.push(this); }
  createMediaStreamSource = vi.fn(() => this.source);
  createGain = vi.fn(() => this.gain);
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
}
class FakeWorklet extends FakeNode {
  port = { onmessage: null as ((event: { data: Float32Array }) => void) | null, close: vi.fn(), postMessage: vi.fn() };
  onprocessorerror: (() => void) | null = null;
  constructor() { super(); worklets.push(this); }
  frame(value = 0.25) { this.port.onmessage?.({ data: new Float32Array(1600).fill(value) }); }
}
const api = () => ({
  getState: vi.fn(async () => ({ phase: 'capturing', sessionId: 'session', microphoneCaptureId: 'capture', elapsedMs: 200, options: DEFAULT_OPTIONS })),
  sendAudio: vi.fn(async () => true), reportCaptureError: vi.fn(),
}) as unknown as SussurroApi;

beforeEach(() => {
  vi.useFakeTimers(); contexts.length = 0; worklets.length = 0;
  getUserMedia = vi.fn(); loadModule = async () => {};
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeContext); vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  mic = new Microphone();
});
afterEach(async () => { await mic.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('emits PCM16 with session timeline and releases tracks, nodes and context on stop', async () => {
  const { stream, track } = media(); getUserMedia.mockResolvedValue(stream);
  const bridge = api(), level = vi.fn();
  await mic.start(bridge, 'session', 'capture', 'selected-device', level);
  expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'selected-device' });
  worklets[0].frame(); await tick(); worklets[0].frame();
  expect(bridge.sendAudio).toHaveBeenCalledTimes(2);
  const frame = vi.mocked(bridge.sendAudio).mock.calls[1][0];
  expect(frame).toMatchObject({ sessionId: 'session', sequence: 1, startMs: 300 });
  expect(frame.pcm.length).toBe(3200);
  expect(level).toHaveBeenLastCalledWith(expect.closeTo(0.25, 3));
  expect(contexts[0].gain.gain.value).toBe(0);
  const lateMessage = worklets[0].port.onmessage!;
  await mic.stop();
  lateMessage({ data: new Float32Array(1600) });
  expect(bridge.sendAudio).toHaveBeenCalledTimes(2);
  expect(track.stop).toHaveBeenCalledOnce();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(contexts[0].source.disconnect).toHaveBeenCalledOnce();
  expect(contexts[0].gain.disconnect).toHaveBeenCalledOnce();
  expect(worklets[0].port.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('releases a permission result that arrives after stop without creating a context', async () => {
  const permission = deferred<MediaStream>(), { stream, track } = media();
  getUserMedia.mockReturnValue(permission.promise);
  const bridge = api(), start = mic.start(bridge, 'session', 'capture', '', vi.fn()); await tick();
  await mic.stop(); permission.resolve(stream); await start;
  expect(track.stop).toHaveBeenCalledOnce(); expect(contexts).toHaveLength(0);
  expect(bridge.sendAudio).not.toHaveBeenCalled();
});
it('settles a cancelled start and clears its timeout without waiting for permission', async () => {
  getUserMedia.mockReturnValue(new Promise<MediaStream>(() => {}));
  const settled = vi.fn(), bridge = api();
  const start = mic.start(bridge, 'session', 'capture', '', vi.fn()).then(settled);
  await tick();
  expect(vi.getTimerCount()).toBe(1);
  await mic.stop(); await tick();
  expect(settled).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(bridge.reportCaptureError).not.toHaveBeenCalled();
  expect(contexts).toHaveLength(0);
  await start;
});
it('keeps a new permission timeout when an older pending request is cancelled', async () => {
  const first = deferred<MediaStream>(), second = deferred<MediaStream>();
  getUserMedia.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const settled = vi.fn();
  const oldStart = mic.start(api(), 'session', 'capture', '', vi.fn()).then(settled); await tick();
  const bridge = api(), newStart = mic.start(bridge, 'session', 'capture', '', vi.fn()); await tick();
  expect(settled).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  const oldMedia = media(); first.resolve(oldMedia.stream); await tick();
  expect(oldMedia.track.stop).toHaveBeenCalledOnce();
  const failure = expect(newStart).rejects.toThrow('20 segundos');
  await vi.advanceTimersByTimeAsync(20000); await failure; await oldStart;
  expect(vi.getTimerCount()).toBe(0);
  expect(bridge.sendAudio).not.toHaveBeenCalled();
});
it('times out ignored permission and also stops a late granted track', async () => {
  const permission = deferred<MediaStream>(), { stream, track } = media();
  getUserMedia.mockReturnValue(permission.promise);
  const start = mic.start(api(), 'session', 'capture', '', vi.fn());
  const failure = expect(start).rejects.toThrow('20 segundos');
  await vi.advanceTimersByTimeAsync(20000); await failure;
  permission.resolve(stream); await tick();
  expect(track.stop).toHaveBeenCalledOnce(); expect(contexts).toHaveLength(0);
});
it('does not let an obsolete getState result cancel a newer capture', async () => {
  const oldState = deferred<Awaited<ReturnType<SussurroApi['getState']>>>();
  const oldBridge = api(); vi.mocked(oldBridge.getState).mockReturnValue(oldState.promise);
  const first = media(), second = media();
  getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
  const oldStart = mic.start(oldBridge, 'session', 'capture', '', vi.fn()); await tick();
  const bridge = api(); await mic.start(bridge, 'session', 'capture', '', vi.fn());
  oldState.resolve({ ...(await bridge.getState()), phase: 'paused' }); await oldStart;
  worklets[0].frame();
  expect(first.track.stop).toHaveBeenCalledOnce(); expect(second.track.stop).not.toHaveBeenCalled();
  expect(bridge.sendAudio).toHaveBeenCalledOnce(); expect(oldBridge.sendAudio).not.toHaveBeenCalled();
});
it('rejects permission denial with an actionable message', async () => {
  getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  await expect(mic.start(api(), 'session', 'capture', '', vi.fn())).rejects.toThrow('Permissão do microfone negada');
  expect(contexts).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
});
it('cleans up if loading the worklet fails', async () => {
  const { stream, track } = media(); getUserMedia.mockResolvedValue(stream);
  loadModule = async () => { throw new Error('Module unavailable'); };
  await expect(mic.start(api(), 'session', 'capture', '', vi.fn())).rejects.toThrow('Module unavailable');
  expect(track.stop).toHaveBeenCalledOnce(); expect(contexts[0].close).toHaveBeenCalledOnce();
});
it('handles device disconnect while the worklet module is loading', async () => {
  const module = deferred<void>(), { stream, track } = media();
  loadModule = () => module.promise; getUserMedia.mockResolvedValue(stream);
  const bridge = api(), start = mic.start(bridge, 'session', 'capture', '', vi.fn()); await tick();
  track.dispatchEvent(new Event('ended')); module.resolve(); await start;
  expect(bridge.reportCaptureError).toHaveBeenCalledWith(expect.stringContaining('desconectado'), 'capture');
  expect(contexts[0].close).toHaveBeenCalledOnce(); expect(worklets).toHaveLength(0);
});
it.each(['processor', 'no-frames'])('releases capture on %s failure', async (failure) => {
  const { stream, track } = media(); getUserMedia.mockResolvedValue(stream);
  const bridge = api(); await mic.start(bridge, 'session', 'capture', '', vi.fn());
  if (failure === 'processor') worklets[0].onprocessorerror!();
  else await vi.advanceTimersByTimeAsync(5000);
  expect(track.stop).toHaveBeenCalledOnce(); expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(bridge.reportCaptureError).toHaveBeenCalledOnce();
  expect(worklets[0].port.onmessage).toBeNull();
});
it('uses the same capture pipeline for a local preview with only level/duration callbacks', async () => {
  getUserMedia.mockResolvedValue(media().stream);
  const sample = vi.fn(), error = vi.fn();
  await mic.preview('default', sample, error);
  worklets[0].frame(0); worklets[0].frame(0.5);
  expect(sample).toHaveBeenNthCalledWith(1, { level: 0, seconds: 0.1 });
  expect(sample).toHaveBeenLastCalledWith({ level: 0.5, seconds: 0.2 });
  await vi.advanceTimersByTimeAsync(4000);
  expect(error).not.toHaveBeenCalled(); // Silence is valid audio, not a broken device.
});

it('releases a device if its capture identity was replaced before readiness', async () => {
  const { stream, track } = media(); getUserMedia.mockResolvedValue(stream);
  const bridge = api();
  await mic.start(bridge, 'session', 'obsolete-capture', 'old-device', vi.fn());
  expect(track.stop).toHaveBeenCalledOnce();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(worklets).toHaveLength(0);
  expect(bridge.sendAudio).not.toHaveBeenCalled();
});

it('stops rather than queuing a second PCM frame while main acknowledgment is pending', async () => {
  const { stream, track } = media(); getUserMedia.mockResolvedValue(stream);
  const bridge = api(); vi.mocked(bridge.sendAudio).mockReturnValue(new Promise(() => {}));
  await mic.start(bridge, 'session', 'capture', 'selected-device', vi.fn());
  worklets[0].frame(); worklets[0].frame(); await tick();
  expect(bridge.sendAudio).toHaveBeenCalledOnce(); expect(track.stop).toHaveBeenCalledOnce();
  expect(bridge.reportCaptureError).toHaveBeenCalledWith(expect.stringContaining('lacuna'), 'capture');
});
it('does not let a late rejected IPC acknowledgment stop a replacement microphone', async () => {
  getUserMedia.mockImplementation(async () => media().stream);
  const old = api(); let reject!: (reason: Error) => void;
  vi.mocked(old.sendAudio).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  await mic.start(old, 'session', 'capture', '', vi.fn()); worklets[0].frame();
  const current = api(); await mic.start(current, 'session', 'capture', '', vi.fn());
  reject(new Error('IPC failed')); await tick(); worklets[1].frame(); await tick();
  expect(current.sendAudio).toHaveBeenCalledOnce(); expect(contexts[1].close).not.toHaveBeenCalled();
  expect(current.reportCaptureError).not.toHaveBeenCalled();
});
