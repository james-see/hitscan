#!/usr/bin/env node
/**
 * Screenshots of the round overlays, for eyeballing them against the rest of
 * the HUD.
 *
 * Not a determinism harness and not part of the critic set: these frames exist
 * to check that the lobby, the live scoreline, the scoreboard, the death notice
 * and the results screen read as the same interface as the widgets that were
 * already there.
 *
 * Usage: node src/match/e2e/shots.mjs [--out <dir>]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser } from '../../../tools/critic/capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? path.join(ROOT, 'captures', 'match') : path.resolve(process.argv[outIndex + 1]);

const WIDTH = 2560;
const HEIGHT = 1440;

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer({ snapshot: false });
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.bringToFront').catch(() => {});

    const shoot = async (name) => {
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      );
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = path.join(OUT, `${name}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      process.stdout.write(`  ${path.relative(ROOT, file)}\n`);
    };

    await page.goto(`${server.url}/?bots=10&matchScore=10&matchTime=600`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });
    await page.waitForTimeout(400);
    await shoot('01-lobby');

    await page.click('.mscreen-panel--pregame .mscreen-cta');
    await page.waitForTimeout(1200);

    // A plausible mid-round scoreline, scored through the real damage path.
    await page.evaluate(() => {
      const bus = window.engine.events;
      const point = window.engine.camera.position.clone();
      const direction = point.clone().set(0, 0, -1);
      for (const id of ['bot-00', 'bot-02', 'bot-03', 'bot-05', 'bot-06', 'bot-08', 'bot-09']) {
        bus.emit('combat:damage-dealt', {
          targetId: id,
          sourceId: 'player',
          amount: 400,
          hitbox: id === 'bot-02' ? 'head' : 'chest',
          point,
          direction,
          lethal: true,
        });
      }
      bus.emit('combat:player-damaged', { amount: 46, from: point, health: 54 });
    });
    await page.waitForTimeout(900);
    await shoot('02-live');

    await page.keyboard.down('Tab');
    await page.waitForTimeout(400);
    await shoot('03-scoreboard');
    await page.keyboard.up('Tab');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const bus = window.engine.events;
      const point = window.engine.camera.position.clone();
      point.x += 8;
      point.z += 5;
      bus.emit('combat:player-damaged', { amount: 54, from: point, health: 0 });
      bus.emit('combat:damage-dealt', {
        targetId: 'player',
        sourceId: 'bot-04',
        amount: 54,
        hitbox: null,
        point,
        direction: point.clone().set(0.85, 0, 0.53),
        lethal: true,
      });
    });
    await page.waitForTimeout(1400);
    await shoot('04-death');

    // Straight to the score limit for the results screen.
    await page.waitForTimeout(3200);
    await page.evaluate(() => {
      const bus = window.engine.events;
      const point = window.engine.camera.position.clone();
      const direction = point.clone().set(0, 0, -1);
      for (const id of ['bot-01', 'bot-04', 'bot-07']) {
        bus.emit('combat:damage-dealt', {
          targetId: id,
          sourceId: 'player',
          amount: 400,
          hitbox: 'chest',
          point,
          direction,
          lethal: true,
        });
      }
    });
    await page.waitForTimeout(1400);
    await shoot('05-results');

    await page.close();
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch((err) => {
  console.error(`shots failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
