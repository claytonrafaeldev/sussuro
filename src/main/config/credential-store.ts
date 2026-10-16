import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeepgramCredentials } from './deepgram';
import type { CredentialStatus } from '../../shared/runtime';
export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** The renderer receives only status. File contains safeStorage ciphertext, never JSON/text. */
export class CredentialStore {
  #persisted = false;
  #warning = '';
  #busy = false;
  constructor(private readonly credentials: DeepgramCredentials, private readonly file: string, private readonly storage: SecretStorage) {}
  private secure(): boolean {
    try {
      return this.storage.isEncryptionAvailable() && ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.storage.getSelectedStorageBackend());
    } catch { return false; }
  }
  status(): CredentialStatus {
    const secure = this.secure();
    return { configured: this.credentials.configured, persisted: this.#persisted, canPersist: secure,
      message: this.#warning || (!secure ? 'Proteção do sistema indisponível: chave somente na memória até fechar.' : this.#persisted ? 'Chave protegida pelo chaveiro do sistema.' : 'Chave somente na memória; salvar no chaveiro é opcional.') };
  }
  async load(): Promise<void> {
    if (!this.secure()) return;
    let handle;
    try {
      handle = await open(this.file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16384) throw new Error();
      const data = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead > 16384) throw new Error();
      if (!this.credentials.configured) {
        this.credentials.set(this.storage.decryptString(data.subarray(0, bytesRead)));
        this.#persisted = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#warning = 'Não foi possível abrir a chave salva. Configure novamente ou remova a chave.';
    } finally { await handle?.close(); }
  }
  async configure(value: unknown): Promise<CredentialStatus> {
    if (this.#busy) throw new Error('Aguarde a configuração da chave.');
    this.#busy = true;
    try {
      if (!value || typeof value !== 'object' || !('key' in value) || !('persist' in value) || typeof value.persist !== 'boolean') throw new Error('Configuração de chave inválida.');
      const candidate = new DeepgramCredentials(); candidate.set(value.key);
      const persist = value.persist && this.secure();
      let temporary: string | undefined;
      try {
        if (persist) {
          await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
          const encrypted = this.storage.encryptString(candidate.getApiKey());
          temporary = `${this.file}.${randomUUID()}.tmp`;
          const handle = await open(temporary, 'wx', 0o600);
          try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, this.file); temporary = undefined;
        } else await this.erase();
        this.credentials.set(candidate.getApiKey()); this.#persisted = persist; this.#warning = '';
      } catch { throw new Error('Não foi possível atualizar a chave protegida. Confira o chaveiro e as permissões.'); }
      finally { candidate.clear(); if (temporary) await unlink(temporary).catch(() => {}); }
      return this.status();
    } finally { this.#busy = false; }
  }
  private async erase(): Promise<void> {
    try { await unlink(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async remove(): Promise<CredentialStatus> {
    if (this.#busy) throw new Error('Aguarde a configuração da chave.');
    this.#busy = true;
    try {
      this.credentials.clear();
      try { await this.erase(); } catch {
        this.#warning = 'Chave removida da memória; arquivo protegido ainda presente. Confira as permissões antes de reiniciar.';
        throw new Error('Chave removida da memória; não foi possível excluir o arquivo protegido. Confira as permissões.');
      }
      this.#persisted = false; this.#warning = ''; return this.status();
    } finally { this.#busy = false; }
  }
}
