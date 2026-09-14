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
    // --host: the offline spec needs 127.0.0.1 (the service worker skips
    // registering on the literal hostname `localhost`).
    command: 'npx vite preview --port 4173 --strictPort --host',
    url: 'http://localhost:4173/wahoo/',
    reuseExistingServer: !process.env.CI,
  },
});
