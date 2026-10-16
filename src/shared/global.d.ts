import type { SussurroApi } from './runtime';

declare global {
  interface Window { sussurro: SussurroApi; sussurroOverlay?: import('./overlay').OverlayApi }
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

export {};
