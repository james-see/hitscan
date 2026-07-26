/**
 * The source-of-truth asset list, shared by `fetch.mjs` and `pack.mjs`.
 *
 * Every slug here was confirmed to exist via the Poly Haven API. All Poly
 * Haven content is CC0-1.0, so no attribution is legally required, but the
 * manifest records it anyway.
 *
 * Texture selection favours surfaces without a single distinctive "hero"
 * feature (one big crack, one dark stain), because these tile across large
 * surfaces and any unique landmark becomes a visible grid at distance.
 */

export const POLYHAVEN_API = 'https://api.polyhaven.com';

/** Resolutions to try, in order of preference. */
export const TEXTURE_RESOLUTIONS = ['4k', '2k'];
export const HDRI_RESOLUTIONS = ['2k', '1k'];

/**
 * Poly Haven file-tree keys we care about.
 *
 * `nor_gl` is the OpenGL-convention normal (+Y up), which is what three.js
 * expects; `nor_dx` would render lighting inverted on the green channel.
 * `arm` is Poly Haven's own AO/Roughness/Metalness pack, kept as a fallback
 * for the handful of assets that ship it but not the individual maps.
 */
export const TEXTURE_MAPS = ['Diffuse', 'nor_gl', 'Rough', 'AO', 'Metal', 'arm'];

/**
 * @typedef {object} MaterialSource
 * @property {string} id         Material id requested by `src/world/Arena.ts`.
 * @property {string} slug       Poly Haven asset slug.
 * @property {number} tileScale  World metres covered by one texture repeat.
 * @property {string} note       Why this texture was chosen.
 * @property {number} [metalness]
 *   Constant metalness in [0,1], written to the ORM blue channel when the
 *   source ships no metalness map. Poly Haven authors most weathered metals
 *   as fully dielectric, which makes painted steel read as chalky plastic
 *   under a bright sky; where they do ship a metalness map for a comparable
 *   surface it is itself a flat low constant, so this matches their intent.
 */

/** @type {MaterialSource[]} */
export const MATERIALS = [
  {
    id: 'concrete_ground',
    slug: 'concrete_floor_02',
    tileScale: 4,
    note: 'Weathered outdoor concrete. Mottled at a low spatial frequency, so it tiles across the 90 m arena floor without a readable grid.',
  },
  {
    id: 'plaster_wall',
    slug: 'beige_wall_001',
    tileScale: 3,
    note: 'Warm beige Mediterranean plaster. Almost featureless in albedo — all the detail is in the normal map, which makes it effectively repeat-free.',
  },
  {
    id: 'rusted_metal',
    slug: 'worn_corrugated_iron',
    tileScale: 2.5,
    metalness: 0.25,
    note: 'Weathered galvanised corrugated sheet with rust streaking. Vertical ribbing hides horizontal repetition along the long container flanks, and the cool grey-blue is the only cold hue in an otherwise warm palette, so containers separate from the ground at distance.',
  },
  {
    id: 'wood_planks',
    slug: 'old_planks_02',
    tileScale: 2,
    note: 'Sun-bleached grey-brown planking for dockside crates. Even plank widths and no knot-heavy hero board.',
  },
  {
    id: 'concrete_trim',
    slug: 'concrete_wall_008',
    tileScale: 3.5,
    note: 'Smooth poured concrete with faint form-board lines. Reads as cast coping and stair treads, and sits a value lighter than the ground so trim silhouettes stay legible.',
  },
];

/**
 * @typedef {object} EnvironmentSource
 * @property {string} id
 * @property {string} slug
 * @property {number} intensity
 * @property {string} note
 */

/** @type {EnvironmentSource[]} */
export const ENVIRONMENTS = [
  {
    id: 'courtyard_noon',
    slug: 'spiaggia_di_mondello',
    intensity: 1,
    note: 'Clear high-contrast Sicilian coastal sky. Provides both the hard key direction and the warm sky/sand bounce the arena is lit for.',
  },
];
