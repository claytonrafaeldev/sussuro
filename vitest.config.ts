import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false, envPrefix: [],
  test: { environment: 'node', include: ['tests/**/*.test.ts'], maxWorkers: 1 },
});
