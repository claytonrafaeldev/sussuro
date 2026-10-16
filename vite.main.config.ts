import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
export default defineConfig({
  envDir: false, envPrefix: [],
  plugins: [{
    name: 'sussurro-ws-license',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'ws-LICENSE.txt', source: readFileSync(path.join(path.dirname(require.resolve('ws/package.json')), 'LICENSE'), 'utf8') });
    },
  }],
});
