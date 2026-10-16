const { VitePlugin } = require('@electron-forge/plugin-vite');
const MakerDebLocal = require('./scripts/maker-deb.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Reuse the matching official runtime already cached by npm's Electron installation.
const version = require('./package.json').devDependencies.electron;
const zipName = `electron-v${version}-linux-x64.zip`;
const cacheRoot = path.join(os.homedir(), '.cache/electron');
const candidates = [process.env.SUSSURRO_ELECTRON_ZIP_DIR, path.join(__dirname, '.cache/electron')].filter(Boolean);
if (fs.existsSync(cacheRoot)) for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) if (entry.isDirectory()) candidates.push(path.join(cacheRoot, entry.name));
const electronZipDir = candidates.find(directory => fs.existsSync(path.join(directory, zipName)));


module.exports = {
  packagerConfig: {
    asar: true,
    icon: path.join(__dirname, 'public/icon.png'),
    ...(electronZipDir ? { electronZipDir } : {}),
    executableName: 'sussurro',
    appBundleId: 'local.sussurro.desktop',
    // Preserve Vite's output-only packaging boundary and exclude secrets at any depth.
    ignore: (file) => {
      if (/(^|[/\\])\.env(?:\.[^/\\]*)?(?:[/\\]|$)/.test(file)) return true;
      return !!file && file !== '/.vite' && !file.startsWith('/.vite/');
    },
    // Whisper development artifacts are preserved on disk, excluded from the Nova-3 package.
  },
  makers: [new MakerDebLocal()],
  plugins: [new VitePlugin({
    concurrent: 1,
    build: [
      { entry: 'src/main/main.ts', config: 'vite.main.config.ts' },
      { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  })],
};
