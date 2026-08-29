import { expect, test } from '@playwright/test';
import { clickBoard, forceState, startLocal, trackErrors, trackPos, view, waitForTurn } from './helpers.ts';

test('menu renders and a local game starts cleanly', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('./');
  await expect(page.locator('#local-panel h2')).toHaveText('Local Game');
  await startLocal(page);
  await expect(page.locator('#status')).toContainText('Round 1');
  await expect(page.locator('#hand .card')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('the game progresses through CPU turns', async ({ page }) => {
  const errors = trackErrors(page);
  await startLocal(page);
  // Play up to 12 human decisions programmatically; CPUs respond on their own.
  for (let i = 0; i < 12; i++) {
    await waitForTurn(page);
    const done = await page.evaluate(() => {
      const w = (window as any).__wahoo;
      const v = w.app.view;
      if (v.winner !== null) return true;
      w.app.submit(v.legal[Math.floor(Math.random() * v.legal.length)]);
      return false;
    });
    if (done) break;
  }
  const v = await view(page);
  expect(v.log.length).toBeGreaterThan(3);
  expect(errors).toEqual([]);
});

test('a single-option card auto-plays on click', async ({ page }) => {
  const errors = trackErrors(page);
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 0, rank: 'A', suit: '♠' }], // no bunnies out: spawn is the only action
  });
  await page.click('#hand .card');
  await expect(page.locator('#log')).toContainText('Red spawns a bunny');
  expect(errors).toEqual([]);
});

test('a multi-option card waits for a destination pick', async ({ page }) => {
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 16, rank: '4', suit: '♥' }],
    bunnies: [
      { id: 0, place: { kind: 'track', index: 5 } },
      { id: 1, place: { kind: 'track', index: 30 } },
    ],
  });
  await page.click('#hand .card');
  // Two bunnies can move: nothing auto-plays, sources are highlighted.
  await expect(page.locator('#status')).toContainText("Red's turn");
  const v = await view(page);
  expect(v.bunnies.find((b: any) => b.id === 0).place).toEqual({ kind: 'track', index: 5 });
});

test('fold appears when no card is playable', async ({ page }) => {
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 2, rank: '3', suit: '♠' }], // no bunnies on track: unplayable
  });
  await expect(page.locator('#btn-fold')).toBeVisible();
  await page.click('#btn-fold');
  await expect(page.locator('#log')).toContainText('Red has no legal move and folds');
});

test('king stomp-spawns onto an opponent via board clicks', async ({ page }) => {
  const errors = trackErrors(page);
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 12, rank: 'K', suit: '♠' }],
    bunnies: [{ id: 4, place: { kind: 'track', index: 47 } }],
  });
  await page.click('#hand .card'); // single action: auto-plays the king spawn
  await expect(page.locator('#log')).toContainText('Red spawns with a King, stomping Blue');
  const v = await view(page);
  expect(v.bunnies.find((b: any) => b.id === 4).place).toEqual({ kind: 'reserve' });
  expect(errors).toEqual([]);
});

test('7-split shows step labels and completes via destination clicks', async ({ page }) => {
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 6, rank: '7', suit: '♠' }],
    bunnies: [
      { id: 0, place: { kind: 'track', index: 5 } },
      { id: 1, place: { kind: 'track', index: 30 } },
    ],
  });
  await page.click('#hand .card');
  // Select bunny 0, then click 3 steps ahead (track 8).
  await clickBoard(page, await trackPos(page, 5));
  await expect(page.locator('#status')).toContainText('how far');
  await clickBoard(page, await trackPos(page, 8));
  // Remaining 4 steps are forced onto bunny 1 and auto-play.
  await expect(page.locator('#log')).toContainText('Red plays 7');
  const v = await view(page);
  expect(v.bunnies.find((b: any) => b.id === 0).place).toEqual({ kind: 'track', index: 8 });
  expect(v.bunnies.find((b: any) => b.id === 1).place).toEqual({ kind: 'track', index: 34 });
});
