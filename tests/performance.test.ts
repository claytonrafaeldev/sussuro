import { expect, it, vi } from 'vitest';
import { StreamMetrics } from '../src/main/performance/stream-metrics';
import { ResourceMonitor, parseProcStat } from '../src/main/performance/resources';
import { Measurement, MEASUREMENT_LIMIT } from '../src/main/performance/measurement';
import type { PerformanceSample } from '../src/shared/performance';

it('measures each source on monotonic clocks and keeps arrival lag frozen during silence', () => {
  let now = 100; const m = new StreamMetrics(() => now);
  m.begin('microphone'); now = 250; m.connected('microphone');
  now = 1000; m.sent('microphone', 100); now = 1300; m.result('microphone', 'partial', 200, 800);
  now = 1700; m.result('microphone', 'final', 300, 1200);
  expect(m.snapshot().microphone).toMatchObject({ connectionMs: 150, firstPartialMs: 300, firstFinalMs: 700, lastPartialLagMs: 600, lastFinalLagMs: 900, partialCount: 1, finalCount: 1, lastFinalAtMs: 1200 });
  now = 30000;
  expect(m.snapshot().microphone.lastFinalLagMs).toBe(900);
  expect(m.snapshot().system).toMatchObject({ connection: 'closed', firstPartialMs: null, firstFinalMs: null });
  m.pending({ microphone: 10000, system: 20000 }); m.pending({ microphone: 15000, system: 0 });
  expect(m.peakTotalPendingBytes).toBe(30000); expect(m.snapshot().microphone.peakPendingBytes).toBe(15000);
  const snapshot = m.snapshot(); snapshot.microphone.finalCount = 999; expect(m.snapshot().microphone.finalCount).toBe(1);
});
it('resets first-result clocks on a new connection and measures finals arriving while closing', () => {
  let now = 1000; const m = new StreamMetrics(() => now);
  m.begin('system'); m.connected('system'); m.sent('system', 100);
  now = 1200; m.end('system', 'closing'); now = 1500; m.result('system', 'final', 100, 500);
  expect(m.snapshot().system.firstFinalMs).toBe(500);
  m.end('system', 'failed'); m.end('system'); expect(m.snapshot().system.connection).toBe('failed');
  now = 2000; m.begin('system'); m.connected('system');
  expect(m.snapshot().system).toMatchObject({ firstFinalMs: null, connectionCount: 2, finalCount: 1 });
  now = 3000; m.sent('system', 100); now = 3100; m.result('system', 'final', 5000, 5100);
  expect(m.snapshot().system.firstFinalMs).toBe(100); expect(m.snapshot().system.maxFinalLagMs).toBe(400);
});
it('parses bounded Linux stat with spaces and parentheses and refuses invalid numbers', () => {
  const fields = Array(22).fill('0'); fields[0] = 'S'; fields[11] = '20'; fields[12] = '10'; fields[19] = '999'; fields[21] = '128';
  expect(parseProcStat(`42 (name with ) spaces) ${fields.join(' ')}`)).toEqual({ ticks: 30, start: 999, rssPages: 128 });
  expect(() => parseProcStat('garbage')).toThrow(); fields[21] = '-1'; expect(() => parseProcStat(`42 (x) ${fields.join(' ')}`)).toThrow();
});
it('sums owned Electron and capture PIDs once, uses clock tick/page units and allows more than one CPU core', async () => {
  let now = 1000, ticks = 10;
  const read = vi.fn(async (pid: number) => ({ ticks, start: pid * 100, rssPages: 128 }));
  const monitor = new ResourceMonitor(() => [1, 2, 2], read, async () => ({ ticks: 100, pageBytes: 4096 }), () => now);
  expect(await monitor.sample(3)).toMatchObject({ cpuPercent: null, rssMiB: 1.5, processCount: 3, complete: true });
  now = 2000; ticks = 60;
  expect(await monitor.sample(3)).toMatchObject({ cpuPercent: 150, intervalMs: 1000, rssMiB: 1.5 });
  expect(read).toHaveBeenCalledTimes(6);
});
it('reports missing resources as unavailable and discards CPU baselines on PID reuse/process-set changes', async () => {
  let now = 1000, start = 100, pids = [1, 2];
  const read = vi.fn(async () => ({ ticks: now, start, rssPages: 128 }));
  const m = new ResourceMonitor(() => pids, read, async () => ({ ticks: 100, pageBytes: 4096 }), () => now);
  await m.sample(); now = 2000; start = 200;
  expect((await m.sample()).cpuPercent).toBeNull(); now = 3000; pids = [1];
  expect((await m.sample()).cpuPercent).toBeNull(); now = 4000;
  read.mockRejectedValueOnce(new Error('private process detail'));
  expect(await m.sample()).toMatchObject({ complete: false, processCount: 0, rssMiB: null, cpuPercent: null });
  const unavailable = new ResourceMonitor(() => [1], read, async () => { throw new Error(); });
  expect(await unavailable.sample()).toMatchObject({ rssMiB: null, cpuPercent: null });
  const invalid = new ResourceMonitor(() => [-5], read); expect((await invalid.sample()).complete).toBe(false);
});
function sample(): PerformanceSample {
  return { atMs: 555, sessionElapsedMs: 1000, phase: 'capturing', enabled: { microphone: true, system: false },
    pendingBytes: { microphone: 3200, system: 0 }, peakTotalPendingBytes: 3200, audioGapCount: 1, sources: new StreamMetrics().snapshot(), resources: null };
}
it('records only after opt-in, bounds storage, excludes unknown fields and returns copies', () => {
  let now = 1000; const m = new Measurement(() => now);
  m.record(sample()); expect(m.status().samples).toBe(0); m.begin('one-source');
  expect(() => m.begin('load')).toThrow();
  const value = Object.assign(sample(), { key: 'synthetic-secret', text: 'synthetic-transcript', pcm: Buffer.alloc(10) });
  Object.assign(value.sources.microphone, { secret: 'synthetic-secret' });
  m.record(value); now = 2000;
  const json = JSON.stringify(m.report()); expect(json).not.toContain('synthetic-'); expect(json).not.toContain('pcm');
  for (let i = 1; i <= MEASUREMENT_LIMIT + 20; i++) m.record(sample());
  expect(m.status()).toMatchObject({ active: false, samples: 300, limitReached: true });
  expect(m.report().samples[0].atMs).toBe(0);
  const report = m.report(); report.samples.length = 0; expect(m.status().samples).toBe(300);
  m.begin('two-sources'); expect(m.status().samples).toBe(0); m.end(); m.record(sample()); expect(m.status().samples).toBe(0);
});
it('also stops after five minutes when sampling has been delayed', () => {
  let now = 1000; const m = new Measurement(() => now); m.begin('network-loss'); now = 301000; m.record(sample());
  expect(m.status()).toMatchObject({ active: false, samples: 1, durationMs: 300000, limitReached: true });
});
it('reads actual own Node process resources without audio, key, Electron launch or synthetic CPU load', async () => {
  const monitor = new ResourceMonitor(() => [process.pid]);
  const snapshot = await monitor.sample();
  expect(snapshot.complete).toBe(true); expect(snapshot.rssMiB).toBeGreaterThan(0); expect(snapshot.cpuPercent).toBeNull();
  expect(snapshot.processCount).toBe(1);
});

it('summarizes valid resource samples without treating unavailable data as zero and separates capturing source counts', () => {
  const m = new Measurement(() => 1000); m.begin('two-sources');
  const unavailable = sample(); unavailable.phase = 'paused'; m.record(unavailable);
  const one = sample(); one.resources = { sampledAtMs: 1000, intervalMs: 1000, cpuPercent: 20, rssMiB: 100, processCount: 1, expectedProcesses: 1, complete: true }; m.record(one);
  const two = sample(); two.enabled.system = true; two.resources = { ...one.resources, cpuPercent: 40, rssMiB: 200 }; m.record(two); m.end();
  expect(m.report().summary.cpuPercent).toEqual({ availableSamples: 2, mean: 30, max: 40 });
  expect(m.report().summary.byCapturingSourceCount.one.cpuPercent.mean).toBe(20);
  expect(m.report().summary.byCapturingSourceCount.two.rssMiB.max).toBe(200);
});

it('aborts pending unit queries at shutdown and does not read processes after disposal', async () => {
  const read = vi.fn(async () => ({ ticks: 1, start: 1, rssPages: 1 }));
  const units = (signal?: AbortSignal) => new Promise<{ ticks: number; pageBytes: number }>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  const monitor = new ResourceMonitor(() => [1], read, units);
  const pending = monitor.sample(); monitor.dispose();
  expect((await pending).cpuPercent).toBeNull();
  expect((await monitor.sample()).complete).toBe(false);
  expect(read).not.toHaveBeenCalled();
});
