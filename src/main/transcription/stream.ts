import type { SourceId } from '../../shared/contracts';

export const STREAM_LIMITS = Object.freeze({ sourceBytes: 64_000, totalBytes: 128_000, frameBytes: 3_200, upstreamBytes: 6_400, sendOverhead: 32, closeMs: 2_000, openMs: 5_000 });
export interface StreamFrame { pcm: Uint8Array; startMs: number; endMs: number }
/** bufferedBytes includes ALL retained bytes (adapter + socket), including in-flight writes.
 * send is synchronous, non-reentrant and queues at most this frame; no hidden retry queue.
 * abort must synchronously prevent further writes and release buffers/listeners.
 * finish resolves only after final events/closure. The owner aborts it after closeMs.
 */
export interface StreamTransport {
  readonly ready: boolean;
  readonly bufferedBytes: number;
  send(frame: StreamFrame): void;
  finish(): Promise<void>;
  abort(): void;
}
export interface StreamContext {
  sessionId: string; language: string; signal: AbortSignal;
  onFinal: (result: { id: string; text: string; startMs: number; endMs: number }) => void;
  onPartial?: (result: { text: string; startMs: number; endMs: number } | null) => void;
  onFailure: (fault?: import('./deepgram').ProviderFault) => void;
}
export type StreamFactory = (source: SourceId, context: StreamContext) => Promise<StreamTransport>;
export const unavailableStream: StreamFactory = async () => { throw new Error('A transcrição por streaming ainda está indisponível. A integração Deepgram é a próxima etapa.'); };
export type StreamFault = 'limit' | 'connection' | 'send' | 'accounting' | 'order';
interface Slot { transport: StreamTransport; lastEnd: number }
const sources: SourceId[] = ['microphone', 'system'];

/** No application audio queue: each 100 ms frame goes straight to the transport. */
export class StreamingAudio {
  private slots = new Map<SourceId, Slot>();
  private halted = false;
  constructor(private readonly fault: (reason: StreamFault) => void) {}
  attach(source: SourceId, transport: StreamTransport): void {
    if (this.halted || this.slots.has(source)) { transport.abort(); throw new Error('Fluxo já encerrado ou ocupado.'); }
    this.slots.set(source, { transport, lastEnd: -1 });
  }
  has(source: SourceId): boolean { return this.slots.has(source); }
  get pendingBytes(): Record<SourceId, number> {
    const result = { microphone: 0, system: 0 };
    for (const source of sources) {
      const n = this.slots.get(source)?.transport.bufferedBytes ?? 0;
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('Contagem de transporte inválida.');
      result[source] = n;
    }
    return result;
  }
  check(): boolean {
    if (this.halted) return false;
    try {
      const bytes = this.pendingBytes;
      if (bytes.microphone > STREAM_LIMITS.sourceBytes || bytes.system > STREAM_LIMITS.sourceBytes || bytes.microphone + bytes.system > STREAM_LIMITS.totalBytes) return this.fail('accounting');
      for (const { transport } of this.slots.values()) if (!transport.ready) return this.fail('connection');
      return true;
    } catch { return this.fail('accounting'); }
  }
  offer(source: SourceId, frame: StreamFrame): boolean {
    if (this.halted) return false;
    const slot = this.slots.get(source);
    if (!slot) return false;
    if (!this.check()) return false;
    if (!(frame.pcm instanceof Uint8Array) || !frame.pcm.length || frame.pcm.length > STREAM_LIMITS.frameBytes || frame.pcm.length % 2 ||
        !Number.isFinite(frame.startMs) || frame.startMs < 0 || frame.startMs < slot.lastEnd - 5 || frame.endMs !== frame.startMs + frame.pcm.length / 32) return this.fail('order');
    const bytes = this.pendingBytes;
    const reservation = frame.pcm.length + STREAM_LIMITS.sendOverhead;
    const upstream = STREAM_LIMITS.upstreamBytes;
    if (bytes[source] + reservation + upstream > STREAM_LIMITS.sourceBytes || bytes.microphone + bytes.system + reservation + 2 * upstream > STREAM_LIMITS.totalBytes) return this.fail('limit');
    try {
      // The capture owns only this bounded frame; ownership passes to the adapter.
      slot.transport.send(frame);
      slot.lastEnd = frame.endMs;
      return this.check();
    } catch { return this.fail('send'); }
  }
  private fail(reason: StreamFault): false {
    if (!this.halted) { this.halted = true; this.fault(reason); }
    return false;
  }
  detach(source: SourceId): StreamTransport | undefined {
    const slot = this.slots.get(source); this.slots.delete(source); return slot?.transport;
  }
  abort(): void {
    this.halted = true;
    const slots = [...this.slots.values()]; this.slots.clear();
    for (const { transport } of slots) { try { transport.abort(); } catch { /* Continue releasing other sources. */ } }
  }
}

export async function openStream(factory: StreamFactory, source: SourceId, context: StreamContext): Promise<StreamTransport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let rejectAbort!: () => void;
  const abort = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('Abertura de fluxo cancelada.')); });
  context.signal.addEventListener('abort', rejectAbort, { once: true });
  if (context.signal.aborted) rejectAbort();
  const opening = Promise.resolve().then(() => {
    if (context.signal.aborted) throw new Error('Abertura de fluxo cancelada.');
    return factory(source, context);
  }).then((transport) => {
    if (expired || context.signal.aborted) { transport.abort(); throw new Error('Abertura de fluxo cancelada.'); }
    return transport;
  });
  try {
    return await Promise.race([opening, abort, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('A conexão não respondeu em cinco segundos.')), STREAM_LIMITS.openMs);
    })]);
  } catch (error) { expired = true; throw error; }
  finally { clearTimeout(timer); context.signal.removeEventListener('abort', rejectAbort); }
}

export async function finishStream(transport: StreamTransport, signal: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const cancelled = new Promise<false>((resolve) => { cancel = () => resolve(false); });
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let result = false;
  try {
    result = await Promise.race([cancelled, Promise.resolve().then(() => {
      if (signal.aborted) return false;
      return transport.finish().then(() => true);
    }), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), STREAM_LIMITS.closeMs); })]);
  } catch { result = false; }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
    try { transport.abort(); } catch { result = false; }
  }
  return result;
}
