import { open, mkdir, rename, realpath, readdir, unlink, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LANGUAGES, parseSources, validId, type Session, type SessionSummary } from '../shared/contracts';

export function validateSession(value: unknown, id: string): Session {
  const s = value as Session;
  if (!s || s.schemaVersion !== 1 || s.id !== id || !validId(id) || !s.options ||
      (s.destinationPath !== undefined && (typeof s.destinationPath !== 'string' || !path.isAbsolute(s.destinationPath) || s.destinationPath.length > 4096 || s.destinationPath.includes('\0'))) ||
      (s.audioGapCount !== undefined && (!Number.isSafeInteger(s.audioGapCount) || s.audioGapCount < 0)) ||
      typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt)) || !Array.isArray(s.segments) || s.segments.length > 10000 ||
      !s.segments.every((item) => item && typeof item.text === 'string' && item.text.length <= 50000 &&
        ['microphone', 'system'].includes(item.source) && typeof item.id === 'string' &&
        Number.isFinite(item.startMs) && item.startMs >= 0 && Number.isFinite(item.endMs) && item.endMs >= item.startMs)) throw new Error('Sessão salva inválida ou incompatível.');
  parseSources(s.options);
  if (!LANGUAGES.includes(s.options.language as typeof LANGUAGES[number]) || ![1, 2].includes(s.options.threads) ||
      (s.options.persistence !== undefined && !['saved', 'temporary'].includes(s.options.persistence)) ||
      !['idle', 'preparing', 'capturing', 'paused', 'draining', 'completed', 'error'].includes(s.status)) throw new Error('Sessão salva inválida ou incompatível.');
  return s;
}
export const formatTime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
export const sessionText = (session: Session): string => [...session.segments].sort((a, b) => a.startMs - b.startMs)
  .map((segment) => `[${formatTime(segment.startMs)}] ${segment.source === 'microphone' ? 'Microfone' : 'Computador'}: ${segment.text.trim()}`).join('\n\n');

/** Replace a complete snapshot in the same directory; a failed write leaves the previous file intact. */
export async function atomicText(file: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export class SessionStore {
  readonly directory: string;
  private pending = Promise.resolve();
  private queuedWrites = 0;
  constructor(directory: string) { this.directory = directory; }
  private file(id: string): string {
    if (!validId(id)) throw new Error('Identificador de sessão inválido.');
    return path.join(this.directory, `${id}.json`);
  }
  async save(session: Session, destination?: string | null): Promise<void> {
    if (session.options.persistence === 'temporary') return;
    if (destination && (!path.isAbsolute(destination) || destination.includes('\0') ||
        !path.relative(this.directory, destination).startsWith(`..${path.sep}`))) throw new Error('Escolha uma pasta fora do armazenamento interno do aplicativo.');
    if (this.queuedWrites >= 4) throw new Error('Salvamento lento: limite de quatro escritas pendentes atingido.');
    const file = this.file(session.id), storedSession = { ...session, destinationPath: destination || undefined }, json = JSON.stringify(storedSession), text = destination ? sessionText(session) : null;
    if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('Sessão atingiu o limite de armazenamento. Inicie uma nova sessão.');
    this.queuedWrites++;
    const operation = this.pending.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      if (destination) {
        const actualDirectory = await realpath(this.directory), target = path.join(await realpath(path.dirname(destination)), path.basename(destination));
        if (!path.relative(actualDirectory, target).startsWith(`..${path.sep}`)) throw new Error('Escolha uma pasta fora do armazenamento interno do aplicativo.');
      }
      await atomicText(file, json);
      if (destination && text !== null) await atomicText(destination, text);
    }).finally(() => { this.queuedWrites--; });
    this.pending = operation; await operation;
  }
  async read(id: string): Promise<Session> {
    const file = this.file(id);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error();
      const buffer = Buffer.alloc(metadata.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > metadata.size) throw new Error();
      return validateSession(JSON.parse(buffer.subarray(0, used).toString('utf8')), id);
    } catch { throw new Error('Não foi possível ler a sessão: arquivo ausente, inválido ou muito grande.'); }
    finally { await handle?.close(); }
  }

  async list(): Promise<SessionSummary[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const results: SessionSummary[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json') || !validId(name.slice(0, -5))) continue;
      try {
        const s = await this.read(name.slice(0, -5));
        if (!await this.hasSavedText(s)) continue;
        results.push({ id: s.id, createdAt: s.createdAt, count: s.segments.length, status: s.status });
      } catch { /* Invalid files remain on disk, never overwrite them silently. */ }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async hasSavedText(session: Session | string): Promise<boolean> {
    const value = typeof session === 'string' ? await this.read(session) : session;
    if (!value.destinationPath) return false;
    try {
      const metadata = await lstat(value.destinationPath);
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch { return false; }
  }
  async delete(id: string): Promise<void> { await this.pending.catch(() => {}); await unlink(this.file(id)); }
  async flush(): Promise<void> { await this.pending; }
}
