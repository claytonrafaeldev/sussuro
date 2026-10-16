import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>());
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (event: IpcMainInvokeEvent, payload?: unknown) => unknown) => handlers.set(name, handler),
  removeHandler: (name: string) => handlers.delete(name), on: vi.fn(), removeListener: vi.fn(),
} }));
import { registerIpc, type Backend } from '../src/main/ipc';
afterEach(() => { handlers.clear(); vi.restoreAllMocks(); });
it('accepts local microphone checks only from the configured main renderer frame', async () => {
  const url = 'file:///app/index.html', frame = { url };
  const contents = { mainFrame: frame };
  const window = { webContents: contents } as unknown as BrowserWindow;
  const begin = vi.fn(async () => {}), end = vi.fn(async () => {});
  const backend = { beginMicrophoneCheck: begin, endMicrophoneCheck: end } as unknown as Backend;
  const unregister = registerIpc(window, url, backend);
  const invoke = (name: string, sender: unknown, senderFrame: unknown) => handlers.get(`sussurro:${name}`)!({ sender, senderFrame } as IpcMainInvokeEvent);
  for (const command of ['microphone-check-start', 'microphone-check-stop']) {
    expect(() => invoke(command, {}, frame)).toThrow('Origem IPC recusada');
    expect(() => invoke(command, contents, { url })).toThrow('Origem IPC recusada');
    frame.url = 'https://example.com/';
    expect(() => invoke(command, contents, frame)).toThrow('Origem IPC recusada');
    frame.url = url;
  }
  expect(begin).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
  await invoke('microphone-check-start', contents, frame);
  await invoke('microphone-check-stop', contents, frame);
  expect(begin).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce();
  unregister(); expect(handlers.size).toBe(0);
});

it('validates live source/device changes at the trusted IPC boundary', async () => {
  const url = 'file:///app/index.html', frame = { url };
  const contents = { mainFrame: frame };
  const setSources = vi.fn(async () => {});
  const unregister = registerIpc({ webContents: contents } as unknown as BrowserWindow, url, { setSources } as unknown as Backend);
  const invoke = handlers.get('sussurro:sources')!;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const payload = { microphone: true, system: false, microphoneId: 'new-mic', systemId: 'new-out', language: 'injected' };
  expect(() => invoke({ ...event, sender: {} } as IpcMainInvokeEvent, payload)).toThrow('Origem IPC');
  expect(() => invoke(event, { ...payload, systemId: {} })).toThrow('Dispositivo');
  expect(setSources).not.toHaveBeenCalled();
  await invoke(event, payload);
  expect(setSources).toHaveBeenCalledWith({ microphone: true, system: false, microphoneId: 'new-mic', systemId: 'new-out' });
  unregister();
});

it('acknowledges bounded audio only through the trusted invoke channel', async () => {
  const url = 'file:///app/index.html', frame = { url }, contents = { mainFrame: { url } };
  contents.mainFrame = frame;
  const audio = vi.fn(() => true), captureError = vi.fn();
  const unregister = registerIpc({ webContents: contents } as unknown as BrowserWindow, url, { audio, captureError } as unknown as Backend);
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const invoke = handlers.get('sussurro:audio')!;
  const payload = { sessionId: '12345678-1234-1234-1234-123456789abc', captureId: '12345678-1234-1234-1234-123456789abc', sequence: 0, startMs: 0, pcm: new Uint8Array(3200) };
  expect(() => invoke({ ...event, sender: {} } as IpcMainInvokeEvent, payload)).toThrow('Origem IPC');
  expect(invoke(event, { ...payload, pcm: new Uint8Array(3202) })).toBe(false);
  expect(audio).not.toHaveBeenCalled(); expect(captureError).toHaveBeenCalledOnce();
  expect(invoke(event, payload)).toBe(true); expect(audio).toHaveBeenCalledOnce();
  unregister();
});

it('protects credential routes and rejects oversized/malformed payloads before reaching the backend', async () => {
  const url = 'file:///app/index.html', frame = { url }, contents = { mainFrame: {} as object };
  contents.mainFrame = frame;
  const status = { configured: true, canPersist: false, persisted: false, message: 'Somente memória' };
  const configureCredential = vi.fn(async () => status), removeCredential = vi.fn(async () => status), getCredentialStatus = vi.fn(async () => status);
  registerIpc({ webContents: contents } as unknown as BrowserWindow, url, { configureCredential, removeCredential, getCredentialStatus } as unknown as Backend);
  const invoke = (route: string, payload: unknown, sender = contents) => handlers.get(`sussurro:${route}`)!({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent, payload);
  for (const route of ['credential-set', 'credential-remove', 'credential-status']) {
    expect(() => invoke(route, {}, { mainFrame: {} })).toThrow('Origem IPC recusada');
  }
  for (const payload of [null, { key: 42, persist: true }, { key: 'x'.repeat(513), persist: true }, { key: 'synthetic-key' }]) {
    expect(() => invoke('credential-set', payload)).toThrow('Configuração de chave inválida');
  }
  expect(configureCredential).not.toHaveBeenCalled();
  expect(await invoke('credential-set', { key: 'synthetic-key', persist: false })).toEqual(status);
  expect(JSON.stringify(await invoke('credential-status', null))).not.toContain('synthetic-key');
  await invoke('credential-remove', null); expect(removeCredential).toHaveBeenCalledOnce();
});

it('accepts measurement commands only from the trusted frame and refuses free-text scenarios', async () => {
  const url = 'file:///app/index.html', frame = { url }, contents = { mainFrame: frame };
  const beginMeasurement = vi.fn(async () => {}), endMeasurement = vi.fn(async () => {}), exportMeasurement = vi.fn(async () => true);
  registerIpc({ webContents: contents } as unknown as BrowserWindow, url, { beginMeasurement, endMeasurement, exportMeasurement } as unknown as Backend);
  const invoke = (route: string, payload: unknown, sender: unknown = contents) => handlers.get(`sussurro:${route}`)!({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent, payload);
  for (const route of ['measurement-start', 'measurement-stop', 'measurement-export']) expect(() => invoke(route, 'one-source', {})).toThrow('Origem IPC recusada');
  for (const bad of ['synthetic-secret', '', {}, null]) expect(() => invoke('measurement-start', bad)).toThrow('Cenário de medição inválido');
  await invoke('measurement-start', 'two-sources'); await invoke('measurement-stop', null); await invoke('measurement-export', null);
  expect(beginMeasurement).toHaveBeenCalledWith('two-sources'); expect(endMeasurement).toHaveBeenCalledOnce(); expect(exportMeasurement).toHaveBeenCalledOnce();
});

it('bounds audio bursts and expensive concurrent IPC commands without blocking pause/stop', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const url = 'file:///app/index.html', frame = { url }, contents = { mainFrame: frame };
  const audio = vi.fn(() => true), captureError = vi.fn(), pause = vi.fn(async () => {}), stop = vi.fn(async () => {});
  let release!: () => void;
  const listSessions = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  registerIpc({ webContents: contents } as unknown as BrowserWindow, url, { audio, captureError, pause, stop, listSessions } as unknown as Backend);
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const invoke = (route: string, payload?: unknown) => handlers.get(`sussurro:${route}`)!(event, payload);
  const payload = { sessionId: '12345678-1234-1234-1234-123456789abc', captureId: '12345678-1234-1234-1234-123456789abc', sequence: 0, startMs: 0, pcm: new Uint8Array(3200) };
  for (let i = 0; i < 40; i++) expect(invoke('audio', payload)).toBe(true);
  for (let i = 0; i < 100; i++) expect(invoke('audio', payload)).toBe(false);
  expect(audio).toHaveBeenCalledTimes(40); expect(captureError).toHaveBeenCalledOnce();
  const pending = invoke('list-sessions');
  // Keep four bounded requests in flight; additional requests never reach the backend.
  const resolvers: (() => void)[] = [release];
  const promises = [pending];
  for (let i = 0; i < 3; i++) { promises.push(invoke('list-sessions')); resolvers.push(release); }
  expect(() => invoke('list-sessions')).toThrow('Comando em andamento');
  expect(listSessions).toHaveBeenCalledTimes(4);
  await invoke('pause'); await invoke('stop', true); expect(stop).toHaveBeenCalledOnce();
  resolvers.forEach(resolve => resolve()); await Promise.all(promises);
});

it('refuses command floods before backend work and replenishes the fixed budget while keeping stop available', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const url = 'file:///app/index.html', frame = { url }, contents = { mainFrame: frame };
  const getState = vi.fn(() => ({})), stop = vi.fn(async () => {});
  registerIpc({ webContents: contents } as unknown as BrowserWindow, url, { getState, stop } as unknown as Backend);
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const state = handlers.get('sussurro:get-state')!;
  for (let i = 0; i < 60; i++) state(event);
  expect(() => state(event)).toThrow('Muitos comandos'); expect(getState).toHaveBeenCalledTimes(60);
  await handlers.get('sussurro:stop')!(event, true); expect(stop).toHaveBeenCalledOnce();
  clock.mockReturnValue(2000); state(event); expect(getState).toHaveBeenCalledTimes(61);
});
