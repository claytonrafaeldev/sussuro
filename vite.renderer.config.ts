import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Credentials are loaded by the main at runtime, never by the Vite pipeline.
  envDir: false,
  envPrefix: [],
  server: { host: '127.0.0.1' },
  plugins: [{
    name: 'sussurro-development-csp',
    transformIndexHtml(html) {
      // Only Vite's local development server needs HMR connections/inline CSS.
      if (command !== 'serve') return html;
      return html.replace(
        "style-src 'self'; connect-src 'none'",
        "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*",
      );
    },
  }],
}));
