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
  await expect(page.locator('#status')).toContainText('win the game');
  await expect(page.locator('#btn-again')).toBeVisible();
  await page.click('#btn-again');
  await expect(page.locator('#status')).toContainText('Round 1');
  const v = await view(page);
  expect(v.winner).toBeNull();
  expect(v.bunnies.every((b: any) => b.place.kind === 'reserve')).toBe(true);
  expect(errors).toEqual([]);
});

test('a local game survives a page reload via Resume', async ({ page }) => {
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await page.evaluate(() => {
    const w = (window as any).__wahoo;
    const v = w.app.view;
    w.app.submit(v.legal[Math.floor(Math.random() * v.legal.length)]);
  });
  const before = await view(page);
  await page.reload();
  const resume = page.locator('#local-resume');
  await expect(resume).toBeVisible();
  await resume.click();
  await page.waitForSelector('#game:not([hidden]) .board-canvas');
  const after = await page.evaluate(() => (window as any).__wahoo.app.view);
  expect(after.log).toEqual(before.log);
  expect(after.round).toBe(before.round);
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

test('house rules from the menu reach the game state', async ({ page }) => {
  await page.goto('./');
  await page.uncheck('#hr-ff');
  await page.selectOption('#hr-seven', '4');
  await page.evaluate(() => ((window as any).__wahooCpuDelay = 60_000));
  await page.click('#start-local');
  await page.waitForSelector('#game:not([hidden]) .board-canvas');
  const rules = await page.evaluate(() => (window as any).__wahoo.app.view.rules);
  expect(rules).toEqual({ friendlyFire: false, sevenMaxBunnies: 4, burrowJump: false, finger: true });
  // The choice persists for next time.
  const saved = await page.evaluate(() => localStorage.getItem('wahoo-rules'));
  expect(JSON.parse(saved!)).toMatchObject({ friendlyFire: false, sevenMaxBunnies: 4 });
});

test('first local game shows the tour once', async ({ page }) => {
  await page.addInitScript(() => ((window as any).__wahooResolution = 1));
  await page.goto('./');
  await page.evaluate(() => ((window as any).__wahooCpuDelay = 60_000));
  await page.click('#start-local');
  await page.waitForSelector('#tour-card');
  for (let i = 0; i < 3; i++) {
    await page.click('#tour-card button.primary');
  }
  await expect(page.locator('#tour-card')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('wahoo-tour-done'))).toBe('1');
  // Second game: no tour.
  await page.click('#btn-menu');
  await page.click('#start-local');
  await page.waitForTimeout(600);
  await expect(page.locator('#tour-card')).toHaveCount(0);
});

test('cards and moves work from the keyboard', async ({ page }) => {
  await page.addInitScript(() => ((window as any).__wahooResolution = 1));
  await page.goto('./');
  await page.evaluate(() => {
    localStorage.setItem('wahoo-tour-done', '1');
    localStorage.setItem('wahoo-tips-seen', '["*"]');
    (window as any).__wahooCpuDelay = 60_000; // freeze CPUs
  });
  await page.click('#start-local');
  await page.waitForSelector('#game:not([hidden]) .board-canvas');
  // Announcer live region exists for screen readers.
  await expect(page.locator('#announcer')).toBeAttached();
  // Deterministic position: one bunny on the track, a single 5 in hand.
  await forceState(page, {
    current: 0,
    hand: [{ id: 0, rank: '5', suit: '♠' }],
    bunnies: [{ id: 0, place: { kind: 'track', index: 5 } }],
  });
  await page.keyboard.press('1'); // select the 5
  await expect(page.locator('#hand .card.selected')).toHaveCount(1);
  await page.keyboard.press('ArrowRight'); // focus the bunny
  await page.keyboard.press('Enter'); // pick it up
  await page.keyboard.press('ArrowRight'); // focus the destination
  await page.keyboard.press('Enter'); // move
  await page.waitForFunction(() => {
    const v = (window as any).__wahoo.app.view;
    return v.lastPlay && v.lastPlay.seat === 0 && !v.lastPlay.fold;
  });
  const bunny = await page.evaluate(
    () => (window as any).__wahoo.app.view.bunnies.find((b: any) => b.id === 0).place,
  );
  expect(bunny).toEqual({ kind: 'track', index: 10 });
});
