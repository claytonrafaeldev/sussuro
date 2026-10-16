import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../forge.config.cjs');
it('keeps the Vite packaging boundary and rejects env secrets inside build outputs', async () => {
  // Exercise the final config after the installed Forge Vite plugin resolves it.
  const resolved = await config.plugins[0].resolveForgeConfig(config);
  const ignore = resolved.packagerConfig.ignore as (file: string) => boolean;
  for (const file of ['/.env', '/.env.local', '/.env.production', '/.env.example', '/.vite/renderer/main_window/.env', '/.vite/build/.env.local']) {
    expect(ignore(file), file).toBe(true);
  }
  for (const file of ['', '/.vite', '/.vite/build/main.cjs', '/.vite/renderer/main_window/assets/index.js']) {
    expect(ignore(file), file).toBe(false);
  }
  for (const file of ['/src', '/resources', '/tests', '/.git', '/.vitemap', '/out']) {
    expect(ignore(file), file).toBe(true);
  }
});
