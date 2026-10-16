import { pcmRms } from '../../shared/audio';

export interface AudioChunk { pcm: Uint8Array; startMs: number; endMs: number }
export class Segmenter {
  private frames: Uint8Array[] = [];
  private bytes = 0;
  private startMs = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private lead: Uint8Array[] = [];
  readonly accept: (chunk: AudioChunk) => boolean;
  constructor(accept: (chunk: AudioChunk) => boolean) { this.accept = accept; }
  get seconds(): number { return this.bytes / 32000; }
  push(pcm: Uint8Array, startMs: number): boolean {
    if (this.bytes + pcm.length > 320000 && !this.flush()) return false;
    const speech = pcmRms(pcm) >= 0.008;
    if (!this.bytes && !speech) { this.lead.push(pcm); while (this.lead.reduce((n, p) => n + p.length, 0) > 6400) this.lead.shift(); return true; }
    if (!this.bytes) {
      this.frames = this.lead; this.bytes = this.lead.reduce((n, p) => n + p.length, 0);
      this.startMs = Math.max(0, startMs - this.bytes / 32); this.lead = [];
    }
    this.frames.push(pcm); this.bytes += pcm.length;
    if (speech) { this.speechMs += pcm.length / 32; this.silenceMs = 0; }
    else this.silenceMs += pcm.length / 32;
    if (this.bytes >= 316800 || this.silenceMs >= 700) return this.flush();
    return true;
  }
  flush(): boolean {
    if (!this.bytes) { this.clear(); return true; }
    if (this.speechMs < 250) { this.clear(); return true; }
    const pcm = new Uint8Array(this.bytes); let offset = 0;
    for (const frame of this.frames) { pcm.set(frame, offset); offset += frame.length; }
    if (!this.accept({ pcm, startMs: this.startMs, endMs: this.startMs + pcm.length / 32 })) return false;
    this.clear(); return true;
  }
  clear(): void { this.frames = []; this.lead = []; this.bytes = 0; this.speechMs = 0; this.silenceMs = 0; }
}
