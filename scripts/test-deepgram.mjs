import { build } from 'vite';
import { builtinModules } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// Keep credentials out of any build-tool subprocess environment.
let environmentKey = process.env.DEEPGRAM_API_KEY;
delete process.env.DEEPGRAM_API_KEY;
const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log(`Diagnóstico real Deepgram (não abre microfone/saída).
Uso: npm run deepgram:test -- --language pt-BR --wav /caminho/amostra-publica.wav --confirm-public-audio
Idiomas de aceite: pt-BR e en. WAV PCM mono, 16 kHz, 16 bits, até 30 s.
A confirmação declara que a amostra é pública e autoriza seu envio ao Deepgram com consumo de créditos.
Usa a chave já configurada no ambiente/.env.local/.env, sem mostrá-la. Não altera sua chave.
Imprime apenas métricas; não imprime nem salva áudio/transcrição. Não valida captura ou popup.
Exemplo inglês: npm run deepgram:test -- --language en --wav .cache/whisper/jfk.wav --confirm-public-audio`);
} else {
  let directory;
  try {
    // Emit outside the source tree; use the existing project's ws package at runtime.
    await mkdir(path.join(project, '.cache'), { recursive: true });
    directory = await mkdtemp(path.join(project, '.cache/deepgram-check-'));
    const result = await build({ configFile: false, envDir: false, envPrefix: [], logLevel: 'silent',
      build: { write: false, minify: false, lib: { entry: path.join(project, 'src/main/diagnostics/deepgram-check.ts'), formats: ['es'] },
        rollupOptions: { external: ['ws', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] } },
    });
    const output = (Array.isArray(result) ? result[0] : result).output;
    const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
    if (!chunk) throw new Error();
    const runner = path.join(directory, 'runner.mjs');
    await writeFile(runner, chunk.code, { mode: 0o600 });
    const { runDeepgramCheck } = await import(pathToFileURL(runner).href);
    await runDeepgramCheck(args, project, environmentKey);
  } catch {
    console.error('Não foi possível executar o diagnóstico. Confira os argumentos, o WAV PCM e a configuração local. Nenhum detalhe de chave é exibido.');
    process.exitCode = 1;
  } finally { environmentKey = undefined; if (directory) await rm(directory, { recursive: true, force: true }); }
}
