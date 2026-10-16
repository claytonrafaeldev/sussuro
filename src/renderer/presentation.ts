import { DEFAULT_OPTIONS, LANGUAGES, type StartOptions, type ViewState } from '../shared/contracts';

export const languageOptions = [
  ['pt-BR', 'Português brasileiro'], ['en', 'Inglês'], ['multi', 'Multilíngue · português e inglês, entre outros'],
  ['pt', 'Português'], ['es', 'Espanhol'], ['fr', 'Francês'], ['de', 'Alemão'], ['it', 'Italiano'], ['ja', 'Japonês'], ['zh', 'Chinês'],
] as const;
export const languageLabel = (language: string): string => languageOptions.find(([id]) => id === language)?.[1] || language;
export const phaseLabels = { idle: 'Pronto', preparing: 'Conectando', capturing: 'Capturando', paused: 'Pausado', draining: 'Finalizando', completed: 'Finalizado', error: 'Atenção' };
export const time = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
/** Read only known preferences. Neither corrupt storage nor extra fields become command payloads. */
export function savedOptions(value: unknown): StartOptions {
  const result = { ...DEFAULT_OPTIONS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const entry = value as Record<string, unknown>;
  for (const key of ['microphone', 'system'] as const) if (typeof entry[key] === 'boolean') result[key] = entry[key];
  for (const key of ['microphoneId', 'systemId'] as const) if (typeof entry[key] === 'string' && entry[key].length <= 512 && !/[\x00-\x1f\x7f]/.test(entry[key])) result[key] = entry[key];
  if (entry.persistence === 'saved' || entry.persistence === 'temporary') result.persistence = entry.persistence;
  if (LANGUAGES.includes(entry.language as typeof LANGUAGES[number]) && entry.language !== 'auto') result.language = entry.language as string;
  return result;
}
export function startBlocker(options: StartOptions, ready: boolean, credential: boolean | undefined, systemAvailable: boolean): string | null {
  if (!ready || credential === undefined) return 'Verificando a configuração do aplicativo…';
  if (!credential) return 'Configure sua API key para iniciar a transcrição.';
  if (!options.microphone && !options.system) return 'Ative pelo menos uma fonte de áudio.';
  if (options.system && (!options.systemId || !systemAvailable)) return 'Selecione uma saída disponível para o áudio do computador ou desative essa fonte.';
  return null;
}
export function emptyTranscript(state: ViewState, blocker: string | null, historical: boolean): { title: string; detail: string } {
  if (historical) return { title: 'Nenhum trecho nesta sessão.', detail: 'A sessão foi salva sem texto final.' };
  switch (state.phase) {
    case 'preparing': return { title: 'Conectando ao Deepgram…', detail: 'A captura só será habilitada depois da preparação. Você pode cancelar a conexão.' };
    case 'capturing': return { title: 'Aguardando suas palavras', detail: 'Acompanhe os medidores das fontes. O texto parcial pode mudar antes de ser confirmado.' };
    case 'paused': return { title: 'Captura pausada', detail: 'Nenhum áudio novo está sendo enviado. Ative uma fonte e use Retomar quando quiser.' };
    case 'draining': return { title: 'Aguardando os últimos resultados…', detail: 'A captura foi encerrada. A finalização aguarda o provedor por um prazo limitado.' };
    case 'completed': return { title: 'Sessão finalizada sem texto', detail: 'Você pode iniciar outra sessão e conferir os medidores, o idioma e a fonte selecionada.' };
    case 'error': return { title: 'Não foi possível continuar', detail: state.message };
    default: return { title: 'Este espaço vai receber suas palavras.', detail: blocker || 'Escolha uma ou duas fontes e inicie quando quiser.' };
  }
}
