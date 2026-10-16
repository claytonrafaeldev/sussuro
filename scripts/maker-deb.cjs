const Maker = require('@electron-forge/maker-base').default;
const { cp, mkdir, mkdtemp, writeFile, chmod, symlink, rm, readdir, stat } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { tmpdir } = require('node:os');
const execute = promisify(execFile);
async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(directory, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}
module.exports = class MakerDebLocal extends Maker {
  name = 'sussurro-deb';
  defaultPlatforms = ['linux'];
  requiredExternalBinaries = ['dpkg-deb'];
  isSupportedOnCurrentPlatform() { return process.platform === 'linux'; }
  async make({ dir, makeDir, targetArch, packageJSON }) {
    if (targetArch !== 'x64' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/.test(packageJSON.version)) throw new Error('Este pacote suporta apenas Linux amd64 e versão semântica.');
    const stage = await mkdtemp(path.join(tmpdir(), 'sussurro-deb-'));
    const outputDirectory = path.join(makeDir, 'deb', 'x64');
    const output = path.join(outputDirectory, `sussurro_${packageJSON.version}_amd64.deb`);
    try {
      await cp(dir, path.join(stage, 'opt/sussurro'), { recursive: true });
      // The installed helper must be root-owned/setuid; root ownership is metadata only during this rootless build.
      await chmod(path.join(stage, 'opt/sussurro/chrome-sandbox'), 0o4755);
      for (const directory of ['DEBIAN', 'usr/bin', 'usr/share/applications', 'usr/share/icons/hicolor/512x512/apps', 'usr/share/icons/hicolor/scalable/apps', 'usr/share/doc/sussurro']) await mkdir(path.join(stage, directory), { recursive: true, mode: 0o755 });
      await symlink('/opt/sussurro/sussurro', path.join(stage, 'usr/bin/sussurro'));
      await cp(path.join(__dirname, '../public/icon.png'), path.join(stage, 'usr/share/icons/hicolor/512x512/apps/sussurro.png'));
      await cp(path.join(__dirname, '../public/icon.svg'), path.join(stage, 'usr/share/icons/hicolor/scalable/apps/sussurro.svg'));
      await writeFile(path.join(stage, 'usr/share/applications/sussurro.desktop'), `[Desktop Entry]\nVersion=1.0\nType=Application\nName=Sussurro\nComment=Transcrição de áudio com Deepgram\nExec=/usr/bin/sussurro\nTryExec=/usr/bin/sussurro\nIcon=sussurro\nTerminal=false\nCategories=AudioVideo;Audio;Utility;\nStartupNotify=true\nStartupWMClass=sussurro\n`, { mode: 0o644 });
      await writeFile(path.join(stage, 'usr/share/doc/sussurro/README'), 'Sussurro\n\nAbra pelo menu de aplicativos ou pelo comando sussurro.\nConfigure sua chave Deepgram pelo popup Configurar API key. O app instalado não lê .env.\nA captura começa somente por ação do usuário. Requer internet e créditos Deepgram.\nÁudio do computador requer PipeWire (pw-dump/pw-record). Nenhum áudio bruto é salvo automaticamente.\nLicenças do Electron/Chromium e ws ficam em /opt/sussurro.\n');
      const payloadFiles = await files(stage);
      let bytes = 0; const sums = [];
      for (const file of payloadFiles) { bytes += (await stat(path.join(stage, file))).size; sums.push(`${await digest(path.join(stage, file), 'md5')}  ${file}`); }
      await writeFile(path.join(stage, 'DEBIAN/md5sums'), sums.join('\n') + '\n');
      const dependencies = [
        'libc6 (>= 2.31)', 'libgtk-3-0 | libgtk-3-0t64', 'libnss3', 'libnspr4',
        'libasound2 | libasound2t64', 'libatk-bridge2.0-0 | libatk-bridge2.0-0t64',
        'libatspi2.0-0 | libatspi2.0-0t64', 'libcups2 | libcups2t64', 'libdbus-1-3',
        'libdrm2', 'libgbm1', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1',
        'libxfixes3', 'libxrandr2', 'libxkbcommon0', 'libxss1', 'libpango-1.0-0', 'libcairo2', 'libexpat1', 'pipewire-bin',
      ];
      await writeFile(path.join(stage, 'DEBIAN/control'), `Package: sussurro\nVersion: ${packageJSON.version}\nSection: sound\nPriority: optional\nArchitecture: amd64\nMaintainer: Sussurro <noreply@localhost>\nInstalled-Size: ${Math.ceil(bytes / 1024)}\nDepends: ${dependencies.join(', ')}\nDescription: Transcrição do microfone e áudio do computador\n Aplicativo desktop independente com Deepgram Nova-3, histórico local\n opcional e salvamento automático de texto. Requer chave e internet.\n`);
      await chmod(stage, 0o755);
      await mkdir(outputDirectory, { recursive: true });
      await execute('dpkg-deb', ['--threads-max=1', '-Zxz', '-z3', '--root-owner-group', '--build', stage, output], { timeout: 240000, maxBuffer: 1024 * 1024 });
      await writeFile(`${output}.sha256`, `${await digest(output, 'sha256')}  ${path.basename(output)}\n`);
      return [output, `${output}.sha256`];
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
};
