import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { endianness } from 'node:os';
import { promisify } from 'node:util';
import type { Device } from '../../shared/contracts';

const execute = promisify(execFile);
const FRAME_BYTES = 3200; // 100 ms, mono PCM16 at 16 kHz.
export async function systemDevices(signal?: AbortSignal): Promise<Device[]> {
  try {
    const { stdout } = await execute('pw-dump', [], { signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const objects: unknown = JSON.parse(stdout);
    if (!Array.isArray(objects)) throw new Error('Invalid inventory');
    const seen = new Set<string>();
    return objects.flatMap((object) => {
      const props = object?.info?.props;
      const id = props?.['node.name'];
      if (props?.['media.class'] !== 'Audio/Sink' || typeof id !== 'string' || !id ||
        id === 'auto' || id === '0' || id.startsWith('-') || /[\x00-\x1f\x7f]/.test(id) || id.length > 1024 || seen.has(id)) return [];
      seen.add(id);
      const label = props['node.description'] || props['node.nick'];
      return [{ id, label: typeof label === 'string' ? label : id }];
    });
  } catch { throw new Error('Não foi possível consultar PipeWire. Verifique pw-dump e a sessão de áudio do usuário.'); }
}

interface Capture {
  child: ChildProcess;
  closed: Promise<void>;
  isClosed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  discard: () => void;
}

async function closedWithin(capture: Capture, ms: number): Promise<boolean> {
  if (capture.isClosed) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([capture.closed.then(() => true), new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export class LinuxOutput {
  private capture: Capture | null = null;
  private generation = 0;
  private enumeration: AbortController | null = null;
  private stopping: Promise<void> = Promise.resolve();

  /** Main-process diagnostics only; not exposed over IPC. */
  get processId(): number | undefined { return this.capture?.child.pid; }

  async start(id: string, receive: (pcm: Uint8Array) => void, fail: (message: string) => void): Promise<void> {
    // Claim before waiting: an obsolete start must never replace a newer capture.
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    await this.release();
    if (!current()) return;
    if (endianness() !== 'LE') throw new Error('Captura PCM disponível apenas em plataformas little endian.');
    const enumeration = new AbortController();
    this.enumeration = enumeration;
    try {
      const devices = await systemDevices(enumeration.signal);
      if (!current()) return;
      if (!devices.some((device) => device.id === id)) throw new Error('Saída de áudio indisponível. Atualize os dispositivos.');
    } catch (error) { if (current()) throw error; else return; }
    finally { if (this.enumeration === enumeration) this.enumeration = null; }
    if (!current()) return;
    const child = spawn('pw-record', ['--target', id, '--properties', JSON.stringify({
      'stream.capture.sink': true, 'node.dont-reconnect': true, 'node.dont-fallback': true, 'application.name': 'Sussurro',
    }), '--rate', '16000', '--channels', '1', '--channel-map', 'MONO', '--format', 's16', '--raw', '-'],
    { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let closed!: () => void;
    const capture: Capture = { child, isClosed: false, closed: new Promise<void>((resolve) => { closed = resolve; }), discard: () => {} };
    this.capture = capture;
    let used = 0;
    const pending = Buffer.alloc(FRAME_BYTES);
    const error = (message: string) => {
      if (!current()) return;
      // Invalidate immediately, including when the owner does not stop on error.
      void this.stop().catch(() => fail('Não foi possível encerrar pw-record. Feche o aplicativo e confira os processos de áudio.'));
      fail(message);
    };
    const expectFrame = () => {
      clearTimeout(capture.timer);
      capture.timer = setTimeout(() => error('A saída parou de entregar áudio. Confira o dispositivo e as permissões PipeWire.'), 5000);
    };
    const onData = (data: Buffer) => {
      if (!current()) return;
      if (!Buffer.isBuffer(data) || data.length > 256 * 1024) {
        error('Fluxo da saída excedeu o limite de leitura. Capture novamente.'); return;
      }
      let offset = 0;
      while (offset < data.length && current()) {
        const length = Math.min(FRAME_BYTES - used, data.length - offset);
        data.copy(pending, used, offset, offset + length); used += length; offset += length;
        if (used === FRAME_BYTES) {
          const frame = new Uint8Array(pending); used = 0;
          expectFrame(); receive(frame);
        }
      }
    };
    capture.discard = () => {
      clearTimeout(capture.timer); capture.timer = undefined;
      child.stdout?.removeListener('data', onData);
      child.stdout?.destroy();
      pending.fill(0); used = 0;
    };
    child.stdout?.on('data', onData);
    child.once('error', () => error('Não foi possível iniciar pw-record. Confira pipewire-bin e sua sessão de áudio.'));
    child.once('close', () => {
      capture.isClosed = true; closed();
      capture.discard();
      error('Captura da saída interrompida. O dispositivo pode ter sido desconectado.');
    });
    expectFrame();
  }

  async stop(): Promise<void> { this.generation++; await this.release(); }

  private release(): Promise<void> {
    this.enumeration?.abort(); this.enumeration = null;
    const capture = this.capture; this.capture = null;
    if (capture) {
      capture.discard();
      const shutdown = async () => {
        if (capture.isClosed) return;
        // A failed spawn has no pid; Node still emits close after error.
        if (capture.child.pid && capture.child.exitCode === null && capture.child.signalCode === null) capture.child.kill('SIGTERM');
        if (await closedWithin(capture, 1000)) return;
        if (capture.child.pid) capture.child.kill('SIGKILL');
        if (!await closedWithin(capture, 1000)) throw new Error('pw-record não confirmou encerramento. Confira os processos antes de reiniciar a captura.');
      };
      this.stopping = Promise.all([this.stopping, shutdown()]).then(() => {});
    }
    return this.stopping;
  }
}
