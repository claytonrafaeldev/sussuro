import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clipboard, dialog, type BrowserWindow } from 'electron';
import { DEFAULT_OPTIONS, assertTransition, parseOptions, parseSources, type AudioFrame, type Phase, type Session, type SourceId, type StartOptions, type SourceOptions, type ViewState } from '../shared/contracts';
import { pcmRms } from '../shared/audio';
import { systemDevices, LinuxOutput } from './audio/linux';
import { StreamingAudio, openStream, finishStream, unavailableStream, type StreamFactory, type StreamContext, type StreamTransport } from './transcription/stream';
import { DeepgramError, providerMessage } from './transcription/deepgram';
import type { CredentialStore } from './config/credential-store';
import { StreamMetrics } from './performance/stream-metrics';
import { Measurement } from './performance/measurement';
import type { ResourceReader } from './performance/resources';
import { parseMeasurementScenario, type MeasurementScenario, type ResourceSnapshot } from '../shared/performance';
import { cpus, totalmem } from 'node:os';
import { SessionStore, sessionText } from './storage';

export class Coordinator {
  private readonly stateListeners = new Set<(state: ViewState) => void>();
  subscribeState(listener: (state: ViewState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }
  private window: BrowserWindow;
  private store: SessionStore;
  private output = new LinuxOutput();
  private stream: StreamingAudio;
  private metrics = new StreamMetrics();
  private measurement = new Measurement();
  private resources: ResourceSnapshot | null = null;
  private lastResourceSample = -Infinity;
  private samplingResources = false;
  private exportingMeasurement = false;
  private factory: StreamFactory;
  private connections = new Map<SourceId, AbortController>();
  private closing = new Set<AbortController>();
  private drainingTransports = new Map<SourceId, StreamTransport>();
  private stopping: Promise<void> | null = null;
  private finalIds = new Set<string>();
  private session: Session | null = null;
  private destination: string | null = null;
  private origin = 0;
  private lastFrameSequence = -1;
  private lastFrameEnd = 0;
  private outputGeneration = 0;
  private disposed = false;
  private rendererPresent = true;
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
  constructor(window: BrowserWindow, store: SessionStore, factory: StreamFactory = unavailableStream, private readonly credentials?: CredentialStore, private readonly resourceReader?: ResourceReader) {
    this.window = window; this.store = store; this.factory = factory;
    this.stream = this.makeStream();
    this.watchdog = setInterval(() => {
      if (!this.samplingResources && performance.now() - this.lastResourceSample >= 1000) void this.sampleResources();
      if (this.state.phase === 'capturing') this.stream.check();
      if (this.state.phase === 'capturing' && this.elapsed() > 4 * 3600_000) this.captureError('Limite de quatro horas atingido; finalize esta sessão.');
      if (['capturing', 'paused', 'draining'].includes(this.state.phase)) this.emit();
    }, 100);
  }
  private async sampleResources(): Promise<void> {
    this.samplingResources = true; this.lastResourceSample = performance.now();
    try {
      this.resources = this.resourceReader ? await this.resourceReader.sample(this.output.processId) : null;
    } catch { this.resources = null; }
    finally { this.samplingResources = false; }
    if (this.disposed) return;
    this.updatePending();
    this.measurement.record({ atMs: 0, sessionElapsedMs: this.elapsed(), phase: this.state.phase,
      enabled: { microphone: this.state.options.microphone, system: this.state.options.system },
      pendingBytes: { ...this.state.pendingBytes }, peakTotalPendingBytes: this.metrics.peakTotalPendingBytes, audioGapCount: this.state.audioGapCount,
      sources: this.metrics.snapshot(), resources: this.resources });
    this.emit(true);
  }
  async beginMeasurement(scenario: MeasurementScenario): Promise<void> {
    if (this.disposed || this.exportingMeasurement) throw new Error('Medição indisponível neste momento.');
    this.measurement.begin(parseMeasurementScenario(scenario)); this.emit(true);
  }
  async endMeasurement(): Promise<void> { this.measurement.end(); this.emit(true); }
  async exportMeasurement(): Promise<boolean> {
    if (this.disposed || this.exportingMeasurement || this.measurement.status().active || !this.measurement.status().samples) throw new Error('Encerre uma medição com amostras antes de exportar.');
    this.exportingMeasurement = true;
    try {
      const report = { ...this.measurement.report(), recordedAt: new Date().toISOString(),
        environment: { platform: process.platform, arch: process.arch, logicalCpus: cpus().length, totalMemoryMiB: totalmem() / 1048576,
          electronVersion: process.versions.electron ?? null, nodeVersion: process.versions.node },
        privacy: { audioIncluded: false, transcriptIncluded: false, keyIncluded: false },
        methodology: 'Linux owned PIDs from Electron plus pw-record; CPU 100% = one core; RSS sum includes shared pages; timestamps measured at main arrival, not network-only latency.' };
      const result = await dialog.showSaveDialog(this.window, { defaultPath: `sussurro-desempenho-${report.scenario}.json`, filters: [{ name: 'Métricas JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      return true;
    } catch { throw new Error('Não foi possível exportar a medição. Confira a pasta escolhida.'); }
    finally { this.exportingMeasurement = false; }
  }
  private credentialChangeAllowed(): void {
    if (this.disposed || this.operation || !['idle', 'completed', 'error'].includes(this.state.phase)) throw new Error('Finalize a sessão antes de alterar a chave.');
  }
  async getCredentialStatus() {
    if (!this.credentials) throw new Error('Configuração de chave indisponível.');
    return this.credentials.status();
  }
  async configureCredential(value: { key: string; persist: boolean }) {
    this.credentialChangeAllowed(); this.operation = true;
    try { if (!this.credentials) throw new Error('Configuração de chave indisponível.'); return await this.credentials.configure(value); }
    finally { this.operation = false; }
  }
  async removeCredential() {
    this.credentialChangeAllowed(); this.operation = true;
    try { if (!this.credentials) throw new Error('Configuração de chave indisponível.'); return await this.credentials.remove(); }
    finally { this.operation = false; }
  }
  private async saveSession(): Promise<void> {
    if (!this.session || this.session.options.persistence === 'temporary') return;
    try { await this.store.save(this.session, this.destination); }
    catch { throw new Error('Não foi possível salvar automaticamente. O texto continua disponível; confira a pasta e copie ou exporte antes de fechar.'); }
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
    this.updatePending();
    for (const listener of this.stateListeners) {
      try { listener(this.state); } catch { /* Optional UI cannot interrupt the audio lifecycle. */ }
    }
    if (this.rendererPresent) this.window.webContents.send('sussurro:state', this.state);
  }
  async getState(): Promise<ViewState> { this.updatePending(); this.state.elapsedMs = this.elapsed(); return structuredClone(this.state); }
  microphoneAllowed(): boolean { return !this.disposed && this.rendererPresent && (this.state.microphoneChecking || (this.state.phase === 'capturing' && this.state.options.microphone && !!this.state.microphoneCaptureId)); }
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
  rendererReady(): void { if (!this.disposed) { this.rendererPresent = true; this.emit(true); } }
  rendererUnavailable(): void {
    if (this.disposed || !this.rendererPresent) return;
    this.rendererPresent = false;
    void this.endMicrophoneCheck();
    const message = 'Janela recarregada ou indisponível. Captura interrompida; confira as fontes e retome explicitamente.';
    if (this.state.phase === 'capturing') { this.state.audioGapCount++; this.captureError(message); }
    else if (this.state.phase === 'preparing') this.fail(message);
    else if (this.state.phase === 'draining') void this.stop(true).catch(() => this.fail('Não foi possível salvar ao interromper a janela. Copie ou exporte antes de fechar.'));
    else if (this.state.phase === 'paused') {
      this.epoch++; this.releaseStreams(); this.state.partials = {}; this.state.message = message;
      void this.output.stop().then(() => this.saveSession()).catch(() => this.fail('Não foi possível salvar ao interromper a janela. Copie ou exporte antes de fechar.'));
    }
  }
  listSystemDevices = systemDevices;
  private updatePending(): void {
    try {
      this.state.pendingBytes = this.stream.pendingBytes;
      for (const [source, transport] of this.drainingTransports) {
        const bytes = transport.bufferedBytes;
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error();
        this.state.pendingBytes[source] += bytes;
      }
    }
    catch { this.state.pendingBytes = { microphone: 0, system: 0 }; }
    if (this.session) this.session.audioGapCount = this.state.audioGapCount;
    this.state.pendingSeconds = (this.state.pendingBytes.microphone + this.state.pendingBytes.system) / 32000;
    this.metrics.pending(this.state.pendingBytes);
    this.state.performance = { sources: this.metrics.snapshot(), resources: this.resources,
      peakTotalPendingBytes: this.metrics.peakTotalPendingBytes, measurement: this.measurement.status() };
  }
  private makeStream(): StreamingAudio {
    return new StreamingAudio((reason) => {
      this.state.audioGapCount++;
      this.captureError(reason === 'limit' ? 'Transporte lento: captura pausada antes de exceder o limite. Há uma lacuna de áudio; retome explicitamente.' :
        'Fluxo interrompido: captura pausada. Há uma lacuna de áudio; confira a conexão e retome explicitamente.');
    });
  }
  private async connect(source: SourceId): Promise<void> {
    if (this.disposed || !['preparing', 'capturing', 'paused'].includes(this.state.phase)) return;
    const metrics = this.metrics; metrics.begin(source);
    const epoch = this.epoch, sessionId = this.session!.id;
    const phase = this.state.phase;
    const controller = new AbortController(); this.connections.set(source, controller);
    const context: StreamContext = {
      sessionId, language: this.state.options.language, signal: controller.signal,
      onPartial: (result) => {
        if (controller.signal.aborted || epoch !== this.epoch || this.disposed || this.session?.id !== sessionId) return;
        this.state.partials ??= {};
        if (result) { this.state.partials[source] = result; if (result.text.trim()) this.metrics.result(source, 'partial', result.endMs, this.elapsed()); } else delete this.state.partials[source];
        this.emit(true);
      },
      onFailure: (fault) => { if (!controller.signal.aborted && epoch === this.epoch) {
        this.metrics.end(source, 'failed');
        this.state.audioGapCount++;
        if (this.state.phase === 'preparing') this.fail(providerMessage(fault));
        else if (this.state.phase === 'capturing') this.captureError(`${providerMessage(fault)} Há uma lacuna de áudio.`);
        else controller.abort();
      } },
      onFinal: (result) => {
        if (controller.signal.aborted || epoch !== this.epoch || this.disposed || this.session?.id !== sessionId) return;
        const key = `${source}:${connectionId}:${result.id}`;
        if (this.finalIds.has(key)) return;
        if (!result.id || result.id.length > 200 || typeof result.text !== 'string' || result.text.length > 32000 ||
            !Number.isFinite(result.startMs) || !Number.isFinite(result.endMs) || result.startMs < 0 || result.endMs < result.startMs ||
            this.session.segments.length >= 10000) { this.captureError('Resultado de transcrição inválido.'); return; }
        if (!result.text.trim()) return;
        this.metrics.result(source, 'final', result.endMs, this.elapsed());
        this.finalIds.add(key);
        this.session.segments.push({ id: randomUUID(), source, startMs: result.startMs, endMs: result.endMs, text: result.text.trim() });
        this.session.segments.sort((a, b) => a.startMs - b.startMs);
        this.state.segments = this.session.segments.slice(-200);
        this.state.lagSeconds = Math.max(0, (this.elapsed() - result.endMs) / 1000);
        void this.saveSession().catch(() => { if (epoch === this.epoch && this.session?.id === sessionId) this.fail('Falha no salvamento automático. Confira a pasta; copie ou exporte o texto antes de fechar.'); });
        this.emit(true);
      },
    };
    const connectionId = randomUUID();
    let transport;
    try { transport = await openStream(this.factory, source, context); }
    catch (error) {
      metrics.end(source, 'failed');
      controller.abort();
      if (epoch !== this.epoch || this.disposed || this.state.phase !== phase) return;
      throw this.factory === unavailableStream || error instanceof DeepgramError || (error instanceof Error && error.message.startsWith('Configure DEEPGRAM_API_KEY')) ? error : new Error('Não foi possível abrir a conexão de transcrição. Confira a rede e tente novamente.');
    }
    if (controller.signal.aborted || epoch !== this.epoch || this.disposed || this.state.phase !== phase) { transport.abort(); return; }
    if (!transport.ready) { controller.abort(); transport.abort(); throw new Error('O transporte não está conectado.'); }
    this.stream.attach(source, transport); metrics.connected(source);
  }
  private releaseSource(source: SourceId): void {
    this.metrics.end(source);
    if (this.state.partials) delete this.state.partials[source];
    const transport = this.stream.detach(source);
    this.connections.get(source)?.abort(); this.connections.delete(source);
    if (transport) {
      try {
        if (transport.bufferedBytes > 0) { this.state.audioGapCount++; this.state.message += ' Áudio pendente foi interrompido; há uma lacuna.'; }
      } catch { this.state.audioGapCount++; }
      finally { try { transport.abort(); } catch { this.state.audioGapCount++; } }
    }
  }
  private releaseStreams(): void {
    for (const source of ['microphone', 'system'] as const) this.releaseSource(source);
    this.stream.abort();
    for (const controller of this.closing) controller.abort();
    this.closing.clear();
    for (const transport of this.drainingTransports.values()) { try { transport.abort(); } catch { /* Continue release. */ } }
    this.drainingTransports.clear();
  }
  private accept(source: SourceId, pcm: Uint8Array, startMs: number): boolean {
    if (this.state.phase !== 'capturing' || !this.state.options[source]) return false;
    this.state.levels[source] = pcmRms(pcm);
    this.updatePending();
    const accepted = this.stream.offer(source, { pcm, startMs, endMs: startMs + pcm.length / 32 });
    if (accepted) this.metrics.sent(source, pcm.length / 32);
    this.updatePending();
    this.emit(); return accepted;
  }
  audio(frame: AudioFrame): boolean {
    if (this.state.phase !== 'capturing' || frame.sessionId !== this.session?.id || frame.captureId !== this.state.microphoneCaptureId || !this.state.options.microphone) return false;
    // Sequence may restart after explicitly restarting the microphone.
    if (frame.sequence <= this.lastFrameSequence || frame.startMs < this.lastFrameEnd - 5 || frame.startMs > this.elapsed() + 1500) return false;
    if (frame.sequence !== this.lastFrameSequence + 1) {
      this.state.audioGapCount++; this.captureError('Quadros do microfone interrompidos. Há uma lacuna; retome a captura.'); return false;
    }
    this.lastFrameSequence = frame.sequence; this.lastFrameEnd = frame.startMs + frame.pcm.length / 32;
    return this.accept('microphone', frame.pcm, frame.startMs);
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
    if (this.disposed || !this.rendererPresent) throw new Error('Janela indisponível para iniciar captura.');
    options = parseOptions(options);
    if (this.state.microphoneChecking) throw new Error('Encerre o teste de microfone antes de iniciar a transcrição.');
    if (this.operation || !['idle', 'completed', 'error'].includes(this.state.phase)) throw new Error('Finalize a sessão atual antes de iniciar outra.');
    this.operation = true;
    try {
      let destination: string | null = null;
      if (options.persistence !== 'temporary') {
        const result = await dialog.showSaveDialog(this.window, {
          title: 'Onde salvar a transcrição?', buttonLabel: 'Salvar e iniciar',
          defaultPath: `sussurro-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
          filters: [{ name: 'Transcrição em texto', extensions: ['txt'] }], properties: ['showOverwriteConfirmation'],
        });
        if (result.canceled || !result.filePath || this.disposed) return this.getState();
        if (!path.isAbsolute(result.filePath)) throw new Error('Escolha um caminho absoluto para salvar.');
        destination = result.filePath;
      }
      if (this.disposed) return this.getState();
      this.epoch++;
      this.releaseStreams(); await this.output.stop();
      this.stream = this.makeStream(); this.metrics = new StreamMetrics(); this.finalIds.clear(); this.state.audioGapCount = 0;
      this.destination = destination; this.state.savePath = destination;
      this.state.options = { ...options }; this.state.segments = []; this.state.partials = {}; this.state.lagSeconds = 0;
      this.session = { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'preparing', options: { ...options }, segments: [] };
      this.state.sessionId = this.session.id; this.origin = 0; this.lastFrameSequence = -1; this.lastFrameEnd = 0;
      this.transition('preparing', 'Preparando conexões de transcrição…');
      await this.saveSession();
      for (const source of ['microphone', 'system'] as const) {
        if (options[source]) await this.connect(source);
        if (this.disposed || this.state.phase !== 'preparing') return this.getState();
      }
      this.origin = performance.now();
      this.state.microphoneCaptureId = options.microphone ? randomUUID() : null;
      this.transition('capturing', 'Capturando. O texto pode chegar com atraso.');
      await this.startOutput(); await this.saveSession();
      return this.getState();
    } catch (error) {
      if (this.disposed || ['draining', 'completed'].includes(this.state.phase)) return this.getState();
      this.fail(error instanceof Error ? error.message : 'Não foi possível iniciar.'); throw error;
    }
    finally { this.operation = false; }
  }
  async pause(): Promise<void> { await this.pauseWithMessage('Captura pausada. Retome para abrir novos fluxos; áudio interrompido não será reenviado.'); }
  private async pauseWithMessage(message: string): Promise<void> {
    if (this.state.phase !== 'capturing') return;
    this.state.levels = { microphone: 0, system: 0 }; this.transition('paused', message);
    this.releaseStreams(); await this.output.stop(); await this.saveSession(); this.emit(true);
  }
  async resume(): Promise<void> {
    if (this.disposed || !this.rendererPresent || this.operation || this.state.phase !== 'paused') throw new Error('A sessão não está pausada.');
    if (!this.state.options.microphone && !this.state.options.system) throw new Error('Ative pelo menos uma fonte.');
    this.operation = true;
    const epoch = this.epoch;
    try {
      this.stream = this.makeStream();
      for (const source of ['microphone', 'system'] as const) {
        if (this.state.options[source]) await this.connect(source);
        if (this.disposed || epoch !== this.epoch || this.state.phase !== 'paused') return;
      }
      this.state.microphoneCaptureId = this.state.options.microphone ? randomUUID() : null;
      this.lastFrameSequence = -1; this.lastFrameEnd = 0;
      this.transition('capturing', 'Captura retomada.');
      await this.startOutput();
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return;
      const message = error instanceof DeepgramError ? providerMessage(error.fault) : 'Não foi possível retomar. Confira a conexão e as fontes antes de tentar novamente.';
      if ((this.state.phase as Phase) === 'capturing') { this.state.audioGapCount++; await this.pauseWithMessage(message); }
      else { this.releaseStreams(); await this.output.stop(); this.state.message = message; this.emit(true); }
      throw new Error(message);
    }
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
        this.releaseSource('microphone');
        this.state.microphoneCaptureId = null;
      }
      if (systemChanged) { this.outputGeneration++; this.state.levels.system = 0; this.releaseSource('system'); }
      // Publish revocation before awaiting process shutdown; the other source continues.
      this.emit(true);
      if (systemChanged) {
        await this.output.stop();
      }
      if (!next.microphone && !next.system) await this.pauseWithMessage('As duas fontes estão desativadas. Ative uma fonte e retome.');
      else if (this.state.phase === 'capturing') {
        if (microphoneChanged && next.microphone) {
          await this.connect('microphone');
          if (this.state.phase === 'capturing') { this.restartMicrophone(); this.emit(true); }
        }
        if (systemChanged && next.system && this.state.phase === 'capturing') await this.connect('system');
        if (systemChanged) await this.startOutput();
      }
      if (this.session) { this.updatePending(); await this.saveSession(); }
      this.emit(true);
    } catch (error) {
      this.captureError(error instanceof Error ? error.message : 'Falha ao alterar a fonte de áudio.');
      throw error;
    } finally { this.operation = false; }
  }
  async stop(cancel: boolean): Promise<void> {
    if (this.stopping && !cancel) return this.stopping;
    const task = this.finishSession(cancel);
    this.stopping = task;
    try { await task; } finally { if (this.stopping === task) this.stopping = null; }
  }
  private async finishSession(cancel: boolean): Promise<void> {
    if (this.state.phase === 'completed' || this.state.phase === 'idle') return;
    const epoch = cancel ? ++this.epoch : this.epoch;
    if (this.state.phase !== 'draining') this.transition('draining', cancel ? 'Cancelando áudio pendente…' : 'Finalizando trechos pendentes…');
    this.state.levels = { microphone: 0, system: 0 }; this.emit(true);
    // Cancel openings even when no transport has been attached yet.
    for (const [source, controller] of this.connections) if (!this.stream.has(source) || cancel) controller.abort();
    if (cancel) this.releaseStreams();
    await this.output.stop();
    if (this.disposed || epoch !== this.epoch) return;
    if (!cancel) {
      const tasks: Promise<boolean>[] = [];
      for (const source of ['microphone', 'system'] as const) {
        const transport = this.stream.detach(source);
        if (transport) {
          const metrics = this.metrics; metrics.end(source, 'closing');
          this.drainingTransports.set(source, transport);
          const controller = new AbortController(); this.closing.add(controller);
          const task = finishStream(transport, controller.signal).then((ok) => { metrics.end(source, ok ? 'closed' : 'failed'); return ok; }).finally(() => { this.closing.delete(controller); if (this.drainingTransports.get(source) === transport) this.drainingTransports.delete(source); });
          tasks.push(task);
        }
      }
      const results = await Promise.all(tasks);
      if (this.disposed || epoch !== this.epoch) return;
      if (results.some((ok) => !ok)) { this.state.audioGapCount++; this.state.message = 'Prazo de finalização esgotado; pode haver uma lacuna no fim.'; }
      this.releaseStreams();
    }
    if (this.disposed || this.state.phase !== 'draining') return;
    this.state.partials = {};
    if (this.session) {
      this.session.status = 'completed'; this.updatePending();
      try { await this.saveSession(); }
      catch (error) { this.fail('Falha no salvamento automático. Copie ou exporte o texto antes de fechar.'); throw error; }
    }
    this.transition('completed', this.state.options.persistence === 'temporary' ? 'Transcrição finalizada sem histórico; texto disponível até iniciar outra ou fechar.' : this.state.audioGapCount ? 'Sessão salva com lacuna de áudio indicada.' : 'Sessão finalizada e salva neste computador.');
    this.emit(true);
  }
  captureError(message: string, captureId?: string): void {
    if (captureId !== undefined && captureId !== this.state.microphoneCaptureId) return;
    if (captureId !== undefined && this.state.phase === 'capturing') this.state.audioGapCount++;
    void this.pauseWithMessage(message).catch(() => this.fail('Não foi possível concluir a pausa ou salvar o texto. Confira a pasta; copie ou exporte antes de fechar.'));
  }
  private fail(message: string): void {
    if (this.disposed) return;
    this.epoch++; this.outputGeneration++; this.state.microphoneCaptureId = null; this.state.phase = 'error'; this.state.message = message; this.state.levels = { microphone: 0, system: 0 };
    this.releaseStreams();
    void this.output.stop().catch(() => {});
    this.updatePending();
    if (this.session) { this.session.status = 'error'; void this.saveSession().catch(() => {}); }
    this.emit(true);
  }
  listSessions = async () => (await this.store.list()).map((item) =>
    item.id !== this.session?.id && ['preparing', 'capturing', 'paused', 'draining'].includes(item.status) ? { ...item, status: 'error' as const } : item);
  readSession = async (id: string) => {
    const session = await this.store.read(id);
    if (!await this.store.hasSavedText(session)) throw new Error('O arquivo TXT desta sessão não existe mais. Atualize o histórico.');
    if (id !== this.session?.id && ['preparing', 'capturing', 'paused', 'draining'].includes(session.status)) session.status = 'error';
    return session;
  };
  async deleteSession(id: string): Promise<void> {
    if (id === this.session?.id && !['completed', 'error'].includes(this.state.phase)) throw new Error('Finalize a sessão antes de excluí-la.');
    await this.store.delete(id);
    if (id === this.session?.id) {
      this.session = null; this.destination = null; this.origin = 0;
      this.state.sessionId = null; this.state.savePath = null; this.state.segments = []; this.state.partials = {};
      this.state.message = 'Registro excluído do histórico. O TXT escolhido permanece no disco.';
      this.emit(true);
    }
  }
  async exportSession(id: string): Promise<boolean> {
    const session = this.session?.id === id ? this.session : await this.store.read(id);
    const result = await dialog.showSaveDialog(this.window, { defaultPath: `sussurro-${session.createdAt.slice(0, 10)}.txt`, filters: [{ name: 'Texto', extensions: ['txt'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, sessionText(session), { mode: 0o600 }); return true;
  }
  async copySession(id: string): Promise<void> {
    clipboard.writeText(sessionText(this.session?.id === id ? this.session : await this.store.read(id)));
  }
  async dispose(discard = false): Promise<void> {
    await this.endMicrophoneCheck();
    if (!discard) {
      if (!['idle', 'completed'].includes(this.state.phase)) await this.stop(false);
      await this.saveSession();
      await this.store.flush();
    }
    this.measurement.end(); this.resourceReader?.dispose?.();
    this.stateListeners.clear();
    this.disposed = true; this.epoch++; this.outputGeneration++; this.state.microphoneCaptureId = null; clearInterval(this.watchdog); this.releaseStreams();
    await this.output.stop();
    await this.store.flush().catch(() => {});
    this.updatePending();
  }
}
