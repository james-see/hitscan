# Asset pipeline

Offline tooling that turns CC0 source material from [Poly Haven](https://polyhaven.com)
into the runtime assets under `public/assets/`, plus the `manifest.json` that
`src/engine/Resources.ts` loads at boot.

## Running

```bash
npm run assets:fetch   # download masters into .assetcache/  (~170 MB, network)
npm run assets:pack    # process the cache into public/assets/  (no network)
npm run assets:all     # both
```

`node tools/assets/fetch.mjs --force` re-downloads everything; by default any
file already in the cache with a matching size and md5 is skipped, so re-runs
are free. `node tools/assets/pack.mjs --size 1024` packs to a smaller runtime
budget without re-downloading.

| File | Role |
| --- | --- |
| `sources.mjs` | The asset list: slugs, tile scales, and why each was chosen. Edit this to change the set. |
| `fetch.mjs` | Downloads masters into `.assetcache/` (gitignored). Sequential, md5-verified, 250 ms between requests. |
| `pack.mjs` | Resizes, packs ORM, copies the Basis transcoder, writes the manifest. |

## Output

```
public/assets/manifest.json          AssetManifest, per src/types/assets.ts
public/assets/textures/<id>_albedo.webp
public/assets/textures/<id>_normal.jpg
public/assets/textures/<id>_orm.jpg
public/assets/env/courtyard_noon.hdr
public/basis/                        Basis Universal transcoder, copied from three
```

Five materials, matching the ids `src/world/Arena.ts` requests:
`concrete_ground`, `plaster_wall`, `rusted_metal`, `wood_planks`,
`concrete_trim`. Total is about 29 MB at the default 2048 px budget.

### ORM packing

The single most important step. Occlusion goes to R, roughness to G and
metalness to B in one texture, which `Resources.ts` binds to `aoMap`,
`roughnessMap` and `metalnessMap` simultaneously. Sources are used in this
order of preference: the individually authored maps, then Poly Haven's own
`arm` pack (same channel order), then a constant — white for missing
occlusion, black for missing metalness.

Poly Haven authors nearly every weathered metal as fully dielectric, which
makes painted steel read as chalky plastic under a bright sky. Where they do
ship a metalness map for a comparable surface it is a flat low constant, so
`rusted_metal` sets `metalness: 0.25` in `sources.mjs` and the packer writes
that constant into the blue channel. This is the only place the pipeline
departs from the source data.

### Format: WebP and JPEG, not KTX2

KTX2 is the right container — GPU-native compression, no decode cost, roughly
a quarter of the VRAM — but encoding it needs a `toktx` or `basisu` binary
that is not available through npm. `pack.mjs` probes for one and falls back
rather than being unrunnable on a clean checkout. **Neither was installed, so
this build is the fallback path.** `Resources.ts` handles it: `loadTexture`
only takes the KTX2 branch for a `.ktx2` extension and otherwise uses
`THREE.TextureLoader`, which reads WebP and JPEG fine.

The fallback is split by what the channels mean, not by file size:

- **Albedo is WebP** (quality 84). It is colour, so WebP's chroma subsampling
  costs nothing visible and the files are tiny.
- **Normal and ORM are JPEG 4:4:4** (quality 94, mozjpeg). Their three
  channels are independent signals, and WebP's lossy mode always converts to
  subsampled YUV — which would bleed roughness into metalness and flatten
  normal detail. JPEG at 4:4:4 keeps every channel at full rate.

Installing `toktx` (`brew install ktx`) and extending `pack.mjs` is the
upgrade path; the manifest shape does not change.

The environment HDR is copied verbatim. `RGBELoader` wants Radiance RGBE, and
re-encoding would clamp the sun's highlights, which are exactly the values
PMREM needs for a believable specular horizon.

### Tiling

`tileScale` in the manifest is **world metres covered by one texture repeat**,
not a UV multiplier. Nothing in the engine applies it yet — the consumer has
to derive `texture.repeat` (or scale UVs) from surface size divided by
`tileScale`. Without that the 90 m arena floor stretches a single texture
across the whole plane.

Scales are 4 m for ground concrete, 3.5 m for trim, 3 m for wall plaster,
2.5 m for metal and 2 m for wood planks.

Because these tile across large surfaces, selection deliberately avoided
textures with a single distinctive stain or crack, which becomes a readable
grid at distance. Every candidate was tiled 2x2 and inspected before being
chosen; `sources.mjs` records the reasoning per material.

## Licensing

Everything is [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/)
from Poly Haven — public domain, no attribution required and no restriction on
commercial use. The manifest records name, author and source URL for every
asset anyway, under `AssetProvenance`.
