/**
 * Bisects which pass makes the opaque viewmodel render see-through.
 *
 * The G-buffer is populated by the world prepass only; the viewmodel is drawn
 * afterwards into the HDR target. Any pass that shades using G-buffer depth or
 * normals therefore reads *background* values at weapon pixels, which can
 * composite the background over a solid object.
 *
 * Samples a patch inside the solid optic housing and reports how strongly it
 * tracks the background behind it.
 */
import { startServer, launchBrowser } from './capture.mjs';

const TOGGLES = [
  'ssaoEnabled',
  'ssrEnabled',
  'volumetricsEnabled',
  'motionBlurEnabled',
  'bloomEnabled',
  'filmGrainEnabled',
  'chromaticAberrationEnabled',
  'vignetteEnabled',
];

const server = await startServer({ build: false });
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

/** Mean luminance of a patch inside the housing wall, left of the aperture. */
async function sampleHousing() {
  return page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    const w = canvas.width;
    const h = canvas.height;
    // Read back through a 2D canvas: the WebGL buffer is not preserved.
    const bitmap = await createImageBitmap(canvas);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    const ctx2d = c.getContext('2d');
    const patch = (cx, cy) => {
      const d = ctx2d.getImageData(Math.round(cx), Math.round(cy), 12, 12).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4);
    };
    return {
      housing: patch(w * 0.42, h * 0.42),
      background: patch(w * 0.12, h * 0.42),
    };
  });
}

try {
  await page.goto(`${server.url}/?capture=1&seed=1&vm=ads`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 });
  await page.evaluate(async () => {
    await window.__hitscan.setShot('lane');
  });

  const baseline = await sampleHousing();
  console.log(`baseline           housing=${baseline.housing.toFixed(1)} bg=${baseline.background.toFixed(1)}`);

  for (const key of TOGGLES) {
    await page.evaluate(
      async ([k]) => {
        const api = window.__hitscan;
        api.setSetting(k, false);
        await api.setShot('lane');
      },
      [key]
    );
    const s = await sampleHousing();
    console.log(`without ${key.padEnd(28)} housing=${s.housing.toFixed(1)}`);
    await page.evaluate(
      async ([k]) => {
        window.__hitscan.setSetting(k, true);
        await window.__hitscan.setShot('lane');
      },
      [key]
    );
  }
} finally {
  await browser.close();
  server.stop();
}
