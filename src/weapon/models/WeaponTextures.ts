import * as THREE from 'three';

/**
 * Procedural PBR texture set for the viewmodel.
 *
 * The weapon has no authored maps and cannot get them: everything here is
 * generated at boot. Each surface family — hard-anodised aluminium, hardcoat
 * black rails, phosphated steel, moulded polymer, rubber, and the two fabrics
 * on the hands — gets its own albedo, ORM (occlusion/roughness/metalness) and
 * normal map, because the single flat albedo they shared before is exactly
 * what makes a model read as untextured plastic no matter how it is lit.
 *
 * Every map is generated on a wrapped lattice so it tiles seamlessly, and all
 * noise is hash-based rather than random so a capture is byte-reproducible.
 */

/** Tile side for the families that dominate screen area. */
const PRIMARY = 384;
/** Tile side for the small-area families, which never resolve as finely. */
const SECONDARY = 256;

// -- noise --------------------------------------------------------------------

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Wraps a lattice coordinate into `[0,period)` so every octave tiles. */
function wrap(v: number, period: number): number {
  return ((v % period) + period) % period;
}

/**
 * Value noise on a lattice of `period` cells per tile.
 *
 * `period` is in cells across the whole texture, so the caller expresses
 * frequency in tiles rather than texels and the map stays seamless whatever
 * resolution it is baked at.
 */
function noise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrap(xi, period);
  const y0 = wrap(yi, period);
  const x1 = wrap(xi + 1, period);
  const y1 = wrap(yi + 1, period);
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal value noise. `period` is the base frequency in cells per tile. */
function fbm(
  u: number,
  v: number,
  period: number,
  octaves: number,
  seed: number,
  gain = 0.5
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    sum += noise(u * p, v * p, p, seed + i * 131) * amplitude;
    total += amplitude;
    amplitude *= gain;
    p *= 2;
  }
  return sum / total;
}

/**
 * Wrapped Worley noise: distance to the nearest jittered lattice point.
 *
 * This is what gives moulded polymer its pebble grain — the one texture that
 * separates injection-moulded furniture from machined metal at a glance.
 */
function cells(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let nearest = 4;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = wrap(xi + dx, period);
      const cy = wrap(yi + dy, period);
      const px = xi + dx + hash(cx, cy, seed);
      const py = yi + dy + hash(cx, cy, seed + 977);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < nearest) nearest = d;
    }
  }
  return Math.min(1, Math.sqrt(nearest) * 1.6);
}

/** Sharp, sparse specks: paint chips, casting flecks, dust in a crevice. */
function speckle(u: number, v: number, period: number, seed: number, threshold: number): number {
  const n = noise(u * period, v * period, period, seed);
  return n > threshold ? (n - threshold) / (1 - threshold) : 0;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

// -- baking -------------------------------------------------------------------

/** One texel of a surface recipe. Colour channels are sRGB in `[0,1]`. */
interface Texel {
  r: number;
  g: number;
  b: number;
  roughness: number;
  metalness: number;
  /** Baked cavity occlusion, multiplied into indirect light only. */
  ao: number;
  /** Height field the normal map is differentiated from. */
  height: number;
}

export interface SurfaceMaps {
  map: THREE.DataTexture;
  /** R = occlusion, G = roughness, B = metalness. */
  orm: THREE.DataTexture;
  normalMap: THREE.DataTexture;
}

interface Recipe {
  size: number;
  /** Vertical exaggeration of the height field when differentiated. */
  relief: number;
  sample(u: number, v: number, out: Texel): void;
}

function bake(recipe: Recipe): SurfaceMaps {
  const size = recipe.size;
  const albedo = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  const texel: Texel = { r: 0, g: 0, b: 0, roughness: 0.5, metalness: 0, ao: 1, height: 0.5 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      recipe.sample((x + 0.5) / size, (y + 0.5) / size, texel);
      const i = y * size + x;
      albedo[i * 4] = Math.round(clamp01(texel.r) * 255);
      albedo[i * 4 + 1] = Math.round(clamp01(texel.g) * 255);
      albedo[i * 4 + 2] = Math.round(clamp01(texel.b) * 255);
      albedo[i * 4 + 3] = 255;
      orm[i * 4] = Math.round(clamp01(texel.ao) * 255);
      orm[i * 4 + 1] = Math.round(clamp01(texel.roughness) * 255);
      orm[i * 4 + 2] = Math.round(clamp01(texel.metalness) * 255);
      orm[i * 4 + 3] = 255;
      heights[i] = texel.height;
    }
  }

  const normal = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const left = heights[y * size + wrap(x - 1, size)] as number;
      const right = heights[y * size + wrap(x + 1, size)] as number;
      const down = heights[wrap(y - 1, size) * size + x] as number;
      const up = heights[wrap(y + 1, size) * size + x] as number;
      const dx = (right - left) * recipe.relief;
      const dy = (up - down) * recipe.relief;
      const length = Math.hypot(dx, dy, 1);
      normal[i * 4] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      normal[i * 4 + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      normal[i * 4 + 2] = Math.round((1 / length) * 255);
      normal[i * 4 + 3] = 255;
    }
  }

  const make = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };

  return { map: make(albedo, true), orm: make(orm, false), normalMap: make(normal, false) };
}

// -- recipes ------------------------------------------------------------------

/**
 * Type III hard-anodised aluminium: the upper and lower receiver and the
 * optic housing.
 *
 * Anodising is a porous oxide grown into bead-blasted alloy, so it is neither
 * a clean metal nor a dielectric: the dye density varies in broad patches, the
 * blast leaves a uniform micro-pit field, and the whole surface sits well
 * short of mirror. The patchiness is the part that reads on screen — a
 * constant grey receiver is the giveaway of an untextured model.
 */
const anodised: Recipe = {
  size: PRIMARY,
  relief: 0.75,
  sample(u, v, out) {
    const blast = fbm(u, v, 48, 3, 11);
    const patch = fbm(u, v, 5, 3, 23);
    const brush = noise(u * 6, v * 90, 90, 37);
    const pits = speckle(u, v, 64, 41, 0.9);

    const tone = 0.132 + patch * 0.024 + (blast - 0.5) * 0.012;
    // Green sits between red and blue, never below both. A grey with green as
    // its minimum channel is a magenta, and a magenta albedo lit by a warm key
    // against a cool sky fill squeezes green from both sides at once — which
    // is precisely the purple-grey that reads as painted plastic rather than
    // as anodising. The tilt toward blue is what carries the gunmetal.
    out.r = tone;
    out.g = tone * 1.005;
    out.b = tone * 1.03;
    // The variation here is deliberately narrow. A metal reads as metal
    // because its value swings with what it happens to be reflecting — sky on
    // the up-faces, ground on the flanks — and that only happens if the
    // highlight stays tight. A wide roughness spread scatters the reflection
    // into a uniform mid-grey wash, which is the look of bead-blasted
    // concrete rather than a hard-anodised receiver.
    out.roughness = clamp01(0.29 + (1 - patch) * 0.09 + (blast - 0.5) * 0.07 + pits * 0.1);
    // Below 1 on purpose: the oxide layer is a dielectric film over the metal,
    // and a fully metallic receiver mirrors the sky and goes chrome.
    out.metalness = clamp01(0.84 + (patch - 0.5) * 0.1);
    out.ao = 1 - pits * 0.1 - (1 - blast) * 0.04;
    out.height = blast * 0.5 + brush * 0.1 - pits * 0.1;
  },
};

/**
 * Hardcoat black on the rails and the extruded handguard.
 *
 * Kept a stop darker and rougher than the receiver so the rail reads as a
 * separate part rather than a moulding of the same block, with extrusion
 * striations running along the weapon's long axis.
 */
const hardcoat: Recipe = {
  size: SECONDARY,
  relief: 0.85,
  sample(u, v, out) {
    const grain = fbm(u, v, 40, 2, 53);
    const stria = noise(u * 4, v * 96, 96, 61);
    const patch = fbm(u, v, 6, 2, 71);
    const scuff = speckle(u, v, 28, 83, 0.84);

    const tone = 0.076 + patch * 0.016 + (grain - 0.5) * 0.01 + scuff * 0.03;
    out.r = tone;
    out.g = tone * 1.01;
    out.b = tone * 1.06;
    out.roughness = clamp01(0.43 + (grain - 0.5) * 0.12 - scuff * 0.12);
    // Well below the receiver's. Hardcoat is a thick oxide rather than a thin
    // dye layer, and the rail is the flattest, most sky-facing part of the
    // weapon: at anything approaching bare-metal reflectance its slots turn
    // into a bright ladder that outshines the optic sitting on top of them.
    out.metalness = clamp01(0.52 + scuff * 0.2);
    out.ao = 1 - (1 - grain) * 0.08;
    out.height = grain * 0.4 + stria * 0.24 + scuff * 0.1;
  },
};

/**
 * Manganese-phosphated (parkerised) steel: barrel, pins, bolt, muzzle device.
 *
 * A phosphate conversion coat is a crystalline matte grey with a distinctly
 * coarser grain than anodising, and it polishes to bright steel wherever a
 * part is handled, which is what the wear layer keys off.
 */
const parkerised: Recipe = {
  size: PRIMARY,
  relief: 0.8,
  sample(u, v, out) {
    const crystal = cells(u, v, 68, 97);
    const grain = fbm(u, v, 36, 3, 103);
    const turn = noise(u * 3, v * 120, 120, 109);
    const patch = fbm(u, v, 4, 2, 127);

    const tone = 0.098 + patch * 0.018 + (1 - crystal) * 0.012 + (grain - 0.5) * 0.01;
    // The one body material allowed to run warm, because phosphate genuinely
    // is a brown-grey and the barrel and bolt need to read as a different
    // metal from the receiver. Only just warm enough to tell them apart.
    out.r = tone * 1.03;
    out.g = tone;
    out.b = tone * 0.99;
    out.roughness = clamp01(0.31 + crystal * 0.14 + (grain - 0.5) * 0.08);
    out.metalness = 1;
    out.ao = 1 - (1 - crystal) * 0.16;
    out.height = crystal * 0.4 + grain * 0.16 + turn * 0.14;
  },
};

/**
 * Glass-filled polymer: pistol grip, stock, magazine, handstop.
 *
 * The mould texture is a pebble stipple rather than noise, and the surface is
 * the only non-metal on the weapon body, so it is what stops the whole rifle
 * reading as one milled block.
 */
const polymer: Recipe = {
  size: PRIMARY,
  relief: 1.7,
  sample(u, v, out) {
    const pebble = cells(u, v, 46, 149);
    const fine = cells(u, v, 96, 151);
    const flow = fbm(u * 0.35, v, 8, 3, 157);
    const filler = speckle(u, v, 72, 163, 0.93);

    const tone = 0.082 + flow * 0.022 + pebble * 0.014 + filler * 0.05;
    out.r = tone * 0.99;
    out.g = tone;
    out.b = tone * 1.03;
    out.roughness = clamp01(0.56 + (1 - pebble) * 0.12 - filler * 0.2 + (flow - 0.5) * 0.06);
    out.metalness = clamp01(0.03 + filler * 0.08);
    out.ao = 1 - (1 - pebble) * 0.18 - (1 - fine) * 0.06;
    out.height = pebble * 0.5 + fine * 0.16;
  },
};

/** Moulded rubber: grip panels, butt pad, handstop tape. */
const rubber: Recipe = {
  size: SECONDARY,
  relief: 2.2,
  sample(u, v, out) {
    const stipple = cells(u, v, 34, 191);
    const fine = fbm(u, v, 44, 2, 193);
    const tone = 0.052 + stipple * 0.022 + (fine - 0.5) * 0.01;
    out.r = tone;
    out.g = tone * 1.01;
    out.b = tone * 1.05;
    out.roughness = clamp01(0.84 + (1 - stipple) * 0.1);
    out.metalness = 0;
    out.ao = 1 - (1 - stipple) * 0.24;
    out.height = stipple * 0.6 + fine * 0.16;
  },
};

/**
 * Glove leather with a nomex back.
 *
 * Deliberately the warmest and lightest surface on screen. The hands are the
 * only thing that tells the player the weapon is held rather than floating,
 * and at the value the gloves used to sit they merged straight into the
 * receiver.
 */
const glove: Recipe = {
  size: SECONDARY,
  relief: 1.5,
  sample(u, v, out) {
    const grain = cells(u, v, 104, 211);
    const creases = fbm(u, v, 14, 4, 223, 0.62);
    const wear = fbm(u, v, 5, 2, 227);
    const crease = Math.pow(1 - Math.abs(creases - 0.5) * 2, 3);

    // Creases carry the shape rather than the grain: leather at viewmodel
    // distance shows folds across a knuckle, not individual pores.
    const tone = 0.148 + wear * 0.05 + grain * 0.012 - crease * 0.06;
    out.r = tone * 1.3;
    out.g = tone * 1.0;
    out.b = tone * 0.66;
    out.roughness = clamp01(0.7 + (1 - grain) * 0.08 + crease * 0.12 - wear * 0.1);
    out.metalness = 0;
    out.ao = 1 - crease * 0.42 - (1 - grain) * 0.08;
    out.height = grain * 0.2 - crease * 0.8;
  },
};

/**
 * Ripstop combat-shirt sleeve.
 *
 * The grid is what stops the forearm reading as a length of tan pipe, which
 * is precisely how the untextured cylinder read before.
 */
const ripstop: Recipe = {
  size: SECONDARY,
  relief: 0.7,
  sample(u, v, out) {
    const weftPhase = Math.sin(u * Math.PI * 2 * 56) * 0.5 + 0.5;
    const warpPhase = Math.sin(v * Math.PI * 2 * 56) * 0.5 + 0.5;
    const weave = weftPhase * 0.5 + warpPhase * 0.5;
    // Ripstop is a plain weave with a heavier thread every few millimetres.
    // Both terms are kept low: at viewmodel distance a literal weave turns
    // the forearm into wire mesh long before it reads as cloth, so the fabric
    // is carried by the folds and the weave only breaks up the specular.
    const gridU = Math.pow(Math.abs(Math.sin(u * Math.PI * 9)), 12);
    const gridV = Math.pow(Math.abs(Math.sin(v * Math.PI * 9)), 12);
    const grid = Math.max(gridU, gridV);
    const fade = fbm(u, v, 6, 3, 239);
    const dirt = fbm(u, v, 3, 2, 241);
    const folds = fbm(u * 0.4, v, 5, 3, 243);

    const tone = 0.118 + fade * 0.032 - dirt * 0.022 + folds * 0.04;
    out.r = tone * 1.16;
    out.g = tone * 1.04;
    out.b = tone * 0.74;
    out.roughness = clamp01(0.88 + (1 - weave) * 0.05 - grid * 0.02);
    out.metalness = 0;
    out.ao = 1 - (1 - weave) * 0.05 - (1 - folds) * 0.16;
    out.height = weave * 0.12 + grid * 0.08 + folds * 0.8;
  },
};

// -- wear mask ----------------------------------------------------------------

/**
 * Break-up mask for the curvature-driven edge wear.
 *
 * Wear that follows a chamfer exactly reads as an outline drawn on the model.
 * Modulating it with this makes it thin, thicken and drop out along the edge
 * the way handling wear actually does.
 */
function createWearNoise(): THREE.DataTexture {
  const size = SECONDARY;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const broad = fbm(u, v, 7, 3, 307, 0.6);
      const fine = fbm(u, v, 40, 2, 311);
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(broad * 0.75 + fine * 0.25) * 255);
      data[i + 1] = Math.round(clamp01(fine) * 255);
      data[i + 2] = Math.round(clamp01(fbm(u, v, 18, 2, 313)) * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// -- public -------------------------------------------------------------------

export interface WeaponTextures {
  anodised: SurfaceMaps;
  hardcoat: SurfaceMaps;
  parkerised: SurfaceMaps;
  polymer: SurfaceMaps;
  rubber: SurfaceMaps;
  glove: SurfaceMaps;
  ripstop: SurfaceMaps;
  wearNoise: THREE.DataTexture;
  dispose(): void;
}

export function createWeaponTextures(): WeaponTextures {
  const sets = {
    anodised: bake(anodised),
    hardcoat: bake(hardcoat),
    parkerised: bake(parkerised),
    polymer: bake(polymer),
    rubber: bake(rubber),
    glove: bake(glove),
    ripstop: bake(ripstop),
  };
  const wearNoise = createWearNoise();
  return {
    ...sets,
    wearNoise,
    dispose(): void {
      for (const maps of Object.values(sets)) {
        maps.map.dispose();
        maps.orm.dispose();
        maps.normalMap.dispose();
      }
      wearNoise.dispose();
    },
  };
}
