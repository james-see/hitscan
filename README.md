# HITSCAN

A first-person shooter running in the browser on WebGL2, built with three.js. The
goal is AAA-grade rendering and game feel in a browser tab: a forward-clustered
HDR pipeline, cascaded shadows, a hand-written post-processing chain, procedural
weapon animation, and bot combat.

Built end to end by an AI agent fanning out to parallel subagents. See
[ORIGIN.md](ORIGIN.md) for the prompt that produced it, the three decisions
that shaped the plan, and an honest account of where the automated quality
loop failed to catch things.

## Requirements

- Node 22+
- A GPU-backed browser. Development and quality review target Chrome on Apple
  Silicon (ANGLE Metal).

## Quick start

```bash
npm install
npm run assets:all   # fetch and process the CC0 asset library
npm run dev
```

Then open the printed URL and click to deploy. `WASD` to move, `Shift` to
sprint, `Ctrl` to crouch, `R` to reload, `Esc` to release the cursor.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run preview` | Serve the production build |
| `npm run assets:fetch` | Download CC0 source assets into `.assetcache/` |
| `npm run assets:pack` | Process the cache into `public/assets/` plus a manifest |
| `npm run capture` | Screenshot every camera preset |
| `npm run critic` | Capture and emit a critic briefing |
| `npm run gate` | Score a critic verdict against the quality gate |

Captures serve a hardlinked copy of the tree from `.capture-snapshot/` with HMR
off, so a run is pinned to one revision even while the working tree is being
edited. `--query` (repeatable) forwards parameters to the page, which is how
module-specific capture overrides are photographed. Each value is parsed as a
query fragment, so several keys can be set in one flag:

```bash
node tools/critic/capture.mjs --shot lane --query vm=ads
node tools/critic/capture.mjs --shot lane --query 'vm=ads&vmdebug=flat'
```

Every camera preset is a static scene, which scored the effects work on frames
containing no effects, so the set also captures firing variants derived from
those presets. They hold real input actions through the capture API rather
than poking the weapon, so the result is a frame a player could produce.

Captures photograph frozen scenes after temporal convergence, which is exactly
the condition under which an unsettled loop looks correct. `flicker-probe.mjs`
covers what that hides, sampling per-frame luminance in-page while the engine
runs and A/B-ing settings to attribute any pulsing:

```bash
node tools/critic/flicker-probe.mjs --shot interior-shadow --frames 240
```

## Architecture

Every subsystem is a `GameModule` (see `src/types/engine.ts`). Modules never
import one another; they read shared state from `EngineContext` and communicate
over a typed `EventBus` (`src/types/events.ts`). Adding a cross-module signal
means adding an entry to the `GameEvents` interface, after which the compiler
enforces the payload shape at both ends.

Simulation runs at a fixed 120Hz with an accumulator, decoupled from the display
rate, so physics and recoil behave identically at 60 and 240Hz. Rendering
interpolates between fixed steps.

```
src/
  types/    shared contracts; the integration surface between all subsystems
  engine/   loop, input, resources, physics, settings, capture bridge
  render/   pipeline, G-buffer, cascaded shadows, sky and IBL
    post/   the post-processing chain
  world/    level geometry, materials, colliders, camera presets
  player/   character controller and camera
  weapon/   viewmodel, procedural animation, ballistics
  ai/       bot navigation and behaviour
  vfx/      particles, decals, tracers
  audio/    Web Audio graph
  ui/       HUD and menus
tools/
  assets/   offline asset pipeline
  critic/   screenshot capture and quality review
```

### Rendering

Forward-clustered rather than deferred, deliberately: it preserves
`MeshPhysicalMaterial`'s multiscatter GGX, clearcoat and anisotropy, which is
where most of the material quality comes from. A thin MRT prepass still supplies
depth, normals, roughness and motion vectors to every screen-space effect.

Frame order is shadow cascades, depth prepass, forward opaque, sky, transparent,
viewmodel (separate camera and near plane so the weapon never clips into walls),
then the post chain ping-ponged to the backbuffer.

### Determinism

Nothing in the game calls `Math.random()`. Every stochastic system draws from a
seeded `Rng` (`src/engine/Rng.ts`), forked per subsystem so one system consuming
random numbers cannot perturb another. Combined with the fixed timestep, this
makes screenshot captures reproducible.

## Quality review

`tools/critic/` implements a verdict-gated review loop. `capture.mjs` boots the
game in real Chrome on the GPU, drives it through `window.__hitscan`, and writes
deterministic 2560x1440 PNGs from fixed camera presets. `rubric.mjs` defines
twelve scored categories and a list of binary disqualifiers. `gate.mjs` applies
the thresholds and exits non-zero while the work still falls short, which is what
lets the improvement loop terminate on evidence rather than on opinion.

The gate: every category at least 8/10, mean at least 8.5, zero disqualifiers,
and at least 60fps at 1440p.

```bash
npm run critic -- --label render      # capture and emit the briefing
# hand the briefing and images to a fresh reviewer, then:
npm run gate -- --label render --verdict verdict.json --fps 92
```

The reviewer is deliberately stateless each iteration; a critic that remembers
its previous scores anchors on them and drifts upward, quietly defeating the
gate.

### Blind comparison

`blind.mjs` builds an anonymised, randomised comparison set from our captures
plus any reference screenshots placed in `refs/`, writing the answer key outside
the image directory. Reference images are gitignored: they are third-party
screenshots and are not ours to redistribute.

## Assets

All assets are CC0, sourced from [Poly Haven](https://polyhaven.com) and
processed offline into packed ORM textures. Provenance for every asset,
including author and licence, is recorded in `public/assets/manifest.json`. See
`tools/assets/README.md` for details.

`refs/`, the reference screenshots used for blind comparison during quality
review, is deliberately not committed. Those are third-party press images and
are not ours to redistribute.

## License

[AGPL-3.0-or-later](LICENSE). The network clause is the point: this runs in a
browser, so a plain GPL would let someone host a modified build without
publishing their changes. Under AGPL, serving it to users obliges you to make
the source available to them.

three.js (MIT) and Rapier (Apache-2.0) are both compatible with this, and the
CC0 assets carry no conditions.
