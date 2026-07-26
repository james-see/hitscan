import * as THREE from 'three';

/**
 * Curvature-masked edge wear and cavity grime for the viewmodel materials.
 *
 * Texture maps alone give a surface its substance but not its history. What
 * makes a weapon read as a used object is that every chamfer the hand and the
 * carrier touch is rubbed back to bright substrate, and every crevice the
 * hand cannot reach fills with grime. Both are driven by the geometric
 * curvature attributes `GeometryBuilder` bakes in, so they follow the actual
 * form rather than a hand-painted mask that would have to be redone whenever
 * a part moves.
 *
 * Two signals, because they want different interpolation:
 *   - `aWear` is per-face and only non-zero on narrow convex strips, which
 *     keeps the bright metal tight to the chamfer instead of washing across
 *     whole faces.
 *   - `aEdge` is per-vertex welded convexity, which interpolates smoothly and
 *     therefore suits the broad terms: the soft rub on proud surfaces and the
 *     gradual darkening into a corner.
 */

export interface EdgeWearOptions {
  /** Break-up noise, shared across every material. */
  noise: THREE.Texture;
  /** sRGB colour of the substrate exposed by wear. */
  color: number;
  roughness: number;
  metalness: number;
  /** Peak wear strength in [0,1]. */
  amount: number;
  /** Tiling of the break-up noise relative to the material's own UVs. */
  scale: number;
  /** Multiplier applied in the deepest cavities. 1 disables the term. */
  cavity: number;
}

const CACHE_KEY = 'weapon-edge-wear';

export function applyEdgeWear(
  material: THREE.MeshPhysicalMaterial,
  options: EdgeWearOptions
): void {
  const color = new THREE.Color(options.color);
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.uWearNoise = { value: options.noise };
    shader.uniforms.uWearColor = { value: color };
    shader.uniforms.uWearParams = {
      value: new THREE.Vector4(options.amount, options.roughness, options.metalness, options.scale),
    };
    shader.uniforms.uCavity = { value: options.cavity };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aEdge;
attribute float aWear;
varying float vEdge;
varying float vWear;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vEdge = aEdge;
vWear = aWear;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uWearNoise;
uniform vec3 uWearColor;
uniform vec4 uWearParams;
uniform float uCavity;
varying float vEdge;
varying float vWear;`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
{
  vec3 breakup = texture2D( uWearNoise, vMapUv * uWearParams.w ).rgb;
  // Two frequencies so the chamfer wear thins and drops out along its length
  // rather than running as an even bright line around every part.
  float mask = breakup.r * 0.6 + breakup.g * 0.4;
  float wear = vWear * smoothstep( 0.24, 0.74, mask ) * uWearParams.x;
  diffuseColor.rgb = mix( diffuseColor.rgb, uWearColor, wear );
  roughnessFactor = mix( roughnessFactor, uWearParams.y, wear );
  metalnessFactor = mix( metalnessFactor, uWearParams.z, wear );

  // Grime and occlusion in the corners the hand cannot reach. This one is
  // driven by measured curvature, which interpolates across a face and so
  // gives the gradient out of a corner that a per-face flag could not.
  float cavity = smoothstep( 0.0, -0.5, vEdge );
  diffuseColor.rgb *= mix( 1.0, uCavity, cavity );
  roughnessFactor = clamp( roughnessFactor + cavity * 0.08, 0.0, 1.0 );
}`
      );
  };
  // Every wear material compiles the same source and differs only in its
  // uniforms, so they should share one program rather than one each.
  material.customProgramCacheKey = (): string => CACHE_KEY;
  material.needsUpdate = true;
}
