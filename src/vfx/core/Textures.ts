import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import { GradientNoise2D, clamp01, smoothstep } from './Noise.ts';

/**
 * Every sprite is generated at load time rather than shipped as an asset.
 *
 * Two reasons: the VFX module stays free of the asset manifest (so it can be
 * built and reviewed independently), and a procedural source lets each sprite
 * carry a matching height field, which is what the decal normal maps are
 * derived from. Generation costs ~40ms once at boot.
 */

/** Layer indices into the particle sprite array texture. */
export const Sprite = {
  SmokeDense: 0,
  SmokeSoft: 1,
  SmokeWisp: 2,
  Dust: 3,
  Spark: 4,
  Glow: 5,
  Flare: 6,
  Debris: 7,
  BloodDrop: 8,
  BloodMist: 9,
  Splash: 10,
  Shard: 11,
  Ring: 12,
  Ember: 13,
  Streak: 14,
  Flash: 15,
} as const;

export const SPRITE_COUNT = 16;
const SPRITE_SIZE = 256;

/** Tile indices into the decal atlas. */
export const DecalTile = {
  Concrete: 0,
  Metal: 1,
  Wood: 2,
  Dirt: 3,
  Glass: 4,
  Flesh: 5,
  Sand: 6,
  Fabric: 7,
} as const;

const DECAL_TILE_SIZE = 256;
const DECAL_COLS = 4;
const DECAL_ROWS = 2;

export interface DecalAtlas {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  readonly cols: number;
  readonly rows: number;
}

// -- particle sprites -------------------------------------------------------

/**
 * Builds the sprite array. A 2D array texture rather than an atlas: mip
 * levels of an atlas bleed neighbouring tiles into each other, and particles
 * are drawn small enough that they sit several mips down most of the time.
 */
export function buildSpriteArray(rng: Rng): THREE.DataArrayTexture {
  const size = SPRITE_SIZE;
  const layerBytes = size * size * 4;
  const data = new Uint8Array(layerBytes * SPRITE_COUNT);
  const noise = new GradientNoise2D(rng);

  const write = (layer: number, fn: (x: number, y: number) => [number, number]): void => {
    const base = layer * layerBytes;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [lum, alpha] = fn((x + 0.5) / size, (y + 0.5) / size);
        const i = base + (y * size + x) * 4;
        const l = Math.round(clamp01(lum) * 255);
        data[i] = l;
        data[i + 1] = l;
        data[i + 2] = l;
        data[i + 3] = Math.round(clamp01(alpha) * 255);
      }
    }
  };

  // Turbulent puff. Domain-warping the radial falloff is what stops the
  // silhouette reading as a circle, which is the usual tell of a fake puff.
  const puff = (
    frequency: number,
    octaves: number,
    erosion: number,
    seedX: number,
    seedY: number,
    edge: number
  ) => {
    return (u: number, v: number): [number, number] => {
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const wx = noise.fbm(u * frequency * 0.6 + seedX, v * frequency * 0.6 + seedY, 3) - 0.5;
      const wy = noise.fbm(u * frequency * 0.6 + seedX + 11.3, v * frequency * 0.6 + seedY - 7.1, 3) - 0.5;
      const n = noise.fbm(
        (u + wx * 0.35) * frequency + seedX,
        (v + wy * 0.35) * frequency + seedY,
        octaves
      );
      const falloff = smoothstep(1.0, edge, r);
      let a = falloff * (1 - erosion + erosion * n * 2);
      a = smoothstep(0.05, 0.62, a);
      // Internal density variation reads as volume once the particle is lit.
      const lum = 0.52 + 0.62 * n - 0.18 * r;
      return [lum, a];
    };
  };

  write(Sprite.SmokeDense, puff(3.4, 5, 0.55, 3.7, 8.2, 0.05));
  write(Sprite.SmokeSoft, puff(2.6, 5, 0.7, 41.2, 17.9, 0.0));
  write(Sprite.SmokeWisp, puff(5.1, 6, 0.92, 91.4, 55.3, 0.0));
  write(Sprite.Dust, puff(4.2, 5, 0.85, 133.7, 22.1, 0.0));
  write(Sprite.BloodMist, puff(6.8, 6, 0.78, 205.5, 71.7, 0.02));

  // Tight bright core with a small halo. Stretched by the billboard, this
  // becomes the spark streak; unstretched it is a hot ember.
  write(Sprite.Spark, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r2 = dx * dx + dy * dy;
    const core = Math.exp(-r2 * 42);
    const halo = Math.exp(-r2 * 5.5) * 0.34;
    const a = clamp01(core + halo);
    return [clamp01(core * 1.6 + halo * 0.6), a];
  });

  write(Sprite.Ember, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r2 = dx * dx + dy * dy;
    const core = Math.exp(-r2 * 90);
    const halo = Math.exp(-r2 * 9) * 0.22;
    return [clamp01(core * 1.8 + halo), clamp01(core + halo)];
  });

  write(Sprite.Glow, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
    const a = Math.pow(1 - r, 2.6);
    return [a * 1.4, a];
  });

  // Muzzle core: a ragged star. The lobe count is deliberately not a clean
  // symmetry so consecutive flashes with different roll angles do not repeat.
  write(Sprite.Flare, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > 1) return [0, 0];
    const theta = Math.atan2(dy, dx);
    const lobes =
      0.36 +
      0.15 * Math.cos(theta * 5 + 0.7) +
      0.09 * Math.cos(theta * 9 - 1.9) +
      0.06 * Math.cos(theta * 3 + 2.6);
    // A short, hard-edged petal skirt around a dense core. Long soft spikes
    // read as a lens flare rather than burning propellant.
    const petals = clamp01((lobes - r) / 0.13);
    const core = Math.exp(-r * r * 34);
    const a = clamp01(core + petals * petals * 0.9);
    return [clamp01(core * 2 + petals * 1.15), a];
  });

  // Broad, slightly irregular flash used behind the core to drive bloom.
  write(Sprite.Flash, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > 1) return [0, 0];
    const theta = Math.atan2(dy, dx);
    const wobble = 1 + 0.14 * Math.cos(theta * 4 + 1.1) + 0.08 * Math.cos(theta * 7 - 0.4);
    const a = Math.pow(clamp01(1 - r / wobble), 2.1);
    return [a * 1.9, a];
  });

  // Irregular opaque chip: a noise-thresholded blob, never a rounded sprite.
  write(Sprite.Debris, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.sqrt(dx * dx + dy * dy);
    const n = noise.fbm(u * 5.5 + 61.1, v * 5.5 - 12.4, 3);
    const a = r < 0.55 + (n - 0.5) * 0.7 ? 1 : 0;
    const shade = 0.35 + 0.5 * noise.fbm(u * 9 + 5, v * 9 + 3, 3);
    return [shade, a * smoothstep(1.0, 0.9, r)];
  });

  write(Sprite.Shard, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    // A thin sliver: narrow in x, tapering along y.
    const taper = 1 - clamp01(Math.abs(dy));
    const width = 0.34 * taper * taper;
    const a = Math.abs(dx) < width ? 1 : 0;
    const facet = 0.55 + 0.45 * clamp01(0.5 + dx / (width + 1e-3));
    return [facet, a];
  });

  write(Sprite.BloodDrop, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.sqrt(dx * dx + dy * dy * 0.75);
    const n = noise.fbm(u * 7 + 200, v * 7 + 88, 3);
    const a = smoothstep(0.92 + (n - 0.5) * 0.25, 0.6, r);
    // Bright specular pip: wet blood catches a highlight.
    const spec = Math.exp(-((dx + 0.22) ** 2 + (dy + 0.26) ** 2) * 26) * 0.9;
    return [0.42 + spec, a];
  });

  write(Sprite.Splash, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = v * 2 - 1;
    // Teardrop: wide at the base, drawn to a point at the top.
    const w = 0.62 * Math.pow(clamp01(1 - (dy + 1) * 0.5), 0.65);
    const a = clamp01((w - Math.abs(dx)) / 0.14);
    const shade = 0.6 + 0.4 * clamp01(1 - Math.abs(dx) / (w + 1e-3));
    return [shade, a];
  });

  write(Sprite.Ring, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.sqrt(dx * dx + dy * dy);
    const n = noise.fbm(Math.atan2(dy, dx) * 2.4 + 9.1, r * 3 + 4.4, 3);
    const width = 0.11 + (n - 0.5) * 0.09;
    const a = clamp01(1 - Math.abs(r - (0.78 + (n - 0.5) * 0.08)) / width);
    return [a * 1.3, a * a];
  });

  // Long axis runs along v, matching the axial billboard's local Y.
  write(Sprite.Streak, (u, v) => {
    const dx = (u - 0.5) * 2;
    const tail = smoothstep(0.0, 0.35, v);
    const head = smoothstep(1.0, 0.82, v);
    const profile = Math.exp(-dx * dx * 9) * tail * head;
    const core = Math.exp(-dx * dx * 40) * tail * head;
    return [clamp01(profile * 0.8 + core * 1.6), clamp01(profile)];
  });

  const texture = new THREE.DataArrayTexture(data, size, size, SPRITE_COUNT);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.name = 'vfx.sprites';
  texture.needsUpdate = true;
  return texture;
}

// -- decals -----------------------------------------------------------------

interface DecalSample {
  /** Coverage in [0,1]. */
  cover: number;
  /** Multiplicative tint applied to the surface underneath, per channel. */
  tint: [number, number, number];
  /** Surface height in [0,1]; 0.5 is flush with the wall. */
  height: number;
}

type DecalGenerator = (u: number, v: number, out: DecalSample) => void;

/**
 * Builds the bullet-hole albedo and normal atlases.
 *
 * Albedo is a *multiplier*, not a colour: decals are drawn with multiplicative
 * blending so they inherit whatever lighting and shadowing the surface already
 * has. Values above 1 brighten, which is how the sunlit lip of a crater and
 * the torn metal petals read as raised.
 */
export function buildDecalAtlas(rng: Rng): DecalAtlas {
  const tile = DECAL_TILE_SIZE;
  const width = tile * DECAL_COLS;
  const height = tile * DECAL_ROWS;
  const albedoData = new Uint8Array(width * height * 4);
  const normalData = new Uint8Array(width * height * 4);
  const noise = new GradientNoise2D(rng);
  const heights = new Float32Array(tile * tile);

  const generators: DecalGenerator[] = [
    concreteHole(noise),
    metalHole(noise),
    woodHole(noise),
    dirtCrater(noise),
    glassCrack(noise),
    fleshWound(noise),
    sandCrater(noise),
    fabricTear(noise),
  ];

  const sample: DecalSample = { cover: 0, tint: [1, 1, 1], height: 0.5 };

  for (let t = 0; t < generators.length; t++) {
    const generate = generators[t]!;
    const ox = (t % DECAL_COLS) * tile;
    const oy = Math.floor(t / DECAL_COLS) * tile;

    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        sample.cover = 0;
        sample.tint[0] = 1;
        sample.tint[1] = 1;
        sample.tint[2] = 1;
        sample.height = 0.5;
        generate((x + 0.5) / tile, (y + 0.5) / tile, sample);

        // Fade coverage at the tile border so mip bleed cannot produce a
        // visible square around the hole.
        const border =
          smoothstep(0, 0.06, (x + 0.5) / tile) *
          smoothstep(1, 0.94, (x + 0.5) / tile) *
          smoothstep(0, 0.06, (y + 0.5) / tile) *
          smoothstep(1, 0.94, (y + 0.5) / tile);
        const cover = clamp01(sample.cover) * border;

        heights[y * tile + x] = 0.5 + (sample.height - 0.5) * cover;

        const i = ((oy + y) * width + (ox + x)) * 4;
        // Tint is stored with 2.0 headroom so a crater lip can brighten.
        albedoData[i] = Math.round(clamp01(sample.tint[0] * 0.5) * 255);
        albedoData[i + 1] = Math.round(clamp01(sample.tint[1] * 0.5) * 255);
        albedoData[i + 2] = Math.round(clamp01(sample.tint[2] * 0.5) * 255);
        albedoData[i + 3] = Math.round(cover * 255);
      }
    }

    // Sobel the height field into a tangent-space normal map.
    const strength = 3.4;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const at = (px: number, py: number): number =>
          heights[Math.min(tile - 1, Math.max(0, py)) * tile + Math.min(tile - 1, Math.max(0, px))]!;
        const dzdx =
          at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
          (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const dzdy =
          at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
          (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        let nx = -dzdx * strength;
        let ny = -dzdy * strength;
        const nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len;
        ny /= len;
        const i = ((oy + y) * width + (ox + x)) * 4;
        normalData[i] = Math.round((nx * 0.5 + 0.5) * 255);
        normalData[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normalData[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
        normalData[i + 3] = 255;
      }
    }
  }

  const albedo = new THREE.DataTexture(albedoData, width, height, THREE.RGBAFormat);
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.magFilter = THREE.LinearFilter;
  albedo.generateMipmaps = true;
  albedo.colorSpace = THREE.NoColorSpace;
  albedo.name = 'vfx.decal.albedo';
  albedo.needsUpdate = true;

  const normal = new THREE.DataTexture(normalData, width, height, THREE.RGBAFormat);
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.magFilter = THREE.LinearFilter;
  normal.generateMipmaps = true;
  normal.colorSpace = THREE.NoColorSpace;
  normal.name = 'vfx.decal.normal';
  normal.needsUpdate = true;

  return { albedo, normal, cols: DECAL_COLS, rows: DECAL_ROWS };
}

/**
 * Decal tint is encoded with 2.0 of headroom, so a crater lip or a chalked
 * spall ring can brighten the surface it sits on rather than only darken it.
 */
function clampTint(value: number): number {
  return value < 0 ? 0 : value > 2 ? 2 : value;
}

/** Polar helpers shared by the decal generators. */
function polar(u: number, v: number): { r: number; theta: number } {
  const dx = (u - 0.5) * 2;
  const dy = (v - 0.5) * 2;
  return { r: Math.sqrt(dx * dx + dy * dy), theta: Math.atan2(dy, dx) };
}

function concreteHole(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r, theta } = polar(u, v);
    const wobble = 1 + (noise.fbm(u * 9 + 2.2, v * 9 - 4.1, 3) - 0.5) * 0.5;
    const holeR = 0.2 * wobble;
    const spallR = 0.42 * (1 + (noise.fbm(u * 5 + 30, v * 5 + 12, 3) - 0.5) * 0.55);
    const dustR = 0.9;

    // Radial hairline cracks.
    const crack = Math.pow(noise.ridged(Math.cos(theta) * 1.7 + 20, Math.sin(theta) * 1.7 + 9, 3), 6);
    const crackMask = crack * smoothstep(0.16, 0.5, r) * smoothstep(0.95, 0.55, r);

    const hole = smoothstep(holeR, holeR * 0.55, r);
    const spall = smoothstep(spallR, spallR * 0.5, r) * (0.45 + 0.55 * noise.fbm(u * 14, v * 14, 4));
    const dust = smoothstep(dustR, 0.22, r) * 0.36 * noise.fbm(u * 6 + 71, v * 6 + 3, 4);

    out.cover = clamp01(hole + spall * 0.85 + dust + crackMask * 0.8);
    const dark = 1 - hole * 0.92 - crackMask * 0.6;
    // Fresh concrete under the weathered face is markedly paler, so the spall
    // ring has to brighten; a ring that only darkens reads as a smudge.
    const chalk = dust * 0.55 + spall * 0.72;
    out.tint[0] = clampTint(dark + chalk * 0.95);
    out.tint[1] = clampTint(dark + chalk * 0.92);
    out.tint[2] = clampTint(dark + chalk * 0.85);
    out.height = 0.5 - hole * 0.5 - spall * 0.18 + smoothstep(holeR * 1.05, holeR * 1.5, r) * smoothstep(spallR, holeR * 1.4, r) * 0.16;
  };
}

function metalHole(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r, theta } = polar(u, v);
    const petals = 1 + 0.22 * Math.cos(theta * 6 + 1.3) + 0.12 * Math.cos(theta * 11 - 0.6);
    const holeR = 0.13 * petals;
    const lipR = 0.24 * petals;

    const hole = smoothstep(holeR, holeR * 0.6, r);
    const lip = smoothstep(lipR, holeR * 0.95, r) - hole;
    // Carbon scorch, elongated slightly to suggest an angled strike.
    const soot = smoothstep(0.72, 0.15, r) * (0.35 + 0.4 * noise.fbm(u * 11 + 44, v * 11 + 5, 4));
    const scratch = Math.pow(noise.ridged(Math.cos(theta) * 2.4 + 60, Math.sin(theta) * 2.4 + 3, 2), 5) *
      smoothstep(0.18, 0.42, r) * smoothstep(0.8, 0.4, r);

    out.cover = clamp01(hole + Math.max(0, lip) + soot * 0.8 + scratch * 0.5);
    const bright = Math.max(0, lip) * 1.5 + scratch * 0.5;
    const dark = 1 - hole * 0.86 - soot * 0.5;
    out.tint[0] = clampTint(dark + bright * 1.15);
    out.tint[1] = clampTint(dark + bright * 1.08);
    out.tint[2] = clampTint(dark + bright * 0.94);
    out.height = 0.5 - hole * 0.5 + Math.max(0, lip) * 0.45;
  };
}

function woodHole(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r, theta } = polar(u, v);
    const holeR = 0.16 * (1 + (noise.fbm(u * 8 + 7, v * 8 + 1, 3) - 0.5) * 0.4);
    const hole = smoothstep(holeR, holeR * 0.55, r);

    // Splinters: long radial spikes with a hard angular profile.
    const spike =
      0.5 +
      0.28 * Math.cos(theta * 7 + 0.9) +
      0.18 * Math.cos(theta * 13 - 2.1) +
      0.12 * Math.cos(theta * 21 + 1.4);
    const splinter = clamp01((spike * 0.86 - r) / 0.1) * smoothstep(holeR * 0.7, holeR * 1.3, r);
    const burn = smoothstep(0.5, 0.1, r) * 0.55;

    out.cover = clamp01(hole + splinter * 0.9 + burn * 0.5);
    const dark = 1 - hole * 0.88 - burn * 0.5;
    // Exposed grain is paler and warmer than the weathered face.
    const raw = splinter * 0.55;
    out.tint[0] = clampTint(dark + raw * 1.6);
    out.tint[1] = clampTint(dark + raw * 1.28);
    out.tint[2] = clampTint(dark + raw * 0.8);
    out.height = 0.5 - hole * 0.5 + splinter * 0.3;
  };
}

function dirtCrater(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r } = polar(u, v);
    const n = noise.fbm(u * 6 + 90, v * 6 + 33, 4);
    const craterR = 0.34 * (1 + (n - 0.5) * 0.6);
    const crater = smoothstep(craterR, craterR * 0.3, r);
    const rim = smoothstep(craterR * 1.7, craterR, r) - crater;
    const scatter = smoothstep(0.95, 0.3, r) * Math.pow(noise.fbm(u * 17 + 4, v * 17 + 8, 4), 2.2) * 1.4;

    out.cover = clamp01(crater + Math.max(0, rim) * 0.7 + scatter * 0.7);
    const dark = 1 - crater * 0.7;
    const loose = Math.max(0, rim) * 0.3 + scatter * 0.35;
    out.tint[0] = clampTint(dark + loose * 1.2);
    out.tint[1] = clampTint(dark + loose * 0.98);
    out.tint[2] = clampTint(dark + loose * 0.7);
    out.height = 0.5 - crater * 0.4 + Math.max(0, rim) * 0.24 + scatter * 0.1;
  };
}

function glassCrack(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r, theta } = polar(u, v);
    const holeR = 0.1;
    const hole = smoothstep(holeR, holeR * 0.5, r);

    // Radial fractures plus concentric arrest lines.
    const radial = Math.pow(noise.ridged(Math.cos(theta) * 3.1 + 5, Math.sin(theta) * 3.1 + 17, 3), 9);
    const radialMask = radial * smoothstep(0.06, 0.2, r) * smoothstep(1.0, 0.45, r);
    const rings =
      Math.pow(Math.abs(Math.sin(r * 19 + noise.fbm(u * 4, v * 4, 2) * 3)), 26) *
      smoothstep(0.12, 0.3, r) *
      smoothstep(0.85, 0.4, r);

    const cracks = clamp01(radialMask * 1.6 + rings * 0.8);
    out.cover = clamp01(hole + cracks * 0.9);
    // Fractured glass scatters light: cracks brighten, the punch-through is black.
    out.tint[0] = clampTint(1 - hole * 0.98 + cracks * 1.5);
    out.tint[1] = clampTint(1 - hole * 0.98 + cracks * 1.6);
    out.tint[2] = clampTint(1 - hole * 0.98 + cracks * 1.75);
    out.height = 0.5 - hole * 0.45 + cracks * 0.2;
  };
}

function fleshWound(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r } = polar(u, v);
    const n = noise.fbm(u * 7 + 12, v * 7 + 55, 4);
    const wound = smoothstep(0.3 * (1 + (n - 0.5) * 0.7), 0.06, r);
    const spatter = smoothstep(0.95, 0.2, r) * Math.pow(noise.fbm(u * 19 + 3, v * 19 + 9, 4), 3.2) * 2.2;
    out.cover = clamp01(wound + spatter * 0.8);
    const amount = clamp01(wound + spatter * 0.6);
    out.tint[0] = clampTint(1 - amount * 0.62);
    out.tint[1] = clampTint(1 - amount * 0.95);
    out.tint[2] = clampTint(1 - amount * 0.95);
    out.height = 0.5 - wound * 0.22;
  };
}

function sandCrater(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r } = polar(u, v);
    const grain = noise.fbm(u * 26 + 6, v * 26 + 2, 3);
    const craterR = 0.4;
    const crater = smoothstep(craterR, craterR * 0.25, r);
    const rim = smoothstep(craterR * 1.6, craterR, r) - crater;
    out.cover = clamp01((crater + Math.max(0, rim) * 0.8) * (0.7 + grain * 0.6));
    const dark = 1 - crater * 0.55;
    out.tint[0] = clampTint(dark + Math.max(0, rim) * 0.5);
    out.tint[1] = clampTint(dark + Math.max(0, rim) * 0.45);
    out.tint[2] = clampTint(dark + Math.max(0, rim) * 0.35);
    out.height = 0.5 - crater * 0.3 + Math.max(0, rim) * 0.2 + (grain - 0.5) * 0.05;
  };
}

function fabricTear(noise: GradientNoise2D): DecalGenerator {
  return (u, v, out) => {
    const { r, theta } = polar(u, v);
    const tearR = 0.17 * (1 + 0.4 * Math.cos(theta * 4 + 0.8));
    const hole = smoothstep(tearR, tearR * 0.4, r);
    const fray =
      clamp01((0.34 + 0.16 * Math.cos(theta * 17 + 2.2) - r) / 0.05) *
      smoothstep(tearR * 0.8, tearR * 1.4, r);
    const dirt = smoothstep(0.6, 0.2, r) * 0.4 * noise.fbm(u * 12 + 8, v * 12 + 4, 3);
    out.cover = clamp01(hole + fray * 0.7 + dirt);
    const dark = 1 - hole * 0.9 - dirt * 0.5;
    out.tint[0] = clampTint(dark + fray * 0.45);
    out.tint[1] = clampTint(dark + fray * 0.42);
    out.tint[2] = clampTint(dark + fray * 0.38);
    out.height = 0.5 - hole * 0.35 + fray * 0.18;
  };
}
