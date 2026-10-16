/** Only the exact application document may navigate; hash changes are harmless. */
export function isTrustedRendererUrl(candidate: string, expected: string): boolean {
  try {
    const actualUrl = new URL(candidate);
    const expectedUrl = new URL(expected);
    actualUrl.hash = '';
    expectedUrl.hash = '';
    return actualUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}
