import { parseMeasurementScenario, type MeasurementScenario, type MeasurementState, type PerformanceSample, type SourceMetrics } from '../../shared/performance';
export const MEASUREMENT_LIMIT = 300;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function source(value: SourceMetrics): SourceMetrics {
  const clean: SourceMetrics = { connection: ['closed', 'connecting', 'open', 'closing', 'failed'].includes(value.connection) ? value.connection : 'failed',
    connectionMs: number(value.connectionMs), connectionCount: number(value.connectionCount) ?? 0,
    sentAudioMs: number(value.sentAudioMs) ?? 0, peakPendingBytes: number(value.peakPendingBytes) ?? 0,
    partialCount: number(value.partialCount) ?? 0, finalCount: number(value.finalCount) ?? 0,
    firstPartialMs: number(value.firstPartialMs), firstFinalMs: number(value.firstFinalMs),
    lastPartialAtMs: number(value.lastPartialAtMs), lastFinalAtMs: number(value.lastFinalAtMs),
    lastPartialLagMs: number(value.lastPartialLagMs), lastFinalLagMs: number(value.lastFinalLagMs),
    maxPartialLagMs: number(value.maxPartialLagMs), maxFinalLagMs: number(value.maxFinalLagMs) };
  return clean;
}
/** Bounded numeric recording, only after a user action. Not a session/transcript serializer. */
export class Measurement {
  private active = false;
  private scenario: MeasurementScenario | null = null;
  private started = 0;
  private ended = 0;
  private values: PerformanceSample[] = [];
  constructor(private readonly now = () => performance.now()) {}
  begin(scenario: MeasurementScenario): void {
    if (this.active) throw new Error('Já há uma medição ativa.');
    const selected = parseMeasurementScenario(scenario);
    this.active = true; this.scenario = selected; this.started = this.now(); this.ended = this.started; this.values = [];
  }
  record(sample: PerformanceSample): void {
    if (!this.active) return;
    if (!['idle', 'preparing', 'capturing', 'paused', 'draining', 'completed', 'error'].includes(sample.phase)) return;
    const resource = sample.resources;
    // Explicit field selection prevents a future caller from exporting a whole ViewState/secret by accident.
    this.values.push({ atMs: Math.max(0, this.now() - this.started), sessionElapsedMs: number(sample.sessionElapsedMs) ?? 0, phase: sample.phase,
      enabled: { microphone: sample.enabled.microphone === true, system: sample.enabled.system === true },
      pendingBytes: { microphone: number(sample.pendingBytes.microphone) ?? 0, system: number(sample.pendingBytes.system) ?? 0 },
      peakTotalPendingBytes: number(sample.peakTotalPendingBytes) ?? 0, audioGapCount: number(sample.audioGapCount) ?? 0,
      sources: { microphone: source(sample.sources.microphone), system: source(sample.sources.system) },
      resources: resource ? { sampledAtMs: number(resource.sampledAtMs) ?? 0, intervalMs: number(resource.intervalMs),
        cpuPercent: number(resource.cpuPercent), rssMiB: number(resource.rssMiB),
        processCount: number(resource.processCount) ?? 0, expectedProcesses: number(resource.expectedProcesses) ?? 0, complete: resource.complete === true } : null });
    if (this.values.length >= MEASUREMENT_LIMIT || this.now() - this.started >= 300000) this.end();
  }
  end(): void { if (this.active) { this.active = false; this.ended = this.now(); } }
  status(): MeasurementState { return { active: this.active, scenario: this.scenario, samples: this.values.length, durationMs: Math.max(0, (this.active ? this.now() : this.ended) - this.started), limitReached: this.values.length >= MEASUREMENT_LIMIT || this.ended - this.started >= 300000 }; }
  report() {
    const describe = (values: Array<number | null | undefined>) => {
      const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      return { availableSamples: valid.length, mean: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null, max: valid.length ? Math.max(...valid) : null };
    };
    const captureGroup = (count: number) => {
      const values = this.values.filter((value) => value.phase === 'capturing' && Number(value.enabled.microphone) + Number(value.enabled.system) === count);
      return { samples: values.length, cpuPercent: describe(values.map((value) => value.resources?.cpuPercent)), rssMiB: describe(values.map((value) => value.resources?.rssMiB)) };
    };
    const summary = { byCapturingSourceCount: { one: captureGroup(1), two: captureGroup(2) }, cpuPercent: describe(this.values.map((value) => value.resources?.cpuPercent)),
      rssMiB: describe(this.values.map((value) => value.resources?.rssMiB)),
      peakPendingBytes: this.values.reduce((peak, value) => Math.max(peak, value.peakTotalPendingBytes), 0),
      finalGapCount: this.values.at(-1)?.audioGapCount ?? 0,
      observedPhases: [...new Set(this.values.map((value) => value.phase))] };
    return { schemaVersion: 1, ...this.status(), sampleCount: this.values.length, intervalTargetMs: 1000, sampleLimit: MEASUREMENT_LIMIT, summary, samples: structuredClone(this.values) };
  }
}
