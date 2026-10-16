import { open } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DeepgramCredentials } from '../config/deepgram';
import { deepgramFactory } from '../transcription/deepgram';
import { StreamingAudio, finishStream, openStream, type StreamTransport } from '../transcription/stream';

/** Diagnostic input only: bounded RIFF PCM. Does not generalize the application's capture API. */
export function parseDiagnosticWav(data: Buffer): Uint8Array {
  if (data.length > 1_000_000 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE' || data.readUInt32LE(4) + 8 !== data.length) throw new Error('WAV inválido.');
  let format = false, audio: Uint8Array | undefined;
  for (let at = 12; at < data.length;) {
    if (at + 8 > data.length) throw new Error('WAV truncado.');
    const size = data.readUInt32LE(at + 4), start = at + 8, end = start + size;
    if (end > data.length) throw new Error('WAV truncado.');
    const type = data.toString('ascii', at, at + 4);
    if (type === 'fmt ') {
      if (format || size < 16 || data.readUInt16LE(start) !== 1 || data.readUInt16LE(start + 2) !== 1 || data.readUInt32LE(start + 4) !== 16000 || data.readUInt32LE(start + 8) !== 32000 || data.readUInt16LE(start + 12) !== 2 || data.readUInt16LE(start + 14) !== 16) throw new Error('Use PCM mono 16 kHz/16 bits.');
      format = true;
    } else if (type === 'data') {
      if (audio || size < 2 || size % 2 || size > 30 * 32000) throw new Error('Duração/formato inválido.');
      audio = data.subarray(start, end);
    }
    at = end + (size % 2);
    if (at > data.length) throw new Error('WAV truncado.');
  }
  if (!format || !audio) throw new Error('WAV incompleto.');
  return audio;
}
export function parseDiagnosticArgs(args: string[]): { file: string; language: string } {
  let file: string | undefined, language: string | undefined, confirmed = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--confirm-public-audio' && !confirmed) confirmed = true;
    else if (arg === '--wav' && file === undefined) file = args[++index];
    else if (arg === '--language' && language === undefined) language = args[++index];
    else throw new Error('Argumentos inválidos.');
  }
  if (!confirmed || !file || file.startsWith('--') || !['pt-BR', 'en'].includes(language ?? '')) throw new Error('Informe WAV público, idioma e confirmação de envio.');
  return { file, language: language! };
}
export async function runDeepgramCheck(args: string[], project: string, environmentKey?: string): Promise<void> {
  const { file, language } = parseDiagnosticArgs(args);
  const handle = await open(file, 'r');
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error('WAV grande/inválido.');
    data = Buffer.alloc(1_000_001);
    let used = 0;
    while (used < data.length) {
      const { bytesRead } = await handle.read(data, used, data.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    data = data.subarray(0, used);
  } finally { await handle.close(); }
  const pcm = parseDiagnosticWav(data);
  // Network prerequisite before reading the configured credential or attempting a paid request.
  try { await lookup('api.deepgram.com'); }
  catch {
    console.log(JSON.stringify({ passed: false, language, reason: 'dns-unavailable', providerRequestMade: false, audioCaptured: false }));
    process.exitCode = 1; return;
  }
  const credentials = new DeepgramCredentials(), controller = new AbortController();
  let transport: StreamTransport | undefined, failure = false;
  let partials = 0, finals = 0, firstPartialMs: number | null = null, firstFinalMs: number | null = null, finalLagMs: number | null = null;
  let peakPendingBytes = 0, began = 0;
  let stage = 'credentials', providerConnectionAttempted = false;
  const stream = new StreamingAudio(() => { failure = true; controller.abort(); });
  const stop = () => { failure = true; controller.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadline = setTimeout(stop, 45000);
  try {
    await credentials.load({ appPath: project, isPackaged: false, env: environmentKey === undefined ? {} : { DEEPGRAM_API_KEY: environmentKey } });
    if (!credentials.configured) throw new Error();
    stage = 'connection'; providerConnectionAttempted = true;
    transport = await openStream(deepgramFactory(credentials), 'system', {
      sessionId: randomUUID(), language, signal: controller.signal,
      onPartial: (value) => { if (value?.text.trim()) { partials++; firstPartialMs ??= Math.round(performance.now() - began); } },
      onFinal: (value) => { if (value.text.trim()) { finals++; firstFinalMs ??= Math.round(performance.now() - began); finalLagMs = Math.max(0, Math.round(performance.now() - began - value.endMs)); } },
      onFailure: () => { failure = true; controller.abort(); },
    });
    stream.attach('system', transport); began = performance.now(); stage = 'stream';
    for (let at = 0; at < pcm.length; at += 3200) {
      if (failure || controller.signal.aborted) throw new Error();
      // Pace in wall time. If the host falls behind, stop instead of sending a burst.
      const startMs = at / 32, wait = began + startMs - performance.now();
      if (wait > 0) await delay(wait, undefined, { signal: controller.signal });
      if (performance.now() - began - startMs > 500) throw new Error();
      const frame = pcm.subarray(at, Math.min(at + 3200, pcm.length));
      if (!stream.offer('system', { pcm: frame, startMs, endMs: startMs + frame.length / 32 })) throw new Error();
      peakPendingBytes = Math.max(peakPendingBytes, stream.pendingBytes.system);
    }
    const remaining = began + pcm.length / 32 - performance.now();
    if (remaining > 0) await delay(remaining, undefined, { signal: controller.signal });
    stage = 'finish'; stream.detach('system');
    const closed = await finishStream(transport, controller.signal);
    const passed = closed && !failure && finals > 0;
    console.log(JSON.stringify({ passed, language, audioSeconds: pcm.length / 32000, partials, finals, firstPartialMs, firstFinalMs, finalLagMs,
      peakPendingBytes, closeConfirmed: closed, providerConnectionAttempted, audioCaptured: false, audioSaved: false, transcriptLogged: false,
      scope: 'real-adapter-only; quality, capture and key popup require application validation' }, null, 2));
    if (!passed) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ passed: false, language, stage, providerConnectionAttempted, audioCaptured: false, audioSaved: false, transcriptLogged: false }));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline); controller.abort(); stream.abort(); transport?.abort(); credentials.clear();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
