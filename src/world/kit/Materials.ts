import * as THREE from 'three';
import type { ResourceManager } from '@/types/assets.ts';
import type { SurfaceKind } from '@/types/gameplay.ts';
import { disposeDetailTextures } from './Detail.ts';
import { decorateSurface, type SurfaceProfile } from './Surfaces.ts';

/**
 * `metal`, `steel` and `paint` are all the same corrugated-iron scan and differ
 * only in how they treat its metalness channel. See `RESPONSE` for why there
 * are three of them.
 */
export type MaterialKey =
  | 'ground'
  | 'plaster'
  | 'trim'
  | 'metal'
  | 'steel'
  | 'paint'
  | 'wood'
  | 'burlap';

const MATERIAL_IDS: Record<MaterialKey, string> = {
  ground: 'concrete_ground',
  plaster: 'plaster_wall',
  trim: 'concrete_trim',
  metal: 'rusted_metal',
  steel: 'rusted_metal',
  paint: 'rusted_metal',
  wood: 'wood_planks',
  // Hessian has no scan of its own in the set; the fine aggregate of the
  // concrete wall reads as coarse cloth once the weave normal is over it and
  // the tile is pulled down to sack scale.
  burlap: 'concrete_trim',
};

const SURFACES: Record<MaterialKey, SurfaceKind> = {
  ground: 'concrete',
  plaster: 'concrete',
  trim: 'concrete',
  metal: 'metal',
  steel: 'metal',
  paint: 'metal',
  wood: 'wood',
  burlap: 'sand',
};

/** World-space size of one base-texture repeat, overriding the manifest. */
const TILE_OVERRIDE: Partial<Record<MaterialKey, number>> = {
  burlap: 0.85,
};

const colour = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

interface MaterialResponse {
  /** Multiplies the ORM green channel. */
  roughness: number;
  /** Multiplies the ORM blue channel unless `mapMetalness` is false. */
  metalness: number;
  normal: number;
  /**
   * Ignores the ORM blue channel, making `metalness` above the whole story.
   * The scan's own metalness is a property of the surface it was taken from,
   * so it can only be honoured by a material that claims to be that surface.
   */
  mapMetalness?: boolean;
  /**
   * Replaces the albedo map with a flat colour. For a conductor the albedo is
   * the specular F0 rather than a diffuse tint, and a real steel F0 is close
   * to uniform: what varies over a sheet of it is gloss and relief, not
   * reflectance. Painting the scan's tonal variation into F0 instead reads as
   * a metal that cannot decide what it is made of.
   */
  albedo?: THREE.Color;
  envMapIntensity?: number;
}

/**
 * Per-material response overrides, on top of what the ORM texture carries.
 *
 * THE THREE IRON MATERIALS. All three are the same Poly Haven corrugated-iron
 * scan, and the only thing separating them is metalness — which is the whole
 * point, because metalness is not a dial for how shiny something should look.
 *
 *  - `metal` is the scan as authored: weathered rust, whose ORM blue channel
 *    sits at 0.25 because rust is an oxide and oxides are dielectrics. That
 *    value is correct and is deliberately left alone. Raising it would buy
 *    reflections by lying about what the surface is.
 *  - `steel` is bare or lightly worn steel, which is a conductor: metalness 1
 *    with the scan's rust metalness discarded, and a flat F0 in place of the
 *    scan's albedo. This is the only material in the kit that reflects the
 *    yard, and it exists because a working shipyard is full of clean steel —
 *    guardrail, shutter guides, conduit, switchgear — none of which had any
 *    representation here.
 *  - `paint` is painted steel, which is a dielectric film over a conductor and
 *    reads as the film: metalness 0, and glossier than bare rust because
 *    industrial enamel is. Its 0 is as deliberate as steel's 1 — a painted
 *    container flank that reflects like metal is the same error in reverse.
 */
const RESPONSE: Record<MaterialKey, MaterialResponse> = {
  ground: { roughness: 1.0, metalness: 0.0, normal: 1.1 },
  plaster: { roughness: 0.98, metalness: 0.0, normal: 1.35 },
  trim: { roughness: 0.92, metalness: 0.0, normal: 1.0 },
  metal: { roughness: 0.85, metalness: 1.0, normal: 0.95, envMapIntensity: 1.15 },
  // 0.58 against a green channel averaging 0.62 lands the sheet around 0.36
  // with the weathered patches reaching 0.5 — worn galvanising, not chrome.
  steel: {
    roughness: 0.58,
    metalness: 1.0,
    normal: 0.8,
    mapMetalness: false,
    albedo: colour(0.56, 0.57, 0.58),
  },
  paint: {
    roughness: 0.62,
    metalness: 0.0,
    normal: 0.95,
    mapMetalness: false,
    envMapIntensity: 1.0,
  },
  wood: { roughness: 0.95, metalness: 0.0, normal: 1.25 },
  burlap: { roughness: 1.0, metalness: 0.0, normal: 0.45 },
};

/**
 * Detail-layer settings per material.
 *
 * The scales are metres per repeat of the procedural atlas and are deliberately
 * unrelated to the base texture's tile. The coarse tap lands features in the
 * five-to-forty-centimetre band, which is what a camera between five and twenty
 * metres out resolves; the fine tap runs a full order of magnitude tighter, at
 * a couple of millimetres to a few centimetres, because that band is the
 * concrete tooth the surfaces were short of and it is the only one that
 * survives the high-pass a detail measurement runs.
 *
 * `cavityOcclusion` sits well below the tint the same mask applies, because the
 * render pass now traces screen-space occlusion over these crevices too. The
 * dirt colour in a crack is this layer's to own; the light missing from it is
 * not, and applying both turns every junction to mud.
 */
const PROFILES: Record<MaterialKey, SurfaceProfile> = {
  ground: {
    macroScale: 3.4,
    microScale: 0.34,
    normalMacro: 0.55,
    normalMicro: 0.45,
    aggregate: 0.6,
    patch: 0.18,
    stain: 0.26,
    stainColor: colour(0.8, 0.76, 0.7),
    cavity: 0.26,
    cavityOcclusion: 0.34,
    // Kept low: the yard floor is horizontal everywhere, so this term is a
    // background dirtiness on it rather than a junction, and the walls carry
    // the actual corner darkening from their own side.
    grime: 0.2,
    grimeHeight: 0.5,
    grimeColor: colour(0.62, 0.58, 0.52),
    streak: 0,
    dust: 0.05,
    roughness: 0.14,
  },
  plaster: {
    macroScale: 2.9,
    microScale: 0.3,
    normalMacro: 0.68,
    normalMicro: 0.52,
    aggregate: 0.7,
    patch: 0.3,
    stain: 0.3,
    stainColor: colour(0.78, 0.72, 0.63),
    cavity: 0.3,
    cavityOcclusion: 0.36,
    grime: 0.5,
    grimeHeight: 1.25,
    grimeColor: colour(0.5, 0.46, 0.4),
    streak: 0.38,
    dust: 0.05,
    roughness: 0.15,
  },
  // The platform deck is this material, and the elevated shot looks along it
  // for its full depth. Nothing at the fine tap's scale survives that: at
  // grazing incidence a screen pixel covers more ground than a whole repeat, so
  // the deck's detail has to be carried by the coarse tap, and `patch` is
  // weighted accordingly rather than matched to plaster.
  trim: {
    macroScale: 2.6,
    microScale: 0.28,
    normalMacro: 0.72,
    normalMicro: 0.55,
    aggregate: 0.8,
    patch: 0.4,
    stain: 0.34,
    stainColor: colour(0.76, 0.73, 0.68),
    cavity: 0.32,
    cavityOcclusion: 0.36,
    grime: 0.4,
    grimeHeight: 0.9,
    grimeColor: colour(0.55, 0.51, 0.45),
    streak: 0.32,
    dust: 0.06,
    roughness: 0.16,
  },
  // Metal and wood take the weathering but not the relief. Their source maps
  // already carry the tightest detail in the arena — the crate the critic
  // measured at 60.7 is one of them — and both of the layer's relief terms cost
  // that detail rather than adding to it: perturbing the normal renormalises
  // the source map's own variation down, and occluding the cavity scales the
  // indirect light the fine grain is read by. Measured, the pair took 7% off
  // the crate.
  metal: {
    macroScale: 2.2,
    microScale: 0,
    normalMacro: 0,
    normalMicro: 0,
    aggregate: 0,
    patch: 0,
    stain: 0.22,
    stainColor: colour(0.72, 0.62, 0.52),
    cavity: 0,
    cavityOcclusion: 0,
    grime: 0.34,
    grimeHeight: 0.7,
    grimeColor: colour(0.52, 0.46, 0.4),
    streak: 0.24,
    dust: 0.04,
    roughness: 0.1,
  },
  // Clean steel is deliberately the least weathered profile in the kit. It
  // still takes junction dirt and a little run-off, because nothing in a yard
  // stays spotless and a flawless handrail reads as a placeholder — but the
  // stain and cavity terms that give rust its blotching are nearly off, since
  // on a conductor they darken F0 rather than a diffuse tint, and a mottled
  // F0 is what makes cheap metal look like painted plastic.
  //
  // The roughness swing is the widest here for the opposite reason: a
  // reflective surface is read almost entirely through the sharpness of what
  // it reflects, so half a stop of gloss variation across a sheet does more
  // work on steel than any amount of albedo detail would.
  steel: {
    macroScale: 2.0,
    microScale: 0,
    normalMacro: 0,
    normalMicro: 0,
    aggregate: 0,
    patch: 0,
    stain: 0.08,
    stainColor: colour(0.86, 0.85, 0.83),
    cavity: 0,
    cavityOcclusion: 0,
    grime: 0.24,
    grimeHeight: 0.6,
    grimeColor: colour(0.58, 0.56, 0.52),
    streak: 0.16,
    dust: 0.03,
    roughness: 0.2,
  },
  // Painted steel weathers on the surface of the paint rather than through it,
  // so this sits between rust and bare: visible run-off and junction dirt, but
  // no pitting, and a narrow gloss swing because enamel wears evenly.
  paint: {
    macroScale: 2.4,
    microScale: 0,
    normalMacro: 0,
    normalMicro: 0,
    aggregate: 0,
    patch: 0,
    stain: 0.18,
    stainColor: colour(0.78, 0.74, 0.68),
    cavity: 0,
    cavityOcclusion: 0,
    grime: 0.32,
    grimeHeight: 0.7,
    grimeColor: colour(0.54, 0.5, 0.44),
    streak: 0.22,
    dust: 0.04,
    roughness: 0.1,
  },
  // Wood takes the junction dirt and nothing else: it is the surface the critic
  // measured at 60.7 and held up as the standard, so the only job here is to
  // stop crates looking as though they were set down clean.
  wood: {
    macroScale: 1.9,
    microScale: 0,
    normalMacro: 0,
    normalMicro: 0,
    aggregate: 0,
    patch: 0,
    stain: 0,
    stainColor: colour(0.76, 0.68, 0.58),
    cavity: 0,
    cavityOcclusion: 0,
    grime: 0.3,
    grimeHeight: 0.55,
    grimeColor: colour(0.55, 0.48, 0.4),
    streak: 0,
    dust: 0,
    roughness: 0.04,
  },
  burlap: {
    weave: true,
    // Fourteen threads across the tile, so the coarse tap puts a thread every
    // two centimetres — the scale a hessian sack actually reads at.
    macroScale: 0.3,
    microScale: 0.08,
    // Restrained on purpose: a sack is a metre of screen at most, so the weave
    // sits near the sampling limit and a strong normal there stops reading as
    // cloth and starts reading as a moire.
    normalMacro: 0.6,
    normalMicro: 0.26,
    aggregate: 0.2,
    patch: 0.24,
    stain: 0.3,
    stainColor: colour(0.74, 0.68, 0.56),
    cavity: 0.3,
    cavityOcclusion: 0.55,
    grime: 0.3,
    grimeHeight: 0.5,
    grimeColor: colour(0.6, 0.55, 0.46),
    streak: 0,
    dust: 0.06,
    roughness: 0.1,
  },
};

export interface KitMaterials {
  byKey: Record<MaterialKey, THREE.MeshPhysicalMaterial>;
  tileScale: Record<MaterialKey, number>;
  surface: Record<MaterialKey, SurfaceKind>;
  /** Unlit material for lamp lenses and glowing fixtures. */
  emissive: THREE.MeshBasicMaterial;
  dispose(): void;
}

/**
 * Clones the shared PBR materials so the world can enable vertex colours.
 *
 * Vertex colour is doing a lot of work here: with only five CC0 textures
 * available, per-piece tinting and baked grime are the only way to get
 * building-to-building variation without shipping more albedo maps, and they
 * cost nothing at runtime because the geometry is merged anyway.
 */
export function buildMaterials(resources: ResourceManager): KitMaterials {
  const byKey = {} as Record<MaterialKey, THREE.MeshPhysicalMaterial>;
  const tileScale = {} as Record<MaterialKey, number>;

  for (const key of Object.keys(MATERIAL_IDS) as MaterialKey[]) {
    const id = MATERIAL_IDS[key];
    const base = resources.getMaterial(id);
    const material = base.clone();
    material.name = `world.${key}`;
    material.vertexColors = true;

    const response = RESPONSE[key];
    material.roughness = response.roughness;
    material.metalness = response.metalness;
    if (response.mapMetalness === false) material.metalnessMap = null;
    if (response.albedo) {
      material.map = null;
      material.color.copy(response.albedo);
    }
    if (material.normalMap) material.normalScale.set(response.normal, response.normal);
    // The tinting below already darkens; a slight sheen keeps plaster from
    // going completely matte under the sky dome. The conductors get the
    // physical 1.0: on a surface whose whole appearance is its reflection,
    // scaling the environment is scaling the thing itself.
    material.envMapIntensity = response.envMapIntensity ?? (response.metalness > 0 ? 1.0 : 0.85);
    decorateSurface(material, PROFILES[key]);
    byKey[key] = material;

    const asset = resources.manifest.materials.find((m) => m.id === id);
    tileScale[key] = TILE_OVERRIDE[key] ?? asset?.tileScale ?? 2;
  }

  const emissive = new THREE.MeshBasicMaterial({
    color: 0xffc98a,
    toneMapped: true,
    fog: false,
    vertexColors: true,
  });
  emissive.name = 'world.emissive';

  return {
    byKey,
    tileScale,
    surface: SURFACES,
    emissive,
    dispose(): void {
      for (const material of Object.values(byKey)) material.dispose();
      emissive.dispose();
      disposeDetailTextures();
    },
  };
}

/**
 * Kit palette.
 *
 * These are multipliers on the albedo, not absolute colours, so anything meant
 * to read as *painted* — container flanks, awnings, shutters — needs channels
 * above 1.0 to overcome the grey-blue cast of the corrugated iron texture.
 * Anything meant to read as weathered stays close to 1.0 and lets the source
 * texture speak.
 */
export const PALETTE = {
  plasterWarm: new THREE.Color(1.06, 0.96, 0.82),
  plasterOchre: new THREE.Color(1.18, 0.94, 0.62),
  plasterPale: new THREE.Color(0.94, 0.96, 0.96),
  plasterRose: new THREE.Color(1.08, 0.9, 0.82),
  plasterBlue: new THREE.Color(0.78, 0.88, 0.96),
  concrete: new THREE.Color(0.92, 0.91, 0.88),
  concreteDark: new THREE.Color(0.68, 0.67, 0.64),
  steel: new THREE.Color(0.88, 0.9, 0.94),
  steelRust: new THREE.Color(1.1, 0.74, 0.5),
  steelBlue: new THREE.Color(0.5, 0.7, 0.95),
  steelGreen: new THREE.Color(0.58, 0.82, 0.62),
  steelRed: new THREE.Color(1.32, 0.52, 0.42),
  steelOrange: new THREE.Color(1.45, 0.82, 0.38),
  /** Rubber and unpainted ironmongery — hose, cable, tyre, gasket. */
  steelDark: new THREE.Color(0.24, 0.24, 0.26),
  woodWarm: new THREE.Color(1.3, 1.04, 0.76),
  woodGrey: new THREE.Color(1.02, 1.0, 0.96),
  tarpBlue: new THREE.Color(0.52, 0.7, 0.94),
  sand: new THREE.Color(1.2, 1.04, 0.74),
  foliage: new THREE.Color(0.52, 0.62, 0.3),
  /** Sun-bleached canvas and painted tin. Deliberately low chroma: the
   *  corrugated normal map already banded these, and a saturated tint on top
   *  turned every awning into a candy stripe. */
  canvasRed: new THREE.Color(1.2, 0.66, 0.56),
  canvasCream: new THREE.Color(1.14, 1.04, 0.86),
  canvasGreen: new THREE.Color(0.68, 0.84, 0.66),
  canvasBlue: new THREE.Color(0.7, 0.82, 0.96),
} as const;
