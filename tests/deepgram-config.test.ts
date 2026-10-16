import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DeepgramCredentials } from '../src/main/config/deepgram';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'sussurro-deepgram-config-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const options = (env: NodeJS.ProcessEnv = {}, isPackaged = false) => ({ appPath: directory, isPackaged, env });

it('reads only the selected key from a development .env without mutating process environment', async () => {
  const credentials = new DeepgramCredentials(), env = { PATH: '/existing' };
  await writeFile(path.join(directory, '.env'), '# local fixture\nDEEPGRAM_API_KEY="synthetic-key"\nNODE_OPTIONS=--inspect\nPATH=/injected\n');
  await credentials.load(options(env));
  expect(credentials.configured).toBe(true);
  expect(credentials.getApiKey()).toBe('synthetic-key');
  expect(env).toEqual({ PATH: '/existing' });
  expect(JSON.stringify(credentials)).not.toContain('synthetic-key');
});
it('prioritizes the explicit environment and removes the token before subprocesses can inherit it', async () => {
  const credentials = new DeepgramCredentials();
  await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=synthetic-file-key');
  const env: NodeJS.ProcessEnv = { DEEPGRAM_API_KEY: 'synthetic-env-key', PATH: '/existing' };
  await credentials.load(options(env));
  expect(credentials.getApiKey()).toBe('synthetic-env-key');
  expect(env).toEqual({ PATH: '/existing' });
  credentials.clear(); expect(credentials.configured).toBe(false);
  expect(() => credentials.getApiKey()).toThrow('Configure DEEPGRAM_API_KEY');
});
it('does not search the working directory or read .env in a packaged application', async () => {
  const credentials = new DeepgramCredentials();
  await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=synthetic-file-key');
  await credentials.load(options({}, true));
  expect(credentials.configured).toBe(false);
  await credentials.load(options({ DEEPGRAM_API_KEY: 'synthetic-env-key' }, true));
  expect(credentials.getApiKey()).toBe('synthetic-env-key');
});
it('allows missing/empty configuration without starting any network connection', async () => {
  const credentials = new DeepgramCredentials();
  await credentials.load(options()); expect(credentials.configured).toBe(false);
  await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=\n');
  await credentials.load(options()); expect(credentials.configured).toBe(false);
});
it('lets an explicitly empty environment value disable the file key and clears an older key', async () => {
  const credentials = new DeepgramCredentials();
  await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=synthetic-file-key');
  await credentials.load(options()); expect(credentials.configured).toBe(true);
  await credentials.load(options({ DEEPGRAM_API_KEY: '' }));
  expect(credentials.configured).toBe(false);
});
it.each(['synthetic\r\nInjected: unsafe', 'synthetic key', 'synthetic\u0000key', 'á'.repeat(10), 'x'.repeat(513)])('rejects unsafe tokens without including the value in the error', async (key) => {
  const credentials = new DeepgramCredentials(), env = { DEEPGRAM_API_KEY: key };
  try { await credentials.load(options(env)); throw new Error('Expected rejection'); }
  catch (error) {
    expect((error as Error).message).toBe('DEEPGRAM_API_KEY inválida. Confira a configuração local sem compartilhar a chave.');
    expect(String(error)).not.toContain(key);
  }
  expect(env).not.toHaveProperty('DEEPGRAM_API_KEY'); expect(credentials.configured).toBe(false);
});
it('rejects an oversized file and a directory with a sanitized error', async () => {
  const credentials = new DeepgramCredentials(), file = path.join(directory, '.env');
  await writeFile(file, 'synthetic-key'.repeat(6000));
  await expect(credentials.load(options())).rejects.toThrow('Não foi possível ler o .env');
  await rm(file); await mkdir(file);
  await expect(credentials.load(options())).rejects.toThrow('Não foi possível ler o .env');
});
it('prefers .env.local over .env and preserves the local file contents', async () => {
  const credentials = new DeepgramCredentials();
  const local = 'DEEPGRAM_API_KEY=synthetic-local-key\n';
  await writeFile(path.join(directory, '.env.local'), local);
  await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=synthetic-base-key');
  await credentials.load(options());
  expect(credentials.getApiKey()).toBe('synthetic-local-key');
  await credentials.load(options({ DEEPGRAM_API_KEY: 'synthetic-env-key' }));
  expect(credentials.getApiKey()).toBe('synthetic-env-key');
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(path.join(directory, '.env.local'), 'utf8')).toBe(local);
  await credentials.load(options({}, true));
  expect(credentials.configured).toBe(false);
});
it('allows an explicitly blank .env.local key to disable a base file key', async () => {
  const credentials = new DeepgramCredentials();
  await writeFile(path.join(directory, '.env.local'), 'DEEPGRAM_API_KEY=\n');
  await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=synthetic-base-key');
  await credentials.load(options());
  expect(credentials.configured).toBe(false);
});
it('falls back to .env if .env.local has no key without importing unrelated variables', async () => {
  const credentials = new DeepgramCredentials(), env = {};
  await writeFile(path.join(directory, '.env.local'), 'UNRELATED=synthetic-value');
  await writeFile(path.join(directory, '.env'), 'DEEPGRAM_API_KEY=synthetic-base-key');
  await credentials.load(options(env));
  expect(credentials.getApiKey()).toBe('synthetic-base-key');
  expect(env).toEqual({});
});
