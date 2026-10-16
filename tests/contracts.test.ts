import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, parseOptions, parseSources, parseFrame, assertTransition } from '../src/shared/contracts';

describe('validated IPC payloads and state transitions', () => {
  it('accepts explicit microphone and CPU configuration', () => expect(parseOptions(DEFAULT_OPTIONS)).toEqual(DEFAULT_OPTIONS));
  it.each([null, {}, { ...DEFAULT_OPTIONS, threads: 4 }, { ...DEFAULT_OPTIONS, language: 'translate' },
    { ...DEFAULT_OPTIONS, microphone: false }, { ...DEFAULT_OPTIONS, system: true },
    { ...DEFAULT_OPTIONS, microphone: 'true' }, { ...DEFAULT_OPTIONS, persistence: 'unknown' }])('rejects invalid settings', (value) => expect(() => parseOptions(value)).toThrow());
  it('bounds PCM and rejects invalid session identity/timestamps', () => {
    const frame = { captureId: '12345678-1234-1234-1234-123456789abc', sessionId: '12345678-1234-1234-1234-123456789abc', sequence: 0, startMs: 0, pcm: new Uint8Array(3200) };
    expect(parseFrame(frame).pcm.length).toBe(3200);
    for (const bad of [{ ...frame, pcm: new Uint8Array(32002) }, { ...frame, startMs: NaN }, { ...frame, sessionId: '../private' }, { ...frame, sequence: -1 }, { ...frame, captureId: null }, { ...frame, captureId: 'invalid' }]) expect(() => parseFrame(bad)).toThrow();
  });
  it('prevents resume from starting without preparation', () => {
    expect(() => assertTransition('idle', 'capturing')).toThrow();
    expect(() => assertTransition('paused', 'capturing')).not.toThrow();
  });
});

it('validates device changes independently of the start-only no-source restriction', () => {
  expect(parseSources({ microphone: false, system: false, microphoneId: 'mic-b', systemId: 'out-b', threads: 99 })).toEqual({ microphone: false, system: false, microphoneId: 'mic-b', systemId: 'out-b' });
  for (const bad of [null, {}, { microphone: true, system: false, microphoneId: {} }, { microphone: false, system: true, systemId: 'x'.repeat(513) }, { microphone: false, system: false, systemId: 'bad\nname' }]) expect(() => parseSources(bad)).toThrow();
});
