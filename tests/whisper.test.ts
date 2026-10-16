import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashFile, validateWhisper, WhisperEngine } from '../src/main/transcription/whisper';

describe('Whisper resource validation', () => {
  it('rejects missing files with an actionable diagnostic', async () => {
    await expect(validateWhisper('/nonexistent-sussurro-runtime')).rejects.toThrow('ausente/corrompido');
  });
  it('rejects a manifest selecting a different model before executing a binary', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sussurro-test-'));
    try {
      await mkdir(path.join(dir, 'bin'));
      await writeFile(path.join(dir, 'bin/whisper-server'), 'not an executable runtime');
      await chmod(path.join(dir, 'bin/whisper-server'), 0o700);
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.8.2', modelSha256: 'wrong' }));
      await expect(validateWhisper(dir)).rejects.toThrow('ausente/corrompido');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('hashes file contents, not filenames', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sussurro-test-'));
    try {
      const file = path.join(dir, 'file');
      await writeFile(file, 'abc');
      expect(await hashFile(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('does not infer before preparation', async () => {
    const engine = new WhisperEngine();
    await expect(engine.transcribe(new Uint8Array(44))).rejects.toThrow('não está pronto');
    await engine.stop();
    expect(engine.running).toBe(false);
  });
});
