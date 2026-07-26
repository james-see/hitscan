#!/usr/bin/env node
/**
 * Stage 1 of the asset pipeline: download CC0 source material from Poly Haven
 * into `.assetcache/`.
 *
 * Nothing here is shipped. The cache holds full-resolution masters so that
 * `pack.mjs` can be re-run with different budgets without re-downloading, and
 * so a clean `public/assets/` rebuild costs no network traffic.
 *
 * Usage:
 *   node tools/assets/fetch.mjs            # fetch anything missing
 *   node tools/assets/fetch.mjs --force    # re-download everything
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENVIRONMENTS,
  HDRI_RESOLUTIONS,
  MATERIALS,
  POLYHAVEN_API,
  TEXTURE_MAPS,
  TEXTURE_RESOLUTIONS,
} from './sources.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const CACHE = join(ROOT, '.assetcache');

const FORCE = process.argv.includes('--force');
/** Poly Haven is a donation-funded service; stay well under any rate limit. */
const POLITE_DELAY_MS = 250;
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      const backoff = 500 * 2 ** (attempt - 1);
      console.warn(`  retry ${attempt}/${MAX_RETRIES - 1} for ${label}: ${err.message}`);
      await sleep(backoff);
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function getJson(url, cachePath) {
  if (!FORCE && cachePath) {
    try {
      return JSON.parse(await readFile(cachePath, 'utf8'));
    } catch {
      /* not cached yet */
    }
  }
  const json = await withRetry(url, async () => {
    const res = await fetch(url, { headers: { 'user-agent': 'hitscan-asset-pipeline' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  if (cachePath) {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(json, null, 2));
  }
  await sleep(POLITE_DELAY_MS);
  return json;
}

/** Downloads `entry` ({url, size, md5}) to `dest`, skipping verified hits. */
async function download(entry, dest, label) {
  if (!FORCE) {
    try {
      const info = await stat(dest);
      // Size alone is enough to detect a truncated download; the md5 check is
      // what catches a silently corrupt one, so do both when md5 is offered.
      if (info.size === entry.size) {
        if (!entry.md5) return { skipped: true, bytes: info.size };
        const hash = createHash('md5').update(await readFile(dest)).digest('hex');
        if (hash === entry.md5) return { skipped: true, bytes: info.size };
      }
    } catch {
      /* not cached yet */
    }
  }

  const bytes = await withRetry(label, async () => {
    const res = await fetch(entry.url, { headers: { 'user-agent': 'hitscan-asset-pipeline' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (entry.md5) {
      const hash = createHash('md5').update(buffer).digest('hex');
      if (hash !== entry.md5) throw new Error('md5 mismatch');
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buffer);
    return buffer.length;
  });

  await sleep(POLITE_DELAY_MS);
  return { skipped: false, bytes };
}

/** Picks the first available resolution from `preferred`, else the largest. */
function pickResolution(node, preferred) {
  for (const res of preferred) if (node[res]) return res;
  const available = Object.keys(node);
  if (available.length === 0) return null;
  return available.sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).at(-1) ?? null;
}

async function fetchTexture(source, totals) {
  const { slug } = source;
  console.log(`\n[texture] ${source.id} <- ${slug}`);

  const info = await getJson(`${POLYHAVEN_API}/info/${slug}`, join(CACHE, 'meta', `${slug}.json`));
  const files = await getJson(`${POLYHAVEN_API}/files/${slug}`, join(CACHE, 'files', `${slug}.json`));

  const record = {
    slug,
    name: info.name ?? slug,
    authors: Object.keys(info.authors ?? {}),
    maps: /** @type {Record<string, {path: string, resolution: string}>} */ ({}),
  };

  for (const map of TEXTURE_MAPS) {
    const node = files[map];
    if (!node) continue;
    const resolution = pickResolution(node, TEXTURE_RESOLUTIONS);
    const entry = resolution && node[resolution]?.jpg;
    if (!entry) continue;

    const dest = join(CACHE, 'textures', slug, `${map}_${resolution}.jpg`);
    const { skipped, bytes } = await download(entry, dest, `${slug}/${map}`);
    totals.bytes += bytes;
    if (skipped) totals.skipped++;
    else totals.downloaded++;
    console.log(`  ${skipped ? 'cached' : 'fetched'} ${map} @${resolution} ${human(bytes)}`);

    record.maps[map] = { path: dest, resolution };
  }

  const missing = ['Diffuse', 'nor_gl'].filter((m) => !record.maps[m]);
  if (missing.length > 0) {
    throw new Error(`${slug} is missing required map(s): ${missing.join(', ')}`);
  }
  return record;
}

async function fetchEnvironment(source, totals) {
  const { slug } = source;
  console.log(`\n[hdri] ${source.id} <- ${slug}`);

  const info = await getJson(`${POLYHAVEN_API}/info/${slug}`, join(CACHE, 'meta', `${slug}.json`));
  const files = await getJson(`${POLYHAVEN_API}/files/${slug}`, join(CACHE, 'files', `${slug}.json`));

  const node = files.hdri;
  if (!node) throw new Error(`${slug} has no hdri files`);
  const resolution = pickResolution(node, HDRI_RESOLUTIONS);
  // RGBELoader in `src/engine/Resources.ts` reads Radiance .hdr, not .exr.
  const entry = resolution && node[resolution]?.hdr;
  if (!entry) throw new Error(`${slug} has no .hdr variant`);

  const dest = join(CACHE, 'hdris', `${slug}_${resolution}.hdr`);
  const { skipped, bytes } = await download(entry, dest, `${slug}/hdri`);
  totals.bytes += bytes;
  if (skipped) totals.skipped++;
  else totals.downloaded++;
  console.log(`  ${skipped ? 'cached' : 'fetched'} hdri @${resolution} ${human(bytes)}`);

  return {
    slug,
    name: info.name ?? slug,
    authors: Object.keys(info.authors ?? {}),
    path: dest,
    resolution,
  };
}

async function main() {
  console.log(`Poly Haven -> ${CACHE}${FORCE ? ' (forced re-download)' : ''}`);
  await mkdir(CACHE, { recursive: true });
  // The cache is a build artefact, not source. Self-ignore so it can never be
  // committed by accident regardless of the repo-level .gitignore.
  await writeFile(join(CACHE, '.gitignore'), '*\n');

  const totals = { downloaded: 0, skipped: 0, bytes: 0 };
  const index = { fetchedAt: new Date().toISOString(), textures: {}, hdris: {} };

  for (const source of MATERIALS) {
    index.textures[source.id] = await fetchTexture(source, totals);
  }
  for (const source of ENVIRONMENTS) {
    index.hdris[source.id] = await fetchEnvironment(source, totals);
  }

  const indexPath = join(CACHE, 'index.json');
  await writeFile(indexPath, JSON.stringify(index, null, 2));

  console.log(
    `\nDone. ${totals.downloaded} downloaded, ${totals.skipped} already cached, ${human(totals.bytes)} total.`
  );
  console.log(`Cache index: ${indexPath}`);
  console.log('Next: node tools/assets/pack.mjs');
}

main().catch((err) => {
  console.error(`\nfetch failed: ${err.message}`);
  process.exitCode = 1;
});
