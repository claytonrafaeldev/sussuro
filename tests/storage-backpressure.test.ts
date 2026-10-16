import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => { if (gate.wait) await gate.wait; return fs.rename(...args); } };
});
import { SessionStore } from '../src/main/storage';
import { DEFAULT_OPTIONS, type Session } from '../src/shared/contracts';
it('bounds outstanding immutable writes on a slow disk and releases capacity after completion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sussurro-disk-limit-'));
  let release!: () => void; gate.wait = new Promise<void>(resolve => { release = resolve; });
  const store = new SessionStore(root);
  const session: Session = { schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'capturing', options: DEFAULT_OPTIONS, segments: [] };
  const pending: Promise<void>[] = [];
  try {
    for (let i = 0; i < 4; i++) pending.push(store.save(session));
    await expect(store.save(session)).rejects.toThrow('quatro escritas');
    gate.wait = null; release(); await Promise.all(pending);
    await expect(store.save(session)).resolves.toBeUndefined();
  } finally { gate.wait = null; release(); await Promise.allSettled(pending); await rm(root, { recursive: true, force: true }); }
});
