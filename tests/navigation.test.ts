import { describe, expect, it } from 'vitest';
import { isTrustedRendererUrl } from '../src/main/navigation';

describe('document navigation boundary', () => {
  const packaged = 'file:///opt/Sussurro/resources/app.asar/.vite/renderer/main_window/index.html';

  it('allows application hash navigation', () => {
    expect(isTrustedRendererUrl(`${packaged}#inicio`, packaged)).toBe(true);
  });

  it.each([
    'https://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    `${packaged}?redirect=1`,
    'not a URL',
  ])('rejects a different document: %s', (url) => {
    expect(isTrustedRendererUrl(url, packaged)).toBe(false);
  });

  it('does not trust another path or host on the development server', () => {
    const dev = 'http://127.0.0.1:5173/';
    expect(isTrustedRendererUrl(`${dev}#inicio`, dev)).toBe(true);
    expect(isTrustedRendererUrl(`${dev}other`, dev)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', dev)).toBe(false);
  });
});
