// Explicit interactive test of the production adapter. No API, .env or raw audio files.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { LinuxOutput, systemDevices } from '../src/main/audio/linux.ts';
import { pcmRms, pcmToWav } from '../src/shared/audio.ts';
import { inspectOutputGraph, outputProcessReleased } from '../src/main/audio/graph.ts';

// This diagnostic never needs a provider credential, including in subprocesses.
delete process.env.DEEPGRAM_API_KEY;
delete process.env.VITE_DEEPGRAM_API_KEY;
const execute = promisify(execFile);
const output = new LinuxOutput();
const abort = new AbortController();
let playback;
let playbackClosed = Promise.resolve();
let stoppedBySignal = false;
const interrupt = () => { stoppedBySignal = true; abort.abort(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
let terminal;
let failure;
let frames = 0;
let phase = 'silenceBefore';
const stats = { silenceBefore: { frames: 0, peak: 0 }, tone: { frames: 0, peak: 0 }, silenceAfter: { frames: 0, peak: 0 } };

async function inspectLinks(pid, selectedId) {
  const { stdout } = await execute('pw-dump', [], { signal: abort.signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  let inventory;
  try { inventory = JSON.parse(stdout); }
  catch { throw new Error('Não foi possível ler o grafo PipeWire. Nenhum tom foi iniciado.'); }
  return inspectOutputGraph(inventory, pid, selectedId);
}

try {
  if (process.argv.includes('--help')) {
    console.log('npm run audio:test — lista saídas, pede seleção e confirmação, testa monitor com tom sintético por tempo limitado. Sem salvar/enviar áudio.');
  } else {
    const devices = await systemDevices(abort.signal);
    if (!devices.length) throw new Error('Nenhuma saída PipeWire disponível. Confira sua sessão de áudio.');
    console.log('Teste local do áudio interno. Feche o Sussurro e pause outros sons para não captar conteúdo pessoal.');
    devices.forEach((device, index) => console.log(`${index + 1}. ${device.label}`));
    if (!process.stdin.isTTY) throw new Error('Execute em um terminal interativo para selecionar e autorizar o teste.');
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    const choice = (await terminal.question('Número da saída em que você ouve o computador: ', { signal: abort.signal })).trim();
    const device = /^\d+$/.test(choice) ? devices[Number(choice) - 1] : null;
    if (!device) throw new Error('Seleção inválida. Execute novamente e escolha uma saída da lista.');
    console.log('Será capturado apenas o monitor da saída escolhida: silêncio, um tom de 4 s em volume baixo e silêncio. Microfone não será aberto. Nenhum áudio será salvo ou enviado.');
    if ((await terminal.question('Digite TESTAR para iniciar (ou Enter para cancelar): ', { signal: abort.signal })).trim() !== 'TESTAR') {
      console.log('Cancelado; nenhuma captura iniciada.');
    } else {
      terminal.close(); terminal = undefined;
      await output.start(device.id, (pcm) => {
        frames++;
        const level = pcmRms(pcm), stat = stats[phase]; stat.frames++; stat.peak = Math.max(stat.peak, level);
      }, (message) => { failure = message; abort.abort(); });
      console.log('1/3 · Silêncio por 3 segundos.');
      await delay(3000, undefined, { signal: abort.signal });
      const pid = output.processId;
      if (!pid) throw new Error('Captura não confirmou processo ativo. Teste interrompido.');
      let graph = await inspectLinks(pid, device.id);
      for (let attempt = 0; attempt < 2 && ['process-node-missing', 'input-links-missing'].includes(graph.reason); attempt++) {
        await delay(200, undefined, { signal: abort.signal });
        graph = await inspectLinks(pid, device.id);
      }
      if (!graph.selectedMonitorOnly) {
        console.log(JSON.stringify({ captureDiagnostic: graph, receivedFrames: frames }, null, 2));
        throw new Error('Não foi possível comprovar a origem do áudio. Teste interrompido antes do tom. Envie o diagnóstico acima.');
      }
      console.log('Origem verificada: somente portas de monitor da saída selecionada.');
      phase = 'tone'; console.log('2/3 · Reproduzindo tom sintético por 4 segundos.');
      const pcm = new Uint8Array(4 * 32000), view = new DataView(pcm.buffer);
      for (let i = 0; i < 4 * 16000; i++) view.setInt16(i * 2, Math.round(2000 * Math.sin(2 * Math.PI * 440 * i / 16000)), true);
      playback = spawn('pw-play', ['--target', device.id, '-'], { shell: false, stdio: ['pipe', 'ignore', 'ignore'], signal: abort.signal });
      let playError = false;
      playbackClosed = new Promise((resolve) => {
        playback.once('error', () => { playError = true; });
        playback.once('close', (code) => {
          if (playError || code !== 0) { failure ||= 'Não foi possível reproduzir o tom com pw-play.'; abort.abort(); }
          resolve();
        });
      });
      playback.stdin.on('error', () => { /* close reports a sanitized failure */ });
      playback.stdin.end(pcmToWav(pcm));
      // Stop even if the playback utility stalls; never wait indefinitely.
      await Promise.race([playbackClosed, delay(7000, undefined, { signal: abort.signal }).then(() => { throw new Error('Tempo de reprodução excedido.'); })]);
      if (abort.signal.aborted) throw new Error('Teste interrompido.');
      await delay(500, undefined, { signal: abort.signal });
      phase = 'silenceAfter'; console.log('3/3 · Silêncio por 3 segundos.');
      await delay(3000, undefined, { signal: abort.signal });
      await output.stop();
      const finalFrames = frames;
      await delay(300, undefined, { signal: abort.signal });
      const released = frames === finalFrames && output.processId === undefined;
      const { stdout } = await execute('pw-dump', [], { signal: abort.signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      let finalInventory;
      try { finalInventory = JSON.parse(stdout); }
      catch { throw new Error('Não foi possível verificar a liberação no grafo PipeWire.'); }
      const nodesGone = outputProcessReleased(finalInventory, pid);
      const quiet = stats.silenceBefore.peak < 0.003 && stats.silenceAfter.peak < 0.003;
      const signal = stats.tone.frames > 0 && stats.tone.peak >= 0.003;
      console.log(JSON.stringify({ sampleRate: 16000, channels: 1, bits: 16, receivedSeconds: frames / 10,
        peaks: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value.peak.toFixed(5))])),
        selectedMonitorOnly: graph.selectedMonitorOnly, signalDetected: signal, quietBeforeAndAfter: quiet,
        captureReleased: released && nodesGone, audioSaved: false, providerRequestMade: false }, null, 2));
      if (!signal || !quiet || !released || !nodesGone) throw new Error('Verificação inconclusiva. Confira saída, volume/mute e outros sons; não altere o volume global automaticamente.');
      console.log('Teste de sinal e liberação passou. Informe este resultado no chat; não envie áudio.');
    }
  }
} catch (error) {
  console.error(stoppedBySignal ? 'Teste cancelado pelo usuário.' : failure || (error instanceof Error && error.name !== 'AbortError' ? error.message : 'Teste interrompido.'));
  process.exitCode = 1;
} finally {
  terminal?.close(); abort.abort();
  try { await output.stop(); } catch { console.error('Não foi possível confirmar encerramento da captura. Confira pw-record antes de tentar novamente.'); process.exitCode = 1; }
  if (playback && playback.exitCode === null && playback.signalCode === null) {
    playback.kill('SIGTERM');
    let timeout;
    try {
      const closed = await Promise.race([playbackClosed.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1000); })]);
      if (!closed) {
        playback.kill('SIGKILL');
        await Promise.race([playbackClosed, delay(1000)]);
      }
    } finally { clearTimeout(timeout); }
  }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
