import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Coordinator } from '../coordinator';
import { SessionStore } from '../storage';
import { CredentialStore } from '../config/credential-store';
import { DeepgramCredentials } from '../config/deepgram';
import { registerIpc } from '../ipc';

// Standalone test entry only: never imported by the production main. No real key or audio.
const [root] = process.argv.slice(2);
if (!root || !path.isAbsolute(root)) app.exit(1);
app.setPath('userData', path.join(root, 'isolated-user-data'));
app.setPath('sessionData', path.join(root, 'isolated-session-data'));
const checks: string[] = [];
let window: BrowserWindow | undefined, coordinator: Coordinator | undefined, unregister: (() => void) | undefined;
const key = new DeepgramCredentials();
const evaluate = (code: string) => window!.webContents.executeJavaScript(code);
async function until(code: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(code)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Popup condition timed out.');
}
void app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    const credentials = new CredentialStore(key, path.join(root, 'synthetic-key.enc'), {
      isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text',
      encryptString: () => { throw new Error(); }, decryptString: () => { throw new Error(); },
    });
    coordinator = new Coordinator(window, new SessionStore(path.join(root, 'history')), undefined, credentials);
    coordinator.listSystemDevices = async () => [];
    const url = pathToFileURL(path.join(root, 'renderer/index.html')).href;
    unregister = registerIpc(window, url, coordinator);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await window.loadURL(url);
    await until(`!![...document.querySelectorAll('button')].find(b => b.textContent === 'Configurar API key' && !b.disabled)`);
    const open = `[...document.querySelectorAll('button')].find(b => b.textContent === 'Configurar API key').click();`;
    await evaluate(open); await until(`document.querySelector('dialog').open`); checks.push('popup-opens');
    await evaluate(`document.querySelector('dialog input[type=password]').value = 'synthetic-popup-key'; document.querySelector('dialog form').requestSubmit();`);
    await until(`!document.querySelector('dialog').open`);
    if (!(await coordinator.getCredentialStatus()).configured) throw new Error();
    if (JSON.stringify(await coordinator.getCredentialStatus()).includes('synthetic-popup-key')) throw new Error();
    checks.push('configure-through-real-form-and-ipc'); checks.push('status-excludes-secret');
    await evaluate(open);
    if (!(await evaluate(`document.querySelector('dialog input[type=password]').value === ''`))) throw new Error();
    checks.push('password-cleared-after-submit');
    await evaluate(`document.querySelector('dialog input[type=password]').value = 'synthetic-discard-key';`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(`!document.querySelector('dialog').open`); await evaluate(open);
    if (!(await evaluate(`document.querySelector('dialog input[type=password]').value === ''`))) throw new Error();
    checks.push('escape-clears-password');
    await evaluate(`[...document.querySelectorAll('dialog button')].find(b => b.textContent === 'Remover chave').click();`);
    await until(`!document.querySelector('dialog').open`);
    if ((await coordinator.getCredentialStatus()).configured) throw new Error();
    checks.push('remove-through-real-popup-and-ipc');
    if ((await coordinator.getState()).sessionId !== null) throw new Error();
    checks.push('no-capture-session-started');
    console.log(JSON.stringify({ popupCheck: true, passed: true, checks, syntheticCredentials: true, audioCaptured: false, providerRequestMade: false, keyringTested: false }));
  } catch {
    process.exitCode = 1;
    console.log(JSON.stringify({ popupCheck: true, passed: false, checks, reason: 'desktop-unavailable-or-popup-check-failed', audioCaptured: false, providerRequestMade: false, keyringTested: false }));
  } finally {
    await coordinator?.dispose(true); key.clear(); unregister?.(); window?.destroy(); app.exit(Number(process.exitCode || 0));
  }
});
