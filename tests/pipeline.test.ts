import { it, expect } from 'vitest';
import { AudioQueue } from '../src/main/transcription/queue';
import { Segmenter } from '../src/main/transcription/segmenter';

it('counts active work in the 30 second limit and serializes execution', async () => {
  let finish!: () => void; let running = 0, max = 0;
  const queue = new AudioQueue<{ seconds: number }>(async () => {
    running++; max = Math.max(max, running); await new Promise<void>((r) => finish = r); running--;
  }, () => {}, () => {});
  expect(queue.offer({ seconds: 10 })).toBe(true);
  expect(queue.offer({ seconds: 10 })).toBe(true);
  expect(queue.offer({ seconds: 10 })).toBe(true);
  expect(queue.offer({ seconds: 0.1 })).toBe(false);
  expect(queue.seconds).toBe(30);
  queue.clear(); finish(); await Promise.resolve(); await Promise.resolve();
  expect(max).toBe(1); expect(queue.idle).toBe(true);
});
it('keeps rejected audio for retry and bounds speech segmentation', () => {
  let ready = false, accepted = 0;
  const segmenter = new Segmenter((chunk) => { if (!ready) return false; accepted += chunk.pcm.length; return true; });
  const pcm = new Uint8Array(3200); new Int16Array(pcm.buffer).fill(1000);
  let halted = false;
  for (let i = 0; i < 100; i++) if (!segmenter.push(pcm, i * 100)) { halted = true; break; }
  expect(halted).toBe(true); expect(segmenter.seconds).toBeLessThanOrEqual(10);
  expect(accepted).toBe(0); ready = true; expect(segmenter.flush()).toBe(true);
  expect(accepted).toBeGreaterThan(0); expect(segmenter.seconds).toBe(0);
});
it('does not enqueue silence', () => {
  let accepted = false;
  const segmenter = new Segmenter(() => { accepted = true; return true; });
  for (let i = 0; i < 200; i++) segmenter.push(new Uint8Array(3200), i * 100);
  segmenter.flush(); expect(accepted).toBe(false); expect(segmenter.seconds).toBe(0);
});

it('does not carry buffered silence across a source restart or pause gap', () => {
  const chunks: { startMs: number; endMs: number }[] = [];
  const segmenter = new Segmenter((chunk) => { chunks.push(chunk); return true; });
  segmenter.push(new Uint8Array(3200), 0);
  segmenter.push(new Uint8Array(3200), 100);
  segmenter.flush();
  const speech = new Uint8Array(3200); new Int16Array(speech.buffer).fill(1000);
  for (let i = 0; i < 3; i++) segmenter.push(speech, 5000 + i * 100);
  segmenter.flush();
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ startMs: 5000, endMs: 5300 });
});
