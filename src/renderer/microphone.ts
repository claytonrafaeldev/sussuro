import { Resampler, pcmRms } from '../shared/audio';
import type { SussurroApi } from '../shared/runtime';

export interface MicrophoneSample { level: number; seconds: number }
interface CaptureOptions {
  deviceId: string;
  ready: () => Promise<((pcm: Uint8Array) => void) | null>;
  onError: (message: string) => void;
}

function captureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permissão do microfone negada. Libere o acesso e tente novamente.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Microfone selecionado indisponível. Atualize a lista e selecione outro dispositivo.';
  if (name === 'NotReadableError') return 'Não foi possível acessar o microfone. Verifique o dispositivo e outros aplicativos de áudio.';
  return error instanceof Error ? error.message : 'Falha ao iniciar o microfone.';
}

export class Microphone {
  private generation = 0;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelPermission: (() => void) | undefined;

  async start(api: SussurroApi, sessionId: string, captureId: string, deviceId: string, onLevel: (level: number) => void): Promise<void> {
    return this.capture({ deviceId, onError: (message) => api.reportCaptureError(message, captureId), ready: async () => {
      const state = await api.getState();
      if (state.sessionId !== sessionId || state.microphoneCaptureId !== captureId || state.phase !== 'capturing' || !state.options.microphone) return null;
      let sequence = 0, sentSamples = 0, pending = false;
      let sending = true;
      const offset = state.elapsedMs;
      const captureGeneration = this.generation;
      return (pcm) => {
        if (!sending) return;
        if (pending) {
          sending = false; void this.stop();
          api.reportCaptureError('O envio do microfone atrasou. Captura interrompida; há uma lacuna de áudio.', captureId); return;
        }
        onLevel(pcmRms(pcm));
        pending = true;
        void api.sendAudio({ sessionId, captureId, sequence: sequence++, startMs: offset + sentSamples / 16, pcm }).then((accepted) => {
          if (!accepted && sending) {
            sending = false;
            // A late acknowledgment from a previous capture cannot stop its replacement.
            if (captureGeneration !== this.generation) return;
            void this.stop(); api.reportCaptureError('O áudio do microfone não foi aceito. Há uma lacuna; retome a captura.', captureId);
          }
        }).catch(() => {
          sending = false;
          if (captureGeneration !== this.generation) return;
          void this.stop(); api.reportCaptureError('Comunicação do microfone interrompida. Há uma lacuna; retome a captura.', captureId);
        }).finally(() => { pending = false; });
        sentSamples += pcm.length / 2;
      };
    } });
  }

  /** Local meter only: PCM never leaves this object and is not retained. */
  async preview(deviceId: string, onSample: (sample: MicrophoneSample) => void, onError: (message: string) => void): Promise<void> {
    let samples = 0;
    return this.capture({ deviceId, onError, ready: async () => (pcm) => {
      samples += pcm.length / 2;
      onSample({ level: pcmRms(pcm), seconds: samples / 16000 });
    } });
  }

  private async capture(options: CaptureOptions): Promise<void> {
    // Claim this attempt before any await, so an older start cannot stop a newer one.
    const generation = ++this.generation;
    let permissionTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelPermission: (() => void) | undefined;
    const current = () => generation === this.generation;
    const fail = (message: string) => {
      if (!current()) return;
      void this.stop();
      options.onError(message);
    };
    try {
      await this.release();
      if (!current()) return;
      const permission = navigator.mediaDevices.getUserMedia({
        audio: { ...(options.deviceId && options.deviceId !== 'default' ? { deviceId: { exact: options.deviceId } } : {}),
          echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 }, video: false,
      }).then((stream) => {
        if (!current()) { stream.getTracks().forEach((track) => track.stop()); throw new Error('Captura cancelada.'); }
        return stream;
      });
      // getUserMedia itself cannot be cancelled. Stop our wait immediately,
      // while the generation check above releases any late permission result.
      const cancelled = new Promise<never>((_, reject) => {
        cancelPermission = () => {
          clearTimeout(permissionTimer);
          reject(new Error('Captura cancelada.'));
        };
        this.cancelPermission = cancelPermission;
      });
      const stream = await Promise.race([permission, cancelled, new Promise<never>((_, reject) => {
        permissionTimer = setTimeout(() => reject(new Error('Permissão do microfone não respondeu em 20 segundos.')), 20_000);
      })]);
      clearTimeout(permissionTimer);
      if (this.cancelPermission === cancelPermission) this.cancelPermission = undefined;
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      // Register immediately: disconnect during module loading must also release capture.
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () =>
        fail('Microfone desconectado. Atualize a lista e selecione-o novamente.'), { once: true }));
      const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      this.context = context;
      await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-worklet.js`);
      if (!current()) return;
      const onPcm = await options.ready();
      if (!current()) return;
      if (!onPcm) { await this.stop(); return; }
      const resampler = new Resampler(context.sampleRate);
      this.source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'sussurro-pcm');
      this.worklet = worklet;
      this.sink = context.createGain(); this.sink.gain.value = 0;
      const expectFrame = () => {
        clearTimeout(this.frameTimer);
        this.frameTimer = setTimeout(() => fail('O microfone parou de entregar áudio. Verifique o dispositivo e tente novamente.'), 5000);
      };
      worklet.onprocessorerror = () => fail('O processamento do microfone falhou. Tente iniciar novamente.');
      worklet.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (!current()) return;
        if (data && typeof data === 'object' && 'overflow' in data) {
          fail('O processamento do microfone atrasou. Há uma lacuna; retome a captura.'); return;
        }
        if (!(data instanceof Float32Array) || data.length > context.sampleRate) {
          fail('Formato de áudio do microfone inválido.'); return;
        }
        const pcm = resampler.push(data);
        if (!pcm.length) return;
        expectFrame();
        onPcm(pcm);
        if (current()) worklet.port.postMessage('ack');
      };
      this.source.connect(worklet); worklet.connect(this.sink); this.sink.connect(context.destination);
      expectFrame();
      await context.resume();
    } catch (error) {
      if (current()) { await this.stop(); throw new Error(captureMessage(error)); }
    } finally {
      clearTimeout(permissionTimer);
      if (this.cancelPermission === cancelPermission) this.cancelPermission = undefined;
    }
  }

  async stop(): Promise<void> { this.generation++; await this.release(); }

  private async release(): Promise<void> {
    const cancelPermission = this.cancelPermission;
    this.cancelPermission = undefined;
    cancelPermission?.();
    clearTimeout(this.frameTimer); this.frameTimer = undefined;
    if (this.worklet) {
      this.worklet.port.onmessage = null; this.worklet.onprocessorerror = null;
      this.worklet.port.close(); this.worklet.disconnect();
    }
    this.source?.disconnect(); this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    const context = this.context;
    this.worklet = null; this.source = null; this.sink = null; this.stream = null; this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }
}
