import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import type { ResourceSnapshot } from '../../shared/performance';
const execute = promisify(execFile);
export interface ProcNumbers { ticks: number; start: number; rssPages: number }
export function parseProcStat(value: string): ProcNumbers {
  const end = value.lastIndexOf(')');
  if (end < 0 || value.length > 8192) throw new Error();
  const fields = value.slice(end + 1).trim().split(/\s+/);
  const user = Number(fields[11]), system = Number(fields[12]), start = Number(fields[19]), rssPages = Number(fields[21]);
  if (![user, system, start, rssPages].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error();
  return { ticks: user + system, start, rssPages };
}
async function units(signal?: AbortSignal): Promise<{ ticks: number; pageBytes: number }> {
  const read = async (name: string) => {
    const { stdout } = await execute('getconf', [name], { timeout: 1000, maxBuffer: 1024, signal, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, shell: false });
    const value = Number(stdout.trim());
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) throw new Error();
    return value;
  };
  const [ticks, pageBytes] = await Promise.all([read('CLK_TCK'), read('PAGESIZE')]);
  return { ticks, pageBytes };
}
async function proc(pid: number): Promise<ProcNumbers> {
  const file = await open(`/proc/${pid}/stat`, 'r');
  try {
    const data = Buffer.alloc(8193);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    return parseProcStat(data.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
export interface ResourceReader { sample(extraPid?: number): Promise<ResourceSnapshot>; dispose?(): void }
/** Linux: sample only PIDs owned/discovered by the application, including pw-record.
 * No /proc environ/cmdline, process names or PIDs are returned to the renderer/report.
 */
export class ResourceMonitor implements ResourceReader {
  private readonly controller = new AbortController();
  private previous = new Map<number, ProcNumbers>();
  private previousAt: number | undefined;
  private unitsPromise: Promise<{ ticks: number; pageBytes: number } | null> | undefined;
  constructor(private readonly pids: () => number[], private readonly read = proc, private readonly getUnits = units, private readonly now = () => performance.now()) {}
  dispose(): void { this.controller.abort(); this.previous.clear(); }
  async sample(extraPid?: number): Promise<ResourceSnapshot> {
    const sampledAtMs = this.now();
    let pids: number[] = [];
    try { pids = [...new Set([...this.pids(), ...(extraPid ? [extraPid] : [])])]; } catch { /* Report unavailable. */ }
    const intervalMs = this.previousAt === undefined ? null : sampledAtMs - this.previousAt;
    const empty = { sampledAtMs, intervalMs, cpuPercent: null, rssMiB: null, processCount: 0, expectedProcesses: pids.length, complete: false };
    if (this.controller.signal.aborted || !pids.length || pids.length > 64 || pids.some((id) => !Number.isSafeInteger(id) || id <= 0)) { this.previous.clear(); this.previousAt = undefined; return empty; }
    this.unitsPromise ??= this.getUnits(this.controller.signal).catch(() => null);
    const unit = await this.unitsPromise;
    if (!unit) return empty;
    const reads = await Promise.allSettled(pids.map((id) => this.read(id)));
    const next = new Map<number, ProcNumbers>();
    let rssPages = 0, deltaTicks = 0, cpuComplete = intervalMs !== null && intervalMs > 0 && this.previous.size === pids.length;
    for (let index = 0; index < reads.length; index++) {
      const reading = reads[index];
      if (reading.status !== 'fulfilled') { cpuComplete = false; continue; }
      const value = reading.value, id = pids[index]; next.set(id, value); rssPages += value.rssPages;
      const old = this.previous.get(id);
      if (!old || old.start !== value.start || value.ticks < old.ticks) cpuComplete = false;
      else deltaTicks += value.ticks - old.ticks;
    }
    this.previous = next; this.previousAt = sampledAtMs;
    const complete = next.size === pids.length;
    return { sampledAtMs, intervalMs, processCount: next.size, expectedProcesses: pids.length, complete,
      cpuPercent: cpuComplete && complete ? deltaTicks / unit.ticks * 100000 / intervalMs! : null,
      rssMiB: complete ? rssPages * unit.pageBytes / 1048576 : null };
  }
}
