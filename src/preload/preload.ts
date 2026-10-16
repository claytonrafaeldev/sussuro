import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeInfo, SussurroApi } from '../shared/runtime';
import type { OverlayApi } from '../shared/overlay';

const runtime: RuntimeInfo = {
  platform: process.platform,
  electronVersion: process.versions.electron,
};

let audioPending = false;
const api: SussurroApi = {
  getRuntimeInfo: () => ({ ...runtime }),
  getCredentialStatus: () => ipcRenderer.invoke('sussurro:credential-status'),
  configureCredential: (value) => ipcRenderer.invoke('sussurro:credential-set', value),
  removeCredential: () => ipcRenderer.invoke('sussurro:credential-remove'),
  beginMeasurement: (scenario) => ipcRenderer.invoke('sussurro:measurement-start', scenario),
  endMeasurement: () => ipcRenderer.invoke('sussurro:measurement-stop'),
  exportMeasurement: () => ipcRenderer.invoke('sussurro:measurement-export'),
  getState: () => ipcRenderer.invoke('sussurro:get-state'),
  beginMicrophoneCheck: () => ipcRenderer.invoke('sussurro:microphone-check-start'),
  endMicrophoneCheck: () => ipcRenderer.invoke('sussurro:microphone-check-stop'),
  listSystemDevices: () => ipcRenderer.invoke('sussurro:devices'),
  start: (options) => ipcRenderer.invoke('sussurro:start', options),
  pause: () => ipcRenderer.invoke('sussurro:pause'),
  resume: () => ipcRenderer.invoke('sussurro:resume'),
  stop: (cancel) => ipcRenderer.invoke('sussurro:stop', cancel),
  setSources: (sources) => ipcRenderer.invoke('sussurro:sources', sources),
  sendAudio: async (frame) => {
    if (audioPending) return false;
    audioPending = true;
    try { return await ipcRenderer.invoke('sussurro:audio', frame) === true; }
    finally { audioPending = false; }
  },
  reportCaptureError: (message, captureId) => ipcRenderer.send('sussurro:capture-error', { message, captureId }),
  onState: (callback) => {
    const listener = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on('sussurro:state', listener);
    return () => ipcRenderer.removeListener('sussurro:state', listener);
  },
  listSessions: () => ipcRenderer.invoke('sussurro:list-sessions'),
  readSession: (id) => ipcRenderer.invoke('sussurro:read-session', id),
  deleteSession: (id) => ipcRenderer.invoke('sussurro:delete-session', id),
  exportSession: (id) => ipcRenderer.invoke('sussurro:export-session', id),
  copySession: (id) => ipcRenderer.invoke('sussurro:copy-session', id),
};

if (process.argv.includes('--sussurro-overlay')) {
  const overlay: OverlayApi = {
    getState: () => ipcRenderer.invoke('sussurro:overlay:get-state'),
    pause: () => ipcRenderer.invoke('sussurro:overlay:pause'),
    openMain: () => ipcRenderer.invoke('sussurro:overlay:open-main'),
    onState: (callback) => {
      const listener = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state);
      ipcRenderer.on('sussurro:overlay:state', listener);
      return () => ipcRenderer.removeListener('sussurro:overlay:state', listener);
    },
  };
  contextBridge.exposeInMainWorld('sussurroOverlay', overlay);
} else contextBridge.exposeInMainWorld('sussurro', api);
