import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeepgramCredentials } from '../src/main/config/deepgram';
import { CredentialStore } from '../src/main/config/credential-store';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'sussurro-credentials-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture(backend = 'gnome_libsecret') {
  const key = new DeepgramCredentials();
  // Cipher stub: assert the production store delegates to safeStorage. This is not a keyring test.
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
    encryptString: vi.fn((_value: string) => Buffer.from([1, 5, 9])), decryptString: vi.fn((_value: Buffer) => 'synthetic-key') };
  const file = path.join(directory, 'key.enc');
  return { key, storage, file, store: new CredentialStore(key, file, storage) };
}
it('persists ciphertext only, uses restricted permissions and loads/removes via the protected backend', async () => {
  const t = fixture();
  expect(await t.store.configure({ key: 'synthetic-key', persist: true })).toMatchObject({ configured: true, persisted: true, canPersist: true });
  expect(t.storage.encryptString).toHaveBeenCalledWith('synthetic-key');
  expect(await readFile(t.file)).toEqual(Buffer.from([1, 5, 9])); expect((await stat(t.file)).mode & 0o777).toBe(0o600);
  t.key.clear(); await t.store.load(); expect(t.key.getApiKey()).toBe('synthetic-key');
  expect(JSON.stringify(t.store.status())).not.toContain('synthetic-key');
  await t.store.remove(); expect(t.key.configured).toBe(false); expect(await readdir(directory)).toEqual([]);
});
it.each(['basic_text', 'unknown', 'kwallet7', ''])('never persists with insecure/unrecognized backend %s and deletes an older file', async (backend) => {
  const t = fixture(backend); await writeFile(t.file, Buffer.from([1, 5, 9]));
  await t.store.load(); expect(t.storage.decryptString).not.toHaveBeenCalled();
  expect(await t.store.configure({ key: 'synthetic-key', persist: true })).toMatchObject({ configured: true, persisted: false, canPersist: false });
  expect(await readdir(directory)).toEqual([]); expect(t.storage.encryptString).not.toHaveBeenCalled();
  expect(t.key.getApiKey()).toBe('synthetic-key');
});
it('keeps the previous key on failed encryption, sanitizes errors and leaves no temporary file', async () => {
  const t = fixture(); t.key.set('synthetic-old'); t.storage.encryptString.mockImplementation(() => { throw new Error('synthetic-secret'); });
  await expect(t.store.configure({ key: 'synthetic-key', persist: true })).rejects.toThrow('Não foi possível atualizar');
  expect(t.key.getApiKey()).toBe('synthetic-old'); expect(await readdir(directory)).toEqual([]);
});
it('refuses invalid payloads and serializes credential changes', async () => {
  const t = fixture();
  for (const value of [{ key: 'synthetic\nkey', persist: false }, { key: 7, persist: false }, { key: 'x'.repeat(513), persist: true }, { key: 'x', persist: 'true' }, null]) {
    await expect(t.store.configure(value)).rejects.toThrow();
  }
  const changing = t.store.configure({ key: 'synthetic-key', persist: true });
  await expect(t.store.remove()).rejects.toThrow('Aguarde'); await changing;
});
it('keeps the configured development key ahead of persisted credentials and handles corrupt files safely', async () => {
  const t = fixture(); await writeFile(t.file, Buffer.from([1, 5, 9])); t.key.set('synthetic-env'); await t.store.load();
  expect(t.key.getApiKey()).toBe('synthetic-env'); expect(t.storage.decryptString).not.toHaveBeenCalled();
  t.key.clear(); t.storage.decryptString.mockImplementation(() => { throw new Error('synthetic-secret'); }); await t.store.load();
  expect(t.store.status()).toMatchObject({ configured: false }); expect(t.store.status().message).toContain('Não foi possível abrir');
  expect(t.store.status().message).not.toContain('synthetic-secret');
});

it('keeps a visible warning when removal clears memory but cannot erase the protected file', async () => {
  const t = fixture(); t.key.set('synthetic-memory-key'); await mkdir(t.file);
  await expect(t.store.remove()).rejects.toThrow('removida da memória');
  expect(t.key.configured).toBe(false);
  expect(t.store.status().message).toContain('arquivo protegido ainda presente');
  expect(JSON.stringify(t.store.status())).not.toContain('synthetic-memory-key');
});
