import { WhisperEngine, validateWhisper } from '../src/main/transcription/whisper.ts';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const runtime = path.resolve('resources/whisper');
await assert.rejects(validateWhisper(path.resolve('.cache/nonexistent-runtime')), /ausente\/corrompido/);
const engine = new WhisperEngine();
const start = performance.now();
try {
  await engine.start(runtime);
  const loaded = performance.now();
  // Intentionally test the private HTTP boundary without exposing it through IPC.
  const endpoint = engine.endpoint;
  const forbidden = await fetch(`${endpoint}/health`);
  assert.equal(forbidden.status, 403);
  const noLoad = await fetch(`${endpoint}/load`, { method: 'POST', headers: { Authorization: `Bearer ${engine.token}` } });
  assert.equal(noLoad.status, 404);
  const origin = await fetch(`${endpoint}/health`, { headers: { Authorization: `Bearer ${engine.token}`, Origin: 'http://example.com' } });
  assert.equal(origin.status, 403);
  const audio = new Uint8Array(await readFile('.cache/whisper/jfk.wav'));
  const result = await engine.transcribe(audio, 'en');
  assert.match(result.text.toLowerCase(), /country/);
  assert.equal(result.task, 'transcribe');
  await writeFile('docs/evidencias/T003-whisper.json', JSON.stringify({
    passed: true, fixture: 'whisper.cpp v1.8.2 samples/jfk.wav (public)', audioSeconds: 11,
    modelLoadMs: Math.round(loaded - start), inferenceMs: Math.round(performance.now() - loaded),
    textMatched: 'country', task: result.task, authorizationRequired: true, originsRejected: true, loadRouteBlocked: true,
  }, null, 2) + '\n');
  console.log('Whisper base transcreveu amostra pública. Autenticação/Origin/rotas restritas verificados.');
} finally { await engine.stop(); assert.equal(engine.running, false); }
console.log('Shutdown confirmado.');
