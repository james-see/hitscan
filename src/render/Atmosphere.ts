import * as THREE from 'three';
import { Photometry } from './Lighting.ts';

/**
 * Aerial perspective: exponential height fog with sun inscattering.
 *
 * Distance in a rendered image is read almost entirely from contrast falloff.
 * A frame with none of it puts a wall sixty metres away at the same local
 * contrast and saturation as a crate two metres away, and the eye flattens
 * the whole thing into a poster. This is the term that fixes that, and it is
 * why a desert shooter still hazes its long sightlines even on a clear day.
 *
 * The model is the standard analytic one:
 *
 *   density(h) = d0 * exp( -k * ( h - h0 ) )
 *
 * integrated in closed form along the view ray, which is what makes the fog
 * settle into low ground and thin out over rooftops instead of being a
 * uniform slab. The integral of that density between the camera and the
 * fragment is
 *
 *   d0 * exp( -k * ( cameraY - h0 ) ) * ( 1 - exp( -k * dir.y * L ) ) / ( k * dir.y )
 *
 * with the ray-parallel case handled separately.
 *
 * On top of that, the fog colour is graded between a cool shadow tint away
 * from the sun and a hot one toward it, weighted by a Henyey-Greenstein-ish
 * forward lobe. That is the term that produces the bright haze wrapping the
 * sun in a backlit shot; without it, fog tinted a single colour reads as
 * dirty glass rather than as air.
 *
 * Applied through three's own fog chunks rather than a post pass, because the
 * pipeline renders to a linear HDR target with tonemapping deferred: fog
 * mixed in here is mixed in radiance, before the tone curve, which is the
 * only place the result is physically meaningful. A post fog pass would have
 * to work in display space and would grey out the shadows.
 */
export interface AtmosphereOptions {
  /** Extinction at the base height, per metre. */
  density: number;
  /** Height falloff rate, per metre. Larger settles the fog lower. */
  heightFalloff: number;
  /** World height the density is quoted at, in metres. */
  baseHeight: number;
  /** Distance before fog begins to accumulate, in metres. */
  startDistance: number;
  /** Upper bound on the fog blend, so distant geometry never fully vanishes. */
  maxOpacity: number;
  /** Forward-scattering anisotropy in [0,1). */
  anisotropy: number;
}

/**
 * Tuned so the perimeter wall at roughly a hundred metres loses about a third
 * of its contrast while a prop at twenty metres loses almost none. Fog that
 * bites earlier than that does not read as distance, it reads as an interior
 * full of smoke — which is exactly what the first pass at these numbers did
 * to the warehouse shot.
 */
const DEFAULTS: AtmosphereOptions = {
  density: 0.0058,
  heightFalloff: 0.045,
  baseHeight: 0,
  startDistance: 18,
  maxOpacity: 0.86,
  anisotropy: 0.76,
};

export class Atmosphere {
  #options: AtmosphereOptions;
  #patched = new WeakSet<THREE.Material>();
  #sun = new THREE.Vector3(0, 1, 0);

  #uniforms = {
    hitscanFogDensity: { value: DEFAULTS.density },
    hitscanFogHeightFalloff: { value: DEFAULTS.heightFalloff },
    hitscanFogBaseHeight: { value: DEFAULTS.baseHeight },
    hitscanFogStartDistance: { value: DEFAULTS.startDistance },
    hitscanFogMaxOpacity: { value: DEFAULTS.maxOpacity },
    hitscanFogAnisotropy: { value: DEFAULTS.anisotropy },
    hitscanFogSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    hitscanFogAwayColor: { value: new THREE.Color() },
    hitscanFogSunColor: { value: new THREE.Color() },
  };

  constructor(scene: THREE.Scene, sunDirection: THREE.Vector3, options: Partial<AtmosphereOptions> = {}) {
    installFogChunks();
    this.#options = { ...DEFAULTS, ...options };

    // three only defines USE_FOG, and therefore only compiles any fog code at
    // all, when the scene carries a fog object. The values on it are unused
    // by the patched chunk; it exists to switch the feature on, and its own
    // density is left low enough that any material this module has not
    // patched degrades to a barely visible haze rather than to a grey wall.
    const fog = new THREE.FogExp2(0x9fb4cc, 0.0016);
    fog.name = 'atmosphere';
    scene.fog = fog;

    this.setSunDirection(sunDirection);
    this.#pushOptions();
  }

  /**
   * Recolours the fog for a sun direction.
   *
   * Both tints are derived from the same photometric anchor the rest of the
   * lighting uses, so raising the sun or regrading its colour moves the
   * aerial perspective with it instead of leaving a hand-picked constant
   * behind.
   */
  setSunDirection(direction: THREE.Vector3): void {
    this.#sun.copy(direction).normalize();
    this.#uniforms.hitscanFogSunDirection.value.copy(this.#sun);

    const skyRadiance = (Photometry.SUN_IRRADIANCE * Photometry.SKY_TO_SUN_RATIO) / Math.PI;
    // Away from the sun the air is lit by the sky: cool, and roughly the
    // radiance of the zenith.
    this.#uniforms.hitscanFogAwayColor.value
      .setHex(0x9dbcdd)
      .convertSRGBToLinear()
      .multiplyScalar(skyRadiance * 2.1);
    // Toward it, by the sun itself, forward-scattered. Brighter than the sky
    // by a wide margin, which is what makes a backlit shot bloom.
    this.#uniforms.hitscanFogSunColor.value
      .setHex(Photometry.SUN_COLOR)
      .convertSRGBToLinear()
      .multiplyScalar(skyRadiance * 9.5);
  }

  /** Adjusts the fog model at runtime. Partial; unset fields are unchanged. */
  configure(options: Partial<AtmosphereOptions>): void {
    this.#options = { ...this.#options, ...options };
    this.#pushOptions();
  }

  get options(): Readonly<AtmosphereOptions> {
    return this.#options;
  }

  /**
   * Patches a material to use the height-fog model.
   *
   * Applied to everything drawn in the world scene, lit or not, so a piece of
   * unlit set dressing does not sit at full contrast against fogged geometry
   * beside it.
   */
  setupMaterial(material: THREE.Material): void {
    if (this.#patched.has(material)) return;
    // `fog` lives on the concrete material classes rather than the base, but
    // the walk that gets here only ever has a `Material`.
    if ((material as { fog?: boolean }).fog !== true) return;
    this.#patched.add(material);

    const defines = (material.defines ??= {});
    defines.HITSCAN_FOG = '';

    const previous = material.onBeforeCompile;
    const uniforms = this.#uniforms;
    material.onBeforeCompile = function (shader, renderer): void {
      previous.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
    };
    material.needsUpdate = true;
  }

  #pushOptions(): void {
    const o = this.#options;
    this.#uniforms.hitscanFogDensity.value = o.density;
    this.#uniforms.hitscanFogHeightFalloff.value = o.heightFalloff;
    this.#uniforms.hitscanFogBaseHeight.value = o.baseHeight;
    this.#uniforms.hitscanFogStartDistance.value = o.startDistance;
    this.#uniforms.hitscanFogMaxOpacity.value = o.maxOpacity;
    this.#uniforms.hitscanFogAnisotropy.value = o.anisotropy;
  }
}

let installed = false;

/**
 * Replaces three's four fog chunks.
 *
 * Every branch is guarded by `HITSCAN_FOG`, which only patched materials
 * define, so an unpatched material still compiles and still renders three's
 * own linear or exponential fog exactly as before.
 */
export function installFogChunks(): void {
  if (installed) return;
  installed = true;

  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;

  chunks.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	#ifdef HITSCAN_FOG
		varying vec3 vFogWorldPosition;
	#endif
#endif
`;

  // `transformed` is the post-morph, post-skin local position and is in scope
  // wherever three includes this chunk. Instancing is folded in by hand
  // because `modelMatrix` does not carry the per-instance transform.
  chunks.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	#ifdef HITSCAN_FOG
		vec4 hitscanFogLocal = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
			hitscanFogLocal = instanceMatrix * hitscanFogLocal;
		#endif
		vFogWorldPosition = ( modelMatrix * hitscanFogLocal ).xyz;
	#endif
#endif
`;

  chunks.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG

	uniform vec3 fogColor;
	varying float vFogDepth;

	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif

	#ifdef HITSCAN_FOG

		varying vec3 vFogWorldPosition;

		uniform float hitscanFogDensity;
		uniform float hitscanFogHeightFalloff;
		uniform float hitscanFogBaseHeight;
		uniform float hitscanFogStartDistance;
		uniform float hitscanFogMaxOpacity;
		uniform float hitscanFogAnisotropy;
		uniform vec3 hitscanFogSunDirection;
		uniform vec3 hitscanFogAwayColor;
		uniform vec3 hitscanFogSunColor;

		/**
		 * Optical depth of an exponentially stratified medium along a ray,
		 * in closed form. The ray-parallel case is a removable singularity,
		 * not a special case in the physics, so it is expanded rather than
		 * clamped.
		 */
		float hitscanFogOpticalDepth( vec3 origin, vec3 direction, float distance ) {
			float k = hitscanFogHeightFalloff;
			float base = hitscanFogDensity * exp( - k * ( origin.y - hitscanFogBaseHeight ) );
			float t = k * direction.y;
			float integral = abs( t ) > 1e-4 ? ( 1.0 - exp( - t * distance ) ) / t : distance;
			return base * max( integral, 0.0 );
		}

		/** Forward-scattering lobe. Henyey-Greenstein, normalisation dropped. */
		float hitscanFogPhase( float cosTheta ) {
			float g = hitscanFogAnisotropy;
			float g2 = g * g;
			float denom = 1.0 + g2 - 2.0 * g * cosTheta;
			return ( 1.0 - g2 ) / max( pow( denom, 1.5 ), 1e-4 );
		}

	#endif

#endif
`;

  chunks.fog_fragment = /* glsl */ `
#ifdef USE_FOG

	#ifdef HITSCAN_FOG

		vec3 hitscanFogRay = vFogWorldPosition - cameraPosition;
		float hitscanFogDistance = length( hitscanFogRay );
		vec3 hitscanFogDirection = hitscanFogRay / max( hitscanFogDistance, 1e-4 );

		// Holding the near field clear keeps the frame's contrast anchored on
		// the foreground; fog that starts at the camera flattens everything
		// equally and buys no depth cue at all.
		float hitscanFogRange = max( hitscanFogDistance - hitscanFogStartDistance, 0.0 );
		float hitscanFogTau = hitscanFogOpticalDepth( cameraPosition, hitscanFogDirection, hitscanFogRange );
		float hitscanFogFactor = ( 1.0 - exp( - hitscanFogTau ) ) * hitscanFogMaxOpacity;

		float hitscanFogCos = dot( hitscanFogDirection, hitscanFogSunDirection );
		float hitscanFogInscatter = clamp( hitscanFogPhase( hitscanFogCos ) * 0.22, 0.0, 1.0 );
		vec3 hitscanFogTint = mix( hitscanFogAwayColor, hitscanFogSunColor, hitscanFogInscatter );

		gl_FragColor.rgb = mix( gl_FragColor.rgb, hitscanFogTint, clamp( hitscanFogFactor, 0.0, 1.0 ) );

	#else

		#ifdef FOG_EXP2
			float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif

		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );

	#endif

#endif
`;
}
