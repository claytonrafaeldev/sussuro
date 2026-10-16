import { build } from 'vite';
import { spawn } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(?:VITE_)?DEEPGRAM_API_KEY$/.test(name)) delete env[name];
// Vite never loads dotenv, and later tool subprocesses cannot inherit the main's key.
delete process.env.DEEPGRAM_API_KEY; delete process.env.VITE_DEEPGRAM_API_KEY;
const temporary = await mkdtemp(path.join(tmpdir(), 'sussurro-popup-check-'));
let report = { schemaVersion: 1, checkedAt: new Date().toISOString(), passed: false, desktopPopupTested: false,
  audioCaptured: false, providerRequestMade: false, realKeyUsed: false, keyringTested: false };
try {
  await mkdir(path.join(temporary, 'isolated-user-data')); await mkdir(path.join(temporary, 'isolated-session-data'));
  await build({ configFile: path.join(project, 'vite.renderer.config.ts'), root: project, base: './', logLevel: 'silent',
    build: { outDir: path.join(temporary, 'renderer'), emptyOutDir: true } });
  for (const [entry, fileName] of [['src/preload/preload.ts', 'preload.cjs'], ['src/main/diagnostics/popup-check.ts', 'runner.cjs']]) {
    await build({ configFile: false, envDir: false, envPrefix: [], logLevel: 'silent',
      resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] },
      build: { copyPublicDir: false, outDir: temporary, emptyOutDir: false, lib: { entry: path.join(project, entry), formats: ['cjs'], fileName: () => fileName },
        rollupOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)] } } });
  }
  const electron = createRequire(import.meta.url)('electron');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temporary, 'runner.cjs'), temporary], { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', force;
    const native = { sandbox: false, permission: false, display: false };
    child.stderr.on('data', data => {
      const text = data.toString();
      native.sandbox ||= /sandbox|zygote/i.test(text);
      native.permission ||= /Operation not permitted|Permission denied/i.test(text);
      native.display ||= /Missing X server|DISPLAY|cannot open display/i.test(text);
    });
    child.stdout.on('data', data => { if (stdout.length < 64 * 1024) stdout += data.toString(); });
    child.stderr.resume(); // Native diagnostics can contain local paths; persist only fixed failure categories.
    const timer = setTimeout(() => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 3000); }, 30_000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(force); resolve({ code, signal, stdout, native }); });
  });
  const line = result.stdout.split('\n').find(value => value.startsWith('{') && value.includes('"popupCheck":true'));
  if (line) {
    const value = JSON.parse(line); report = { ...report, ...value, desktopPopupTested: true, passed: result.code === 0 && value.passed === true };
  } else report = { ...report, reason: 'electron-did-not-reach-test-harness', exitCode: result.code, signal: result.signal, nativeFailureCategories: result.native };
} catch { report.reason = 'desktop-test-build-or-launch-unavailable'; }
finally {
  await writeFile(path.join(project, 'docs/evidencias/T013-popup-desktop.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;
