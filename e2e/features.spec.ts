import { expect, test } from '@playwright/test';
import { burrowPos, clickBoard, forceState, startLocal, trackErrors, trackPos, view } from './helpers.ts';

test('hot-seat curtain hides the hand between human turns', async ({ page }) => {
  await startLocal(page, ['human', 'human', 'cpu-medium', 'cpu-medium'], false);
  // First human turn also starts behind the curtain.
  await expect(page.locator('.curtain-btn')).toBeVisible();
  await expect(page.locator('#hand .card')).toHaveCount(0);
  await page.click('.curtain-btn');
  await expect(page.locator('#hand .card')).toHaveCount(4);
});

test('no curtain with a single human seat', async ({ page }) => {
  await startLocal(page); // 1 human + 3 CPUs
  await expect(page.locator('#hand .card')).toHaveCount(4);
  await expect(page.locator('.curtain-btn')).toHaveCount(0);
});

test('winning shows the rematch button and restarts with fresh reserves', async ({ page }) => {
  const errors = trackErrors(page);
  await startLocal(page, ['human', 'human', 'human', 'human']);
  // Red & Green have 7 bunnies home; the last one sits one step from slot 0.
  await forceState(page, {
    current: 0,
    hand: [{ id: 0, rank: 'A', suit: '♠' }],
    bunnies: [
      ...[0, 1, 2, 3].map(id => ({ id, place: { kind: 'burrow', slot: id } })),
      ...[8, 9, 10].map(id => ({ id, place: { kind: 'burrow', slot: id - 7 } })),
      { id: 11, place: { kind: 'track', index: 39 } }, // seat 2 dist 79: an A reaches slot 0
    ],
  });
  await page.click('#hand .card'); // seat 0 controls the teammate
  await clickBoard(page, await trackPos(page, 39)); // pick the last bunny
  await clickBoard(page, await burrowPos(page, 2, 0)); // step it home
  await expect(page.locator('#status')).toContainText('wins');
  await expect(page.locator('#btn-again')).toBeVisible();
  await page.click('#btn-again');
  await expect(page.locator('#status')).toContainText('Round 1');
  const v = await view(page);
  expect(v.winner).toBeNull();
  expect(v.bunnies.every((b: any) => b.place.kind === 'reserve')).toBe(true);
  expect(errors).toEqual([]);
});

test('?join=CODE prefills the room code', async ({ page }) => {
  await page.goto('./?join=zzzzz');
  await expect(page.locator('#p2p-code')).toHaveValue('ZZZZZ');
});

test('PWA manifest and service worker are served', async ({ page, request, baseURL }) => {
  const manifest = await request.get(`${baseURL}manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).name).toBe('Wahoo');
  const sw = await request.get(`${baseURL}sw.js`);
  expect(sw.ok()).toBe(true);
  const icon = await request.get(`${baseURL}icons/icon-192.png`);
  expect(icon.ok()).toBe(true);
  await page.goto('./');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');
});
