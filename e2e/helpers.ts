import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Collect page errors; assert none at the end of a test. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(String(err)));
  return errors;
}

/** Start a local game. Seats default to 1 human + 3 CPUs. */
export async function startLocal(page: Page, seats?: string[], dismissCurtain = true) {
  // Headless browsers render the board in software: keep the canvas at 1x.
  await page.addInitScript(() => ((window as any).__wahooResolution = 1));
  await page.goto('./');
  // The first-game tour is covered by its own test; keep the others clean.
  await page.evaluate(() => {
    localStorage.setItem('wahoo-tour-done', '1');
    localStorage.setItem('wahoo-tips-seen', '["*"]');
  });
  if (seats) {
    await page.evaluate(kinds => {
      document
        .querySelectorAll<HTMLSelectElement>('#seat-config select')
        .forEach(sel => (sel.value = kinds[Number(sel.dataset.seat)]));
    }, seats);
  }
  await page.evaluate(() => ((window as any).__wahooCpuDelay = 40));
  await page.click('#start-local');
  await page.waitForSelector('#game:not([hidden]) .board-canvas');
  // Multi-human games open behind the pass-the-device curtain.
  if (dismissCurtain) {
    const curtain = page.locator('.curtain-btn');
    if (await curtain.count()) await curtain.click();
  }
}

interface StateOverrides {
  current?: number;
  hand?: { id: number; rank: string; suit: string }[];
  bunnies?: { id: number; place: unknown }[];
}

/** Reach into the local session (test hook) to set up a deterministic position. */
export async function forceState(page: Page, overrides: StateOverrides) {
  await page.evaluate(o => {
    const w = (window as any).__wahoo;
    const session = w.app.session;
    const state = session.state;
    if (o.current !== undefined) state.current = o.current;
    if (o.hand) state.players[o.current ?? 0].hand = o.hand;
    for (const b of o.bunnies ?? []) {
      state.bunnies.find((x: any) => x.id === b.id).place = b.place;
    }
    session.push();
  }, overrides as any);
}

export async function view(page: Page) {
  return page.evaluate(() => (window as any).__wahoo.app.view);
}

/** Wait until the local human can act (CPUs blocked waiting on input). */
export async function waitForTurn(page: Page) {
  await page.waitForFunction(() => {
    const v = (window as any).__wahoo.app.view;
    return v && (v.canAct || v.winner !== null);
  });
}

export async function clickBoard(page: Page, pos: { x: number; y: number }) {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const scale = box!.width / 820;
  await page.mouse.click(box!.x + pos.x * scale, box!.y + pos.y * scale);
}

export async function trackPos(page: Page, index: number) {
  return page.evaluate(i => (window as any).__wahoo.trackPos(i), index);
}

export async function burrowPos(page: Page, player: number, slot: number) {
  return page.evaluate(
    ([p, s]) => (window as any).__wahoo.burrowPos(p, s),
    [player, slot],
  );
}

export async function reservePos(page: Page, player: number) {
  return page.evaluate(p => (window as any).__wahoo.reservePos(p, 0), player);
}
