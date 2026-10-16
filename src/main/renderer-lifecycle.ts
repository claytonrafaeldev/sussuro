import type { BrowserWindow, Event, WebContentsDidStartNavigationEventParams } from 'electron';

/** Losing the UI revokes capture; loading it again never restarts capture automatically. */
export function guardRenderer(window: BrowserWindow, backend: { rendererUnavailable(): void; rendererReady(): void }): () => void {
  const lost = () => backend.rendererUnavailable();
  const ready = () => backend.rendererReady();
  const navigate = (details: Event<WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) lost();
  };
  window.webContents.on('render-process-gone', lost);
  window.webContents.on('did-start-navigation', navigate);
  window.webContents.on('did-finish-load', ready);
  window.on('unresponsive', lost);
  return () => {
    window.webContents.removeListener('render-process-gone', lost);
    window.webContents.removeListener('did-start-navigation', navigate);
    window.webContents.removeListener('did-finish-load', ready);
    window.removeListener('unresponsive', lost);
  };
}
