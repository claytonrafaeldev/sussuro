/** Stateful interpolation for a fallback context rate; the browser normally runs at 16 kHz. */
export class Resampler {
  private samples: number[] = [];
  private position = 0;
  private readonly inputRate: number;
  private readonly outputRate: number;
  constructor(inputRate: number, outputRate = 16_000) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000) throw new Error('Taxa de áudio inválida.');
    this.inputRate = inputRate;
    this.outputRate = outputRate;
  }
  push(input: Float32Array): Uint8Array {
    const values: number[] = [];
    if (this.inputRate === this.outputRate) values.push(...input);
    else {
      this.samples.push(...input);
      const step = this.inputRate / this.outputRate;
      while (this.position + 1 < this.samples.length) {
        const index = Math.floor(this.position), frac = this.position - index;
        values.push(this.samples[index] * (1 - frac) + this.samples[index + 1] * frac);
        this.position += step;
      }
      const consumed = Math.min(Math.floor(this.position), this.samples.length);
      this.samples.splice(0, consumed);
      this.position -= consumed;
    }
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => {
      const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
      view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    });
    return bytes;
  }
}
export function pcmRms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += (view.getInt16(i, true) / 32768) ** 2;
  return pcm.length ? Math.sqrt(sum / (pcm.length / 2)) : 0;
}
export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const output = new Uint8Array(44 + pcm.length), view = new DataView(output.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => output[offset + i] = c.charCodeAt(0));
  text(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, pcm.length, true); output.set(pcm, 44);
  return output;
}
