# Changelog

## v1 — first playable

Built from a single prompt by parallel subagents, each owning one module and
coding against the shared interfaces in `src/types/`. `ORIGIN.md` records the
prompt and the decisions that shaped the plan.

### Engine

Fixed-timestep simulation loop with interpolated rendering, a typed event bus,
seeded RNG (sfc32) forked per subsystem for determinism, pointer-lock input with
action mapping and a lockout mechanism, quality presets persisted to
`localStorage`, a resource manager with fallbacks for missing assets, a Rapier
physics wrapper, and a capture bridge that exposes the whole engine to the
screenshot harness.

### Rendering

Forward-clustered HDR pipeline on WebGL2. MRT depth prepass writing normal,
velocity, metalness and a viewmodel flag. Four-cascade shadow maps with PCSS
contact hardening, physical sky with PMREM image-based lighting, exponential
height fog with sun inscattering, and screen-space occlusion implemented as a
pre-shading horizon trace rather than a post-process dimming pass.

Every post-processing effect is hand-written: GTAO, SSR, TAA with velocity
reprojection and neighbourhood clamping, motion blur, dual-filter bloom,
auto-exposure with a latched target, AgX tonemapping, LUT grading, grain,
chromatic aberration, vignette and sharpen.

### Gameplay

Player controller with Rapier collision, acceleration and friction movement,
slide, mantle and vault, crouch, sprint, and camera view-kick. Hero carbine
modelled to published M4A1 dimensions with a spring-damped viewmodel rig,
ADS/recoil/reload state machine, and hitscan ballistics with penetration and
range falloff. Bots with a navmesh, behaviour tree, cover selection and
suppression. GPU particles for muzzle flash, impact debris, smoke, sparks,
blood, tracers and shell ejection. Positional Web Audio with layered weapon
sounds and convolution reverb zones.

A free-for-all match layer runs the round: 30 kills or 10 minutes, player death
and respawn, score and clock HUD, scoreboard, and an end-of-round screen whose
restart fully resets the world.

### Tooling

Deterministic capture through real Chrome at 2560x1440, a 12-category scoring
rubric with a numeric gate, an integration health check, and probes for
temporal stability, physics stepping and capture determinism. Asset pipeline
fetches CC0 sources, packs ORM channels, compresses to KTX2 and records
provenance per asset.

## Defects worth recording

Several of these were live for most of the project and invalidated work that
had already been signed off. They are listed because the pattern matters more
than the individual bugs: in every case something reported success while doing
nothing.

- **The arena was empty for the entire project.** `Number(null)` evaluates to
  `0` and passed the `?bots` override guard, so no bots ever spawned on a dev
  run. Every critic score before the fix judged a deserted map.
- **Then the arena was still empty, for a second reason.** Nav voxelisation
  covered the whole ground plane, which reaches ~20m past the perimeter walls.
  That ring is flat and unobstructed, so it produced the most inviting walkable
  cells in the level, and `#pickSpawn`'s preference for points far from the
  player then selected it over the four authored spawns. All ten bots spawned
  outside the map. The arena now publishes `playBounds` and nav clips to it;
  as a side effect the grid holds its full 0.5m resolution instead of coarsening
  to fit the terrain.
- **Normal perturbation never executed.** Its anchor string sat inside an
  unresolved `#include` at `onBeforeCompile` time, and `String.replace` fails
  silently when it matches nothing. Every authored surface-detail value had
  been doing nothing.
- **The capture harness was never deterministic**, despite claiming to be. Four
  causes: the engine advanced its frame counter on frozen frames, moving the
  TAA jitter phase; screen-space occlusion kept a private noise counter; TAA
  half-float accumulation has no fixed point; and boot warmup skewed the first
  shot.
- **Snapshot isolation was never real.** Captures served a hardlinked copy of
  the tree on the assumption that editors replace files rather than rewriting
  them in place. The agent edit path writes in place, which mutates the shared
  inode, so every edit reached into every concurrent capture.
- **Physics never stepped.** No module owned `physics.step(dt)`; the engine
  does now.
- **The depth prepass replaced each material's `onBeforeCompile`** instead of
  composing with it, silently discarding the roughness modulation the forward
  pass shaded with.
- **Auto-exposure never settled**, making shadowed areas pulse during play.
  Invisible to every capture, because captures photograph frozen scenes after
  temporal convergence — precisely the condition under which an unsettled loop
  looks correct. Found by a human playing the game.
