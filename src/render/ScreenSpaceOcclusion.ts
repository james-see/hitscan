import * as THREE from 'three';
import type { GBuffer } from '@/types/render.ts';
import { FullscreenDraw } from './FullscreenDraw.ts';
import { isLitMaterial } from './SceneMaterials.ts';

/**
 * Screen-space occlusion, evaluated before shading and consumed by the
 * forward pass.
 *
 * WHY THIS IS NOT A POST PASS
 *
 * Ambient occlusion is a visibility term on *indirect* light. A post pass can
 * only ever multiply the composited frame, which means it darkens direct
 * sunlight by exactly as much as it darkens skylight. That is wrong twice
 * over: a sunlit crease gets dimmed when it should not, and the frame as a
 * whole loses exposure, so the effect has to be dialled back until it reads
 * as a flat haze rather than as contact. Running the trace between the depth
 * prepass and the forward pass instead means the shader can put the term
 * exactly where it belongs — on `reflectedLight.indirectDiffuse` — and leave
 * the sun alone. See `ShadowShader.ts` for the injection.
 *
 * Two terms are produced in one pass, packed into an RG8 target:
 *
 *   r  ambient occlusion. A GTAO horizon search run at two radii from the
 *      same slice frame: a short one (~0.5m) for the cavity and contact
 *      darkening that grounds props, and a long one (~5m) whose only job is
 *      to close down enclosed spaces. Without the long radius an interior lit
 *      by an unoccluded sky probe receives exactly as much ambient as the
 *      courtyard outside it, which is the "milky interior" failure.
 *
 *   g  sun contact shadow. A short ray march through the depth buffer toward
 *      the sun, multiplied into the directional light. Cascaded shadow maps
 *      have a texel footprint of several centimetres in the near cascade and
 *      a normal-offset bias on top, so the last few centimetres where an
 *      object meets the floor are always lit. This recovers them.
 *
 * Noise is a per-pixel, per-frame interleaved gradient rotation. Because the
 * result is folded into scene colour before TAA rather than after it, the
 * temporal resolve the pipeline already pays for does the denoising, and no
 * separate accumulation buffer or history rejection is needed.
 */
export interface OcclusionOptions {
  /** Sample budget, mapped onto slice and step counts. */
  quality: number;
}

export class ScreenSpaceOcclusion {
  /** Cavity radius in metres. Short: this is the contact-darkening term. */
  radius = 0.55;
  /** Long radius in metres, for room-scale sky occlusion. */
  macroRadius = 12.0;
  /** How much of the long-radius term to apply. */
  macroStrength = 1.0;
  /** Exponent on visibility. Above 1 deepens creases. */
  power = 1.9;
  /**
   * Exponent on the long-radius term. Deliberately steeper than `power`.
   *
   * The near term is a cosine-weighted visibility integral and wants an
   * exponent close to physical, because it is competing with real geometry the
   * eye can check. The long term is standing in for something else entirely:
   * the sky probe is a single unoccluded environment map, so a room's interior
   * receives the same irradiance as the yard, and the only signal available to
   * correct that is how much of the hemisphere the walls take up. Raising the
   * exponent turns a soft "somewhat enclosed" reading into the two-to-three
   * stop drop an interior actually sits at.
   */
  macroPower = 3.4;
  /** Blend toward unoccluded. Drops to 0 when the effect is disabled. */
  strength = 1.0;

  /** Length of the sun-facing contact trace, in metres. */
  contactLength = 0.45;
  /** Depth interval a hit has to fall inside, in metres. */
  contactThickness = 0.6;
  /** View distance at which contact shadows have faded out, in metres. */
  contactFade = 32;
  contactStrength = 1.0;

  /**
   * Smallest tap offset in the horizon march, in pixels.
   *
   * Slightly over the diagonal of one texel. Below this a tap reads back its
   * own depth and reports a false horizon; see the march in `TRACE_SHADER`.
   */
  minPixels = 1.5;

  #gbuffer: GBuffer;
  #width = 1;
  #height = 1;
  #enabled = true;
  #quality = 10;

  #target: THREE.WebGLRenderTarget;
  #blurred: THREE.WebGLRenderTarget;
  #white: THREE.DataTexture;

  #trace: FullscreenDraw;
  #blur: FullscreenDraw;

  #sunWorld = new THREE.Vector3(0, 1, 0);
  #sunView = new THREE.Vector3(0, 1, 0);
  #frame = 0;

  /**
   * Shared by every patched material, so a single write here updates the
   * whole scene. Same mechanism the cascades use.
   */
  #uniforms = {
    hitscanOcclusionMap: { value: null as THREE.Texture | null },
    hitscanOcclusionTexel: { value: new THREE.Vector2(1, 1) },
    hitscanOcclusionStrength: { value: 1 },
    hitscanContactStrength: { value: 1 },
  };

  #patched = new WeakSet<THREE.Material>();

  constructor(gbuffer: GBuffer, options: OcclusionOptions) {
    this.#gbuffer = gbuffer;

    this.#target = createTarget(1, 1, 'occlusion');
    this.#blurred = createTarget(1, 1, 'occlusion.blurred');

    // Bound until the first trace runs, and whenever the effect is off, so a
    // material can never sample an uninitialised texture.
    this.#white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.#white.needsUpdate = true;
    this.#uniforms.hitscanOcclusionMap.value = this.#white;

    this.#trace = new FullscreenDraw({
      name: 'render.occlusion.trace',
      defines: { AO_SLICES: 2, AO_STEPS: 4, AO_MACRO_STEPS: 3, CONTACT_STEPS: 8 },
      uniforms: {
        tDepth: { value: null },
        tNormal: { value: null },
        uProjection: { value: new THREE.Matrix4() },
        uInvProjection: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2() },
        uSunView: { value: new THREE.Vector3() },
        uRadius: { value: 0.55 },
        uMacroRadius: { value: 12 },
        uMacroStrength: { value: 1 },
        uPower: { value: 1.9 },
        uMacroPower: { value: 3.4 },
        uProjScale: { value: 1 },
        uMinPixels: { value: 1.5 },
        uMaxRadiusPixels: { value: 96 },
        uContactLength: { value: 0.45 },
        uContactThickness: { value: 0.6 },
        uContactFade: { value: 32 },
        uFrame: { value: 0 },
      },
      fragmentShader: TRACE_SHADER,
    });

    this.#blur = new FullscreenDraw({
      name: 'render.occlusion.blur',
      uniforms: {
        tOcclusion: { value: null },
        tDepth: { value: null },
        uInvProjection: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2() },
      },
      fragmentShader: BLUR_SHADER,
    });

    this.setQuality(options.quality);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Toggling drives the uniforms rather than the defines, so switching the
   * setting at runtime cannot trigger a scene-wide shader recompile mid-game.
   */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.#applyStrength();
    if (!enabled) this.#uniforms.hitscanOcclusionMap.value = this.#white;
  }

  /** Maps `ssaoQuality` onto slice, step and march counts. */
  setQuality(quality: number): void {
    const clamped = THREE.MathUtils.clamp(Math.round(quality), 2, 24);
    if (clamped === this.#quality) return;
    this.#quality = clamped;

    const slices = THREE.MathUtils.clamp(Math.round(clamped / 5), 1, 4);
    const steps = THREE.MathUtils.clamp(Math.round(clamped / slices / 1.25), 2, 6);
    const macro = THREE.MathUtils.clamp(Math.round(steps * 0.75), 1, 4);
    const contact = THREE.MathUtils.clamp(Math.round(clamped * 0.8), 4, 16);

    const defines = this.#trace.material.defines as Record<string, number>;
    defines.AO_SLICES = slices;
    defines.AO_STEPS = steps;
    defines.AO_MACRO_STEPS = macro;
    defines.CONTACT_STEPS = contact;
    this.#trace.invalidate();
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.#sunWorld.copy(direction).normalize();
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.#width && h === this.#height) return;
    this.#width = w;
    this.#height = h;
    this.#target.setSize(w, h);
    this.#blurred.setSize(w, h);
    this.#uniforms.hitscanOcclusionTexel.value.set(1 / w, 1 / h);
  }

  /**
   * Patches a material to read the occlusion buffer.
   *
   * Unlit materials are skipped because the term they would receive it into
   * does not exist, and transparent ones because they are excluded from the
   * depth prepass: the buffer behind them describes whatever is further away,
   * so sampling it would stamp a silhouette of the background onto the glass.
   */
  setupMaterial(material: THREE.Material): void {
    if (this.#patched.has(material)) return;
    if (material.transparent === true || !isLitMaterial(material)) return;
    this.#patched.add(material);

    const defines = (material.defines ??= {});
    defines.HITSCAN_SSAO = '';

    const previous = material.onBeforeCompile;
    const uniforms = this.#uniforms;
    material.onBeforeCompile = function (shader, renderer): void {
      previous.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
    };
    material.needsUpdate = true;
  }

  /**
   * Runs the trace. Called by the pipeline after the G-buffer prepass and
   * before the forward pass, so the camera's projection already carries this
   * frame's TAA jitter and the buffer lines up with the shaded pixels exactly.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (!this.#enabled) {
      this.#uniforms.hitscanOcclusionMap.value = this.#white;
      return;
    }

    this.#frame = (this.#frame + 1) % 64;
    this.#sunView.copy(this.#sunWorld).transformDirection(camera.matrixWorldInverse).normalize();

    const trace = this.#trace;
    trace.set('tDepth', this.#gbuffer.depth);
    trace.set('tNormal', this.#gbuffer.normalRoughness);
    (trace.uniforms.uProjection!.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (trace.uniforms.uInvProjection!.value as THREE.Matrix4)
      .copy(camera.projectionMatrix)
      .invert();
    (trace.uniforms.uTexel!.value as THREE.Vector2).set(1 / this.#width, 1 / this.#height);
    (trace.uniforms.uSunView!.value as THREE.Vector3).copy(this.#sunView);
    trace.set('uRadius', this.radius);
    trace.set('uMacroRadius', this.macroRadius);
    trace.set('uMacroStrength', this.macroStrength);
    trace.set('uPower', this.power);
    trace.set('uMacroPower', this.macroPower);
    // proj[1][1] * halfHeight turns a world radius at one metre into pixels.
    trace.set('uProjScale', 0.5 * this.#height * camera.projectionMatrix.elements[5]!);
    trace.set('uMinPixels', this.minPixels);
    trace.set('uMaxRadiusPixels', Math.max(32, this.#height * 0.14));
    trace.set('uContactLength', this.contactLength);
    trace.set('uContactThickness', this.contactThickness);
    trace.set('uContactFade', this.contactFade);
    trace.set('uFrame', this.#frame);

    const previousTarget = renderer.getRenderTarget();
    trace.render(renderer, this.#target);

    const blur = this.#blur;
    blur.set('tOcclusion', this.#target.texture);
    blur.set('tDepth', this.#gbuffer.depth);
    (blur.uniforms.uInvProjection!.value as THREE.Matrix4)
      .copy(camera.projectionMatrix)
      .invert();
    (blur.uniforms.uTexel!.value as THREE.Vector2).set(1 / this.#width, 1 / this.#height);
    blur.render(renderer, this.#blurred);

    renderer.setRenderTarget(previousTarget);

    this.#uniforms.hitscanOcclusionMap.value = this.#blurred.texture;
    this.#applyStrength();
  }

  /** The packed occlusion buffer, for debug visualisation. */
  get texture(): THREE.Texture {
    return this.#uniforms.hitscanOcclusionMap.value ?? this.#white;
  }

  dispose(): void {
    this.#trace.dispose();
    this.#blur.dispose();
    this.#target.dispose();
    this.#blurred.dispose();
    this.#white.dispose();
  }

  #applyStrength(): void {
    this.#uniforms.hitscanOcclusionStrength.value = this.#enabled ? this.strength : 0;
    this.#uniforms.hitscanContactStrength.value = this.#enabled ? this.contactStrength : 0;
  }
}

function createTarget(width: number, height: number, name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    // Eight bits per term is plenty for a visibility scalar, and keeping the
    // buffer at a quarter of the bandwidth of RGBA16F matters when it is
    // written and then read once per shaded pixel.
    format: THREE.RGFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  target.texture.name = name;
  return target;
}

const GLSL_COMMON = /* glsl */ `
  #define OCC_PI 3.141592653589793
  #define OCC_HALF_PI 1.570796326794897

  float occSaturate( float x ) { return clamp( x, 0.0, 1.0 ); }

  vec3 occViewPosition( vec2 uv, float depth, mat4 invProjection ) {
    vec4 ndc = vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
    vec4 view = invProjection * ndc;
    return view.xyz / view.w;
  }

  float occNoise( vec2 p ) {
    return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
  }
`;

const TRACE_SHADER = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 uProjection;
uniform mat4 uInvProjection;
uniform vec2 uTexel;
uniform vec3 uSunView;
uniform float uRadius;
uniform float uMacroRadius;
uniform float uMacroStrength;
uniform float uPower;
uniform float uMacroPower;
uniform float uProjScale;
uniform float uMinPixels;
uniform float uMaxRadiusPixels;
uniform float uContactLength;
uniform float uContactThickness;
uniform float uContactFade;
uniform float uFrame;
varying vec2 vUv;

${GLSL_COMMON}

/**
 * Closed-form cosine-weighted visibility over the arc between the two horizon
 * angles, projected into the slice plane. Evaluating this integral instead of
 * guessing at it from a horizon angle is the whole difference between GTAO
 * and HBAO.
 */
float occIntegrateArc( float h1, float h2, float n, float cosN, float sinN ) {
  float a = - cos( 2.0 * h1 - n ) + cosN + 2.0 * h1 * sinN;
  float b = - cos( 2.0 * h2 - n ) + cosN + 2.0 * h2 * sinN;
  return 0.25 * ( a + b );
}

/**
 * Raises the running horizon cosine with one depth tap.
 *
 * Samples past the radius are faded to "below the horizon" rather than
 * discarded: a hard cut-off makes the occlusion boundary of every object a
 * visible ring at exactly the radius distance.
 */
float occHorizon( vec2 uv, vec3 P, vec3 V, float falloffStart, float falloffScale, float current ) {
  if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) return current;
  float d = texture2D( tDepth, uv ).r;
  if ( d >= 1.0 ) return current;
  vec3 S = occViewPosition( uv, d, uInvProjection );
  vec3 diff = S - P;
  float dist = length( diff );
  // A degenerate sample vector is not a neutral one. dot( diff, V ) / dist
  // would return 0, and 0 is a valid cosine meaning "horizon at 90 degrees",
  // i.e. the strongest occluder this function can report. Callers keep their
  // taps clear of the source texel, but the guard is cheap and the failure it
  // prevents is silent and large.
  if ( dist < 1e-3 ) return current;
  float c = dot( diff, V ) / dist;
  c = mix( c, -1.0, occSaturate( ( dist - falloffStart ) * falloffScale ) );
  return max( current, c );
}

/**
 * Marches the depth buffer toward the sun over a few tens of centimetres.
 *
 * The thickness window is what keeps this from shadowing the whole frame: a
 * depth buffer has no back face, so without an upper bound every ray that
 * passes behind any surface at all counts as blocked, and distant geometry
 * silhouettes get stamped across the floor.
 */
float occContactShadow( vec3 P, vec3 N, float noise ) {
  float NdotL = dot( N, uSunView );
  if ( NdotL <= 0.02 ) return 1.0;

  float viewZ = - P.z;
  float fade = 1.0 - occSaturate( ( viewZ - uContactFade * 0.55 ) / ( uContactFade * 0.45 ) );
  if ( fade <= 0.001 ) return 1.0;

  // Offset along the normal by rather more than the depth-buffer quantisation
  // at this distance, otherwise a grazing surface shadows itself in bands.
  vec3 origin = P + N * ( 0.012 + 0.0035 * viewZ );
  float stepLength = uContactLength / float( CONTACT_STEPS );
  float occluded = 0.0;

  for ( int i = 0; i < CONTACT_STEPS; i ++ ) {
    vec3 samplePos = origin + uSunView * ( stepLength * ( float( i ) + noise ) );
    vec4 clip = uProjection * vec4( samplePos, 1.0 );
    if ( clip.w <= 0.0 ) break;
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) break;

    float d = texture2D( tDepth, uv ).r;
    if ( d >= 1.0 ) continue;
    float sceneZ = - occViewPosition( uv, d, uInvProjection ).z;
    float rayZ = - samplePos.z;
    float delta = rayZ - sceneZ;
    if ( delta > 0.015 && delta < uContactThickness ) {
      occluded = 1.0;
      break;
    }
  }

  return 1.0 - occluded * fade;
}

void main() {
  float depth = texture2D( tDepth, vUv ).r;
  vec4 normalSample = texture2D( tNormal, vUv );

  // Sky, and anything the prepass never wrote, is unoccluded by definition.
  if ( depth >= 1.0 || dot( normalSample.xyz, normalSample.xyz ) < 0.01 ) {
    gl_FragColor = vec4( 1.0, 1.0, 0.0, 1.0 );
    return;
  }

  vec3 P = occViewPosition( vUv, depth, uInvProjection );
  vec3 N = normalize( normalSample.xyz );
  vec3 V = normalize( - P );
  float viewZ = max( - P.z, 1e-3 );

  float noise = occNoise( gl_FragCoord.xy + vec2( uFrame * 5.588238, uFrame * 3.141592 ) );
  float sliceNoise = fract( noise + uFrame * 0.6180339887 );
  float stepNoise = fract( noise * 1.6180339887 + uFrame * 0.3819660113 );

  float nearPixels = min( uRadius * uProjScale / viewZ, uMaxRadiusPixels );
  float macroPixels = min( uMacroRadius * uProjScale / viewZ, uMaxRadiusPixels * 2.5 );

  // Every tap has to clear the source texel, see the march below. Once the
  // whole search radius has shrunk to around that floor there is no arc left
  // to resolve, so the term is faded out rather than evaluated from taps that
  // are all sitting on top of each other. That is also the honest answer: a
  // half-metre cavity two hundred metres away does not occlude a pixel.
  float nearSpan = max( nearPixels - uMinPixels, 0.0 );
  float macroFloor = max( nearPixels, uMinPixels );
  float macroSpan = max( macroPixels - macroFloor, 0.0 );
  float fadeScale = 1.0 / max( uMinPixels, 1e-3 );
  float nearFade = occSaturate( nearSpan * fadeScale );
  float macroFade = occSaturate( macroSpan * fadeScale );

  float nearStart = uRadius * 0.55;
  float nearScale = 1.0 / max( uRadius - nearStart, 1e-3 );
  // The long-radius term holds its samples almost to the full radius. Its job
  // is to answer "how much of the sky can this point see", and a room's walls
  // are metres away from the floor in the middle of it: fade them out early
  // and an enclosed space measures as open as the yard outside.
  float macroStart = uMacroRadius * 0.8;
  float macroScale = 1.0 / max( uMacroRadius - macroStart, 1e-3 );

  float visNear = 0.0;
  float visMacro = 0.0;
  float sliceWeight = 0.0;

  for ( int s = 0; s < AO_SLICES; s ++ ) {
    float phi = OCC_PI * ( float( s ) + sliceNoise ) / float( AO_SLICES );
    vec2 omega = vec2( cos( phi ), sin( phi ) );
    vec3 sliceDir = vec3( omega, 0.0 );

    vec3 axis = cross( sliceDir, V );
    float axisLength = length( axis );
    if ( axisLength < 1e-4 ) continue;
    axis /= axisLength;

    vec3 projected = N - axis * dot( N, axis );
    float projectedLength = length( projected );
    if ( projectedLength < 1e-4 ) continue;
    vec3 projectedNormal = projected / projectedLength;

    float cosN = clamp( dot( projectedNormal, V ), -1.0, 1.0 );
    vec3 ortho = sliceDir - V * dot( sliceDir, V );
    float n = sign( dot( ortho, projectedNormal ) ) * acos( cosN );
    float sinN = sin( n );

    float forward = -1.0;
    float backward = -1.0;

    // Quadratic step spacing concentrates taps near the shading point, which
    // is where contact occlusion lives and where a linear march wastes most
    // of its budget.
    //
    // The distribution starts at uMinPixels, not at zero, and this is not a
    // refinement. A tap that lands inside the source texel reads back the
    // depth it was launched from, so the sample vector is degenerate and
    // dot( diff, V ) / dist returns 0 -- which the arc integrator reads as a
    // horizon at exactly 90 degrees, the strongest occluder it can be told
    // about. The arc collapses from [n - pi/2, n + pi/2] to [-pi/2, pi/2] and
    // the integral from cos(n) + n*sin(n) down to cos(n), so flat open ground
    // resolves to roughly 0.55 instead of 1.0. Quadratic spacing makes this
    // far more likely than a linear march would: the first offset is
    // (stepNoise / AO_STEPS)^2 of the radius, which at four steps is under
    // 6% of it, and the radius itself shrinks as 1/z. Past twenty metres or
    // so almost every frame's first tap was self-sampling.
    for ( int t = 0; t < AO_STEPS; t ++ ) {
      float f = ( float( t ) + stepNoise ) / float( AO_STEPS );
      vec2 offset = omega * ( uMinPixels + f * f * nearSpan ) * uTexel;
      forward = occHorizon( vUv + offset, P, V, nearStart, nearScale, forward );
      backward = occHorizon( vUv - offset, P, V, nearStart, nearScale, backward );
    }

    float h1 = n + max( - acos( clamp( backward, -1.0, 1.0 ) ) - n, - OCC_HALF_PI );
    float h2 = n + min( acos( clamp( forward, -1.0, 1.0 ) ) - n, OCC_HALF_PI );
    visNear += projectedLength * occIntegrateArc( h1, h2, n, cosN, sinN );

    // The long-radius pass continues from the short one: a horizon is a
    // running maximum, so restarting it would lose everything the near taps
    // already found and the two terms would disagree along every silhouette.
    float macroForward = forward;
    float macroBackward = backward;
    for ( int t = 0; t < AO_MACRO_STEPS; t ++ ) {
      float f = ( float( t ) + 1.0 - stepNoise ) / float( AO_MACRO_STEPS );
      float px = macroFloor + f * f * macroSpan;
      vec2 offset = omega * px * uTexel;
      macroForward = occHorizon( vUv + offset, P, V, macroStart, macroScale, macroForward );
      macroBackward = occHorizon( vUv - offset, P, V, macroStart, macroScale, macroBackward );
    }

    float m1 = n + max( - acos( clamp( macroBackward, -1.0, 1.0 ) ) - n, - OCC_HALF_PI );
    float m2 = n + min( acos( clamp( macroForward, -1.0, 1.0 ) ) - n, OCC_HALF_PI );
    visMacro += projectedLength * occIntegrateArc( m1, m2, n, cosN, sinN );

    sliceWeight += 1.0;
  }

  float ao = 1.0;
  if ( sliceWeight > 0.0 ) {
    float near = pow( occSaturate( visNear / sliceWeight ), uPower );
    float macro = pow( occSaturate( visMacro / sliceWeight ), uMacroPower );
    ao = mix( 1.0, near, nearFade ) * mix( 1.0, macro, uMacroStrength * macroFade );
  }

  float contact = occContactShadow( P, N, stepNoise );

  gl_FragColor = vec4( ao, contact, 0.0, 1.0 );
}
`;

const BLUR_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D tOcclusion;
uniform highp sampler2D tDepth;
uniform mat4 uInvProjection;
uniform vec2 uTexel;
varying vec2 vUv;

${GLSL_COMMON}

float occLinearDepth( vec2 uv ) {
  float d = texture2D( tDepth, uv ).r;
  if ( d >= 1.0 ) return -1.0;
  return - occViewPosition( uv, d, uInvProjection ).z;
}

void main() {
  vec2 center = texture2D( tOcclusion, vUv ).rg;
  float centerZ = occLinearDepth( vUv );
  if ( centerZ < 0.0 ) {
    gl_FragColor = vec4( center, 0.0, 1.0 );
    return;
  }

  vec2 sum = center;
  float weightSum = 1.0;

  // A 3x3 cross-bilateral kernel. Deliberately small: the temporal resolve
  // downstream is doing most of the denoising, and a wide blur here would
  // smear away exactly the tight contact darkening the pass exists to make.
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      if ( x == 0 && y == 0 ) continue;
      vec2 uv = vUv + vec2( float( x ), float( y ) ) * uTexel;
      float z = occLinearDepth( uv );
      if ( z < 0.0 ) continue;
      float w = exp2( - abs( z - centerZ ) / max( centerZ * 0.01, 1e-3 ) );
      sum += texture2D( tOcclusion, uv ).rg * w;
      weightSum += w;
    }
  }

  gl_FragColor = vec4( sum / weightSum, 0.0, 1.0 );
}
`;
