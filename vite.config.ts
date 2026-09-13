import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { execSync } from 'node:child_process';

/** The short git SHA, stamped into the menu footer for support questions. */
function buildStamp(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

/**
 * Emit the complete list of built files so the service worker can precache
 * everything — including lazy chunks (Pixi's renderers) that a menu-only
 * first visit would never fetch, breaking the first offline game.
 */
const assetList = (): Plugin => ({
  name: 'wahoo-asset-list',
  apply: 'build',
  generateBundle(_options, bundle) {
    this.emitFile({
      type: 'asset',
      fileName: 'asset-list.json',
      source: JSON.stringify(Object.keys(bundle).sort()),
    });
  },
});

export default defineConfig({
  base: '/wahoo/',
  define: { __WAHOO_BUILD__: JSON.stringify(buildStamp()) },
  plugins: [assetList()],
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'], // e2e/ belongs to Playwright, not vitest
  },
});
