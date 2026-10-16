import { build } from 'vite';
import { builtinModules } from 'node:module';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Compilation only. No Electron download, installer, capture, or access to dotenv.
delete process.env.DEEPGRAM_API_KEY; delete process.env.VITE_DEEPGRAM_API_KEY;
const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'sussurro-build-check-'));
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), kind: 'compilation-only', passed: false,
  targets: [], installerGenerated: false, runtimeDownloaded: false };
try {
  for (const [name, entry, config] of [['main', 'src/main/main.ts', 'vite.main.config.ts'], ['preload', 'src/preload/preload.ts', 'vite.preload.config.ts']]) {
    await build({ configFile: path.join(project, config), root: project, logLevel: 'warn',
      resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] },
      define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined', MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window') },
      build: { outDir: path.join(temporary, 'build'), emptyOutDir: false, copyPublicDir: false,
        lib: { entry: path.join(project, entry), formats: ['cjs'], fileName: () => `${name}.cjs` },
        rollupOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)] } } });
    report.targets.push(name);
  }
  await build({ configFile: path.join(project, 'vite.renderer.config.ts'), root: project, base: './', logLevel: 'warn',
    build: { outDir: path.join(temporary, 'renderer/main_window'), emptyOutDir: true } });
  report.targets.push('renderer'); report.passed = true;
  report.mainAssets = (await readdir(path.join(temporary, 'build'))).filter(name => name.endsWith('.cjs') || name.endsWith('LICENSE.txt'));
} catch { report.reason = 'compilation-failed'; }
finally {
  await writeFile(path.join(project, 'docs/evidencias/T014-build-bundles.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rm(temporary, { recursive: true, force: true });
}
console.log(report.passed ? 'Main, preload e renderer compilados. Verificação sem empacotamento ou instalador.' : 'Compilação incompleta; consulte docs/evidencias/T014-build-bundles.json.');
process.exitCode = report.passed ? 0 : 1;
