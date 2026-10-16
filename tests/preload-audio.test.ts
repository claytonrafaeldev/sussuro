import { expect, it, vi } from 'vitest';
import type { SussurroApi } from '../src/shared/runtime';
const controls = vi.hoisted(() => ({ api: null as SussurroApi | null, invoke: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: SussurroApi) => { controls.api = api; } },
  ipcRenderer: { invoke: controls.invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
it('allows only one unacknowledged audio IPC call and releases the gate after rejection', async () => {
  await import('../src/preload/preload');
  let reject!: (reason: Error) => void;
  controls.invoke.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  const frame = { sessionId: 'session', captureId: 'capture', sequence: 0, startMs: 0, pcm: new Uint8Array(3200) };
  const first = controls.api!.sendAudio(frame);
  expect(await controls.api!.sendAudio(frame)).toBe(false); expect(controls.invoke).toHaveBeenCalledOnce();
  reject(new Error('closed')); await expect(first).rejects.toThrow('closed');
  controls.invoke.mockResolvedValueOnce(true);
  expect(await controls.api!.sendAudio(frame)).toBe(true); expect(controls.invoke).toHaveBeenCalledTimes(2);
});

it('exposes only the minimal popup bridge in the auxiliary renderer', async () => {
  vi.resetModules();
  process.argv.push('--sussurro-overlay');
  try {
    await import('../src/preload/preload');
    const overlay = controls.api as unknown as import('../src/shared/overlay').OverlayApi;
    expect(Object.keys(overlay).sort()).toEqual(['getState', 'onState', 'openMain', 'pause']);
    controls.invoke.mockResolvedValue(undefined);
    await overlay.pause(); expect(controls.invoke).toHaveBeenLastCalledWith('sussurro:overlay:pause');
    await overlay.openMain(); expect(controls.invoke).toHaveBeenLastCalledWith('sussurro:overlay:open-main');
    await overlay.getState(); expect(controls.invoke).toHaveBeenLastCalledWith('sussurro:overlay:get-state');
  } finally { process.argv.pop(); vi.resetModules(); }
});
