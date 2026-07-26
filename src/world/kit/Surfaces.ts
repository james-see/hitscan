import * as THREE from 'three';
import { surfaceDetailTexture, weaveDetailTexture } from './Detail.ts';

/**
 * The world's surface shader layer.
 *
 * Three problems are solved in one pass over the material, because all three
 * need the same world position, world normal and detail sample and paying for
 * them once is the difference between a rounding error and a millisecond:
 *
 *  1. TEXEL DENSITY. A world-space detail map is blended over the base albedo,
 *     normal and roughness at two scales that have nothing to do with the
 *     source texture's own repeat. The big architectural surfaces were carrying
 *     less than half the measured surface detail of the crates sitting on them;
 *     this is what closes that gap, and because the detail is noise rather than
 *     a photograph it adds no new periodicity for a tiling test to find.
 *
 *  2. WEATHERING. Grime accumulates where surfaces meet — the base of every
 *     wall, the inside of every crevice — and streaks downward off the ledges
 *     above. All of it is driven by world position and the detail map's cavity
 *     channel, so it applies to every piece in the kit without authoring.
 *
 *  3. INTERIOR AMBIENT. A signed box around the warehouse volume attenuates
 *     indirect light only, dropping the interior by two and a half stops
 *     without touching the sunlit yard, and darkens the wall-to-wall and
 *     wall-to-ceiling corners inside it.
 */

/** Metres per repeat and blend weights for one material's detail layer. */
export interface SurfaceProfile {
  /** Metres per repeat of the coarse detail sample. */
  macroScale: number;
  /** Metres per repeat of the fine sample. 0 disables the second tap. */
  microScale: number;
  /** Normal perturbation from the coarse and fine samples. */
  normalMacro: number;
  normalMicro: number;
  /** Albedo modulation from the fine grain and the coarse pit structure. */
  aggregate: number;
  patch: number;
  /** Broad tonal staining, and the colour it stains toward. */
  stain: number;
  stainColor: THREE.Color;
  /** Darkening inside cavities, and how much ambient they occlude. */
  cavity: number;
  cavityOcclusion: number;
  /** Dirt where the surface meets the ground, and the height it fades over. */
  grime: number;
  grimeHeight: number;
  grimeColor: THREE.Color;
  /** Downward water staining on vertical faces. 0 disables the third tap. */
  streak: number;
  /** Pale dust settling on up-facing surfaces. */
  dust: number;
  /** Roughness swing between cavity floor and grain peak. */
  roughness: number;
  /** Use the woven-cloth atlas instead of the concrete one. */
  weave?: boolean;
}

/** The enclosed volume whose indirect light is pulled down. */
export interface InteriorVolume {
  center: THREE.Vector3;
  halfExtents: THREE.Vector3;
  /** Opening the daylight comes through; occlusion relaxes toward it. */
  mouth: THREE.Vector3;
  /** Distance from the mouth over which full occlusion is reached. */
  mouthFalloff: number;
  /** Indirect multiplier deep inside. 0.18 is a little under two and a half stops. */
  floor: number;
  /** Extra darkening in the corners, and the radius it reaches over. */
  corner: number;
  cornerRadius: number;
}

/** Ground plane the junction grime is measured from, plus a raised deck. */
export interface GroundReference {
  deckY: number;
  deckCenter: THREE.Vector2;
  deckHalf: THREE.Vector2;
}

export interface SurfaceContext {
  interior: InteriorVolume;
  ground: GroundReference;
}

const DEFAULT_INTERIOR: InteriorVolume = {
  center: new THREE.Vector3(0, -1000, 0),
  halfExtents: new THREE.Vector3(0.01, 0.01, 0.01),
  mouth: new THREE.Vector3(0, -1000, 0),
  mouthFalloff: 1,
  floor: 1,
  corner: 0,
  cornerRadius: 1,
};

const DEFAULT_GROUND: GroundReference = {
  deckY: -1000,
  deckCenter: new THREE.Vector2(0, 0),
  deckHalf: new THREE.Vector2(0, 0),
};

/**
 * Uniforms every decorated material shares. One object, assigned into each
 * shader, so the interior volume can be positioned once for the whole level.
 */
interface SharedUniforms {
  surfInteriorCenter: { value: THREE.Vector3 };
  surfInteriorHalf: { value: THREE.Vector3 };
  surfInteriorMouth: { value: THREE.Vector4 };
  surfInteriorTerm: { value: THREE.Vector4 };
  surfDeck: { value: THREE.Vector4 };
  surfDeckY: { value: number };
}

const shared: SharedUniforms = {
  surfInteriorCenter: { value: DEFAULT_INTERIOR.center.clone() },
  surfInteriorHalf: { value: DEFAULT_INTERIOR.halfExtents.clone() },
  surfInteriorMouth: { value: new THREE.Vector4(0, -1000, 0, 1) },
  surfInteriorTerm: { value: new THREE.Vector4(1, 0, 1, 1) },
  surfDeck: { value: new THREE.Vector4(0, 0, 0, 0) },
  surfDeckY: { value: DEFAULT_GROUND.deckY },
};

/** Positions the interior volume and the raised deck for the whole level. */
export function configureSurfaces(context: Partial<SurfaceContext>): void {
  const interior = { ...DEFAULT_INTERIOR, ...context.interior };
  shared.surfInteriorCenter.value.copy(interior.center);
  shared.surfInteriorHalf.value.copy(interior.halfExtents);
  shared.surfInteriorMouth.value.set(
    interior.mouth.x,
    interior.mouth.y,
    interior.mouth.z,
    interior.mouthFalloff
  );
  shared.surfInteriorTerm.value.set(
    interior.floor,
    interior.corner,
    interior.cornerRadius,
    0
  );

  const ground = { ...DEFAULT_GROUND, ...context.ground };
  shared.surfDeck.value.set(
    ground.deckCenter.x,
    ground.deckCenter.y,
    ground.deckHalf.x,
    ground.deckHalf.y
  );
  shared.surfDeckY.value = ground.deckY;
}

let cacheKeySeed = 0;

/**
 * One anchored injection into a shader string, loud when the anchor is gone.
 *
 * `String.prototype.replace` returns the subject unchanged when the pattern is
 * absent, so a patch whose anchor has moved compiles a shader that is missing
 * a feature and reports nothing. That is not a hypothetical: the normal
 * perturbation below anchored on a line that lives inside a chunk *body*, and
 * `shader.fragmentShader` at `onBeforeCompile` time still holds the unresolved
 * `#include` — three's `resolveIncludes` does not run until `WebGLProgram`. The
 * perturbation therefore never once executed, and every surface in the arena
 * shipped without the relief its profile asks for.
 *
 * A patch that cannot find its anchor is always a bug, so this throws. Two
 * matches is the same bug wearing a different hat: it means the anchor stopped
 * identifying one site and we would be guessing which one to take.
 */
function injectShader(source: string, anchor: string, replacement: string, where: string): string {
  const at = source.indexOf(anchor);
  if (at < 0) {
    throw new Error(
      `[world/Surfaces] shader anchor missing in ${where}: ${JSON.stringify(anchor)}. ` +
        'The surface layer cannot be applied. If three was upgraded, this anchor ' +
        'has moved or been renamed and the injection needs re-siting.'
    );
  }
  if (source.indexOf(anchor, at + anchor.length) >= 0) {
    throw new Error(
      `[world/Surfaces] shader anchor is ambiguous in ${where}: ${JSON.stringify(anchor)} ` +
        'matches more than once.'
    );
  }
  return source.slice(0, at) + replacement + source.slice(at + anchor.length);
}

/**
 * Anchor for the detail perturbation, inside three's own chunk body.
 *
 * `mapN` is declared and consumed entirely within `<normal_fragment_maps>`, so
 * there is no point outside that chunk at which the perturbation can be added
 * to it. The chunk is therefore resolved here, patched, and substituted for its
 * own `#include`.
 */
const NORMAL_SCALE_ANCHOR = 'mapN.xy *= normalScale;';

/**
 * Three's tangent-space normal chunk with the detail perturbation folded in.
 *
 * Read from `THREE.ShaderChunk` on every compile rather than copied into this
 * file. That is the whole reason this route was chosen over anchoring on
 * `#include <normal_fragment_maps>` and adjusting the finished `normal`
 * afterwards:
 *
 *  - A post-hoc adjustment needs `tbn`, which three only declares under
 *    `#ifdef USE_NORMALMAP_TANGENTSPACE`. Guarding on that macro reintroduces
 *    exactly the failure being fixed — if three renames it, the `#ifdef` goes
 *    quietly false and the perturbation dies again with no diagnostic. Folding
 *    into the chunk needs no macro of our own: the addend sits inside three's
 *    tangent-space branch and is compiled under precisely the condition that
 *    makes `mapN` exist.
 *  - Taking the body live means a chunk rewrite is picked up rather than
 *    shadowed by a stale copy, and any global chunk patch another module
 *    installed is honoured. The one thing an upgrade can break — the anchor
 *    line itself — throws.
 *  - It is also exact. Adding to `mapN` before `normalize( tbn * mapN )` is
 *    what the profiles were authored against; perturbing the normalised result
 *    would rescale the effect by whatever `normalScale` did to the map's length.
 *
 * The chunk contains no nested includes today, and would be fine if it did:
 * `resolveIncludes` runs over the finished string later regardless.
 */
function perturbedNormalChunk(): string {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  return injectShader(
    chunks.normal_fragment_maps!,
    NORMAL_SCALE_ANCHOR,
    `${NORMAL_SCALE_ANCHOR}\n\t${FRAGMENT_NORMAL}`,
    'three ShaderChunk.normal_fragment_maps'
  );
}

/**
 * Partial compensation for the layer's one-sided terms.
 *
 * Stain and cavity only ever darken, so a heavy setting pulls a whole surface
 * down a third of a stop. Restoring all of that turned out to cost more than it
 * saved: the tone curve's shoulder compresses whatever is pushed into it, and a
 * full re-lift measured 10% *less* surface detail than no lift at all. Half is
 * enough to stop the arena going murky without spending the contrast the layer
 * exists to add.
 */
function meanLift(profile: SurfaceProfile): number {
  const average = (c: THREE.Color): number => (c.r + c.g + c.b) / 3;
  // Expected coverage of each mask over a uniform noise field.
  const stain = 1 - 0.25 * profile.stain * (1 - average(profile.stainColor));
  const cavity = 1 - 0.55 * profile.cavity * (1 - average(profile.grimeColor));
  return 1 + 0.5 * (1 / Math.max(0.4, stain * cavity) - 1);
}

/**
 * Patches one material with the surface layer.
 *
 * `customProgramCacheKey` is set explicitly: the default key is the source text
 * of `onBeforeCompile`, which is identical for every material here, so without
 * a distinct key three would hand every material the first one's program.
 */
export function decorateSurface(
  material: THREE.MeshPhysicalMaterial,
  profile: SurfaceProfile
): void {
  const uniforms = {
    surfDetailMap: {
      value: profile.weave ? weaveDetailTexture() : surfaceDetailTexture(),
    },
    surfScale: { value: new THREE.Vector2(profile.macroScale, profile.microScale || 1) },
    surfNormalAmount: {
      value: new THREE.Vector2(profile.normalMacro, profile.normalMicro),
    },
    surfAlbedoAmount: {
      value: new THREE.Vector4(profile.aggregate, profile.patch, profile.stain, profile.cavity),
    },
    surfStainColor: { value: profile.stainColor.clone() },
    surfGrimeColor: { value: profile.grimeColor.clone() },
    surfGrimeAmount: {
      value: new THREE.Vector4(
        profile.grime,
        Math.max(0.05, profile.grimeHeight),
        profile.streak,
        profile.dust
      ),
    },
    surfResponse: {
      value: new THREE.Vector3(profile.roughness, profile.cavityOcclusion, meanLift(profile)),
    },
    ...shared,
  };

  const defines = (material.defines ??= {});
  defines.SURF_LAYER = '';
  if (profile.microScale > 0) defines.SURF_MICRO = '';
  if (profile.streak > 0) defines.SURF_STREAKS = '';
  // The perturbation is folded into three's tangent-space branch, which only
  // compiles when a tangent-space normal map is bound. A profile that asks for
  // relief on a material with no normal map would therefore produce nothing,
  // which is the same silent failure in a different disguise.
  //
  // Reported rather than thrown, unlike a missing shader anchor: this one can
  // be provoked by an asset that failed to load, and taking the whole level
  // down because a texture 404'd would be a worse outcome than a flat surface.
  // The capture harness reports console errors alongside every shot, so it is
  // still caught by the loop rather than only by someone reading a log.
  const tangentSpaceNormals =
    material.normalMap !== null && material.normalMapType === THREE.TangentSpaceNormalMap;
  const perturbs =
    (profile.normalMacro > 0 || profile.normalMicro > 0) && tangentSpaceNormals;
  if (!perturbs && (profile.normalMacro > 0 || profile.normalMicro > 0)) {
    console.error(
      `[world/Surfaces] ${material.name || 'material'} has a normal perturbation ` +
        'profile but no tangent-space normalMap, so the perturbation was dropped. ' +
        'Bind a normal map, or set normalMacro and normalMicro to 0.'
    );
  }

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer): void {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    const vertex = 'vertex shader';
    let source = shader.vertexShader;
    source = injectShader(
      source,
      '#include <common>',
      `${VERTEX_DECLARATIONS}\n#include <common>`,
      vertex
    );
    source = injectShader(
      source,
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>\n${VERTEX_NORMAL}`,
      vertex
    );
    source = injectShader(
      source,
      '#include <project_vertex>',
      `#include <project_vertex>\n${VERTEX_POSITION}`,
      vertex
    );
    shader.vertexShader = source;

    const fragment = 'fragment shader';
    source = shader.fragmentShader;
    source = injectShader(
      source,
      '#include <common>',
      `${FRAGMENT_DECLARATIONS}\n#include <common>`,
      fragment
    );
    source = injectShader(
      source,
      '#include <map_fragment>',
      `${FRAGMENT_SAMPLE}\n#include <map_fragment>\n${FRAGMENT_ALBEDO}`,
      fragment
    );
    source = injectShader(
      source,
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>\n${FRAGMENT_ROUGHNESS}`,
      fragment
    );
    source = injectShader(
      source,
      '#include <aomap_fragment>',
      `#include <aomap_fragment>\n${FRAGMENT_OCCLUSION}`,
      fragment
    );
    if (perturbs) {
      source = injectShader(
        source,
        '#include <normal_fragment_maps>',
        perturbedNormalChunk(),
        fragment
      );
    }
    shader.fragmentShader = source;
  };

  const key = `surf:${cacheKeySeed++}`;
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vSurfPos;
varying vec3 vSurfNrm;
`;

const VERTEX_NORMAL = /* glsl */ `
	vec3 surfObjectNormal = objectNormal;
	#ifdef USE_INSTANCING
		surfObjectNormal = mat3( instanceMatrix ) * surfObjectNormal;
	#endif
	vSurfNrm = mat3( modelMatrix ) * surfObjectNormal;
`;

const VERTEX_POSITION = /* glsl */ `
	vec4 surfLocal = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		surfLocal = instanceMatrix * surfLocal;
	#endif
	vSurfPos = ( modelMatrix * surfLocal ).xyz;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D surfDetailMap;
uniform vec2 surfScale;
uniform vec2 surfNormalAmount;
uniform vec4 surfAlbedoAmount;
uniform vec3 surfStainColor;
uniform vec3 surfGrimeColor;
uniform vec4 surfGrimeAmount;
uniform vec3 surfResponse;
uniform vec3 surfInteriorCenter;
uniform vec3 surfInteriorHalf;
uniform vec4 surfInteriorMouth;
uniform vec4 surfInteriorTerm;
uniform vec4 surfDeck;
uniform float surfDeckY;
varying vec3 vSurfPos;
varying vec3 vSurfNrm;
`;

/**
 * Projects world position onto the dominant axis plane and samples the atlas.
 *
 * The same projection the level builder uses for its base UVs, so detail and
 * base agree across a piece; a full triplanar blend would triple the tap count
 * for a difference nobody can see on noise.
 */
const FRAGMENT_SAMPLE = /* glsl */ `
	vec3 surfNormalWorld = normalize( vSurfNrm );
	vec3 surfAxis = abs( surfNormalWorld );
	vec2 surfPlane = surfAxis.y >= surfAxis.x && surfAxis.y >= surfAxis.z
		? vSurfPos.xz
		: ( surfAxis.x >= surfAxis.z ? vSurfPos.zy : vSurfPos.xy );

	vec4 surfMacro = texture2D( surfDetailMap, surfPlane / surfScale.x );
	vec2 surfDetailNormal = ( surfMacro.rg - 0.5 ) * ( 2.0 * surfNormalAmount.x );
	float surfCavity = 1.0 - surfMacro.b;
	float surfFine = surfMacro.b;

	#ifdef SURF_MICRO
		// Axis-swapped and offset so the fine tap never lines up with the
		// coarse one and the pair reads as one continuous field.
		vec4 surfMicro = texture2D(
			surfDetailMap, surfPlane.yx / surfScale.y + vec2( 0.317, 0.671 )
		);
		surfDetailNormal += ( surfMicro.gr - 0.5 ) * ( 2.0 * surfNormalAmount.y );
		surfCavity = max( surfCavity, ( 1.0 - surfMicro.b ) * 0.85 );
		surfFine = surfMicro.b;
	#endif

	float surfUp = clamp( surfNormalWorld.y, 0.0, 1.0 );
	float surfSide = 1.0 - abs( surfNormalWorld.y );

	// Junction dirt is measured from the yard, and from the platform deck for
	// anything standing on it, so props three metres up are not left clean.
	vec2 surfDeckDelta = abs( vSurfPos.xz - surfDeck.xy ) - surfDeck.zw;
	float surfOnDeck = ( 1.0 - smoothstep( 0.0, 1.4, max( surfDeckDelta.x, surfDeckDelta.y ) ) )
		* smoothstep( -0.15, 0.05, vSurfPos.y - surfDeckY );
	float surfBase = max(
		1.0 - smoothstep( 0.0, surfGrimeAmount.y, vSurfPos.y ),
		( 1.0 - smoothstep( 0.0, surfGrimeAmount.y, vSurfPos.y - surfDeckY ) ) * surfOnDeck
	);
	float surfJunction = clamp(
		surfBase
			* ( 0.4 + 0.6 * surfSide )
			* ( 0.35 + 1.2 * surfMacro.a )
			* surfGrimeAmount.x,
		0.0, 1.0
	);

	#ifdef SURF_STREAKS
		// Vertically stretched sample: the same field read at a twentieth of
		// its horizontal rate, which is what turns blotches into run-off.
		float surfStreakField = texture2D(
			surfDetailMap, vec2( surfPlane.x * 0.42, vSurfPos.y * 0.055 )
		).a;
		float surfStreak = smoothstep( 0.62, 0.98, surfStreakField ) * surfSide
			* surfGrimeAmount.z * smoothstep( 0.4, 2.4, vSurfPos.y );
	#else
		float surfStreak = 0.0;
	#endif

	float surfDirt = clamp( surfJunction + surfStreak, 0.0, 1.0 );

	// Signed distance to the interior box: negative inside, and the mouth term
	// keeps the daylight wedge just inside the doorway from going flat.
	vec3 surfBox = abs( vSurfPos - surfInteriorCenter ) - surfInteriorHalf;
	float surfBoxDistance = length( max( surfBox, vec3( 0.0 ) ) )
		+ min( max( surfBox.x, max( surfBox.y, surfBox.z ) ), 0.0 );
	float surfInside = 1.0 - smoothstep( -0.05, 0.45, surfBoxDistance );
	float surfMouth = smoothstep(
		0.0, surfInteriorMouth.w, distance( vSurfPos, surfInteriorMouth.xyz )
	);
	// Second-smallest distance to a face is what identifies an edge; using the
	// smallest would darken every wall rather than the corners between them.
	vec3 surfFaces = surfInteriorHalf - abs( vSurfPos - surfInteriorCenter );
	float surfNear = min( surfFaces.x, min( surfFaces.y, surfFaces.z ) );
	float surfFar = max( surfFaces.x, max( surfFaces.y, surfFaces.z ) );
	float surfEdge = surfFaces.x + surfFaces.y + surfFaces.z - surfNear - surfFar;
	float surfCorner = exp( -max( surfEdge, 0.0 ) / surfInteriorTerm.z )
		* surfInteriorTerm.y * surfInside;
	float surfInterior = mix( 1.0, surfInteriorTerm.x, surfInside * surfMouth )
		* ( 1.0 - surfCorner );
`;

const FRAGMENT_ALBEDO = /* glsl */ `
	diffuseColor.rgb *= surfResponse.z;
	diffuseColor.rgb *= 1.0
		+ ( surfFine - 0.5 ) * surfAlbedoAmount.x
		+ ( surfMacro.b - 0.5 ) * surfAlbedoAmount.y;
	diffuseColor.rgb = mix(
		diffuseColor.rgb,
		diffuseColor.rgb * surfStainColor,
		smoothstep( 0.42, 1.0, surfMacro.a ) * surfAlbedoAmount.z
	);
	diffuseColor.rgb = mix(
		diffuseColor.rgb, diffuseColor.rgb * surfGrimeColor, surfCavity * surfAlbedoAmount.w
	);
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * surfGrimeColor, surfDirt );
	// Settled dust: a pale lift on up-facing surfaces only, strongest where the
	// stain field says the surface has been sitting undisturbed.
	diffuseColor.rgb *= 1.0 + surfUp * surfGrimeAmount.w * ( 0.3 + surfMacro.a );
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
	roughnessFactor = clamp(
		roughnessFactor + ( surfCavity - 0.5 ) * surfResponse.x + surfDirt * 0.12,
		0.035, 1.0
	);
`;

/**
 * Added to the tangent-space map normal after `normalScale`, so the detail
 * amount in a profile is absolute rather than scaled by the base map's own
 * strength. `surfDetailNormal` comes from `FRAGMENT_SAMPLE`, which is injected
 * at `<map_fragment>` — earlier in the shader than `<normal_fragment_maps>`, so
 * it is in scope here.
 */
const FRAGMENT_NORMAL = /* glsl */ `mapN.xy += surfDetailNormal;`;

// The junction's share of this is kept modest. It is a metre-tall gradient of
// splash-back off the ground, a different thing from the few-centimetre contact
// shadow the render pass traces, and the two only read as separate weathering
// if this one stays the gentler of the pair.
const FRAGMENT_OCCLUSION = /* glsl */ `
	float surfOcclusion = ( 1.0 - surfCavity * surfResponse.y )
		* ( 1.0 - surfJunction * 0.4 )
		* surfInterior;
	reflectedLight.indirectDiffuse *= surfOcclusion;
	reflectedLight.indirectSpecular *= surfOcclusion;
`;
