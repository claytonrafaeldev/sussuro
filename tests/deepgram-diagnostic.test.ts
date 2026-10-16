import { expect, it } from 'vitest';
import { parseDiagnosticArgs, parseDiagnosticWav } from '../src/main/diagnostics/deepgram-check';
function wav(bytes = 3200) {
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(bytes, 40); return data;
}
it('requires explicit public-audio consent and a supported acceptance language before any file/network access', () => {
  const valid = ['--language', 'pt-BR', '--wav', '/sample.wav', '--confirm-public-audio'];
  expect(parseDiagnosticArgs(valid)).toEqual({ language: 'pt-BR', file: '/sample.wav' });
  for (const args of [valid.slice(0, -1), [...valid, '--unknown'], [...valid, '--wav', '/other.wav'], ['--wav', '/sample.wav', '--confirm-public-audio'], ['--wav', '/sample.wav', '--language', 'auto', '--confirm-public-audio']]) {
    expect(() => parseDiagnosticArgs(args)).toThrow();
  }
});
it('accepts bounded PCM, rejects wrong rates/channels/encoding, inconsistent headers and oversized/truncated audio', () => {
  expect(parseDiagnosticWav(wav())).toHaveLength(3200);
  for (const [position, value] of [[20, 3], [22, 2], [24, 48000], [32, 4], [34, 8]]) {
    const data = wav(); data.writeUInt16LE(value, position); expect(() => parseDiagnosticWav(data)).toThrow();
  }
  for (const data of [Buffer.alloc(0), wav().subarray(0, 43), wav(0), wav(3), wav(960002), Buffer.alloc(1000001)]) {
    expect(() => parseDiagnosticWav(data)).toThrow();
  }
  const bad = wav(); bad.writeUInt32LE(999999, 40); expect(() => parseDiagnosticWav(bad)).toThrow();
});
it('ignores RIFF metadata with proper padding while refusing duplicate audio or fmt chunks', () => {
  const original = wav();
  const junk = Buffer.from([74,85,78,75,1,0,0,0,42,0]);
  const metadata = Buffer.concat([original.subarray(0, 12), junk, original.subarray(12)]);
  metadata.writeUInt32LE(metadata.length - 8, 4);
  expect(parseDiagnosticWav(metadata)).toHaveLength(3200);
  const duplicate = Buffer.concat([original, original.subarray(36)]); duplicate.writeUInt32LE(duplicate.length - 8, 4);
  expect(() => parseDiagnosticWav(duplicate)).toThrow();
});
