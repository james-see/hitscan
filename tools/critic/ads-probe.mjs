/**
 * Isolates whether the see-through viewmodel in ADS captures is a material
 * bug or TAA history contamination.
 *
 * The `vm=ads` override teleports the weapon into the aimed pose. If the pose
 * changes after the temporal history has settled, TAA keeps blending frames in
 * which the weapon was not there, which reads exactly like a transparent gun.
 * Captures the same framing with TAA on and off for comparison.
 */
import { startServer, launchBrowser } from './capture.mjs';

const server = await startServer({ build: false });
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

try {
  await page.goto(`${server.url}/?capture=1&seed=1&vm=ads`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });

  for (const taa of [true, false]) {
    await page.evaluate(
      async ([enabled]) => {
        const api = window.__hitscan;
        api.setSetting('taaEnabled', enabled);
        await api.setShot('lane');
        // Let the history rebuild with the weapon already in the aimed pose.
        for (let i = 0; i < 90; i++) api.step(1 / 120);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      },
      [taa]
    );
    const file = `captures/verify/ads-taa-${taa ? 'on' : 'off'}.png`;
    await page.screenshot({ path: file });
    console.log(`wrote ${file}`);
  }
} finally {
  await browser.close();
  server.stop();
}
