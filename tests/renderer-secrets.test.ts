import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, type UserConfigFnObject } from 'vite';
import { expect, it, vi } from 'vitest';
import rendererConfig from '../vite.renderer.config';

it('does not embed env-file or environment tokens into the actual renderer bundle', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sussurro-renderer-env-'));
  vi.stubEnv('VITE_DEEPGRAM_API_KEY', 'synthetic-environment-token');
  try {
    await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=synthetic-file-token\nVITE_DEEPGRAM_API_KEY=synthetic-prefixed-token\n');
    await writeFile(path.join(directory, 'index.html'), '<script type="module" src="/entry.js"></script>');
    await writeFile(path.join(directory, 'entry.js'), 'globalThis.publicConfig = import.meta.env;');
    const config = (rendererConfig as UserConfigFnObject)({ command: 'build', mode: 'production' });
    const result = await build({ ...config, configFile: false, root: directory, logLevel: 'silent', build: { write: false, minify: false } });
    const output = JSON.stringify(result);
    expect(output).toContain('publicConfig');
    for (const value of ['synthetic-environment-token', 'synthetic-file-token', 'synthetic-prefixed-token', 'DEEPGRAM_API_KEY']) {
      expect(output).not.toContain(value);
    }
  } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});
