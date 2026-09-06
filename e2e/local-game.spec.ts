import { expect, test } from '@playwright/test';
import {
  burrowPos, clickBoard, forceState, reservePos, startLocal, trackErrors, trackPos, view, waitForTurn,
} from './helpers.ts';

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
  test.setTimeout(120_000); // 12 real turns of animated play take a while
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

test('an ace with no bunnies out spawns immediately on card click', async ({ page }) => {
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

test('an ace with an active bunny still asks: spawn or move', async ({ page }) => {
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 0, rank: 'A', suit: '♠' }],
    bunnies: [{ id: 0, place: { kind: 'track', index: 5 } }],
  });
  await page.click('#hand .card');
  // Both spawn and move are possible: no auto-play, user picks the reserve.
  await expect(page.locator('#log')).not.toContainText('Red spawns a bunny');
  await clickBoard(page, await reservePos(page, 0));
  await expect(page.locator('#log')).toContainText('Red spawns a bunny');
});

test('taps snap to the nearest legal target', async ({ page }) => {
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 2, rank: '3', suit: '♠' }],
    bunnies: [{ id: 0, place: { kind: 'track', index: 5 } }],
  });
  await page.click('#hand .card');
  // Tap noticeably off-centre from the bunny: still selects it.
  const src = await trackPos(page, 5);
  await clickBoard(page, { x: src.x + 30, y: src.y - 25 });
  // Then tap near (not on) the destination three ahead.
  const dest = await trackPos(page, 8);
  await clickBoard(page, { x: dest.x - 28, y: dest.y + 20 });
  await expect(page.locator('#log')).toContainText('Red plays 3');
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
  // The selected card's description is shown without needing to hover.
  await expect(page.locator('#card-help')).toContainText('backward 4 spaces');
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
  // The fold is announced like a played card.
  await expect(page.locator('#move-callout')).toContainText('folded');
});

test('king stomp-spawns onto an opponent via board clicks', async ({ page }) => {
  const errors = trackErrors(page);
  await startLocal(page, ['human', 'human', 'human', 'human']);
  await forceState(page, {
    current: 0,
    hand: [{ id: 12, rank: 'K', suit: '♠' }],
    bunnies: [{ id: 4, place: { kind: 'track', index: 47 } }],
  });
  await page.click('#hand .card');
  await clickBoard(page, await trackPos(page, 47)); // tap the opponent to stomp
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
  // The remaining 4 steps are chosen explicitly: second bunny, then its destination.
  await clickBoard(page, await trackPos(page, 30));
  await clickBoard(page, await trackPos(page, 34));
  await expect(page.locator('#log')).toContainText('Red plays 7');
  const v = await view(page);
  expect(v.bunnies.find((b: any) => b.id === 0).place).toEqual({ kind: 'track', index: 8 });
  expect(v.bunnies.find((b: any) => b.id === 1).place).toEqual({ kind: 'track', index: 34 });
});
