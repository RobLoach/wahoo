import { defineConfig } from '@playwright/test';

// Runs against the production build: `npm run build` first (CI does).
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/wahoo/',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/wahoo/',
    reuseExistingServer: !process.env.CI,
  },
});
