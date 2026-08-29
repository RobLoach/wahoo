import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/wahoo/',
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'], // e2e/ belongs to Playwright, not vitest
  },
});
