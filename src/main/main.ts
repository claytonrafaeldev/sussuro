import { app, BrowserWindow, safeStorage, dialog, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTrustedRendererUrl } from './navigation';
import { Coordinator } from './coordinator';
import { SessionStore } from './storage';
import { registerIpc } from './ipc';
import { TranscriptionOverlay } from './overlay';
import { guardRenderer } from './renderer-lifecycle';
import { CredentialStore } from './config/credential-store';
import { ResourceMonitor } from './performance/resources';
import { deepgramFactory } from './transcription/deepgram';
import { deepgramCredentials } from './config/deepgram';

if (process.platform === 'linux') { app.setDesktopName('sussurro.desktop'); app.commandLine.appendSwitch('class', 'sussurro'); }

const credentialsReady = deepgramCredentials.load({ appPath: app.getAppPath(), isPackaged: app.isPackaged }).catch(() => {
  console.error('Configuração Deepgram indisponível. Confira DEEPGRAM_API_KEY e o .env local.');
});

let credentialStore: CredentialStore;

function createWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    title: 'Sussurro',
    icon: MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? path.join(app.getAppPath(), 'public/icon.png')
      : path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/icon.png`),
    width: Math.min(1100, width),
    height: Math.min(860, height),
    minWidth: Math.min(900, width),
    minHeight: Math.min(720, height),
    // Alpha is painted by the renderer; keep desktop pixels visible underneath.
    transparent: false,
    backgroundColor: '#10110f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  const documentPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  const rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL || pathToFileURL(documentPath).href;
  const backend = new Coordinator(window, new SessionStore(path.join(app.getPath('userData'), 'sessions')), deepgramFactory(deepgramCredentials), credentialStore, new ResourceMonitor(() => app.getAppMetrics().map((item) => item.pid)));
  let closing = false;
  const overlay = new TranscriptionOverlay(window, rendererUrl, path.join(__dirname, 'preload.cjs'), () => backend.pause());
  const unsubscribeOverlay = backend.subscribeState((state) => { if (!closing) overlay.update(state); });
  window.once('closed', () => { unsubscribeOverlay(); overlay.dispose(); });
  const unregister = registerIpc(window, rendererUrl, backend);
  const unguard = guardRenderer(window, backend);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const trustedWindow = (contents: Electron.WebContents | null) => contents === window.webContents && isTrustedRendererUrl(contents.getURL(), rendererUrl);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(trustedWindow(contents) && backend.microphoneAllowed() && permission === 'media' &&
      'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    trustedWindow(contents) && backend.microphoneAllowed() && permission === 'media' && details.mediaType === 'audio');
  window.on('close', (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    overlay.hide();
    void backend.dispose().then(() => { unguard(); unregister(); window.destroy(); }).catch(async () => {
      const result = await dialog.showMessageBox(window, { type: 'error', title: 'Não foi possível salvar',
        message: 'O salvamento automático falhou. Volte para copiar ou exportar o texto antes de fechar.',
        buttons: ['Voltar à transcrição', 'Fechar mesmo assim'], defaultId: 0, cancelId: 0 });
      if (result.response === 1) { await backend.dispose(true); unguard(); unregister(); window.destroy(); }
      else { closing = false; overlay.update(await backend.getState()); }
    });
  });
  window.once('ready-to-show', () => window.show());
  void window.loadURL(rendererUrl).catch(() => {
    console.error('Não foi possível carregar a janela do Sussurro.');
    app.quit();
  });
}

void app.whenReady().then(async () => {
  await credentialsReady;
  credentialStore = new CredentialStore(deepgramCredentials, path.join(app.getPath('userData'), 'deepgram-key.enc'), safeStorage);
  await credentialStore.load();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => deepgramCredentials.clear());
