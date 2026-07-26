/**
 * Player tuning.
 *
 * Values target the weight of a modern console shooter: high ground
 * acceleration so input reads instantly, low air authority so jumps commit,
 * and short, decisive transitions everywhere else. Anything non-obvious is
 * justified inline.
 */

/** Capsule and eye geometry, in metres. */
export const BODY = {
  standHeight: 1.8,
  crouchHeight: 1.15,
  radius: 0.35,
  /** Eyes sit below the crown; a camera at full height reads as floating. */
  eyeOffset: -0.16,
  /** Shrink applied to probe capsules so a sweep starting in contact with the
   *  surface we are already resting against does not report zero time-of-impact. */
  probeSkin: 0.03,
} as const;

export const MOVE = {
  walkSpeed: 4.4,
  sprintSpeed: 7.1,
  crouchSpeed: 2.3,
  /** Reached in ~0.07s from a standstill: the player feels planted, not icy. */
  groundAccel: 62,
  /** Air control is a redirect, not a thrust. Enough to adjust a jump, not to
   *  gain speed, so bunny-hopping cannot outrun the sprint cap. */
  airAccel: 22,
  groundFriction: 11,
  /** Below this speed friction is applied at a constant rate, so stops are
   *  crisp instead of asymptotically creeping. */
  frictionStopSpeed: 1.6,
  /** Speed above the stance cap (slide and mantle exits) bleeds at this
   *  constant rate, m/s^2, rather than being clamped: 9.3 -> 4.4 m/s takes
   *  1.2s, long enough that the momentum feels earned. */
  overspeedFriction: 4,
  /** How fast surplus momentum can be steered, radians/s. */
  overspeedSteerRate: 2,
  /** 6.4 m/s against 22 m/s^2 gives a 0.93m apex and a 0.58s hang time. */
  jumpVelocity: 6.4,
  gravity: 22,
  /** Terminal velocity, so a long fall cannot tunnel the capsule. */
  maxFallSpeed: 55,
  coyoteTime: 0.11,
  jumpBuffer: 0.14,
  /** Downward bias while grounded, keeping the capsule pinned across slope
   *  and stair transitions instead of skipping off crests. */
  groundStickSpeed: 3.5,
  /** The arena's stairs have 0.4-0.5m risers; Rapier's autostep only covers
   *  0.4m, so the controller does the rest itself. */
  stepHeight: 0.62,
  /** Rate the step-up assist lifts the capsule, m/s. Spread over several ticks
   *  rather than applied at once: a single-tick lift outruns ground snapping
   *  and reads as a hitch, and the camera's eye smoothing cannot hide it. */
  stepClimbSpeed: 3.6,
  /** cos(52 deg). Matches the controller's climb limit with a small margin. */
  walkableCos: 0.6157,
  maxPitch: Math.PI / 2 - 0.02,
} as const;

export const SLIDE = {
  /** Must be near sprint speed to start; a slide out of a walk feels cheap. */
  enterSpeed: 4.6,
  /** Additive forward boost, capped so a slide always leaves at ~9.3 m/s. */
  boost: 2.6,
  maxEntrySpeed: 9.4,
  /** Flat-ground deceleration. 9.3 -> 3.4 m/s in ~1.2s. */
  decel: 5.0,
  /** Fraction of gravity-along-slope added downhill. Under 1 so steep ramps
   *  accelerate without becoming a launch ramp. */
  slopeGravity: 0.85,
  /** Slide steering authority, radians/s. Enough to round a corner. */
  steerRate: 1.75,
  maxDuration: 1.15,
  exitSpeed: 3.4,
  /** Stops slide-spam from acting as a speed boost. */
  cooldown: 0.55,
} as const;

export const MANTLE = {
  /** Below this the step-up assist handles it; above it is hard cover. */
  minHeight: 0.55,
  maxHeight: 2.05,
  /** Forward reach from the capsule surface when looking for a wall face. */
  reach: 0.95,
  /** How far past the ledge lip the player is placed. */
  inset: 0.34,
  /** Duration at min and max height. Short: a mantle that outlasts its
   *  animation reads as a cutscene, not a move. */
  minDuration: 0.3,
  maxDuration: 0.52,
  /** Extra arc height so the capsule clears the lip rather than grazing it. */
  lipClearance: 0.1,
  /** Speed handed back on exit, capped to walk so mantles are not a shortcut. */
  exitSpeed: 4.0,
  cooldown: 0.22,
  /** Automatic vault while sprinting only triggers below this height. */
  autoMaxHeight: 1.25,
  autoMinSpeed: 4.2,
} as const;

export const CAMERA = {
  /** Landing punch, normalised across this impact-speed range. */
  landMinSpeed: 3.5,
  landMaxSpeed: 15,
  /** Peak dip and pitch at full impact. 12cm and 3.4 degrees. */
  landMaxDip: 0.12,
  landMaxPitch: 0.06,
  landOmega: 21,
  /** Slightly underdamped so the return overshoots once and settles. */
  landZeta: 0.55,

  /** Strafe roll. Two degrees: felt, not noticed. */
  strafeRoll: 0.035,
  strafeRollLambda: 7,
  slideRoll: 0.062,

  /** Sprint FOV kick, degrees, before `fovKickScale`. */
  sprintFov: 9,
  slideFov: 13,
  fovLambda: 7,

  /** Head bob. Stride lengths are per-footfall, so the vertical component
   *  runs at twice the horizontal frequency. */
  strideWalk: 1.85,
  strideSprint: 2.15,
  strideCrouch: 1.45,
  bobVertical: 0.031,
  bobLateral: 0.021,
  bobRoll: 0.006,
  /** Sprint exaggerates the bob; crouch flattens it. */
  bobSprintScale: 1.45,
  bobCrouchScale: 0.6,
  bobLambda: 9,

  /** Damage flinch. */
  damagePitch: 0.045,
  damageYaw: 0.03,
  damageRoll: 0.035,
  damageOmega: 26,
  damageZeta: 0.5,
  damageTrauma: 0.4,

  /** Trauma shake. Squared before use, so small hits stay subtle. */
  traumaDecay: 1.9,
  traumaMaxAngle: 0.028,
  traumaMaxOffset: 0.022,

  /** Mantle view: dip and pitch through the arc. */
  mantleDip: 0.1,
  mantlePitch: 0.05,

  /** Eye smoothing while grounded. Steps and slopes level out; falls track
   *  exactly so a drop still reads as a drop. */
  eyeLambda: 18,
} as const;
