import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Photometry, groundBounceRadiance } from './Lighting.ts';

export interface SkyOptions {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  /** Cube resolution the PMREM is filtered from. */
  probeResolution: number;
  /** Fraction of the sky the cumulus deck covers, in [0,1]. */
  cloudCoverage: number;
  /** Opacity of the cumulus deck against the sky behind it. */
  cloudDensity: number;
  /** Opacity of the high cirrus sheet. */
  cirrusDensity: number;
}

const DEFAULTS: SkyOptions = {
  turbidity: 2.6,
  rayleigh: 2.0,
  mieCoefficient: 0.0045,
  mieDirectionalG: 0.82,
  probeResolution: 256,
  cloudCoverage: 0.42,
  cloudDensity: 0.85,
  cirrusDensity: 0.5,
};

/**
 * Physical sky, doubling as the image-based lighting source.
 *
 * The same Preetham scattering model drives the visible dome and the
 * PMREM-filtered environment map, so ambient light and the visible horizon
 * always agree.
 *
 * The important part is the calibration. Preetham radiance is unnormalised —
 * with these parameters an unscaled dome delivers roughly forty times the
 * irradiance of the sun, which drowns every shadow and clips the frame to
 * white. Rather than dialling in a magic `environmentIntensity`, the model is
 * evaluated on the CPU over a Fibonacci hemisphere to get the exact irradiance
 * an up-facing surface receives, and the shader output is scaled so that lands
 * on `Photometry.SKY_TO_SUN_RATIO` of the sun. Change the turbidity or the sun
 * angle and the exposure still holds.
 *
 * The lower hemisphere of the probe is replaced by a diffuse ground bounce.
 * Preetham has no notion of a ground plane and simply clamps to the horizon
 * radiance below it, which is both far too bright and the wrong colour for
 * light coming off dusty concrete.
 */
export class SkyDome {
  readonly mesh: Sky;

  /** Measured scale applied to the raw Preetham radiance. */
  readonly radianceScale: number;

  /** Sky-only irradiance on an up-facing surface, in scene units. */
  readonly skyIrradiance: number;

  #renderer: THREE.WebGLRenderer;
  #options: SkyOptions;
  #pmrem: THREE.PMREMGenerator;
  #target: THREE.WebGLRenderTarget;
  #scaleUniform = { value: 1 };
  #cloudUniforms = {
    hitscanCloudCoverage: { value: 0 },
    hitscanCloudDensity: { value: 0 },
    hitscanCirrusDensity: { value: 0 },
  };
  #groundUniform = { value: new THREE.Color(0, 0, 0) };
  #groundMesh: THREE.Mesh;
  #sunDirection = new THREE.Vector3();

  constructor(
    renderer: THREE.WebGLRenderer,
    sunDirection: THREE.Vector3,
    options: Partial<SkyOptions> = {}
  ) {
    this.#renderer = renderer;
    this.#options = { ...DEFAULTS, ...options };
    this.#sunDirection.copy(sunDirection).normalize();

    this.mesh = new Sky();
    this.mesh.scale.setScalar(8000);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    // Drawn after opaque geometry so early-z rejects the covered pixels; the
    // dome is a full-screen shader and is not cheap at 1440p.
    this.mesh.renderOrder = 1000;

    const uniforms = this.mesh.material.uniforms;
    uniforms.turbidity!.value = this.#options.turbidity;
    uniforms.rayleigh!.value = this.#options.rayleigh;
    uniforms.mieCoefficient!.value = this.#options.mieCoefficient;
    uniforms.mieDirectionalG!.value = this.#options.mieDirectionalG;
    // three's own cloud layer is a single unwarped fbm thresholded flat, which
    // at this field of view reads as television static rather than as weather.
    // It is left off and replaced below.
    uniforms.cloudCoverage!.value = 0;
    uniforms.sunPosition!.value.copy(this.#sunDirection).multiplyScalar(450000);

    this.#cloudUniforms.hitscanCloudCoverage.value = this.#options.cloudCoverage;
    this.#cloudUniforms.hitscanCloudDensity.value = this.#options.cloudDensity;
    this.#cloudUniforms.hitscanCirrusDensity.value = this.#options.cirrusDensity;

    this.#patchSkyMaterial();

    const raw = integrateSkyIrradiance(this.#sunDirection, this.#options);
    const target = Photometry.SUN_IRRADIANCE * Photometry.SKY_TO_SUN_RATIO;
    this.radianceScale = raw > 1e-6 ? target / raw : 1;
    this.skyIrradiance = target;
    this.#scaleUniform.value = this.radianceScale;

    this.#groundMesh = buildGroundShell(this.#groundUniform);

    this.#pmrem = new THREE.PMREMGenerator(renderer);
    this.#pmrem.compileEquirectangularShader();
    this.#target = this.#bakeEnvironment();
  }

  get environment(): THREE.Texture {
    return this.#target.texture;
  }

  /** Rebuilds the dome and the environment after the sun moves. */
  setSunDirection(direction: THREE.Vector3): void {
    this.#sunDirection.copy(direction).normalize();
    this.mesh.material.uniforms.sunPosition!.value
      .copy(this.#sunDirection)
      .multiplyScalar(450000);
    const previous = this.#target;
    this.#target = this.#bakeEnvironment();
    previous.dispose();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.#groundMesh.geometry.dispose();
    (this.#groundMesh.material as THREE.Material).dispose();
    this.#target.dispose();
    this.#pmrem.dispose();
  }

  /**
   * Injects the calibration multiplier and the cloud deck into three's Sky
   * shader. Patching the material rather than scaling `environmentIntensity`
   * keeps the visible dome and the probe in lockstep — if they disagree,
   * reflections stop matching the background and the illusion collapses. The
   * clouds go in here for the same reason: they are baked into the PMREM
   * along with everything else, so they light the scene as well as decorate
   * the background.
   */
  #patchSkyMaterial(): void {
    const material = this.mesh.material;
    material.uniforms.skyRadianceScale = this.#scaleUniform;
    Object.assign(material.uniforms, this.#cloudUniforms);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.skyRadianceScale = this.#scaleUniform;
      Object.assign(shader.uniforms, this.#cloudUniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${CLOUD_SHADER}\nvoid main() {`)
        .replace(
          'gl_FragColor = vec4( texColor, 1.0 );',
          'gl_FragColor = vec4( hitscanClouds( direction, vSunDirection, texColor ) * skyRadianceScale, 1.0 );'
        );
    };
    material.needsUpdate = true;
  }

  #bakeEnvironment(): THREE.WebGLRenderTarget {
    const scene = new THREE.Scene();

    // The dome instance in the world scene cannot be reparented, so the probe
    // renders a lightweight clone that shares the same material.
    const dome = new THREE.Mesh(this.mesh.geometry, this.mesh.material);
    dome.scale.copy(this.mesh.scale);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    scene.add(dome);

    const bounce = groundBounceRadiance(this.#sunDirection);
    const tint = new THREE.Color(Photometry.BOUNCE_COLOR).convertSRGBToLinear();
    this.#groundUniform.value.copy(tint).multiplyScalar(bounce);
    scene.add(this.#groundMesh);

    // The disc is the DirectionalLight's job. Leaving it in double-counts the
    // sun and leaves a hard specular hot spot in every rough reflection.
    const uniforms = this.mesh.material.uniforms;
    const showSunDisc = uniforms.showSunDisc!.value;
    uniforms.showSunDisc!.value = 0;

    const previousTarget = this.#renderer.getRenderTarget();
    this.#pmrem.compileCubemapShader();
    const target = this.#pmrem.fromScene(scene, 0, 0.5, 200);
    this.#renderer.setRenderTarget(previousTarget);

    uniforms.showSunDisc!.value = showSunDisc;
    target.texture.name = 'sky.ibl';

    scene.remove(this.#groundMesh);
    return target;
  }
}

/**
 * Two-layer cloud deck, evaluated in the sky shader.
 *
 * Every cloud value is expressed as a multiple of the Preetham radiance for
 * that view direction rather than as an absolute colour. That is what keeps
 * the deck consistent with the calibration: the clouds are lit by the same
 * sky they sit in, they warm and cool with it as the sun moves, and the total
 * irradiance the probe integrates stays within a few percent of the measured
 * value the exposure is anchored to.
 *
 * The cumulus field is domain-warped before it is thresholded. An unwarped
 * fbm through a smoothstep gives blobs with the isotropic, faintly hexagonal
 * signature of the underlying lattice; warping it by a second, coarser fbm is
 * what produces the sheared, piled silhouettes that read as weather.
 *
 * Everything is static. A drifting deck would be nicer, but the capture
 * harness converges TAA over dozens of frames against a frozen simulation
 * clock, and a sky that moves during that window resolves to mush.
 */
const CLOUD_SHADER = /* glsl */ `
uniform float skyRadianceScale;
uniform float hitscanCloudCoverage;
uniform float hitscanCloudDensity;
uniform float hitscanCirrusDensity;

float hitscanHash( vec2 p ) {
	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

float hitscanValueNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = hitscanHash( i );
	float b = hitscanHash( i + vec2( 1.0, 0.0 ) );
	float c = hitscanHash( i + vec2( 0.0, 1.0 ) );
	float d = hitscanHash( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

float hitscanFbm( vec2 p ) {
	float value = 0.0;
	float amplitude = 0.5;
	for ( int i = 0; i < 5; i ++ ) {
		value += amplitude * hitscanValueNoise( p );
		// A non-integer lacunarity plus an offset keeps successive octaves
		// from sharing lattice corners, which is what causes the grid to
		// show through at high amplitude.
		p = p * 2.03 + vec2( 11.7, 5.3 );
		amplitude *= 0.5;
	}
	return value;
}

float hitscanCumulus( vec2 uv ) {
	// Signed warp. Five octaves of value noise average close to 0.5, so an
	// unsigned one is mostly a constant translation of the domain and shears
	// nothing.
	vec2 warp = vec2( hitscanFbm( uv * 0.55 ), hitscanFbm( uv * 0.55 + 7.31 ) ) * 2.0 - 1.0;
	return hitscanFbm( uv + warp * 1.4 );
}

vec3 hitscanClouds( vec3 direction, vec3 sunDirection, vec3 skyColor ) {

	if ( direction.y <= 0.005 ) return skyColor;

	// Flat-plane projection. Exact for a deck that is thin relative to its
	// altitude, and the horizon compression it produces is the perspective
	// cue that sells the scale.
	//
	// The raw projection is unusable on its own: it is bounded near the
	// zenith and unbounded at the horizon, so any scale that puts a handful
	// of clouds overhead puts a thousand cycles of noise per pixel at the
	// skyline. Compressing it radially onto a finite disc keeps the
	// perspective while bounding the sampling rate.
	vec2 plane = direction.xz / max( direction.y, 0.045 );
	vec2 domain = plane / ( 1.0 + length( plane ) * 0.11 );

	float sunFacing = clamp( dot( direction, sunDirection ) * 0.5 + 0.5, 0.0, 1.0 );
	vec2 sunAzimuth = normalize( sunDirection.xz + vec2( 1e-4 ) );

	// -- cumulus ---------------------------------------------------------
	vec2 cumulusUv = domain * 1.15 + vec2( 4.2, -1.6 );
	float field = hitscanCumulus( cumulusUv );
	// Thresholds are placed against the distribution the fbm actually
	// produces, which is centred near 0.5 with a standard deviation around
	// 0.12 — not against [0,1]. Cutting at 1 - coverage puts the whole deck
	// three standard deviations out and yields an empty sky.
	float threshold = mix( 0.63, 0.35, hitscanCloudCoverage );
	float cumulus = smoothstep( threshold, threshold + 0.085, field );

	// Self-shadowing from one extra tap displaced along the sun's azimuth.
	// Crude, but it is the difference between flat grey pancakes and
	// something with a lit top and a shaded underside.
	float shifted = hitscanCumulus( cumulusUv - sunAzimuth * 0.5 );
	float lit = clamp( ( field - shifted ) * 6.0 + 0.5, 0.0, 1.0 );

	// -- cirrus ----------------------------------------------------------
	vec2 cirrusUv = vec2( domain.x * 0.30, domain.y * 1.05 ) + vec2( -2.7, 3.4 );
	float cirrusField = hitscanFbm( cirrusUv * 1.6 + ( hitscanFbm( cirrusUv * 0.6 ) * 2.0 - 1.0 ) * 1.1 );
	float cirrus = smoothstep( 0.47, 0.62, cirrusField );

	// Both layers fade into the horizon haze rather than terminating on it.
	float horizon = smoothstep( 0.01, 0.19, direction.y );
	cumulus *= horizon * hitscanCloudDensity;
	cirrus *= smoothstep( 0.03, 0.30, direction.y ) * hitscanCirrusDensity;

	// Thin cloud lit from behind scatters forward hard; this is the bright
	// edge that appears on the sun side of a deck and nowhere else.
	float silver = pow( sunFacing, 12.0 ) * ( 1.0 - lit * 0.6 );

	vec3 shaded = skyColor * 0.62;
	vec3 sunlit = skyColor * mix( 1.9, 3.1, sunFacing );
	vec3 cumulusColor = mix( shaded, sunlit, lit ) + skyColor * silver * 2.2;
	vec3 cirrusColor = skyColor * mix( 1.6, 3.6, sunFacing );

	vec3 result = mix( skyColor, cirrusColor, cirrus * ( 1.0 - cumulus * 0.8 ) );
	result = mix( result, cumulusColor, cumulus );
	return result;
}
`;

/**
 * Lower half of the environment probe: a uniform diffuse bounce standing in
 * for the ground plane. Radius sits comfortably inside the PMREM camera's
 * near/far range.
 */
function buildGroundShell(colorUniform: { value: THREE.Color }): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(20, 24, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    uniforms: { groundRadiance: colorUniform },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 groundRadiance;
      void main() { gl_FragColor = vec4( groundRadiance, 1.0 ); }
    `,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.name = 'sky.groundBounce';
  return mesh;
}

// ---------------------------------------------------------------------------
// CPU evaluation of the Preetham model
//
// A direct port of three's `Sky` shader, used only to measure the irradiance
// the dome delivers so the shader output can be normalised. Doing this on the
// CPU avoids a float render-target readback, which is the one operation in
// this pipeline that is not guaranteed to be supported everywhere.
// ---------------------------------------------------------------------------

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const SUN_EE = 1000.0;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const THREE_OVER_SIXTEEN_PI = 0.05968310365946075;
const ONE_OVER_FOUR_PI = 0.07957747154594767;

/**
 * Cosine-weighted irradiance an up-facing surface receives from the unscaled
 * dome, integrated over a Fibonacci hemisphere.
 */
function integrateSkyIrradiance(sunDirection: THREE.Vector3, options: SkyOptions): number {
  const sunfade = 1 - Math.min(Math.max(1 - Math.exp(sunDirection.y), 0), 1);
  const rayleighCoefficient = options.rayleigh - (1 - sunfade);
  const betaR = TOTAL_RAYLEIGH.map((v) => v * rayleighCoefficient);
  const mieC = 0.2 * options.turbidity * 1e-17;
  const betaM = MIE_CONST.map((v) => 0.434 * mieC * v * options.mieCoefficient);

  const zenithCos = Math.min(Math.max(sunDirection.y, -1), 1);
  const sunE =
    SUN_EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(zenithCos)) / STEEPNESS)));

  const samples = 4096;
  const solidAngle = (4 * Math.PI) / samples;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const radiance = [0, 0, 0];
  let irradiance = 0;

  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * (i + 0.5)) / samples;
    if (y <= 0) continue;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const dir = { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };

    evaluatePreetham(dir, sunDirection, betaR, betaM, sunE, options, radiance);
    // Rec.709 luminance: the sky is close to neutral in irradiance terms and a
    // scalar keeps the calibration a single, explainable number.
    const luminance = 0.2126 * radiance[0]! + 0.7152 * radiance[1]! + 0.0722 * radiance[2]!;
    irradiance += luminance * y * solidAngle;
  }

  return irradiance;
}

function evaluatePreetham(
  direction: { x: number; y: number; z: number },
  sunDirection: THREE.Vector3,
  betaR: number[],
  betaM: number[],
  sunE: number,
  options: SkyOptions,
  out: number[]
): void {
  const zenithAngle = Math.acos(Math.max(0, direction.y));
  const denom =
    Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253);
  const inverse = 1 / denom;
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;

  const cosTheta =
    direction.x * sunDirection.x + direction.y * sunDirection.y + direction.z * sunDirection.z;
  const rPhase = THREE_OVER_SIXTEEN_PI * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g = options.mieDirectionalG;
  const g2 = g * g;
  const mPhase =
    ONE_OVER_FOUR_PI * ((1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5));

  const sunUpFade = Math.min(Math.max(Math.pow(1 - sunDirection.y, 5), 0), 1);

  for (let c = 0; c < 3; c++) {
    const bR = betaR[c]!;
    const bM = betaM[c]!;
    const fex = Math.exp(-(bR * sR + bM * sM));
    const scatter = (bR * rPhase + bM * mPhase) / (bR + bM);
    const lin = Math.pow(sunE * scatter * (1 - fex), 1.5);
    const nearSun = Math.pow(Math.max(0, sunE * scatter * fex), 0.5);
    const lit = lin * (1 - sunUpFade + sunUpFade * nearSun);
    const l0 = 0.1 * fex;
    out[c] = (lit + l0) * 0.04 + [0, 0.0003, 0.00075][c]!;
  }
}
