export class AudioQueue<T extends { seconds: number }> {
  private waiting: T[] = [];
  private active: T | null = null;
  private generation = 0;
  readonly execute: (job: T) => Promise<void>;
  readonly onChange: () => void;
  readonly onError: (error: unknown) => void;
  constructor(execute: (job: T) => Promise<void>, onChange: () => void, onError: (error: unknown) => void) {
    this.execute = execute; this.onChange = onChange; this.onError = onError;
  }
  get seconds(): number { return (this.active?.seconds || 0) + this.waiting.reduce((sum, job) => sum + job.seconds, 0); }
  get idle(): boolean { return !this.active && !this.waiting.length; }
  offer(job: T): boolean {
    if (!Number.isFinite(job.seconds) || job.seconds <= 0 || job.seconds > 10 || this.seconds + job.seconds > 30) return false;
    this.waiting.push(job); this.onChange(); void this.pump(); return true;
  }
  clear(): void { this.generation++; this.waiting = []; this.onChange(); }
  private async pump(): Promise<void> {
    if (this.active || !this.waiting.length) return;
    const job = this.waiting.shift()!; this.active = job; const generation = this.generation;
    try { await this.execute(job); } catch (error) { if (generation === this.generation) this.onError(error); }
    finally { this.active = null; this.onChange(); if (generation === this.generation) void this.pump(); }
  }
}
