import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PHP_PORT = 8098;
const hasPhp = spawnSync('php', ['-v']).status === 0;
const hasVendor = existsSync('server/wahoo-php/vendor/autoload.php');

let php: ChildProcess | null = null;

test.describe('PHP relay server', () => {
  test.skip(!hasPhp || !hasVendor, 'php or composer vendor/ not available');
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    // A fresh DB per run: repeated local runs would otherwise trip the
    // per-IP room-creation throttle.
    const db = join(tmpdir(), `wahoo-e2e-${process.pid}.sqlite`);
    php = spawn('php', ['-S', `127.0.0.1:${PHP_PORT}`, 'index.php'], {
      cwd: 'server/wahoo-php',
      stdio: 'ignore',
      // Long polls hold a worker each: the built-in server needs several.
      env: { ...process.env, WAHOO_DB: db, PHP_CLI_SERVER_WORKERS: '6' },
    });
    // Wait for the server to accept requests.
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${PHP_PORT}/api/rooms/NOPE`);
        return;
      } catch {
        await new Promise(r => setTimeout(r, 250));
      }
    }
    throw new Error('php server did not start');
  });

  test.afterAll(() => {
    php?.kill();
  });

  test('rooms work end to end over HTTP polling', async ({ page }) => {
    await page.addInitScript(() => ((window as any).__wahooResolution = 1));
    await page.goto('./');
    await page.fill('#online-name', 'Tester');
    await page.click('#tab-server');
    await page.fill('#online-server', `http://127.0.0.1:${PHP_PORT}`);
    await page.click('#online-create');

    // Lobby appears with a word code.
    await page.waitForSelector('#lobby .code', { timeout: 15_000 });
    const code = (await page.textContent('#lobby .code'))!.trim();
    expect(code).toMatch(/^[A-Z]{4}$/);

    // Start: empty seats become CPUs, the game screen appears.
    await page.click('#lobby button.primary');
    await page.waitForSelector('#game:not([hidden]) .board-canvas', { timeout: 15_000 });

    // Play through several turns: our moves are instant, CPU turns are
    // computed lazily by the polling client after the 4s pause.
    for (let i = 0; i < 60; i++) {
      const state = await page.evaluate(() => {
        const w = (window as any).__wahoo;
        const v = w.app.view;
        if (!v) return { log: 0, canAct: false };
        if (v.canAct) w.app.submit(v.legal[Math.floor(Math.random() * v.legal.length)]);
        return { log: v.log.length, canAct: v.canAct };
      });
      if (state.log >= 4) break;
      await page.waitForTimeout(700);
    }
    const log = await page.evaluate(() => (window as any).__wahoo.app.view.log);
    expect(log.length).toBeGreaterThanOrEqual(4); // deal + our move + CPU moves
  });

  test('invite links carry the server and auto-join it', async ({ page }) => {
    // Create a room directly against the relay.
    const created = await (
      await fetch(`http://127.0.0.1:${PHP_PORT}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Host', token: 'link-tok' }),
      })
    ).json();

    await page.addInitScript(() => ((window as any).__wahooResolution = 1));
    // Open the deep link: it should join that dedicated server, not P2P.
    await page.goto(`./?join=${created.code}&server=http://127.0.0.1:${PHP_PORT}`);
    await page.waitForFunction(
      () => document.querySelector('#lobby .tag')?.textContent === 'you',
      undefined,
      { timeout: 15_000 },
    );
    await expect(page.locator('#lobby .code')).toHaveText(created.code);
    // Joining mode: only the lobby — no Local panel, tabs, or Server section.
    await expect(page.locator('#local-panel')).toBeHidden();
    await expect(page.locator('#tab-panel-server')).toBeHidden();
    await expect(page.locator('.tabs')).toBeHidden();
    // And the lobby's own invite link points back at this server.
    await expect(page.locator('#lobby .invite code')).toContainText(
      `join=${created.code}&server=`,
    );
  });
});
