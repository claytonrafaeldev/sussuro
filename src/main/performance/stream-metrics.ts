import type { SourceId } from '../../shared/contracts';
import type { ConnectionStatus, SourceMetrics } from '../../shared/performance';
const initial = (): SourceMetrics => ({ connection: 'closed', connectionMs: null, connectionCount: 0,
  sentAudioMs: 0, peakPendingBytes: 0, partialCount: 0, finalCount: 0,
  firstPartialMs: null, firstFinalMs: null, lastPartialAtMs: null, lastFinalAtMs: null,
  lastPartialLagMs: null, lastFinalLagMs: null, maxPartialLagMs: null, maxFinalLagMs: null });
/** Fixed-size numeric state; audio and transcript text never enter this object. */
export class StreamMetrics {
  private values = { microphone: initial(), system: initial() };
  private openedAt: Partial<Record<SourceId, number>> = {};
  private firstAudioAt: Partial<Record<SourceId, number>> = {};
  peakTotalPendingBytes = 0;
  constructor(private readonly now = () => performance.now()) {}
  begin(source: SourceId): void {
    const previous = this.values[source];
    this.values[source] = { ...previous, connection: 'connecting', connectionMs: null, connectionCount: previous.connectionCount + 1, firstPartialMs: null, firstFinalMs: null };
    this.openedAt[source] = this.now(); delete this.firstAudioAt[source];
  }
  connected(source: SourceId): void {
    this.values[source].connection = 'open';
    this.values[source].connectionMs = Math.max(0, this.now() - (this.openedAt[source] ?? this.now()));
  }
  end(source: SourceId, status: ConnectionStatus = 'closed'): void {
    if (status !== 'closed' || this.values[source].connection !== 'failed') this.values[source].connection = status;
    if (status !== 'closing') delete this.firstAudioAt[source];
  }
  sent(source: SourceId, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    this.firstAudioAt[source] ??= this.now();
    this.values[source].sentAudioMs += durationMs;
  }
  result(source: SourceId, kind: 'partial' | 'final', endMs: number, elapsedMs: number): void {
    if (!Number.isFinite(endMs) || !Number.isFinite(elapsedMs) || endMs < 0 || elapsedMs < 0) return;
    const value = this.values[source], lag = Math.max(0, elapsedMs - endMs);
    const first = this.firstAudioAt[source];
    if (kind === 'partial') {
      value.partialCount++; value.lastPartialAtMs = elapsedMs; value.lastPartialLagMs = lag;
      value.maxPartialLagMs = Math.max(value.maxPartialLagMs ?? 0, lag);
      if (first !== undefined) value.firstPartialMs ??= Math.max(0, this.now() - first);
    } else {
      value.finalCount++; value.lastFinalAtMs = elapsedMs; value.lastFinalLagMs = lag;
      value.maxFinalLagMs = Math.max(value.maxFinalLagMs ?? 0, lag);
      if (first !== undefined) value.firstFinalMs ??= Math.max(0, this.now() - first);
    }
  }
  pending(bytes: Record<SourceId, number>): void {
    for (const source of ['microphone', 'system'] as const) {
      if (Number.isSafeInteger(bytes[source]) && bytes[source] >= 0) this.values[source].peakPendingBytes = Math.max(this.values[source].peakPendingBytes, bytes[source]);
    }
    this.peakTotalPendingBytes = Math.max(this.peakTotalPendingBytes, bytes.microphone + bytes.system);
  }
  snapshot(): Record<SourceId, SourceMetrics> { return structuredClone(this.values); }
}
