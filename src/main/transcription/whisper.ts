import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';

export const BASE_HASH = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export async function validateWhisper(directory: string): Promise<void> {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const binary = path.join(directory, 'bin/whisper-server');
    await access(binary, constants.X_OK);
    if (manifest.version !== '1.8.2' || manifest.modelSha256 !== BASE_HASH ||
        await hashFile(path.join(directory, 'models/ggml-base.bin')) !== BASE_HASH ||
        await hashFile(binary) !== manifest.binarySha256) throw new Error('Integridade inválida.');
  } catch {
    throw new Error('Whisper ou modelo base ausente/corrompido. Execute a preparação do runtime e confira os arquivos.');
  }
}

export interface WhisperResult {
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  language?: string;
  task?: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WhisperEngine {
  private child: ChildProcess | null = null;
  private endpoint = '';
  private token = '';
  private busy = false;
  private stopping = false;
  private activeRequest: AbortController | null = null;

  get running(): boolean { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null; }

  async start(directory: string, threads: 1 | 2 = 1): Promise<void> {
    if (this.child) throw new Error('O Whisper já foi iniciado.');
    if (threads !== 1 && threads !== 2) throw new Error('Perfil de CPU inválido.');
    await validateWhisper(directory);
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createServer();
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', () => {
        const address = socket.address();
        const value = typeof address === 'object' && address ? address.port : 0;
        socket.close((error) => error ? reject(error) : resolve(value));
      });
    });
    this.stopping = false;
    this.token = randomBytes(32).toString('hex');
    this.endpoint = `http://127.0.0.1:${port}`;
    const child = spawn('nice', ['-n', '15', path.join(directory, 'bin/whisper-server'),
      '--host', '127.0.0.1', '--port', String(port), '-m', path.join(directory, 'models/ggml-base.bin'),
      '-t', String(threads), '-p', '1', '-ng', '-bs', '1', '-bo', '1', '-l', 'auto'], {
      shell: false, stdio: 'ignore', env: { ...process.env, SUSSURRO_WHISPER_TOKEN: this.token },
    });
    this.child = child;
    let launchFailed = false;
    child.once('error', () => { launchFailed = true; });
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (this.stopping || launchFailed || !this.running) throw new Error('O processo Whisper não iniciou ou encerrou.');
        try {
          const response = await fetch(`${this.endpoint}/health`, {
            headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(500),
          });
          const data = await response.json() as { status?: string };
          if (response.ok && data.status === 'ok') return;
        } catch { /* Readiness is separate from process creation. */ }
        await delay(100);
      }
      throw new Error('Tempo esgotado ao carregar o modelo Whisper.');
    } catch (error) { await this.stop(); throw error; }
  }

  async transcribe(wav: Uint8Array, language = 'auto', signal?: AbortSignal): Promise<WhisperResult> {
    if (!this.running || this.stopping) throw new Error('O Whisper não está pronto.');
    if (this.busy) throw new Error('Já há uma transcrição em andamento.');
    if (!['auto', 'pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh'].includes(language)) throw new Error('Idioma inválido.');
    if (wav.byteLength < 44 || wav.byteLength > 2_000_000) throw new Error('Trecho de áudio fora do limite.');
    this.busy = true;
    const controller = new AbortController();
    this.activeRequest = controller;
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    try {
      const body = new FormData();
      body.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav');
      body.set('response_format', 'verbose_json');
      body.set('language', language);
      body.set('translate', 'false');
      body.set('temperature', '0');
      body.set('temperature_inc', '0');
      const response = await fetch(`${this.endpoint}/inference`, {
        method: 'POST', body, headers: { Authorization: `Bearer ${this.token}` }, signal: combined,
      });
      if (!response.ok) throw new Error(`Whisper retornou erro HTTP ${response.status}.`);
      const data = await response.json() as WhisperResult;
      if (typeof data.text !== 'string' || data.task === 'translate') throw new Error('Resposta inválida do Whisper.');
      return data;
    } catch (error) {
      if (combined.aborted) throw new Error('Transcrição cancelada ou tempo limite excedido.');
      throw error;
    } finally { this.busy = false; this.activeRequest = null; }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.activeRequest?.abort();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 3000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        const killDeadline = Date.now() + 2000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < killDeadline) await delay(50);
      }
    }
    this.child = null;
    this.endpoint = '';
    this.token = '';
  }
}
