import { expect, it } from 'vitest';
import { Resampler, pcmRms, pcmToWav } from '../src/shared/audio';

it('encodes signed PCM little endian and a correct 16 kHz mono WAV', () => {
  const pcm = new Resampler(16000).push(new Float32Array([-1, 0, 1]));
  const view = new DataView(pcm.buffer);
  expect([view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true)]).toEqual([-32768, 0, 32767]);
  const wav = pcmToWav(pcm), header = new DataView(wav.buffer);
  expect(header.getUint32(24, true)).toBe(16000);
  expect(header.getUint32(40, true)).toBe(6);
  expect(wav.length).toBe(50);
  expect(pcmRms(pcm)).toBeGreaterThan(0.8);
});
it('keeps resampling phase across chunks and actually reduces the sample count', () => {
  const resampler = new Resampler(48000);
  const first = resampler.push(new Float32Array(4800).fill(0.25));
  const next = resampler.push(new Float32Array(4800).fill(0.25));
  expect((first.length + next.length) / 2).toBe(3200);
  expect(pcmRms(next)).toBeCloseTo(0.25, 3);
});
it.each([44100, 48000])('preserves phase with irregular and single-sample input at %i Hz', (rate) => {
  const input = Float32Array.from({ length: 10000 }, (_, i) => Math.sin(i / 30));
  const expected = new Resampler(rate).push(input);
  const streaming = new Resampler(rate);
  const bytes: number[] = [];
  for (let index = 0; index < input.length;) {
    const length = index % 7 + 1;
    bytes.push(...streaming.push(input.slice(index, index + length)));
    index += length;
  }
  expect(new Uint8Array(bytes)).toEqual(expected);
});
