import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(?:VITE_)?DEEPGRAM_API_KEY$/.test(name)) delete env[name];
const temporary = await mkdtemp(path.join(tmpdir(), 'sussurro-recovery-check-'));
const output = path.join(temporary, 'vitest.json');
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), kind: 'simulated-integration', passed: false,
  audioCaptured: false, providerRequestMade: false, realKeyUsed: false, realKeyringTested: false, desktopPopupTested: false,
  limitations: ['Socket failures and credential backend are controlled test doubles; this does not disconnect the host network or exercise its real keyring.'] };
console.log('Verificando queda de conexão e comandos do popup com dados sintéticos. Nenhuma captura ou API real.');
try {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run',
      'tests/recovery.integration.test.ts', 'tests/credential-store.test.ts', 'tests/deepgram.test.ts',
      'tests/coordinator.test.ts', 'tests/microphone-ipc.test.ts', 'tests/renderer-lifecycle.test.ts', 'tests/storage-backpressure.test.ts',
      '--reporter=default', '--reporter=json', `--outputFile.json=${output}`], { cwd: project, env, stdio: 'inherit', shell: false });
    let force;
    const timer = setTimeout(() => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 3000); }, 60_000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); clearTimeout(force); resolve(code); });
  });
  const result = JSON.parse(await readFile(output, 'utf8'));
  report.passed = status === 0 && result.success === true;
  report.totalTests = result.numTotalTests; report.passedTests = result.numPassedTests; report.failedTests = result.numFailedTests;
  report.checks = result.testResults.flatMap(file => file.assertionResults.map(test => ({ name: test.fullName, status: test.status })));
} catch { report.reason = 'test-runner-or-report-unavailable'; }
finally {
  await writeFile(path.join(project, 'docs/evidencias/T013-recuperacao-automatizada.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rm(temporary, { recursive: true, force: true });
}
console.log(report.passed ? 'Recuperação automatizada aprovada. Relatório: docs/evidencias/T013-recuperacao-automatizada.json' : 'Verificação incompleta ou com falhas; consulte o relatório.');
process.exitCode = report.passed ? 0 : 1;
