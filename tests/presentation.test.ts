import { expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/shared/contracts';
import { savedOptions, startBlocker } from '../src/renderer/presentation';

it('rejects corrupt stored controls and excludes unknown fields before a capture command is constructed', () => {
  for (const value of [null, [], 23, 'bad']) expect(savedOptions(value)).toEqual(DEFAULT_OPTIONS);
  expect(savedOptions({ microphone: 'false', system: {}, microphoneId: 12, systemId: '\u0000bad', language: 'unsupported', threads: 999, key: 'synthetic-secret' })).toEqual(DEFAULT_OPTIONS);
  const options = savedOptions({ microphone: false, system: true, microphoneId: 'chosen', systemId: 'output', language: 'en', threads: 2, extra: true });
  expect(options).toEqual({ ...DEFAULT_OPTIONS, microphone: false, system: true, microphoneId: 'chosen', systemId: 'output', language: 'en' });
  expect(savedOptions({ persistence: 'temporary' }).persistence).toBe('temporary');
  expect(savedOptions({ persistence: 'invalid' }).persistence).toBe('saved');
  expect(savedOptions({ language: 'auto' }).language).toBe('pt-BR');
  expect(savedOptions({ systemId: 'x'.repeat(513) }).systemId).toBe('');
  expect(savedOptions({ microphone: false, system: false })).toMatchObject({ microphone: false, system: false });
});
it('blocks start until ready/key/source checks pass without making an unselected output mandatory for microphone-only capture', () => {
  const microphone = { ...DEFAULT_OPTIONS }, system = { ...DEFAULT_OPTIONS, microphone: false, system: true, systemId: 'output' };
  expect(startBlocker(microphone, true, true, false)).toBeNull();
  expect(startBlocker(system, true, true, true)).toBeNull();
  expect(startBlocker({ ...system, microphone: true }, true, true, true)).toBeNull();
  for (const [ready, key, available] of [[false, true, true], [true, undefined, true], [true, false, true], [true, true, false]] as const) {
    expect(startBlocker(system, ready, key, available)).not.toBeNull();
  }
  expect(startBlocker({ ...system, systemId: '' }, true, true, true)).not.toBeNull();
  expect(startBlocker({ ...microphone, microphone: false }, true, true, true)).not.toBeNull();
});
