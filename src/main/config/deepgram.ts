import { open } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

const INVALID_KEY = 'DEEPGRAM_API_KEY inválida. Confira a configuração local sem compartilhar a chave.';
const INVALID_FILE = 'Não foi possível ler o .env do projeto. Confira o arquivo e suas permissões.';
const MAX_ENV_BYTES = 64 * 1024;

/** Main-only credentials. Private fields prevent accidental serialization in state or logs. */
export class DeepgramCredentials {
  #apiKey: string | undefined;

  get configured(): boolean { return this.#apiKey !== undefined; }
  getApiKey(): string {
    if (!this.#apiKey) throw new Error('Configure DEEPGRAM_API_KEY no .env de desenvolvimento ou a chave nas configurações do aplicativo.');
    return this.#apiKey;
  }
  set(value: unknown): void {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 512 || !/^[\x21-\x7e]+$/.test(value.trim())) throw new Error(INVALID_KEY);
    this.#apiKey = value.trim();
  }
  clear(): void { this.#apiKey = undefined; }

  async load(options: { appPath: string; isPackaged: boolean; env?: NodeJS.ProcessEnv }): Promise<void> {
    this.clear();
    const env = options.env ?? process.env;
    const supplied = env.DEEPGRAM_API_KEY;
    // Keep the secret out of later subprocess environments (including renderer/capture).
    delete env.DEEPGRAM_API_KEY;
    let value = supplied;
    if (value === undefined && !options.isPackaged) {
      value = await this.readDevelopmentFile(path.join(options.appPath, '.env.local'));
      if (value === undefined) value = await this.readDevelopmentFile(path.join(options.appPath, '.env'));
    }
    if (value === undefined || value.trim() === '') return;
    const key = value.trim();
    // Opaque token: validate header safety, not an undocumented provider key length/shape.
    if (key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) throw new Error(INVALID_KEY);
    this.#apiKey = key;
  }

  private async readDevelopmentFile(file: string): Promise<string | undefined> {
    let handle;
    try {
      handle = await open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ENV_BYTES) throw new Error(INVALID_FILE);
      const buffer = Buffer.alloc(MAX_ENV_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > MAX_ENV_BYTES) throw new Error(INVALID_FILE);
      // Parse into an isolated object: never inject .env entries into process.env or Vite.
      return parseEnv(buffer.subarray(0, used).toString('utf8')).DEEPGRAM_API_KEY;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      // Do not forward parser/OS errors: they may contain the file content or key.
      throw new Error(INVALID_FILE);
    } finally { await handle?.close(); }
  }
}

export const deepgramCredentials = new DeepgramCredentials();
