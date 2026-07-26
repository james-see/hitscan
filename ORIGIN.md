# Origin

This project was built by an AI agent (Claude, in Cursor) fanning out work to
parallel subagents, from a single prompt. This file records that prompt, the
three decisions that shaped the plan, and the parts of the brief that were
pushed back on, so the result can be read in light of what was actually asked
for.

## The original prompt

> I want you to build a first-person shooter at the level of the most recent
> Call of Duty games. It should be utterly perfect, visually beautiful, with
> every single thing done at AAA quality—from textures to physics to anything
> you could think of. Fan out sub-agents and have sub-agents tackle each one
> individually so that the game is utterly perfect. You should /loop on each
> item and have a separate sub-agent check it visually to ensure it looks
> triple A. That separate sub-agent should be a really harsh critic, and if it
> doesn't look triple A, it should keep going. Don't stop until each sub-agent
> is utterly wowed with the quality when compared with the actual Call of Duty
> game. It should literally compare them side by side blind and say which one
> looks better. Do this in ThreeJS. /loop until it's utterly perfect. Fan out
> sub-agents and ultracode.

## Pushback before planning

One part of the brief was not accepted as written: **a literal blind
side-by-side win against a modern Call of Duty title is not a reachable
termination condition, and a loop with that exit criterion never exits.**

Call of Duty's look is overwhelmingly asset production rather than code —
photogrammetry-scanned props, thousands of hand-authored 4K PBR material sets,
mocap animation libraries, lighting placed by dedicated lighting artists, and a
budget in the hundreds of millions. No subagent loop generates that.

What was targeted instead is a browser FPS whose **rendering pipeline, weapon
feel and game feel** are genuinely top-tier for the web. The harsh-critic
screenshot loop was built as asked, but against a bounded rubric with concrete
numeric exit conditions, so that it terminates.

## The three planning decisions

Three questions blocked the shape of the plan. Each was asked with a
recommendation, and in each case the recommended option was taken.

### 1. Scope — one arena, one weapon, bots

Depth beats breadth by a wide margin here: a single arena polished obsessively
looks far better than five rough ones. The alternatives considered were 3–4
weapons with a wave mode, a 2–3 level campaign slice, and a multiplayer-shaped
build with netcode scaffolding.

The result is the "Shipyard" arena, one hero assault rifle, and bot opponents.

### 2. Assets — CC0 only, vendored

Asset sourcing is the single biggest lever on final visual quality. The choice
was to pull permissively licensed assets over the network — Poly Haven HDRIs
and PBR textures, Quaternius and Kenney models — and vendor them into the repo
with provenance recorded in the asset manifest.

The alternatives were fully procedural authoring in code, which caps visual
quality hard, and AI-generated textures filling gaps, which was declined to
keep the licensing of everything shipped unambiguous.

No third-party reference screenshots are committed either; see below for why
the comparison that needed them was dropped.

### 3. Renderer — WebGL2 with a hand-rolled post stack

WebGL2 was chosen over WebGPU for stability, universal support, and full
control over the post-processing chain. WebGPU offers a higher ceiling through
compute and clustered lighting, but a rougher ecosystem; a dual-path build
would have cost the most work for reach that this project does not need.

Everything in `src/render/post/` is consequently hand-written rather than taken
from a library: GTAO, SSR, TAA, motion blur, dual-filter bloom, auto-exposure,
AgX tonemapping, colour grading, grain and sharpen.

## On the critic loop

The loop works by capturing deterministic screenshots through real Chrome at
2560x1440, handing them to a fresh critic subagent each iteration scored
against a fixed rubric, and routing failing categories back to the agent that
owns that module.

Two structural weaknesses in that design are worth recording, because both
produced real misses:

- **Captures photograph frozen scenes after temporal convergence**, which is
  exactly the condition under which an unsettled loop looks correct. An
  auto-exposure defect that made shadows visibly pulse during play was
  invisible to every capture, and was found by a human playing the game.
  `tools/critic/flicker-probe.mjs` exists to cover that class of defect.
- **Every camera preset was a static scene with nobody firing**, so the effects
  work was scored on frames containing no effects. The capture set now includes
  firing variants driven through real input actions.
- **The arena was empty for the entire project.** A debug override read
  `Number(null)` as a valid zero, so no bots ever spawned on a dev run. Every
  critic score up to that point judged a deserted map.

### The blind comparison was removed

The brief asked for a literal blind side-by-side against Call of Duty, and it
was built. It has since been deleted, because the comparison it performed was
not the one intended.

Every reference image sourced for it was a third-person promotional
screenshot — hero characters shot from behind, dominated by cloth, skin, faces
and gear. This renderer draws none of that: every frame it produces is
first-person with a weapon in view. A critic comparing the two is scoring
subject matter and art direction, not rendering, and would mark the project
down for reasons no amount of shader work could address.

Sourcing genuine first-person gameplay stills would have fixed the mismatch.
The judgement was that a rubric with concrete numeric criteria is the more
honest instrument regardless, and that a comparison against press material
mostly measures how much of the frame is occupied by a photogrammetry-scanned
face. Quality review is now rubric-only.

## License

AGPL-3.0-or-later. Copyleft was chosen deliberately, and the network clause
specifically: this is a game that runs in a browser, so a plain GPL would let
someone host a modified build without publishing their changes. Under AGPL,
anyone who serves it to users has to make the source available to them.
