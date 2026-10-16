import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/shared/contracts';
const ipc = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>());
const capture = vi.hoisted(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }));
vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, dialog: { showSaveDialog: vi.fn() }, ipcMain: {
  handle: (name: string, handler: (event: IpcMainInvokeEvent, payload?: unknown) => unknown) => ipc.set(name, handler),
  removeHandler: (name: string) => ipc.delete(name), on: vi.fn(), removeListener: vi.fn(),
} }));
vi.mock('../src/main/audio/linux', () => ({ systemDevices: async () => [], LinuxOutput: class {
  start = capture.start; stop = capture.stop;
} }));
import { dialog } from 'electron';
import { Coordinator } from '../src/main/coordinator';
import { SessionStore } from '../src/main/storage';
import { CredentialStore } from '../src/main/config/credential-store';
import { DeepgramCredentials } from '../src/main/config/deepgram';
import { deepgramFactory } from '../src/main/transcription/deepgram';
import { registerIpc } from '../src/main/ipc';

class FaultSocket extends EventEmitter {
  readyState = 0; bufferedAmount = 0; sends = 0;
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  send(data: string | Uint8Array, _options: unknown, done: (error?: Error) => void) {
    this.sends++; done();
    if (typeof data === 'string') queueMicrotask(() => {
      this.emit('message', Buffer.from('{"type":"Metadata"}'), false); this.readyState = 3; this.emit('close', 1000);
    });
  }
  result() { this.emit('message', Buffer.from(JSON.stringify({ type: 'Results', channel_index: [0, 1], start: 0, duration: 0.1,
    is_final: true, channel: { alternatives: [{ transcript: 'Synthetic recovery text' }] } })), false); }
  terminate = vi.fn(() => { this.readyState = 3; });
  disconnect() { this.readyState = 3; this.emit('close', 1006, Buffer.from('synthetic-private-reason')); }
}
async function fixture(run: (c: Coordinator, sockets: FaultSocket[], invoke: (route: string, payload?: unknown) => Promise<unknown>, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'sussurro-recovery-integration-'));
  const key = new DeepgramCredentials(), sockets: FaultSocket[] = [];
  const credentialStore = new CredentialStore(key, path.join(root, 'synthetic-key.enc'), {
    isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => { throw new Error('must not persist insecure storage'); }, decryptString: () => { throw new Error(); },
  });
  const url = 'file:///synthetic/index.html', frame = { url }, contents = { mainFrame: frame, send: vi.fn() };
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: path.join(root, 'automatic.txt') });
  const factory = deepgramFactory(key, () => { const socket = new FaultSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
  const c = new Coordinator(window, new SessionStore(path.join(root, 'history')), factory, credentialStore);
  const unregister = registerIpc(window, url, c);
  const invoke = async (route: string, payload?: unknown) => ipc.get(`sussurro:${route}`)!({ sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent, payload);
  try { await run(c, sockets, invoke, root); }
  finally { await c.dispose(true); unregister(); key.clear(); await rm(root, { recursive: true, force: true }); }
}
afterEach(() => { vi.restoreAllMocks(); ipc.clear(); });

it('configures/replaces/removes synthetic keys through the same trusted IPC commands as the popup', async () => fixture(async (c, sockets, invoke, root) => {
  expect(await invoke('credential-status')).toMatchObject({ configured: false });
  await invoke('credential-set', { key: 'synthetic-first-key', persist: true });
  expect(await invoke('credential-status')).toMatchObject({ configured: true, persisted: false, canPersist: false });
  await invoke('credential-set', { key: 'synthetic-replacement-key', persist: false });
  expect(sockets).toHaveLength(0); expect(await readdir(root)).toEqual([]);
  expect(JSON.stringify(await invoke('get-state'))).not.toContain('synthetic-replacement-key');
  await invoke('credential-remove'); expect(await invoke('credential-status')).toMatchObject({ configured: false });
  await expect(c.start({ ...DEFAULT_OPTIONS, persistence: 'temporary' })).rejects.toThrow('Configure DEEPGRAM_API_KEY');
  expect(sockets).toHaveLength(0); expect(c.microphoneAllowed()).toBe(false);
}));
it.each(['saved', 'temporary'] as const)('preserves confirmed text on simulated abrupt network loss and resumes only explicitly (%s)', async (persistence) => fixture(async (c, sockets, invoke, root) => {
  await invoke('credential-set', { key: 'synthetic-network-key', persist: false });
  await c.start({ ...DEFAULT_OPTIONS, persistence });
  const state = await c.getState();
  expect(c.audio({ sessionId: state.sessionId!, captureId: state.microphoneCaptureId!, sequence: 0, startMs: 0, pcm: new Uint8Array(3200) })).toBe(true);
  sockets[0].result(); sockets[0].disconnect();
  await vi.waitFor(async () => expect((await c.getState()).phase).toBe('paused'));
  const paused = await c.getState();
  expect(paused).toMatchObject({ microphoneCaptureId: null, audioGapCount: 1, segments: [{ text: 'Synthetic recovery text' }] });
  expect(paused.message).not.toContain('synthetic-private-reason'); expect(c.microphoneAllowed()).toBe(false);
  expect(sockets[0].terminate).toHaveBeenCalledOnce(); expect(sockets).toHaveLength(1);
  await expect(invoke('credential-set', { key: 'synthetic-blocked', persist: false })).rejects.toThrow('Finalize');
  const sent = sockets[0].sends;
  expect(c.audio({ sessionId: state.sessionId!, captureId: state.microphoneCaptureId!, sequence: 1, startMs: 100, pcm: new Uint8Array(3200) })).toBe(false);
  expect(sockets[0].sends).toBe(sent);
  if (persistence === 'saved') {
    await vi.waitFor(async () => expect(await readFile(path.join(root, 'automatic.txt'), 'utf8')).toContain('Synthetic recovery text'));
  } else expect(await c.listSessions()).toEqual([]);
  await c.resume(); expect(sockets).toHaveLength(2); expect(sockets[1].sends).toBe(0);
  await c.stop(false); await c.dispose();
  if (persistence === 'saved') expect((await c.readSession(state.sessionId!)).status).toBe('completed');
  else expect(await c.listSessions()).toEqual([]);
}));
