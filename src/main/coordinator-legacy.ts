import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { clipboard, dialog, type BrowserWindow } from 'electron';
import { DEFAULT_OPTIONS, assertTransition, parseOptions, parseSources, type AudioFrame, type Phase, type Session, type SourceId, type StartOptions, type SourceOptions, type ViewState } from '../shared/contracts';
import { pcmRms, pcmToWav } from '../shared/audio';
import { systemDevices, LinuxOutput } from './audio/linux';
import { WhisperEngine } from './transcription/whisper';
import { AudioQueue } from './transcription/queue';
import { Segmenter, type AudioChunk } from './transcription/segmenter';
import { SessionStore, sessionText } from './storage';

interface Job extends AudioChunk { source: SourceId; seconds: number; sessionId: string }
export class Coordinator {
  private window: BrowserWindow;
  private runtime: string;
  private store: SessionStore;
  private engine = new WhisperEngine();
  private output = new LinuxOutput();
  private queue: AudioQueue<Job>;
  private segmenters: Record<SourceId, Segmenter>;
  private session: Session | null = null;
  private origin = 0;
  private lastFrameSequence = -1;
  private lastFrameEnd = 0;
  private outputGeneration = 0;
  private finishing = false;
  private disposed = false;
  private lastEmit = 0;
  private operation = false;
  private epoch = 0;
  private watchdog: ReturnType<typeof setInterval>;
  private microphoneCheckTimer: ReturnType<typeof setTimeout> | undefined;
  private state: ViewState = {
    microphoneChecking: false, microphoneCaptureId: null, pendingBytes: { microphone: 0, system: 0 }, audioGapCount: 0,
    phase: 'idle', sessionId: null, message: 'Escolha suas fontes para começar.', pendingSeconds: 0,
    lagSeconds: 0, elapsedMs: 0, options: { ...DEFAULT_OPTIONS }, segments: [], levels: { microphone: 0, system: 0 },
  };
  constructor(window: BrowserWindow, runtime: string, store: SessionStore) {
    this.window = window; this.runtime = runtime; this.store = store;
    this.queue = this.makeQueue(); this.segmenters = this.makeSegmenters();
    this.watchdog = setInterval(() => {
      if (this.state.phase === 'capturing' && !this.engine.running) this.captureError('O Whisper encerrou. Pare e inicie uma nova sessão.');
      if (this.state.phase === 'capturing' && this.elapsed() > 4 * 3600_000) void this.pauseWithMessage('Limite de quatro horas atingido; finalize esta sessão.');
      if (['capturing', 'paused', 'draining'].includes(this.state.phase)) this.emit();
    }, 1000);
  }
  private elapsed(): number { return this.origin ? Math.max(0, performance.now() - this.origin) : 0; }
  private transition(phase: Phase, message: string): void {
    assertTransition(this.state.phase, phase);
    if (phase !== 'capturing') { this.state.microphoneCaptureId = null; this.outputGeneration++; }
    this.state.phase = phase; this.state.message = message;
    if (this.session) this.session.status = phase;
    this.emit(true);
  }
  private emit(force = false): void {
    if (this.disposed || this.window.isDestroyed()) return;
    if (!force && performance.now() - this.lastEmit < 200) return;
    this.lastEmit = performance.now();
    this.state.elapsedMs = this.elapsed();
    this.state.pendingSeconds = this.queue.seconds + this.segmenters.microphone.seconds + this.segmenters.system.seconds;
    this.window.webContents.send('sussurro:state', this.state);
  }
  async getState(): Promise<ViewState> { this.state.elapsedMs = this.elapsed(); return structuredClone(this.state); }
  microphoneAllowed(): boolean { return !this.disposed && (this.state.microphoneChecking || (this.state.phase === 'capturing' && this.state.options.microphone)); }
  async beginMicrophoneCheck(): Promise<void> {
    if (this.disposed || this.operation || !['idle', 'completed', 'error'].includes(this.state.phase)) throw new Error('Finalize a sessão antes de testar o microfone.');
    if (this.state.microphoneChecking) throw new Error('Teste de microfone já está ativo.');
    this.state.microphoneChecking = true;
    this.microphoneCheckTimer = setTimeout(() => { void this.endMicrophoneCheck(); }, 30_000);
    this.emit(true);
  }
  async endMicrophoneCheck(): Promise<void> {
    clearTimeout(this.microphoneCheckTimer); this.microphoneCheckTimer = undefined;
    this.state.microphoneChecking = false; this.emit(true);
  }
  listSystemDevices = systemDevices;
  private makeSegmenters(): Record<SourceId, Segmenter> {
    const make = (source: SourceId) => new Segmenter((chunk) => this.queue.offer({ ...chunk, source, seconds: chunk.pcm.length / 32000, sessionId: this.session!.id }));
    return { microphone: make('microphone'), system: make('system') };
  }
  private makeQueue(): AudioQueue<Job> {
    return new AudioQueue<Job>(async (job) => {
      const epoch = this.epoch;
      const result = await this.engine.transcribe(pcmToWav(job.pcm), this.state.options.language);
      if (this.disposed || epoch !== this.epoch || this.session?.id !== job.sessionId || this.state.phase === 'error') return;
      const text = result.text.trim();
      if (text) {
        if (this.session.segments.length >= 10000) throw new Error('Limite de segmentos atingido. Finalize esta sessão.');
        this.session.segments.push({ id: randomUUID(), source: job.source, startMs: job.startMs, endMs: job.endMs, text });
        this.session.segments.sort((a, b) => a.startMs - b.startMs);
        this.state.segments = this.session.segments.slice(-200);
        await this.store.save(this.session);
      }
      this.state.lagSeconds = Math.max(0, (this.elapsed() - job.endMs) / 1000);
    }, () => queueMicrotask(() => this.queueChanged()), (error) => this.fail(error instanceof Error ? error.message : 'Falha na transcrição.'));
  }
  private queueChanged(): void {
    if (this.disposed || !this.session) return;
    if (this.state.phase === 'capturing' && this.queue.seconds >= 20) void this.pauseWithMessage('Fila ocupada. Captura pausada; aguarde e retome quando houver espaço.');
    if (['paused', 'draining'].includes(this.state.phase)) this.flushBuffers();
    if (this.state.phase === 'draining' && this.queue.idle && !this.segmenters.microphone.seconds && !this.segmenters.system.seconds) void this.complete();
    this.emit(true);
  }
  private flushBuffers(): void { this.segmenters.microphone.flush(); this.segmenters.system.flush(); }
  private accept(source: SourceId, pcm: Uint8Array, startMs: number): void {
    if (this.state.phase !== 'capturing' || !this.state.options[source]) return;
    this.state.levels[source] = pcmRms(pcm);
    if (!this.segmenters[source].push(pcm, startMs)) void this.pauseWithMessage('Limite de áudio atingido. Captura pausada; os trechos aceitos serão preservados.');
    this.emit();
  }
  audio(frame: AudioFrame): void {
    if (this.state.phase !== 'capturing' || frame.sessionId !== this.session?.id || frame.captureId !== this.state.microphoneCaptureId || !this.state.options.microphone) return;
    // Sequence may restart after explicitly restarting the microphone.
    if (frame.sequence <= this.lastFrameSequence || frame.startMs < this.lastFrameEnd - 5 || frame.startMs > this.elapsed() + 1500) return;
    this.lastFrameSequence = frame.sequence; this.lastFrameEnd = frame.startMs + frame.pcm.length / 32;
    this.accept('microphone', frame.pcm, frame.startMs);
  }
  private restartMicrophone(): void {
    this.lastFrameSequence = -1; this.lastFrameEnd = 0;
    this.state.microphoneCaptureId = this.state.phase === 'capturing' && this.state.options.microphone ? randomUUID() : null;
  }
  private async startOutput(): Promise<void> {
    if (this.disposed || this.state.phase !== 'capturing' || !this.state.options.system) return;
    const generation = ++this.outputGeneration;
    const sessionId = this.session?.id;
    let samples = 0, offset: number | undefined;
    const current = () => !this.disposed && generation === this.outputGeneration && sessionId === this.session?.id &&
      this.state.phase === 'capturing' && this.state.options.system;
    await this.output.start(this.state.options.systemId, (pcm) => {
      if (!current()) return;
      // Anchor the first delivered frame, excluding device enumeration/startup time.
      offset ??= Math.max(0, this.elapsed() - pcm.length / 32);
      const startMs = offset + samples / 16;
      samples += pcm.length / 2;
      this.accept('system', pcm, startMs);
    }, (message) => { if (current()) this.captureError(message); });
  }
  async start(options: StartOptions): Promise<ViewState> {
    options = parseOptions(options);
    if (this.state.microphoneChecking) throw new Error('Encerre o teste de microfone antes de iniciar a transcrição.');
    if (this.operation || !['idle', 'completed', 'error'].includes(this.state.phase)) throw new Error('Finalize a sessão atual antes de iniciar outra.');
    this.operation = true;
    try {
      this.epoch++;
      await this.engine.stop(); await this.output.stop();
      this.queue.clear(); this.queue = this.makeQueue(); this.segmenters = this.makeSegmenters();
      this.state.options = { ...options }; this.state.segments = []; this.state.lagSeconds = 0;
      this.session = { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'preparing', options: { ...options }, segments: [] };
      this.state.sessionId = this.session.id; this.origin = 0; this.lastFrameSequence = -1; this.lastFrameEnd = 0;
      this.transition('preparing', 'Carregando Whisper base no computador…');
      await this.engine.start(this.runtime, options.threads);
      if (this.disposed || this.state.phase !== 'preparing') { await this.engine.stop(); return this.getState(); }
      this.origin = performance.now();
      this.state.microphoneCaptureId = options.microphone ? randomUUID() : null;
      this.transition('capturing', 'Capturando. O texto pode chegar com atraso.');
      await this.startOutput(); await this.store.save(this.session);
      return this.getState();
    } catch (error) {
      if (this.disposed || ['draining', 'completed'].includes(this.state.phase)) return this.getState();
      this.fail(error instanceof Error ? error.message : 'Não foi possível iniciar.'); throw error;
    }
    finally { this.operation = false; }
  }
  async pause(): Promise<void> { await this.pauseWithMessage('Captura pausada. Os trechos pendentes continuam sendo transcritos.'); }
  private async pauseWithMessage(message: string): Promise<void> {
    if (this.state.phase !== 'capturing') return;
    this.state.levels = { microphone: 0, system: 0 }; this.transition('paused', message);
    await this.output.stop(); this.flushBuffers(); this.emit(true);
  }
  async resume(): Promise<void> {
    if (this.operation || this.state.phase !== 'paused') throw new Error('A sessão não está pausada.');
    if (!this.engine.running) throw new Error('Whisper indisponível. Pare e inicie uma nova sessão.');
    if (!this.state.options.microphone && !this.state.options.system) throw new Error('Ative pelo menos uma fonte.');
    if (this.queue.seconds > 10 || this.segmenters.microphone.seconds || this.segmenters.system.seconds) throw new Error('Aguarde a fila diminuir antes de retomar.');
    this.operation = true;
    try {
      this.state.microphoneCaptureId = this.state.options.microphone ? randomUUID() : null;
      this.lastFrameSequence = -1; this.lastFrameEnd = 0;
      this.transition('capturing', 'Captura retomada.');
      await this.startOutput();
    } catch (error) { this.captureError(error instanceof Error ? error.message : 'Falha ao retomar a captura.'); throw error; }
    finally { this.operation = false; }
  }
  async setSources(sources: SourceOptions): Promise<void> {
    sources = parseSources(sources);
    if (this.disposed || this.operation || !['capturing', 'paused'].includes(this.state.phase)) throw new Error('Aguarde a operação atual ou inicie uma sessão de captura.');
    const old = this.state.options;
    const next = { ...old, ...sources };
    if (next.system && !next.systemId) throw new Error('Selecione uma saída de áudio do computador.');
    const microphoneChanged = old.microphone !== next.microphone || old.microphoneId !== next.microphoneId;
    const systemChanged = old.system !== next.system || old.systemId !== next.systemId;
    this.operation = true;
    try {
      this.state.options = next;
      if (this.session) this.session.options = { ...next };
      if (microphoneChanged) {
        this.state.levels.microphone = 0;
        if (!this.segmenters.microphone.flush()) this.captureError('Aguarde a fila diminuir antes de retomar a captura.');
        this.restartMicrophone();
      }
      if (systemChanged) { this.outputGeneration++; this.state.levels.system = 0; }
      // Publish revocation before awaiting process shutdown; the other source continues.
      this.emit(true);
      if (systemChanged) {
        await this.output.stop();
        if (!this.segmenters.system.flush()) this.captureError('Aguarde a fila diminuir antes de retomar a captura.');
      }
      if (!next.microphone && !next.system) await this.pauseWithMessage('As duas fontes estão desativadas. Ative uma fonte e retome.');
      else if (systemChanged) await this.startOutput();
      if (this.session) await this.store.save(this.session);
      this.emit(true);
    } catch (error) {
      this.captureError(error instanceof Error ? error.message : 'Falha ao alterar a fonte de áudio.');
      throw error;
    } finally { this.operation = false; }
  }
  async stop(cancel: boolean): Promise<void> {
    if (this.state.phase === 'completed' || this.state.phase === 'idle') return;
    if (this.state.phase !== 'draining') this.transition('draining', cancel ? 'Cancelando áudio pendente…' : 'Finalizando trechos pendentes…');
    this.state.levels = { microphone: 0, system: 0 }; this.emit(true);
    await this.output.stop();
    if (cancel) { this.epoch++; this.queue.clear(); this.segmenters.microphone.clear(); this.segmenters.system.clear(); await this.engine.stop(); }
    else this.flushBuffers();
    if (cancel || this.queue.idle) await this.complete();
    this.emit(true);
  }
  private async complete(): Promise<void> {
    if (this.finishing || this.state.phase !== 'draining') return;
    this.finishing = true;
    try {
      await this.engine.stop();
      this.transition('completed', 'Sessão finalizada e salva neste computador.');
      if (this.session) await this.store.save(this.session);
    } catch (error) { this.fail(String(error)); }
    finally { this.finishing = false; }
  }
  captureError(message: string, captureId?: string): void {
    if (captureId !== undefined && captureId !== this.state.microphoneCaptureId) return;
    void this.pauseWithMessage(message).catch(() => this.fail('Não foi possível liberar a captura. Feche o aplicativo.'));
  }
  private fail(message: string): void {
    if (this.disposed) return;
    this.epoch++; this.outputGeneration++; this.state.microphoneCaptureId = null; this.state.phase = 'error'; this.state.message = message; this.state.levels = { microphone: 0, system: 0 };
    this.queue.clear(); this.segmenters.microphone.clear(); this.segmenters.system.clear();
    void this.output.stop(); void this.engine.stop();
    if (this.session) { this.session.status = 'error'; void this.store.save(this.session).catch(() => {}); }
    this.emit(true);
  }
  listSessions = () => this.store.list();
  readSession = (id: string) => this.store.read(id);
  async deleteSession(id: string): Promise<void> {
    if (id === this.session?.id && !['completed', 'error'].includes(this.state.phase)) throw new Error('Finalize a sessão antes de excluí-la.');
    await this.store.delete(id);
  }
  async exportSession(id: string): Promise<boolean> {
    const session = await this.store.read(id);
    const result = await dialog.showSaveDialog(this.window, { defaultPath: `sussurro-${session.createdAt.slice(0, 10)}.txt`, filters: [{ name: 'Texto', extensions: ['txt'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, sessionText(session), { mode: 0o600 }); return true;
  }
  async copySession(id: string): Promise<void> {
    clipboard.writeText(sessionText(this.session?.id === id ? this.session : await this.store.read(id)));
  }
  async dispose(): Promise<void> {
    await this.endMicrophoneCheck();
    this.disposed = true; this.epoch++; this.outputGeneration++; this.state.microphoneCaptureId = null; clearInterval(this.watchdog); this.queue.clear();
    await this.output.stop(); await this.engine.stop();
    if (this.session && !['completed', 'error'].includes(this.session.status)) { this.session.status = 'error'; await this.store.save(this.session).catch(() => {}); }
    await this.store.flush().catch(() => {});
  }
}
