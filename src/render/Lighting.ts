import * as THREE from 'three';

/**
 * Photometric calibration for the outdoor lighting model.
 *
 * Every light in the scene is expressed in one coherent radiometric unit so
 * that a single fixed exposure works everywhere. The anchor is:
 *
 *   sun irradiance = PI
 *
 * With three.js' Lambert BRDF (`L = albedo / PI * E * NdotL`) that makes the
 * outgoing radiance of a surface pointed straight at the sun exactly equal to
 * its albedo. A neutral 18% card therefore renders at 0.18, which is the value
 * AgX maps to mid grey at exposure 1.0. Nothing downstream has to guess.
 *
 * Everything else is expressed as a ratio against the sun so the whole model
 * scales together:
 *
 *   sky / sun  ~ 0.12   clear-sky diffuse horizontal irradiance is roughly 12%
 *                       of direct normal irradiance at this solar elevation
 *   bounce     ~ albedo * (horizontal irradiance) / PI
 *
 * The single most common way to wreck an outdoor image is to let an unbounded
 * analytic sky drive the IBL: Preetham radiance is in the hundreds, which
 * swamps the sun by an order of magnitude, erases every shadow and washes the
 * frame to white. `SkyDome` measures its own output and rescales it to hit
 * `SKY_TO_SUN_RATIO` exactly.
 */
export const Photometry = {
  /** Irradiance on a surface normal to the sun, in scene units. */
  SUN_IRRADIANCE: Math.PI,

  /** Sky diffuse irradiance on an up-facing surface, as a fraction of the above. */
  SKY_TO_SUN_RATIO: 0.19,

  /** Diffuse albedo used for the lower hemisphere of the environment probe. */
  GROUND_ALBEDO: 0.3,

  /**
   * Fraction of the analytic ground bounce that actually reaches a surface.
   * The analytic value assumes an infinite unoccluded ground plane; in a
   * walled courtyard most of that is blocked, and screen-space AO cannot
   * recover energy that was never occluded in the first place.
   */
  GROUND_BOUNCE_OCCLUSION: 0.7,

  /** Late-afternoon sun colour, already warm before any grading. */
  SUN_COLOR: 0xfff1de,

  /** Warm tint of the dusty concrete the bounce light comes off. */
  BOUNCE_COLOR: 0xffd9b0,

  /**
   * Direction the sun sits in, i.e. the vector from the scene toward the sun.
   * A low elevation gives long shadows and strong shape definition; 30 degrees
   * is the classic "an hour before golden hour" key.
   */
  SUN_DIRECTION: new THREE.Vector3(-0.42, 0.55, -0.72).normalize(),

  /** Half-angle the sun subtends, in radians. Drives PCSS penumbra growth. */
  SUN_ANGULAR_RADIUS: 0.00465,
} as const;

/**
 * Irradiance arriving on a horizontal surface from sun plus sky. Used to
 * derive the radiance of the diffuse ground bounce baked into the lower half
 * of the environment probe.
 */
export function horizontalIrradiance(sunDirection: THREE.Vector3): number {
  const direct = Photometry.SUN_IRRADIANCE * Math.max(0, sunDirection.y);
  const sky = Photometry.SUN_IRRADIANCE * Photometry.SKY_TO_SUN_RATIO;
  return direct + sky;
}

/** Radiance of the ground bounce that fills the lower hemisphere of the IBL. */
export function groundBounceRadiance(sunDirection: THREE.Vector3): number {
  return (
    (Photometry.GROUND_ALBEDO * horizontalIrradiance(sunDirection)) /
    Math.PI *
    Photometry.GROUND_BOUNCE_OCCLUSION
  );
}
