import { performance } from 'node:perf_hooks';
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { parseOptions, parseSources, parseFrame, validId, type AudioFrame } from '../shared/contracts';
import type { SussurroApi } from '../shared/runtime';
import { parseMeasurementScenario } from '../shared/performance';
import { isTrustedRendererUrl } from './navigation';

type CommandApi = Omit<SussurroApi, 'getRuntimeInfo' | 'sendAudio' | 'onState' | 'reportCaptureError'>;
export interface Backend extends CommandApi { audio(frame: AudioFrame): boolean; captureError(message: string, captureId?: string): void }
export function registerIpc(window: BrowserWindow, rendererUrl: string, backend: Backend): () => void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    !!event.senderFrame && isTrustedRendererUrl(event.senderFrame.url, rendererUrl);
  const budgets = {
    audio: { credit: 40, capacity: 40, perSecond: 20, at: performance.now(), warned: false },
    commands: { credit: 60, capacity: 60, perSecond: 30, at: performance.now(), warned: false },
    errors: { credit: 8, capacity: 8, perSecond: 2, at: performance.now(), warned: false },
  };
  const take = (kind: keyof typeof budgets): boolean => {
    const budget = budgets[kind], now = performance.now();
    budget.credit = Math.min(budget.capacity, budget.credit + Math.max(0, now - budget.at) * budget.perSecond / 1000); budget.at = now;
    if (budget.credit < 1) return false;
    budget.credit--; return true;
  };
  const id = (value: unknown): string => {
    if (!validId(value)) throw new Error('Identificador de sessão inválido.');
    return value;
  };
  const handlers: Record<string, (payload: unknown) => unknown> = {
    'credential-status': () => backend.getCredentialStatus(),
    'credential-set': (payload) => {
      if (!payload || typeof payload !== 'object' || !('key' in payload) || !('persist' in payload) || typeof payload.key !== 'string' || payload.key.length > 512 || typeof payload.persist !== 'boolean') throw new Error('Configuração de chave inválida.');
      return backend.configureCredential({ key: payload.key, persist: payload.persist });
    },
    'credential-remove': () => backend.removeCredential(),
    'measurement-start': (payload) => backend.beginMeasurement(parseMeasurementScenario(payload)),
    'measurement-stop': () => backend.endMeasurement(),
    'measurement-export': () => backend.exportMeasurement(),
    'get-state': () => backend.getState(), devices: () => backend.listSystemDevices(),
    'microphone-check-start': () => backend.beginMicrophoneCheck(),
    'microphone-check-stop': () => backend.endMicrophoneCheck(),
    start: (payload) => backend.start(parseOptions(payload)),
    audio: (payload) => {
      try { return backend.audio(parseFrame(payload)); }
      catch { backend.captureError('Quadro de áudio inválido; captura interrompida.'); return false; }
    },
    pause: () => backend.pause(), resume: () => backend.resume(),
    stop: (payload) => { if (typeof payload !== 'boolean') throw new Error('Comando inválido.'); return backend.stop(payload); },
    sources: (payload) => backend.setSources(parseSources(payload)),
    'list-sessions': () => backend.listSessions(), 'read-session': (payload) => backend.readSession(id(payload)),
    'delete-session': (payload) => backend.deleteSession(id(payload)), 'export-session': (payload) => backend.exportSession(id(payload)),
    'copy-session': (payload) => backend.copySession(id(payload)),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    let pending = 0;
    const limit = name === 'stop' ? 2 : ['devices', 'get-state', 'list-sessions', 'read-session'].includes(name) ? 4 : 1;
    ipcMain.handle(`sussurro:${name}`, (event, payload: unknown) => {
      if (!trusted(event)) throw new Error('Origem IPC recusada.');
      if (name === 'audio') {
        if (!take('audio')) {
          if (!budgets.audio.warned) { budgets.audio.warned = true; backend.captureError('Excesso de quadros IPC. Captura interrompida; há uma lacuna. Retome explicitamente.'); }
          return false;
        }
        budgets.audio.warned = false;
      } else if (!['pause', 'stop'].includes(name) && !take('commands')) throw new Error('Muitos comandos. Aguarde um instante.');
      if (pending >= limit) throw new Error('Comando em andamento. Aguarde sua conclusão.');
      const result = handler(payload);
      if (result instanceof Promise) { pending++; return result.finally(() => { pending--; }); }
      return result;
    });
  }
  const error = (event: IpcMainEvent, payload: unknown) => {
    if (trusted(event) && take('errors') && payload && typeof payload === 'object' && 'message' in payload && 'captureId' in payload &&
        typeof payload.message === 'string' && validId(payload.captureId)) backend.captureError(payload.message.slice(0, 300), payload.captureId);
  };
  ipcMain.on('sussurro:capture-error', error);
  return () => {
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`sussurro:${name}`);
    ipcMain.removeListener('sussurro:capture-error', error);
  };
}
