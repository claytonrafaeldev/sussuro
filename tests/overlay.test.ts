import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_OPTIONS, type ViewState } from '../src/shared/contracts';
import { overlayState } from '../src/shared/overlay';

const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], area: { x: 100, y: 40, width: 1280, height: 760 } }));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler), removeHandler: (name: string) => mock.handlers.delete(name) },
  screen: { getDisplayMatching: () => ({ workArea: mock.area }) },
  BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'http://localhost:5173/#overlay' }, send: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }, setWindowOpenHandler: vi.fn() });
    showInactive = vi.fn(); setVisibleOnAllWorkspaces = vi.fn();
    constructor(public options: unknown) { super(); mock.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    loadURL = vi.fn().mockResolvedValue(undefined);
    destroy() { this.destroyed = true; this.emit('closed'); }
  },
}));
import { TranscriptionOverlay } from '../src/main/overlay';

const state = (phase: ViewState['phase'] = 'capturing', sessionId = 'one'): ViewState => ({
  microphoneChecking: false, microphoneCaptureId: 'private-capture', pendingBytes: { microphone: 0, system: 0 }, audioGapCount: 0,
  phase, sessionId, options: { ...DEFAULT_OPTIONS }, message: 'private-message', pendingSeconds: 0, lagSeconds: 0,
  elapsedMs: 1200, segments: [], levels: { microphone: 0, system: 0 }, savePath: '/private/path',
});
function setup() {
  const main = { webContents: {}, getBounds: () => ({}), isDestroyed: () => false, isMinimized: () => true,
    restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  const pause = vi.fn().mockResolvedValue(undefined);
  const overlay = new TranscriptionOverlay(main as any, 'http://localhost:5173/', '/project/preload.cjs', pause);
  const invoke = (command: string, event?: unknown) => {
    const window = mock.windows.at(-1);
    return mock.handlers.get(`sussurro:overlay:${command}`)! (event ?? { sender: window?.webContents, senderFrame: window?.webContents.mainFrame });
  };
  return { main, pause, overlay, invoke };
}
beforeEach(() => { mock.handlers.clear(); mock.windows.length = 0; });

it('bounds the text tail and strips paths, capture IDs, configuration and unrelated fields', () => {
  const input = state();
  input.segments = [{ id: 'segment', source: 'microphone', startMs: 0, endMs: 1000, text: 'A'.repeat(1000) }];
  input.partials = { microphone: { text: 'últimas palavras', startMs: 1001, endMs: 1100 } };
  const result = overlayState(input)!;
  expect(result.text.length).toBeLessThanOrEqual(280); expect(result.text).toContain('últimas palavras');
  expect(Object.keys(result).sort()).toEqual(['elapsedMs', 'phase', 'text']);
  for (const phase of ['idle', 'preparing', 'completed', 'error'] as const) expect(overlayState(state(phase))).toBeNull();
  expect(overlayState({ ...state(), sessionId: null })).toBeNull();
});

it('opens only when capturing, sends latest state after load, keeps pause visible and destroys on completion', () => {
  const { overlay, invoke } = setup();
  overlay.update(state('idle')); overlay.update(state('preparing')); overlay.update(state('paused'));
  expect(mock.windows).toHaveLength(0);
  overlay.update(state()); const window = mock.windows[0];
  expect(window.options).toMatchObject({ transparent: true, frame: false, alwaysOnTop: true, show: false, x: 1004, y: 56,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'sussurro-overlay' } });
  expect(window.showInactive).not.toHaveBeenCalled();
  overlay.update(state('paused')); window.webContents.emit('did-finish-load');
  expect(window.showInactive).toHaveBeenCalledOnce();
  expect(window.webContents.send).toHaveBeenLastCalledWith('sussurro:overlay:state', expect.objectContaining({ phase: 'paused' }));
  overlay.update(state('draining')); overlay.update(state('completed'));
  expect(window.destroyed).toBe(true);
  expect(() => window.webContents.emit('did-finish-load')).not.toThrow();
  expect(window.showInactive).toHaveBeenCalledOnce();
  overlay.dispose(); expect(mock.handlers.size).toBe(0);
});

it('rejects main-window, subframe and foreign-URL IPC and denies permissions and navigation', async () => {
  const { overlay, main, invoke } = setup(); overlay.update(state());
  const window = mock.windows[0];
  for (const event of [{ sender: main.webContents, senderFrame: window.webContents.mainFrame },
    { sender: window.webContents, senderFrame: { url: 'http://localhost:5173/#overlay' } }]) {
    await expect(invoke('pause', event)).rejects.toThrow('Origem');
  }
  window.webContents.mainFrame.url = 'https://outside.example';
  await expect(invoke('get-state')).rejects.toThrow('Origem');
  window.webContents.mainFrame.url = 'http://localhost:5173/#overlay';
  expect(await invoke('get-state')).toEqual(overlayState(state()));
  const callback = vi.fn(); window.webContents.session.setPermissionRequestHandler.mock.calls[0][0]({}, 'media', callback);
  expect(callback).toHaveBeenCalledWith(false);
  expect(window.webContents.session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
  const preventDefault = vi.fn(); window.webContents.emit('will-navigate', { preventDefault }, 'https://outside.example');
  expect(preventDefault).toHaveBeenCalledOnce();
  overlay.dispose();
});

it('pauses once while pending, blocks pause when already paused and restores the main window without resuming', async () => {
  const { overlay, pause, invoke, main } = setup(); overlay.update(state());
  let done!: () => void; pause.mockImplementation(() => new Promise<void>((resolve) => { done = resolve; }));
  const pending = invoke('pause'); await invoke('pause'); expect(pause).toHaveBeenCalledOnce(); done(); await pending;
  overlay.update(state('paused')); await invoke('pause'); expect(pause).toHaveBeenCalledOnce();
  await invoke('open-main'); await invoke('open-main');
  expect(main.restore).toHaveBeenCalledOnce(); expect(main.focus).toHaveBeenCalledOnce();
  expect(main.show).toHaveBeenCalledOnce(); overlay.dispose();
});

it('avoids respawn loops after popup crash and destroys pending popup on shutdown', () => {
  const { overlay } = setup(); overlay.update(state()); const first = mock.windows[0];
  first.webContents.emit('render-process-gone');
  for (let i = 0; i < 20; i++) overlay.update(state());
  expect(mock.windows).toHaveLength(1); expect(first.destroyed).toBe(true);
  overlay.update(state('capturing', 'two')); expect(mock.windows).toHaveLength(2);
  const second = mock.windows[1]; overlay.dispose(); second.webContents.emit('did-finish-load');
  expect(second.destroyed).toBe(true); expect(second.showInactive).not.toHaveBeenCalled();
  overlay.update(state('capturing', 'three')); expect(mock.windows).toHaveLength(2);
});

it('clears the popup for errors and close attempts without stopping or creating audio resources', () => {
  const { overlay, pause } = setup(); overlay.update(state()); overlay.update(state('error'));
  expect(mock.windows[0].destroyed).toBe(true);
  overlay.update(state('capturing', 'two')); overlay.hide(); expect(mock.windows[1].destroyed).toBe(true);
  expect(pause).not.toHaveBeenCalled(); overlay.dispose();
});
