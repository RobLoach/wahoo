import { expect, test } from '@playwright/test';

// The service worker skips registration on `localhost` (the rest of the
// suite relies on that); reaching the same preview server via 127.0.0.1
// exercises the real install-precache-serve path.
const ORIGIN = 'http://127.0.0.1:4173/wahoo/';

test('one online visit is enough for full offline play', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as any).__wahooResolution = 1;
    (window as any).__wahooCpuDelay = 600_000;
    localStorage.setItem('wahoo-tour-done', '1');
    localStorage.setItem('wahoo-tips-seen', '["*"]');
  });

  // First (and only) online visit: menu only — no game screen, so the lazy
  // Pixi chunks are cached purely via the precache list, the regression that
  // once broke first-visit offline play.
  await page.goto(ORIGIN);
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg?.active) return false;
    const keys = await caches.keys();
    if (!keys.length) return false;
    const cache = await caches.open(keys[0]);
    return (await cache.keys()).length > 20; // shell + assets + lazy chunks
  }, undefined, { timeout: 20_000 });

  // Pull the plug and come back cold.
  await context.setOffline(true);
  await page.goto(ORIGIN, { waitUntil: 'load' });
  await expect(page.locator('#menu h1')).toHaveText('Wahoo');

  // A full local game must start: board canvas, cards, playable state.
  await page.click('#start-local');
  await expect(page.locator('#game:not([hidden]) .board-canvas')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('#hand .card').first()).toBeVisible();

  await context.close();
});
