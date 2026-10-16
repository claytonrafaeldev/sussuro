// Opens the packaged app for a short, real GUI check. Never captures audio.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const evidencePrefix = 'T010-ui';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const app = spawn(path.join(root, 'out/Sussurro-linux-x64/sussurro'), [
  `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
app.stdout.on('data', (data) => { logs += data.toString(); });
app.stderr.on('data', (data) => { logs += data.toString(); });
let launchError;
app.on('error', (error) => { launchError = error; });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Aplicativo encerrou: ${logs}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) }).then((r) => r.json());
      target = targets.find((item) => item.type === 'page' && item.url.startsWith('file:'));
      if (target) break;
    } catch { /* Wait until Chromium's local debugging endpoint is ready. */ }
    await delay(250);
  }
  assert(target, 'Janela do aplicativo não ficou disponível em 20 segundos.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const result = JSON.parse(data);
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    clearTimeout(entry.timer);
    if (result.error) entry.reject(new Error(JSON.stringify(result.error)));
    else entry.resolve(result.result);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  const expression = `JSON.stringify({ title: document.title, text: document.body.innerText,
    runtime: window.sussurro?.getRuntimeInfo(), nodeAccess: typeof require,
    processAccess: typeof process, background: getComputedStyle(document.body).backgroundColor })`;
  let state;
  for (let attempt = 0; attempt < 30; attempt++) {
    const evaluated = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (evaluated.exceptionDetails) throw new Error(JSON.stringify(evaluated.exceptionDetails));
    state = JSON.parse(evaluated.result.value);
    if (state.text.includes('Este espaço vai receber suas palavras.')) break;
    await delay(100);
  }
  assert.equal(state.title, 'Sussurro');
  assert(state.text.includes('Sem captura ativa'));
  assert.equal(state.runtime.platform, 'linux');
  assert.equal(state.nodeAccess, 'undefined');
  assert.equal(state.processAccess, 'undefined');
  assert.equal(state.background, 'rgb(246, 243, 236)');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  const evidenceDir = path.join(root, 'docs/evidencias');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, `${evidencePrefix}-window.png`), Buffer.from(screenshot.data, 'base64'));
  await writeFile(path.join(evidenceDir, `${evidencePrefix}-smoke.json`), JSON.stringify({
    ...state, checkedAt: new Date().toISOString(), audioCaptured: false,
  }, null, 2) + '\n');
  console.log('Janela real verificada: React, CSS, preload e isolamento Node. Captura PNG salva.');
} catch (error) {
  const evidenceDir = path.join(root, 'docs/evidencias');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, `${evidencePrefix}-smoke-failure.json`), JSON.stringify({
    checkedAt: new Date().toISOString(), passed: false,
    message: String(error), audioCaptured: false,
  }, null, 2) + '\n');
  throw error;
} finally {
  socket?.close();
  if (app.exitCode === null && app.signalCode === null) {
    app.kill('SIGTERM');
    const exited = await Promise.race([once(app, 'exit').then(() => true), delay(3000).then(() => false)]);
    if (!exited) { app.kill('SIGKILL'); await once(app, 'exit'); }
  }
}
