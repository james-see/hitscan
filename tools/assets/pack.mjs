#!/usr/bin/env node
/**
 * Stage 2 of the asset pipeline: turn the `.assetcache/` masters into runtime
 * assets under `public/assets/`, and write the manifest that
 * `src/engine/Resources.ts` consumes.
 *
 * The important transform is the ORM pack: occlusion in R, roughness in G,
 * metalness in B. The runtime binds that one texture to `aoMap`,
 * `roughnessMap` and `metalnessMap` at once and relies on three.js sampling
 * the right channel for each, which saves two samplers and two uploads per
 * material.
 *
 * Usage:
 *   node tools/assets/pack.mjs
 *   node tools/assets/pack.mjs --size 1024   # smaller runtime budget
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, stat, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { ENVIRONMENTS, MATERIALS } from './sources.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CACHE = join(ROOT, '.assetcache');
const OUT = join(ROOT, 'public', 'assets');
const TEX_OUT = join(OUT, 'textures');
const ENV_OUT = join(OUT, 'env');
const BASIS_OUT = join(ROOT, 'public', 'basis');

const MANIFEST_VERSION = 1;
const LICENSE = 'CC0-1.0';

const sizeArg = process.argv.indexOf('--size');
/** Runtime texture edge length. 2048 is ~512 px/m at a 4 m tile scale. */
const SIZE = sizeArg >= 0 ? Number(process.argv[sizeArg + 1]) : 2048;

/**
 * KTX2 would be the right container here — GPU-native compression, no decode
 * cost, a quarter of the VRAM. It needs a `toktx` or `basisu` binary that is
 * not part of any npm dependency, so probe for one and fall back rather than
 * making the pipeline unrunnable on a clean checkout.
 */
function detectKtx2Encoder() {
  for (const bin of ['toktx', 'basisu']) {
    try {
      execFileSync('which', [bin], { stdio: 'pipe' });
      return bin;
    } catch {
      /* not installed */
    }
  }
  return null;
}

/**
 * Encoder choice per channel.
 *
 * Albedo is colour, so lossy WebP with chroma subsampling is free quality.
 * Normal and ORM are not colour: their three channels are independent
 * signals, and WebP's lossy mode always converts to subsampled YUV, which
 * bleeds roughness into metalness and flattens normal detail. JPEG at 4:4:4
 * keeps every channel at full rate and still compresses well, so data maps go
 * out as JPEG and only colour maps get WebP.
 */
const ENCODERS = {
  colour: {
    ext: 'webp',
    apply: (pipeline) => pipeline.webp({ quality: 84, effort: 6, smartSubsample: true }),
  },
  data: {
    ext: 'jpg',
    apply: (pipeline) => pipeline.jpeg({ quality: 94, chromaSubsampling: '4:4:4', mozjpeg: true }),
  },
};

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function loadCacheIndex() {
  try {
    return JSON.parse(await readFile(join(CACHE, 'index.json'), 'utf8'));
  } catch {
    throw new Error(`no cache index at ${join(CACHE, 'index.json')} — run: node tools/assets/fetch.mjs`);
  }
}

/** Reads one greyscale plane of a cached map, resized to the runtime budget. */
async function plane(path, channel = 0) {
  const raw = await sharp(path)
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const out = Buffer.allocUnsafe(SIZE * SIZE);
  for (let i = 0, j = channel; i < out.length; i++, j += info.channels) out[i] = data[j];
  return out;
}

function constantPlane(value) {
  return Buffer.alloc(SIZE * SIZE, value);
}

async function writeImage(pipeline, encoder, dest) {
  await encoder.apply(pipeline).toFile(dest);
  return (await stat(dest)).size;
}

async function packMaterial(source, cached, report) {
  const { maps } = cached;
  const has = (key) => Boolean(maps[key]);
  const pathOf = (key) => maps[key].path;

  console.log(`\n[${source.id}] ${cached.slug} @${maps.Diffuse.resolution}`);

  // -- albedo (sRGB colour) -------------------------------------------------
  const albedoFile = `${source.id}_albedo.${ENCODERS.colour.ext}`;
  const albedoBytes = await writeImage(
    sharp(pathOf('Diffuse')).resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' }),
    ENCODERS.colour,
    join(TEX_OUT, albedoFile)
  );
  console.log(`  albedo  ${human(albedoBytes)}`);

  // -- normal (linear data, OpenGL convention) ------------------------------
  const normalFile = `${source.id}_normal.${ENCODERS.data.ext}`;
  const normalBytes = await writeImage(
    sharp(pathOf('nor_gl'))
      .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
      .removeAlpha(),
    ENCODERS.data,
    join(TEX_OUT, normalFile)
  );
  console.log(`  normal  ${human(normalBytes)}`);

  // -- ORM (linear data) ----------------------------------------------------
  // Prefer the individually authored maps; fall back to Poly Haven's own
  // `arm` pack, which already uses the same channel order.
  const ao = has('AO')
    ? await plane(pathOf('AO'))
    : has('arm')
      ? await plane(pathOf('arm'), 0)
      : constantPlane(255);
  const rough = has('Rough')
    ? await plane(pathOf('Rough'))
    : has('arm')
      ? await plane(pathOf('arm'), 1)
      : constantPlane(200);

  let metal;
  let metalOrigin;
  if (has('Metal')) {
    metal = await plane(pathOf('Metal'));
    metalOrigin = 'authored map';
  } else if (source.metalness !== undefined) {
    metal = constantPlane(Math.round(source.metalness * 255));
    metalOrigin = `constant ${source.metalness}`;
  } else if (has('arm')) {
    metal = await plane(pathOf('arm'), 2);
    metalOrigin = 'arm.b';
  } else {
    metal = constantPlane(0);
    metalOrigin = 'constant dielectric';
  }

  const orm = Buffer.allocUnsafe(SIZE * SIZE * 3);
  for (let i = 0, j = 0; i < SIZE * SIZE; i++, j += 3) {
    orm[j] = ao[i];
    orm[j + 1] = rough[i];
    orm[j + 2] = metal[i];
  }

  const ormFile = `${source.id}_orm.${ENCODERS.data.ext}`;
  const ormBytes = await writeImage(
    sharp(orm, { raw: { width: SIZE, height: SIZE, channels: 3 } }),
    ENCODERS.data,
    join(TEX_OUT, ormFile)
  );
  console.log(
    `  orm     ${human(ormBytes)}  (ao: ${has('AO') ? 'map' : has('arm') ? 'arm.r' : 'white'}, ` +
      `rough: ${has('Rough') ? 'map' : has('arm') ? 'arm.g' : 'constant'}, metal: ${metalOrigin})`
  );
  console.log(`  tile    ${source.tileScale} m per repeat`);

  report.bytes += albedoBytes + normalBytes + ormBytes;

  return {
    id: source.id,
    albedo: `/assets/textures/${albedoFile}`,
    normal: `/assets/textures/${normalFile}`,
    orm: `/assets/textures/${ormFile}`,
    tileScale: source.tileScale,
    source: {
      name: cached.name,
      author: cached.authors.join(', ') || 'Poly Haven',
      license: LICENSE,
      url: `https://polyhaven.com/a/${cached.slug}`,
    },
  };
}

async function packEnvironment(source, cached, report) {
  // The HDR is copied verbatim: RGBELoader wants Radiance RGBE, and re-encoding
  // it through sharp would clamp the sun's highlights, which are exactly the
  // values PMREM needs for a believable specular horizon.
  const file = `${source.id}.hdr`;
  const dest = join(ENV_OUT, file);
  await copyFile(cached.path, dest);
  const bytes = (await stat(dest)).size;
  report.bytes += bytes;
  console.log(`\n[${source.id}] ${cached.slug} @${cached.resolution} hdr ${human(bytes)}`);

  return {
    id: source.id,
    url: `/assets/env/${file}`,
    intensity: source.intensity,
    source: {
      name: cached.name,
      author: cached.authors.join(', ') || 'Poly Haven',
      license: LICENSE,
      url: `https://polyhaven.com/a/${cached.slug}`,
    },
  };
}

/**
 * Copies the Basis Universal transcoder next to the app.
 *
 * `Resources.ts` hard-codes `setTranscoderPath('/basis/')`, so these must be
 * present for any future KTX2 asset to load — including KTX2 textures
 * embedded in glTF models, which is a separate path from our own textures.
 */
async function copyBasisTranscoder() {
  const candidates = [
    join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis'),
    join(ROOT, 'node_modules', 'three', 'examples', 'js', 'libs', 'basis'),
  ];
  for (const dir of candidates) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    await mkdir(BASIS_OUT, { recursive: true });
    let copied = 0;
    for (const entry of entries) {
      if (!/\.(js|wasm)$/.test(entry)) continue;
      await copyFile(join(dir, entry), join(BASIS_OUT, entry));
      copied++;
    }
    console.log(`\n[basis] copied ${copied} transcoder file(s) to public/basis/`);
    return true;
  }
  console.warn('\n[basis] transcoder not found in node_modules/three — KTX2 loading will fail');
  return false;
}

async function main() {
  const encoder = detectKtx2Encoder();
  console.log(
    encoder
      ? `KTX2 encoder found (${encoder}) — note: this pipeline currently emits WebP/JPEG only.`
      : 'No toktx/basisu on PATH — emitting WebP (colour) and JPEG 4:4:4 (data) instead of KTX2.'
  );
  console.log(`Runtime texture size: ${SIZE}x${SIZE}`);

  const index = await loadCacheIndex();

  await rm(TEX_OUT, { recursive: true, force: true });
  await rm(ENV_OUT, { recursive: true, force: true });
  await mkdir(TEX_OUT, { recursive: true });
  await mkdir(ENV_OUT, { recursive: true });

  const report = { bytes: 0 };
  const materials = [];
  for (const source of MATERIALS) {
    const cached = index.textures?.[source.id];
    if (!cached) throw new Error(`"${source.id}" is not in the cache — run: node tools/assets/fetch.mjs`);
    materials.push(await packMaterial(source, cached, report));
  }

  const environments = [];
  for (const source of ENVIRONMENTS) {
    const cached = index.hdris?.[source.id];
    if (!cached) throw new Error(`"${source.id}" is not in the cache — run: node tools/assets/fetch.mjs`);
    environments.push(await packEnvironment(source, cached, report));
  }

  await copyBasisTranscoder();

  const manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    materials,
    models: [],
    audio: [],
    environments,
  };
  const manifestPath = join(OUT, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nWrote ${manifestPath}`);
  console.log(`${materials.length} materials, ${environments.length} environments, ${human(report.bytes)} of assets.`);
}

main().catch((err) => {
  console.error(`\npack failed: ${err.message}`);
  process.exitCode = 1;
});
