import type { ViewState } from './contracts';

export interface OverlayState {
  phase: 'capturing' | 'paused' | 'draining';
  text: string;
  elapsedMs: number;
}
export interface OverlayApi {
  getState(): Promise<OverlayState | null>;
  onState(callback: (state: OverlayState | null) => void): () => void;
  pause(): Promise<void>;
  openMain(): Promise<void>;
}

/** Send only a bounded text tail; never send paths, credentials or capture IDs. */
export function overlayState(state: ViewState): OverlayState | null {
  if (!state.sessionId || !['capturing', 'paused', 'draining'].includes(state.phase)) return null;
  const partials = Object.values(state.partials || {}).filter((item) => !!item?.text)
    .sort((a, b) => a!.startMs - b!.startMs).map((item) => item!.text.slice(-280));
  const confirmed = state.segments.slice(-2).map((item) => item.text.slice(-280));
  return { phase: state.phase as OverlayState['phase'], elapsedMs: state.elapsedMs,
    text: [...confirmed, ...partials].join(' ').slice(-280) };
}
