/**
 * Boots the game the way a player does -- no query parameters -- and checks
 * that hostiles spawn inside the walled courtyard.
 *
 * The end-to-end drive always passes `bots=10`, so it says nothing about the
 * default path, which is the only path a player takes. Bots previously spawned
 * in the walkable sand ring outside the perimeter, where a player never goes.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser } from './capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'captures', 'bot-probe');

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.mscreen button')].find((x) =>
        /deploy|play|start/i.test(x.textContent ?? '')
      );
      b?.click();
    });
    await page.waitForTimeout(1500);

    const placement = await page.evaluate(() => {
      const ai = window.engine.ctx.getModule('ai');
      const world = window.engine.ctx.getModule('world');
      const p = window.engine.ctx.getModule('player').state.position;
      const play = world.playBounds;
      const inside = (v) =>
        !!play && v.x >= play.min.x && v.x <= play.max.x && v.z >= play.min.z && v.z <= play.max.z;
      const bots = ai.bots.map((b) => ({
        id: b.actorId,
        x: +b.position.x.toFixed(1),
        z: +b.position.z.toFixed(1),
        dist: +Math.hypot(b.position.x - p.x, b.position.z - p.z).toFixed(1),
        inside: inside(b.position),
      }));
      return {
        play: play ? { x: +play.max.x.toFixed(1), z: +play.max.z.toFixed(1) } : null,
        grid: { cols: ai.navGrid.cols, rows: ai.navGrid.rows, cell: ai.navGrid.cellSize },
        player: { x: +p.x.toFixed(1), z: +p.z.toFixed(1) },
        bots,
      };
    });

    console.log(`play half-extent: ${JSON.stringify(placement.play)}`);
    console.log(`nav grid: ${JSON.stringify(placement.grid)}`);
    console.log(`player: ${JSON.stringify(placement.player)}`);
    for (const b of placement.bots) console.log(`  ${JSON.stringify(b)}`);

    const outside = placement.bots.filter((b) => !b.inside);
    const dists = placement.bots.map((b) => b.dist).sort((a, b) => a - b);
    console.log(
      `\n${placement.bots.length - outside.length}/${placement.bots.length} inside the walls, ` +
        `nearest ${dists[0]}m, farthest ${dists[dists.length - 1]}m`
    );
    if (outside.length) console.log(`OUTSIDE: ${outside.map((b) => b.id).join(', ')}`);

    // Spawn placement prefers distance from the player, so the opening wave
    // lands in the far half. Check they patrol out of it.
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(5000);
      const s = await page.evaluate(() => {
        const ai = window.engine.ctx.getModule('ai');
        const p = window.engine.ctx.getModule('player').state.position;
        const d = ai.bots
          .map((b) => Math.hypot(b.position.x - p.x, b.position.z - p.z))
          .sort((a, b) => a - b);
        const zs = ai.bots.map((b) => b.position.z);
        return {
          nearest: +d[0].toFixed(1),
          median: +d[Math.floor(d.length / 2)].toFixed(1),
          southOfMid: ai.bots.filter((b) => b.position.z > 0).length,
          zSpan: `${Math.min(...zs).toFixed(0)}..${Math.max(...zs).toFixed(0)}`,
        };
      });
      console.log(`  t=${(i + 1) * 5}s  ${JSON.stringify(s)}`);
    }

    // Stand six metres from the nearest bot, facing it, and photograph.
    await page.evaluate(() => {
      const ai = window.engine.ctx.getModule('ai');
      const player = window.engine.ctx.getModule('player');
      const p = player.state.position;
      const near = [...ai.bots].sort(
        (a, b) =>
          Math.hypot(a.position.x - p.x, a.position.z - p.z) -
          Math.hypot(b.position.x - p.x, b.position.z - p.z)
      )[0];
      const t = near.position;
      const from = { x: t.x + 4.5, z: t.z + 4.5 };
      // Forward is (-sin yaw, 0, -cos yaw), so aim the offset back at the bot.
      const yaw = Math.atan2(-(t.x - from.x), -(t.z - from.z));
      player.teleport(new (t.constructor)(from.x, t.y + 0.1, from.z), yaw);
    });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, 'nearest-bot.png') });
    console.log(`wrote ${path.join(OUT, 'nearest-bot.png')}`);
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
