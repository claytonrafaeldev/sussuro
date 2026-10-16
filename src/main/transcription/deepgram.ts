import WebSocket from 'ws';
import type { StreamFactory, StreamTransport, StreamFrame } from './stream';
import { STREAM_LIMITS } from './stream';

export type ProviderFault = 'auth' | 'quota' | 'network' | 'protocol';
const messages: Record<ProviderFault, string> = {
  auth: 'Chave Deepgram recusada. Confira a chave e suas permissões.',
  quota: 'Limite ou saldo Deepgram indisponível. Confira a conta do provedor.',
  network: 'Conexão Deepgram interrompida. Confira a rede e retome explicitamente.',
  protocol: 'Resposta Deepgram inválida. Captura interrompida; tente novamente.',
};
export class DeepgramError extends Error {
  constructor(readonly fault: ProviderFault) { super(messages[fault]); }
}
export function providerMessage(fault?: ProviderFault): string { return messages[fault ?? 'network']; }
export const DEEPGRAM_LANGUAGES = ['pt-BR', 'pt', 'en', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'multi'] as const;
export function deepgramUrl(language: string): string {
  if (!DEEPGRAM_LANGUAGES.includes(language as typeof DEEPGRAM_LANGUAGES[number])) throw new DeepgramError('protocol');
  const query = new URLSearchParams({ model: 'nova-3', language, encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', punctuate: 'true' });
  return `wss://api.deepgram.com/v1/listen?${query}`;
}
export type SocketFactory = (url: string, options: ConstructorParameters<typeof WebSocket>[1]) => WebSocket;
/** Only invoked on explicit start/resume/source activation. No SDK/retry/audio queue. */
export function deepgramFactory(credentials: { getApiKey(): string }, socketFactory: SocketFactory = (url, options) => new WebSocket(url, options)): StreamFactory {
  return async (_source, context) => {
    if (context.signal.aborted) throw new DeepgramError('network');
    const url = deepgramUrl(context.language);
    const key = credentials.getApiKey();
    let socket: WebSocket;
    try {
      socket = socketFactory(url, { headers: { Authorization: `Token ${key}` }, perMessageDeflate: false, maxPayload: 128 * 1024, handshakeTimeout: STREAM_LIMITS.openMs, followRedirects: false });
    } catch { throw new DeepgramError('network'); }
    return new Promise<StreamTransport>((resolve, reject) => {
      let opened = false, ended = false, finishing = false, metadata = false;
      let offset: number | undefined, sentMs = 0, timer: ReturnType<typeof setTimeout>;
      let closeResolve: (() => void) | undefined, closeReject: ((error: Error) => void) | undefined;
      let completion: Promise<void> | undefined;
      // No content of errors/headers/reasons is forwarded or logged.
      const cleanup = () => {
        clearTimeout(timer); context.signal.removeEventListener('abort', abort);
        socket.removeAllListeners(); socket.on('error', () => {});
      };
      const end = (fault?: ProviderFault) => {
        if (ended) return;
        ended = true; cleanup(); socket.terminate();
        if (!opened) reject(new DeepgramError(fault ?? 'network'));
        else if (finishing) {
          if (fault) closeReject?.(new DeepgramError(fault)); else closeResolve?.();
        } else if (fault) context.onFailure(fault);
      };
      const abort = () => end();
      const fail = (fault: ProviderFault) => end(fault);
      const send = (data: Uint8Array | string, binary: boolean) => {
        socket.send(data, { binary, compress: false }, (error) => { if (error) fail('network'); });
      };
      const transport: StreamTransport = {
        get ready() { return !ended && !finishing && socket.readyState === 1; },
        get bufferedBytes() { return ended ? 0 : socket.bufferedAmount; },
        send(frame: StreamFrame) {
          if (!transport.ready) throw new DeepgramError('network');
          offset ??= frame.startMs;
          // A new connection is required across a discontinuity; never compress a session gap silently.
          if (Math.abs(frame.startMs - (offset + sentMs)) > 5) throw new DeepgramError('protocol');
          sentMs += frame.pcm.length / 32;
          send(frame.pcm, true);
        },
        finish() {
          if (completion) return completion;
          if (ended) return Promise.reject(new DeepgramError('network'));
          finishing = true;
          completion = new Promise<void>((yes, no) => { closeResolve = yes; closeReject = no; });
          clearTimeout(timer); timer = setTimeout(() => fail('network'), STREAM_LIMITS.closeMs);
          try { send(JSON.stringify({ type: 'CloseStream' }), false); } catch { fail('network'); }
          return completion;
        },
        abort,
      };
      socket.on('open', () => {
        if (ended || context.signal.aborted) { abort(); return; }
        opened = true; clearTimeout(timer);
        // PCM silence is sent continuously. Missing capture must release the paid connection.
        timer = setTimeout(() => fail('network'), 5000);
        resolve(transport);
      });
      socket.on('unexpected-response', (_request: unknown, response: { statusCode?: number; destroy(): void }) => {
        response.destroy();
        fail(response.statusCode === 401 || response.statusCode === 403 ? 'auth' : response.statusCode === 402 || response.statusCode === 429 ? 'quota' : 'network');
      });
      socket.on('error', () => fail('network'));
      socket.on('close', (code: number) => end(finishing && metadata && code === 1000 ? undefined : 'network'));
      socket.on('message', (data: Buffer, binary: boolean) => {
        if (ended) return;
        try {
          if (binary || data.length > 128 * 1024) throw new Error();
          const value = JSON.parse(data.toString('utf8'));
          if (!value || typeof value !== 'object') throw new Error();
          if (value.type === 'Error') { fail('protocol'); return; }
          if (value.type === 'Metadata') { if (finishing) metadata = true; return; }
          if (value.type !== 'Results') return;
          const text = value.channel?.alternatives?.[0]?.transcript;
          if (typeof text !== 'string' || text.length > 32000 || typeof value.is_final !== 'boolean' ||
              !Number.isFinite(value.start) || !Number.isFinite(value.duration) || value.start < 0 || value.duration < 0 ||
              value.start * 1000 + value.duration * 1000 > sentMs + 250 || !Array.isArray(value.channel_index) || value.channel_index[0] !== 0) throw new Error();
          if (offset === undefined) return;
          const result = { id: `${value.start}:${value.duration}`, text, startMs: offset + value.start * 1000, endMs: offset + (value.start + value.duration) * 1000 };
          if (value.is_final) { context.onPartial?.(null); context.onFinal(result); }
          else context.onPartial?.(text.trim() ? result : null);
        } catch { fail('protocol'); }
      });
      // Each audio send renews a bounded capture watchdog. No idle keepalive after capture disappears.
      const originalSend = transport.send;
      transport.send = (frame) => {
        originalSend(frame);
        if (!ended) { clearTimeout(timer); timer = setTimeout(() => fail('network'), 5000); }
      };
      context.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => fail('network'), STREAM_LIMITS.openMs);
      if (context.signal.aborted) abort();
    });
  };
}
