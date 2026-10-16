import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import type { ViewState } from '../shared/contracts';
import { overlayState, type OverlayState } from '../shared/overlay';
import { isTrustedRendererUrl } from './navigation';

/** Auxiliary UI only: no capture, provider connection, filesystem or credentials. */
export class TranscriptionOverlay {
  private window: BrowserWindow | null = null;
  private state: OverlayState | null = null;
  private ready = false;
  private disposed = false;
  private pendingPause = false;
  private lastOpen = -Infinity;
  private sessionId: string | null = null;
  private failedSession: string | null = null;
  private url: string;
  constructor(private readonly main: BrowserWindow, rendererUrl: string, private readonly preload: string,
    private readonly pause: () => Promise<void>) {
    const url = new URL(rendererUrl); url.hash = 'overlay'; this.url = url.href;
    const trusted = (event: IpcMainInvokeEvent) => this.window && !this.window.isDestroyed() &&
      event.sender === this.window.webContents && event.senderFrame === this.window.webContents.mainFrame &&
      !!event.senderFrame && isTrustedRendererUrl(event.senderFrame.url, this.url);
    for (const command of ['get-state', 'pause', 'open-main'] as const) {
      ipcMain.handle(`sussurro:overlay:${command}`, async (event) => {
        if (this.disposed || !trusted(event)) throw new Error('Origem do popup recusada.');
        if (command === 'get-state') return this.state ? { ...this.state } : null;
        if (command === 'open-main') {
          if (Date.now() - this.lastOpen < 500) return;
          this.lastOpen = Date.now();
          if (!this.main.isDestroyed()) { if (this.main.isMinimized()) this.main.restore(); this.main.show(); this.main.focus(); }
          return;
        }
        if (this.pendingPause || this.state?.phase !== 'capturing') return;
        this.pendingPause = true;
        try { await this.pause(); }
        catch { throw new Error('Não foi possível pausar. Abra o Sussurro para conferir a sessão.'); }
        finally { this.pendingPause = false; }
      });
    }
  }
  update(state: ViewState): void {
    if (this.disposed) return;
    this.sessionId = state.sessionId;
    this.state = overlayState(state);
    if (!this.state) { this.closeWindow(); return; }
    // Do not create a popup for preparation or a paused session never shown before.
    if (this.failedSession === this.sessionId || !this.window && this.state.phase !== 'capturing') return;
    try {
      if (!this.window) this.createWindow();
      if (this.ready && this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('sussurro:overlay:state', this.state);
      }
    } catch { this.failedSession = this.sessionId; this.closeWindow(); } // An optional popup must never interrupt capture.
  }
  private createWindow(): void {
    const area = screen.getDisplayMatching(this.main.getBounds()).workArea;
    const width = Math.min(360, area.width), height = Math.min(190, area.height);
    const window = new BrowserWindow({ title: 'Sussurro · transcrição',
      width, height, x: Math.max(area.x, area.x + area.width - width - 16), y: area.y + Math.min(16, Math.max(0, area.height - height)),
      frame: false, transparent: true, backgroundColor: '#00000000', show: false,
      resizable: false, maximizable: false, minimizable: false, alwaysOnTop: true, skipTaskbar: true,
      autoHideMenuBar: true, hasShadow: false,
      webPreferences: { preload: this.preload, additionalArguments: ['--sussurro-overlay'],
        partition: 'sussurro-overlay', contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, webviewTag: false, backgroundThrottling: false },
    });
    this.window = window; this.ready = false;
    window.setVisibleOnAllWorkspaces(true);
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!isTrustedRendererUrl(url, this.url)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('render-process-gone', () => { if (this.window === window) { this.failedSession = this.sessionId; this.closeWindow(); } });
    window.on('unresponsive', () => { if (this.window === window) { this.failedSession = this.sessionId; this.closeWindow(); } });
    window.on('closed', () => { if (this.window === window) { this.failedSession = this.sessionId; this.window = null; this.ready = false; } });
    window.webContents.on('did-finish-load', () => {
      if (this.disposed || this.window !== window || !this.state || this.main.isDestroyed()) return;
      this.ready = true;
      window.webContents.send('sussurro:overlay:state', this.state);
      window.showInactive();
    });
    void window.loadURL(this.url).catch(() => { if (this.window === window) { this.failedSession = this.sessionId; this.closeWindow(); } });
  }
  private closeWindow(): void {
    const window = this.window; this.window = null; this.ready = false;
    if (window && !window.isDestroyed()) window.destroy();
  }
  hide(): void { this.state = null; this.closeWindow(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.state = null; this.closeWindow();
    for (const command of ['get-state', 'pause', 'open-main']) ipcMain.removeHandler(`sussurro:overlay:${command}`);
  }
}
