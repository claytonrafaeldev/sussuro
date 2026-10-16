import type { Phase, SourceId } from './contracts';
export type ConnectionStatus = 'closed' | 'connecting' | 'open' | 'closing' | 'failed';
export interface SourceMetrics {
  connection: ConnectionStatus; connectionMs: number | null; connectionCount: number;
  sentAudioMs: number; peakPendingBytes: number;
  partialCount: number; finalCount: number;
  firstPartialMs: number | null; firstFinalMs: number | null;
  lastPartialAtMs: number | null; lastFinalAtMs: number | null;
  lastPartialLagMs: number | null; lastFinalLagMs: number | null;
  maxPartialLagMs: number | null; maxFinalLagMs: number | null;
}
export interface ResourceSnapshot {
  sampledAtMs: number; intervalMs: number | null;
  cpuPercent: number | null; rssMiB: number | null;
  processCount: number; expectedProcesses: number; complete: boolean;
}
export const MEASUREMENT_SCENARIOS = ['one-source', 'two-sources', 'load', 'network-loss'] as const;
export type MeasurementScenario = typeof MEASUREMENT_SCENARIOS[number];
export interface MeasurementState { active: boolean; scenario: MeasurementScenario | null; samples: number; durationMs: number; limitReached: boolean }
export interface PerformanceView {
  sources: Record<SourceId, SourceMetrics>;
  resources: ResourceSnapshot | null;
  peakTotalPendingBytes: number;
  measurement: MeasurementState;
}
export interface PerformanceSample {
  atMs: number; sessionElapsedMs: number; phase: Phase; enabled: Record<SourceId, boolean>;
  pendingBytes: Record<SourceId, number>; peakTotalPendingBytes: number; audioGapCount: number;
  sources: Record<SourceId, SourceMetrics>; resources: ResourceSnapshot | null;
}
export function parseMeasurementScenario(value: unknown): MeasurementScenario {
  if (!MEASUREMENT_SCENARIOS.includes(value as MeasurementScenario)) throw new Error('Cenário de medição inválido.');
  return value as MeasurementScenario;
}
