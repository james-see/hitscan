# v2 roadmap

Open work, ordered by how much it changes the result. Each item records what is
already known, so the next session does not re-derive it.

Measurements here were taken at 2560x1440 on an M4 Max.

**Treat every absolute frame time in this repo as unestablished.** The same
static frame, on identical code with no agents running, measured 9.9ms and then
33.6ms half an hour later, and the second figure reproduced across four
consecutive runs. Under parallel agent load the same frame reached 117ms. The
cause has not been isolated — thermal state and whatever else the machine is
doing are the obvious candidates — but the practical consequence is that this
harness cannot currently produce a trustworthy absolute number, and any
conclusion resting on one needs re-deriving on a controlled machine.

Differences measured within a single session are still usable, and that is what
the numbers below rely on.

## Correctness

### Firing costs 9–11ms more than a static frame

The clearest performance signal, and the one that survives the instability
above, because it is a within-session difference rather than an absolute. In
every session sampled, the hip-firing frame costs 9–11ms more than a static one
— 9.9 against 19.2ms in one session, 33.6 against 44.8ms in another. That
margin alone is over half a 60fps budget, so it matters at any baseline.

Whether the game holds 60fps is genuinely unknown, and establishing that needs a
controlled machine first. Two things will make it worse than any figure here:
an M4 Max is far above typical hardware, and captures are frozen frames without
live bot AI or physics.

Nothing has been profiled yet, so the cost is unattributed. Particles, the
muzzle flash light and decal writes are the obvious suspects. No instancing,
LOD, occlusion culling or draw-call batching has been done anywhere; draw calls
sit around 250–300 per frame.

### SSR must consume the viewmodel flag

The viewmodel is now rasterised into the G-buffer and flagged with `1.0` in
attachment 1's `.a`, but the write is behind `setViewmodelGBuffer`, default off,
because SSR is the one pass that would misbehave. Enabling it today moves 1.4%
of pixels by up to 72/255, and turning reflections off drops the worst pixel to
7/255.

Three changes are needed in `SsrPass`:

1. Reject flagged pixels as a shading point, so the weapon receives no
   reflection. It already rejects the zero-length-normal sentinel; the flag test
   belongs alongside.
2. Reject flagged pixels as a ray hit, so the world does not reflect the weapon.
   The hit point is computed from stretched depth, so where the ray lands is
   wrong even though the colour sampled there is genuinely the rifle.
3. Mask weapon pixels to `1.0` when building level 0 of the Hi-Z pyramid. The
   weapon sits at 0.04–1.22m, in front of nearly all world geometry, so a
   min-depth pyramid is dominated by weapon depth in every tile it covers.
   Without this an invisible 20cm slab stops world rays across 8–12% of the
   screen. Rejecting at the shading point does not fix it: the coarse levels
   report a near-depth the fine data cannot explain.

Test with `?vmgbuf=1`. Land the rejection first against a flag that is `0`
everywhere, which changes nothing, then flip the write.

### Re-measure SSR against real metal

SSR was judged a no-op — toggling it changed zero pixels on every shot — but
that measurement was taken when the arena's highest metalness was 0.26. The
arena now has genuine conductors at 1.0 across 0.5–3.1% of frame depending on
the shot. The earlier conclusion was sound for the scene it was measured in, and
that scene no longer exists.

### Re-run quality review on a populated arena

Every critic score to date judged an empty map, because no bots spawned for the
whole project. Combat frames with bots in them are what the game actually looks
like, and nothing has been scored in that state.

Review is rubric-only now; `ORIGIN.md` records why the blind A/B was dropped.

### Re-audit differential conclusions

Any finding derived from differencing two captures predates the determinism
fixes and sat on a noise floor that no longer exists. Single-image and
large-effect measurements are unaffected: texel density, paver occlusion,
absolute luminance. Small-delta A/B results are not.

## Gameplay

### There is no way to resupply ammunition

Found by playing: the player runs dry around the five-minute mark of a
ten-minute round and stays dry, because nothing in the game restores ammunition.
`#reserve` is set once at equip and refilled only on `game:restart`.

The economy could not support the win condition. The carbine carried 30 + 210 =
240 rounds. At 26 damage it needs four hits inside 28m and five past 55m, so the
score limit of 30 kills allowed an eight-round budget per kill — roughly 50–60%
accuracy sustained on a 700rpm automatic, with nothing left over for suppression
or missed engagements. A player who empties the reserve has no melee and no
sidearm, so the remainder of the round is unplayable.

The reserve has been raised to 500 as a stopgap, which is about 17 rounds per
kill. That makes the round winnable but is not a design: it is one number
standing in for a mechanic, and it means the player starts every round carrying
an implausible 530 rounds. Cut it back to a realistic loadout once resupply
exists.

Three options, not exclusive:

1. **Pickups from kills.** Bots drop a magazine on death. Ties resupply to
   performance and needs no arena authoring, but compounds a losing streak.
2. **Static crates.** Placed resupply at a handful of authored positions, on a
   cooldown. Creates map control and rotation pressure, which is the more
   interesting design, and the arena already has crate props to reuse.
3. **Refill on respawn.** The cheapest fix and the usual arena-shooter default.
   Worth doing regardless, since dying currently costs the round.

Whichever lands, the round should be winnable: pick the resupply rate from the
kill budget above rather than by feel, and confirm it in the drive.

## Fidelity

### Reconcile lighting against the photometric anchor

Three things currently bypass it: `VfxModule` tunes particle lighting to a 1.15
constant, world and VFX point lights sidestep the local-light budget, and the
viewmodel carries its own IBL probe with a sand bounce and a dark horizon band,
which is effectively a second environment diverging from the first.

### Base colour in the G-buffer

Attachment 1's `.a` now carries the viewmodel flag, but a free channel would let
SSR tint metallic reflections from real base-colour luminance instead of a
constant. Needs a channel budget decision first.

### Content breadth

One arena, one weapon. Depth over breadth was the right call for v1 and is the
obvious thing to relax in v2: more weapons with distinct handling, a second
arena exercising different lighting conditions, and loadout selection.

## Harness

### Motion is still unobservable

Every capture is a frozen scene after 72 convergence frames, which is exactly
the condition under which an unsettled temporal loop looks correct — an
auto-exposure defect that made shadows pulse during play was invisible to every
capture and was found by a human playing the game. `flicker-probe.mjs` now
covers temporal stability, but nothing captures video.

This blocks two things: a game-feel pass on ADS curves, recoil recovery,
movement weight and audio layering; and any verification of motion vectors,
which is why the motion-blur and TAA behaviour of the viewmodel flag is reasoned
from code rather than measured.

### Parallel agents need isolated worktrees

Module ownership held — no two agents ever edited the same file — but a single
shared working tree means a capture photographs every agent's in-flight changes,
not just the owning agent's. Snapshot collisions have been fixed and the harness
now type-checks its snapshot and refuses to run against a tree caught mid-edit,
but the underlying sharing remains. Give each agent its own git worktree.
