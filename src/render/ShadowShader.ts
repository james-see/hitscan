import * as THREE from 'three';

/**
 * GLSL for the cascaded shadow lookup, injected into three's lighting chunks.
 *
 * The whole block is guarded by `CSM_ENABLED`, which only patched materials
 * define, so unpatched materials compile exactly as they would have.
 *
 * Conventions used throughout:
 *   - `viewPos` is the view-space position of the shading point (`-vViewPosition`).
 *   - `csmViewToShadow[i]` maps view space directly to atlas UV plus a
 *     normalised [0,1] depth, so no world position varying is needed.
 *   - all four cascades live in one 2x2 depth atlas; `csmTileBounds[i]` is the
 *     inset UV rectangle a cascade owns, and every tap is clamped to it so a
 *     wide filter can never bleed into a neighbouring cascade.
 */
export const CSM_PARS = /* glsl */ `
#ifdef CSM_ENABLED

uniform highp sampler2D csmShadowAtlas;
uniform mat4 csmViewToShadow[ CSM_CASCADES ];
uniform vec4 csmTileBounds[ CSM_CASCADES ];
/** View-space distance at which each cascade ends, in metres. */
uniform vec4 csmSplitFar;
/** View-space distance at which each cascade begins, in metres. */
uniform vec4 csmSplitNear;
/** Depth span of each cascade's orthographic volume, in metres. */
uniform vec4 csmDepthRange;
/** World size of a single shadow texel, in metres, per cascade. */
uniform vec4 csmTexelWorld;
/** Atlas UV units per world metre, per cascade. */
uniform vec4 csmUvPerMetre;
uniform float csmShadowFar;
uniform float csmFadeStart;
uniform float csmBlend;
uniform float csmNormalBias;
uniform float csmDepthBias;
/** Tangent of the sun's apparent radius; drives penumbra growth. */
uniform float csmSunTan;
uniform float csmMaxPenumbra;
uniform float csmIntensity;

#ifdef CSM_PCSS
	#define CSM_BLOCKER_SAMPLES 16
	#define CSM_FILTER_SAMPLES 24
#else
	#define CSM_BLOCKER_SAMPLES 1
	#define CSM_FILTER_SAMPLES 12
#endif

/**
 * Vogel disk: an equal-area spiral. Cheaper than a Poisson table, has no
 * clustering, and the sample count is a free parameter.
 */
vec2 csmVogelDisk( const in int index, const in int count, const in float rotation ) {
	float radius = sqrt( ( float( index ) + 0.5 ) / float( count ) );
	float theta = float( index ) * 2.39996323 + rotation;
	return vec2( cos( theta ), sin( theta ) ) * radius;
}

/** Interleaved gradient noise. Decorrelates the disk rotation per pixel. */
float csmDitherRotation( const in vec2 fragment ) {
	return fract( 52.9829189 * fract( dot( fragment, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
}

float csmSampleCascade(
	const in int cascade,
	const in vec3 viewPos,
	const in vec3 viewNormal,
	const in float NdotL,
	const in float rotation
) {
	float texelWorld = csmTexelWorld[ cascade ];
	float depthRange = csmDepthRange[ cascade ];
	float uvPerMetre = csmUvPerMetre[ cascade ];
	// Grazing light needs a longer offset: the depth error across one texel
	// grows with the surface slope relative to the light.
	float slope = clamp( 1.0 - NdotL, 0.0, 1.0 );

	// Normal offset rather than a pure depth bias. Moving the lookup off the
	// surface removes acne without detaching the contact point, which is what
	// a large constant bias does (peter-panning).
	vec3 offsetPos = viewPos + viewNormal * ( texelWorld * csmNormalBias * ( 1.0 + 2.0 * slope ) );
	vec4 projected = csmViewToShadow[ cascade ] * vec4( offsetPos, 1.0 );
	vec3 coord = projected.xyz;

	if ( coord.z <= 0.0 || coord.z >= 1.0 ) return 1.0;

	vec4 bounds = csmTileBounds[ cascade ];
	if ( any( lessThan( coord.xy, bounds.xy ) ) || any( greaterThan( coord.xy, bounds.zw ) ) ) {
		return 1.0;
	}

	float bias = ( csmDepthBias * texelWorld * ( 1.0 + 3.0 * slope ) ) / depthRange;
	float receiver = coord.z - bias;

	float filterWorld = texelWorld;

#ifdef CSM_PCSS
	// Blocker search. The widest penumbra the cascade can produce is bounded
	// by its own depth range, so that caps the search radius.
	float searchWorld = min( depthRange * csmSunTan, csmMaxPenumbra );
	float searchUv = searchWorld * uvPerMetre;

	float blockerSum = 0.0;
	float blockerCount = 0.0;
	// Deepest blocker found, i.e. the one closest to the receiver. Tracked
	// alongside the mean because the mean alone destroys contact hardening:
	// at the point where an object meets the floor, a search wide enough to
	// soften that object's far edge also catches the parts of it that are a
	// metre up, and averaging them in widens the penumbra at exactly the
	// pixel that has to stay sharp.
	float nearestBlocker = 0.0;
	for ( int i = 0; i < CSM_BLOCKER_SAMPLES; i ++ ) {
		vec2 uv = clamp( coord.xy + csmVogelDisk( i, CSM_BLOCKER_SAMPLES, rotation ) * searchUv, bounds.xy, bounds.zw );
		float depth = texture2D( csmShadowAtlas, uv ).r;
		if ( depth < receiver ) {
			blockerSum += depth;
			blockerCount += 1.0;
			nearestBlocker = max( nearestBlocker, depth );
		}
	}

	if ( blockerCount < 0.5 ) return 1.0;

	float averageBlocker = blockerSum / blockerCount;
	float meanSeparation = max( ( receiver - averageBlocker ) * depthRange, 0.0 );
	float nearSeparation = max( ( receiver - nearestBlocker ) * depthRange, 0.0 );
	// Contact hardening: penumbra width is the blocker-to-receiver distance
	// times the angular size of the source. Biasing toward the nearest
	// blocker keeps contacts tight; the mean still dominates once every
	// blocker in the search is genuinely far away, which is the case that
	// should be soft.
	float separation = mix( nearSeparation, meanSeparation, 0.45 );
	// Floor the kernel at a couple of texels: a filter narrower than the map
	// resolution collapses to a binary test and the edge staircases.
	filterWorld = clamp( separation * csmSunTan, texelWorld * 1.7, csmMaxPenumbra );
#endif

	float filterUv = filterWorld * uvPerMetre;
	float visibility = 0.0;
	for ( int i = 0; i < CSM_FILTER_SAMPLES; i ++ ) {
		vec2 uv = clamp( coord.xy + csmVogelDisk( i, CSM_FILTER_SAMPLES, rotation ) * filterUv, bounds.xy, bounds.zw );
		visibility += step( receiver, texture2D( csmShadowAtlas, uv ).r );
	}

	return visibility / float( CSM_FILTER_SAMPLES );
}

float csmGetShadow( const in vec3 viewPos, const in vec3 viewNormal, const in float NdotL ) {
	// Back faces are already black from NdotL; skipping them saves the filter.
	if ( NdotL <= 0.0 ) return 1.0;

	float depth = - viewPos.z;
	if ( depth >= csmShadowFar ) return 1.0;

	int cascade = CSM_CASCADES - 1;
	for ( int i = CSM_CASCADES - 1; i >= 0; i -- ) {
		if ( depth < csmSplitFar[ i ] ) cascade = i;
	}

	float rotation = csmDitherRotation( gl_FragCoord.xy );
	float shadow = csmSampleCascade( cascade, viewPos, viewNormal, NdotL, rotation );

	// Cross-fade the last slice of each cascade into the next one, otherwise
	// the resolution step shows up as a hard line across the ground.
	float far = csmSplitFar[ cascade ];
	float band = ( far - csmSplitNear[ cascade ] ) * csmBlend;
	if ( cascade < CSM_CASCADES - 1 && band > 0.0 && depth > far - band ) {
		float t = clamp( ( depth - ( far - band ) ) / band, 0.0, 1.0 );
		float next = csmSampleCascade( cascade + 1, viewPos, viewNormal, NdotL, rotation );
		shadow = mix( shadow, next, t );
	}

	float fade = 1.0 - smoothstep( csmFadeStart, csmShadowFar, depth );
	return mix( 1.0, mix( 1.0, shadow, csmIntensity ), fade );
}

#endif
`;

/**
 * Screen-space occlusion lookup, filled by `ScreenSpaceOcclusion`.
 *
 * The buffer is at the resolution of the colour target and was traced from
 * the same jittered projection this fragment is being rasterised with, so
 * `gl_FragCoord` indexes it directly and no varying is needed.
 */
export const SSAO_PARS = /* glsl */ `
#ifdef HITSCAN_SSAO

uniform sampler2D hitscanOcclusionMap;
uniform vec2 hitscanOcclusionTexel;
uniform float hitscanOcclusionStrength;
uniform float hitscanContactStrength;

vec2 hitscanOcclusionSample() {
	return texture2D( hitscanOcclusionMap, gl_FragCoord.xy * hitscanOcclusionTexel ).rg;
}

float hitscanAmbientOcclusion() {
	return mix( 1.0, hitscanOcclusionSample().r, hitscanOcclusionStrength );
}

float hitscanContactShadow() {
	return mix( 1.0, hitscanOcclusionSample().g, hitscanContactStrength );
}

#endif
`;

/**
 * Multiplies the first directional light by the cascade lookup and by the
 * short-range contact trace.
 *
 * Only light 0 is treated this way: the sun is added to the scene before any
 * other module runs, so it always occupies slot 0, and there is exactly one
 * directional light in the scene by construction. Extra directional lights
 * would silently take the wrong slot, which is precisely the failure mode
 * three's own CSM helper suffers from.
 */
const DIRECTIONAL_ANCHOR = 'getDirectionalLightInfo( directionalLight, directLight );';

const SUN_APPLY = /* glsl */ `
		#if UNROLLED_LOOP_INDEX == 0
			#ifdef CSM_ENABLED
			directLight.color *= csmGetShadow( geometryPosition, geometryNormal, dot( geometryNormal, directLight.direction ) );
			#endif
			#ifdef HITSCAN_SSAO
			directLight.color *= hitscanContactShadow();
			#endif
		#endif
`;

/**
 * Occlusion on indirect diffuse only.
 *
 * This is the whole reason the trace runs before shading rather than as a
 * post pass. Direct sunlight is already occluded, correctly and at a
 * different scale, by the shadow cascades; multiplying it by an ambient
 * visibility term as well double-counts the same occluder and reads as an
 * underexposed frame rather than as contact. Indirect specular gets the
 * roughness-aware form of the same term, which is what stops a polished
 * surface in a crease from reflecting a sky it cannot see.
 */
const SSAO_APPLY = /* glsl */ `
#ifdef HITSCAN_SSAO

	float hitscanAo = hitscanAmbientOcclusion();

	reflectedLight.indirectDiffuse *= hitscanAo;

	#if defined( USE_ENVMAP ) && defined( STANDARD )

		reflectedLight.indirectSpecular *= computeSpecularOcclusion(
			saturate( dot( geometryNormal, geometryViewDir ) ), hitscanAo, material.roughness
		);

	#endif

#endif
`;

let installed = false;

/**
 * Rewrites three's shared lighting chunks in place.
 *
 * Patching the global chunks rather than every material means geometry added
 * at any later point picks the shadow up automatically once its material has
 * the defines; there is no window in which a new mesh renders unshadowed
 * because someone forgot to call a sync function.
 *
 * Both injections land in the same two chunks, so they are installed together
 * rather than from their own modules: two independent `replace` calls against
 * `lights_fragment_begin` would be order-dependent, and the one that ran
 * second would be searching a string the first had already rewritten.
 */
export function installForwardShadingChunks(): void {
  if (installed) return;
  installed = true;

  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const fragmentBegin = chunks.lights_fragment_begin!;
  if (!fragmentBegin.includes(DIRECTIONAL_ANCHOR)) {
    throw new Error('[CSM] three lights_fragment_begin layout changed; shadow injection failed');
  }

  chunks.lights_pars_begin = CSM_PARS + SSAO_PARS + chunks.lights_pars_begin!;
  chunks.lights_fragment_begin = fragmentBegin.replace(
    DIRECTIONAL_ANCHOR,
    `${DIRECTIONAL_ANCHOR}\n${SUN_APPLY}`
  );
  // Prepended rather than replacing: three's own aoMap handling still has to
  // run for materials that ship a baked occlusion texture.
  chunks.aomap_fragment = SSAO_APPLY + chunks.aomap_fragment!;
}
