import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, stat, readFile, readdir, mkdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore, sessionText } from '../src/main/storage';
import { DEFAULT_OPTIONS, type Session } from '../src/shared/contracts';

it('saves/reopens/exports/deletes sessions atomically without raw audio', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sussurro-store-'));
  try {
    const store = new SessionStore(directory);
    const destination = path.join(directory, '..', `${path.basename(directory)}.txt`);
    const session: Session = { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'completed', options: DEFAULT_OPTIONS,
      segments: [{ id: randomUUID(), source: 'microphone', startMs: 1000, endMs: 2000, text: 'Olá, computador.' }] };
    await store.save(session, destination);
    expect(await store.read(session.id)).toMatchObject({ ...session, destinationPath: destination });
    expect((await store.list())[0].count).toBe(1);
    expect(sessionText(session)).toBe('[00:00:01] Microfone: Olá, computador.');
    expect((await stat(path.join(directory, `${session.id}.json`))).mode & 0o777).toBe(0o600);
    await expect(store.read('../outside')).rejects.toThrow();
    const corrupt = randomUUID(); await writeFile(path.join(directory, `${corrupt}.json`), 'not JSON');
    await expect(store.read(corrupt)).rejects.toThrow('inválido');
    expect(await store.list()).toHaveLength(1);
    await store.delete(session.id); expect(await store.list()).toHaveLength(0);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(path.join(directory, '..', `${path.basename(directory)}.txt`), { force: true }); }
});

it('lists a session only while its chosen transcript file still exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sussurro-history-files-'));
  try {
    const store = new SessionStore(path.join(root, 'history'));
    const id = randomUUID(), destination = path.join(root, 'saved.txt');
    const session: Session = { schemaVersion: 1, id, createdAt: new Date().toISOString(), status: 'completed', options: { ...DEFAULT_OPTIONS }, segments: [] };
    await store.save(session);
    expect(await store.list()).toEqual([]);
    await store.save(session, destination);
    expect((await store.list()).map((item) => item.id)).toEqual([id]);
    await unlink(destination);
    expect(await store.list()).toEqual([]);
    await expect(store.hasSavedText(id)).resolves.toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('writes immutable queued snapshots and chosen TXT; failed destination remains recoverable in history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sussurro-autosave-'));
  try {
    const store = new SessionStore(path.join(root, 'history')), destination = path.join(root, 'transcript.txt');
    const session: Session = { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'paused', options: { ...DEFAULT_OPTIONS }, segments: [] };
    const first = store.save(session, destination);
    session.segments.push({ id: randomUUID(), source: 'system', startMs: 2000, endMs: 3000, text: 'Second snapshot' });
    const second = store.save(session, destination); await Promise.all([first, second]);
    expect(await readFile(destination, 'utf8')).toBe('[00:00:02] Computador: Second snapshot');
    await mkdir(path.join(root, 'blocked'));
    await writeFile(path.join(root, 'blocked', 'keep'), 'preserved');
    await expect(store.save(session, path.join(root, 'blocked'))).rejects.toThrow();
    expect((await store.read(session.id)).segments).toEqual(session.segments);
    expect(await readFile(path.join(root, 'blocked', 'keep'), 'utf8')).toBe('preserved');
    expect((await readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false);
    await expect(store.save(session, path.join(root, 'history', 'bad.txt'))).rejects.toThrow('fora');
    await store.save(session, destination); await store.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('never creates history or destination files for a temporary session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sussurro-temporary-'));
  try {
    const store = new SessionStore(path.join(root, 'history'));
    await store.save({ schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'completed', options: { ...DEFAULT_OPTIONS, persistence: 'temporary' }, segments: [] }, path.join(root, 'not-created.txt'));
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects malformed saved options/status and ignores interrupted temporary files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sussurro-invalid-store-'));
  try {
    const store = new SessionStore(root), id = randomUUID();
    const base = { schemaVersion: 1, id, createdAt: new Date().toISOString(), status: 'completed', options: DEFAULT_OPTIONS, segments: [] };
    await writeFile(path.join(root, `${id}.json`), JSON.stringify({ ...base, options: { ...DEFAULT_OPTIONS, persistence: 'unexpected' } }));
    await expect(store.read(id)).rejects.toThrow('inválido');
    await writeFile(path.join(root, `${id}.json`), JSON.stringify({ ...base, status: 'unexpected' }));
    await expect(store.read(id)).rejects.toThrow('inválido');
    await writeFile(path.join(root, `.${randomUUID()}.tmp`), '{incomplete');
    expect(await store.list()).toEqual([]);
    const legacy = { ...base, options: { ...DEFAULT_OPTIONS, microphone: false, system: false } };
    delete (legacy.options as Partial<typeof DEFAULT_OPTIONS>).persistence;
    await writeFile(path.join(root, `${id}.json`), JSON.stringify(legacy));
    expect((await store.read(id)).options.microphone).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses symbolic history reads and a destination aliased into the private history directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sussurro-history-alias-'));
  try {
    const directory = path.join(root, 'history'); await mkdir(directory);
    const store = new SessionStore(directory), id = randomUUID();
    await writeFile(path.join(root, 'outside.json'), '{}');
    await symlink(path.join(root, 'outside.json'), path.join(directory, `${id}.json`));
    await expect(store.read(id)).rejects.toThrow('inválido');
    const alias = path.join(root, 'alias'); await symlink(directory, alias);
    const session: Session = { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'completed', options: DEFAULT_OPTIONS, segments: [] };
    await expect(store.save(session, path.join(alias, 'bad.txt'))).rejects.toThrow('fora');
  } finally { await rm(root, { recursive: true, force: true }); }
});
