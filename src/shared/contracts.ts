export type SourceId = 'microphone' | 'system';
export type Phase = 'idle' | 'preparing' | 'capturing' | 'paused' | 'draining' | 'completed' | 'error';
export interface StartOptions {
  microphone: boolean; system: boolean; microphoneId: string; systemId: string;
  language: string; threads: 1 | 2; persistence?: 'saved' | 'temporary';
}
export type SourceOptions = Pick<StartOptions, 'microphone' | 'system'> & Partial<Pick<StartOptions, 'microphoneId' | 'systemId'>>;
export interface Device { id: string; label: string }
export interface Segment { id: string; source: SourceId; startMs: number; endMs: number; text: string }
export interface Session {
  schemaVersion: 1; id: string; createdAt: string; status: Phase;
  options: StartOptions; segments: Segment[]; audioGapCount?: number; destinationPath?: string;
}
export interface SessionSummary { id: string; createdAt: string; count: number; status: Phase }
export interface ViewState {
  savePath?: string | null;
  performance?: import('./performance').PerformanceView;
  partials?: Partial<Record<SourceId, { text: string; startMs: number; endMs: number }>>;
  pendingBytes: Record<SourceId, number>;
  audioGapCount: number;
  microphoneChecking: boolean;
  microphoneCaptureId: string | null;
  phase: Phase; sessionId: string | null; message: string; pendingSeconds: number;
  lagSeconds: number; elapsedMs: number; options: StartOptions; segments: Segment[];
  levels: Record<SourceId, number>;
}
export interface AudioFrame { sessionId: string; captureId: string; sequence: number; startMs: number; pcm: Uint8Array }
// Legacy auto remains readable in stored sessions; the streaming adapter rejects it.
export const LANGUAGES = ['auto', 'pt-BR', 'multi', 'pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh'] as const;
export const DEFAULT_OPTIONS: StartOptions = {
  microphone: true, system: false, microphoneId: 'default', systemId: '', language: 'pt-BR', threads: 1, persistence: 'saved',
};
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseOptions(value: unknown): StartOptions {
  if (!record(value) || (value.persistence !== undefined && !['saved', 'temporary'].includes(value.persistence as string)) || typeof value.microphone !== 'boolean' || typeof value.system !== 'boolean' ||
      typeof value.microphoneId !== 'string' || value.microphoneId.length > 512 ||
      typeof value.systemId !== 'string' || value.systemId.length > 512 ||
      !LANGUAGES.includes(value.language as typeof LANGUAGES[number]) || ![1, 2].includes(value.threads as number)) throw new Error('Configuração de captura inválida.');
  if (!value.microphone && !value.system) throw new Error('Ative pelo menos uma fonte de áudio.');
  if (value.system && !value.systemId) throw new Error('Selecione uma saída de áudio do computador.');
  return {
    microphone: value.microphone, system: value.system, microphoneId: value.microphoneId,
    systemId: value.systemId, language: value.language as string, threads: value.threads as 1 | 2, persistence: value.persistence === 'temporary' ? 'temporary' : 'saved',
  };
}
export function parseSources(value: unknown): SourceOptions {
  if (!record(value) || typeof value.microphone !== 'boolean' || typeof value.system !== 'boolean') throw new Error('Fontes inválidas.');
  const result: SourceOptions = { microphone: value.microphone, system: value.system };
  for (const key of ['microphoneId', 'systemId'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 512 || /[\x00-\x1f\x7f]/.test(value[key])) throw new Error('Dispositivo inválido.');
    result[key] = value[key];
  }
  return result;
}
export function parseFrame(value: unknown): AudioFrame {
  if (!record(value) || !validId(value.sessionId) || !validId(value.captureId) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 ||
      typeof value.startMs !== 'number' || !Number.isFinite(value.startMs) || value.startMs < 0 ||
      !(value.pcm instanceof Uint8Array) || value.pcm.byteLength < 2 || value.pcm.byteLength > 3_200 || value.pcm.byteLength % 2 !== 0) throw new Error('Quadro de áudio inválido.');
  return { sessionId: value.sessionId, captureId: value.captureId, sequence: value.sequence as number, startMs: value.startMs, pcm: value.pcm };
}
export const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  idle: ['preparing'], preparing: ['capturing', 'error', 'draining'],
  capturing: ['paused', 'draining', 'error'], paused: ['capturing', 'draining', 'error'],
  draining: ['completed', 'error'], completed: ['preparing'], error: ['preparing', 'draining'],
};
export function assertTransition(from: Phase, to: Phase): void {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`Transição inválida: ${from} → ${to}`);
}
