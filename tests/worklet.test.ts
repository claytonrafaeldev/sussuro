import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { Resampler } from '../src/shared/audio';

it('downmixes stereo into 100 ms frames and resamples the actual worklet output to PCM16', async () => {
  const frames: Float32Array[] = [];
  let Processor!: new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage?: (event: { data: string }) => void } };
  const code = await readFile(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8');
  runInNewContext(code, {
    sampleRate: 48000, Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: (data: Float32Array) => frames.push(data) }; },
    registerProcessor: (name: string, implementation: typeof Processor) => {
      expect(name).toBe('sussurro-pcm'); Processor = implementation;
    },
  });
  const processor = new Processor();
  expect(processor.process([])).toBe(true);
  const channels = [new Float32Array(128).fill(1), new Float32Array(128).fill(-0.5)];
  for (let i = 0; i < 75; i++) { processor.process([channels]); processor.port.onmessage?.({ data: 'ack' }); }
  expect(frames.map((frame) => frame.length)).toEqual([4800, 4800]);
  expect(frames[0].every((value) => value === 0.25)).toBe(true);
  const resampler = new Resampler(48000);
  const outputs = frames.map((frame) => resampler.push(frame));
  expect(outputs.map((pcm) => pcm.byteLength)).toEqual([3200, 3200]);
  expect(new DataView(outputs[0].buffer).getInt16(0, true)).toBe(8192);
});

it('stops after one unacknowledged frame instead of growing the worklet message queue', async () => {
  const messages: unknown[] = [];
  let Processor!: new () => { process(inputs: Float32Array[][]): boolean };
  const code = await readFile(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8');
  runInNewContext(code, {
    sampleRate: 16000, Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: (data: unknown) => messages.push(data) }; },
    registerProcessor: (_name: string, implementation: typeof Processor) => { Processor = implementation; },
  });
  const processor = new Processor(), channels = [new Float32Array(1600)];
  expect(processor.process([channels])).toBe(true);
  expect(processor.process([channels])).toBe(false);
  for (let i = 0; i < 100; i++) expect(processor.process([channels])).toBe(false);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toBeInstanceOf(Float32Array); expect(messages[1]).toEqual({ overflow: true });
});
