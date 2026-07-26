/**
 * Particle shaders.
 *
 * A single program serves both blend batches; the difference is the blending
 * state and the fact that additive particles carry `lightMix = 0`.
 *
 * Written for GLSL3 (needed for `sampler2DArray`). three rewrites the
 * `attribute`/`varying` keywords via its own prefix, but it does not declare
 * the fragment output for GLSL3 ShaderMaterials, so this does.
 */

export const PARTICLE_VERTEX = /* glsl */ `
precision highp float;

attribute vec4 iPosRot;   // xyz = world position, w = roll in radians
attribute vec4 iSize;     // xy = half extents, z = sprite layer, w = billboard mode
attribute vec4 iColor;    // rgb = HDR colour, a = opacity
attribute vec4 iAxis;     // xyz = orientation axis, w = stretch length in metres
attribute vec4 iShade;    // x = light mix, y = soft-fade distance, z,w = spare

varying vec2 vUv;
varying float vLayer;
varying vec4 vColor;
varying float vLightMix;
varying float vSoftness;
varying vec3 vViewPos;
varying vec4 vClip;
varying vec3 vBasisX;
varying vec3 vBasisY;
varying vec3 vToCamera;

void main() {
  vec3 center = iPosRot.xyz;
  float halfW = iSize.x;
  float halfH = iSize.y;
  int mode = int(iSize.w + 0.5);

  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 toCam = cameraPosition - center;
  float camDist = length(toCam);
  toCam = camDist > 1e-5 ? toCam / camDist : vec3(0.0, 0.0, 1.0);

  vec3 world;
  vec3 basisX;
  vec3 basisY;
  vec3 forward = toCam;

  if (mode == 1) {
    // Axial: the quad's long edge tracks the orientation axis and rolls to
    // present its face to the camera. This is what keeps sparks, splinters
    // and tracers from reading as camera-facing cards.
    vec3 axis = normalize(iAxis.xyz);
    vec3 side = cross(axis, toCam);
    float sideLen = length(side);
    side = sideLen > 1e-4 ? side / sideLen : normalize(cross(axis, camUp + vec3(1e-3)));
    float stretch = iAxis.w;
    float halfLen = halfH + stretch * 0.5;
    vec3 tail = center - axis * (stretch * 0.5);
    world = tail + axis * (position.y * halfLen) + side * (position.x * halfW);
    basisX = side;
    basisY = axis;
  } else if (mode == 2) {
    // Planar: the quad lies in the surface, used for impact rings and
    // splash crowns so they wrap the ground instead of standing up in it.
    vec3 axis = normalize(iAxis.xyz);
    vec3 tangentSeed = abs(axis.y) < 0.985 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 bx = normalize(cross(tangentSeed, axis));
    vec3 by = cross(axis, bx);
    float c = cos(iPosRot.w);
    float s = sin(iPosRot.w);
    vec3 rx = bx * c + by * s;
    vec3 ry = by * c - bx * s;
    world = center + rx * (position.x * halfW) + ry * (position.y * halfH);
    basisX = rx;
    basisY = ry;
    forward = axis;
  } else {
    float c = cos(iPosRot.w);
    float s = sin(iPosRot.w);
    vec3 rx = camRight * c + camUp * s;
    vec3 ry = camUp * c - camRight * s;
    world = center + rx * (position.x * halfW) + ry * (position.y * halfH);
    basisX = rx;
    basisY = ry;
  }

  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  vViewPos = viewPos.xyz;
  vClip = projectionMatrix * viewPos;
  gl_Position = vClip;

  vUv = uv;
  vLayer = iSize.z;
  vColor = iColor;
  vLightMix = iShade.x;
  vSoftness = max(iShade.y, 1e-3);
  vBasisX = basisX;
  vBasisY = basisY;
  vToCamera = forward;
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uSprites;
uniform sampler2D uSceneDepth;
/** 0 = RGBA-packed depth from the private prepass, 1 = hardware depth texture. */
uniform int uDepthMode;
uniform float uSoftEnabled;
uniform vec2 uCameraPlanes;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;

varying vec2 vUv;
varying float vLayer;
varying vec4 vColor;
varying float vLightMix;
varying float vSoftness;
varying vec3 vViewPos;
varying vec4 vClip;
varying vec3 vBasisX;
varying vec3 vBasisY;
varying vec3 vToCamera;

layout(location = 0) out vec4 fragColor;

const float UnpackDownscale = 255.0 / 256.0;
const vec4 UnpackFactors = UnpackDownscale / vec4(256.0, 256.0 * 256.0, 256.0 * 256.0 * 256.0, 1.0);

float unpackDepth(const in vec4 v) {
  return dot(v, UnpackFactors);
}

float viewZFromDepth(float depth, float near, float far) {
  return (near * far) / ((far - near) * depth - far);
}

void main() {
  vec4 texel = texture(uSprites, vec3(vUv, vLayer));

  float alpha = vColor.a * texel.a;
  if (alpha < 0.002) discard;

  // Soft particles: fade where the billboard would otherwise slice into
  // geometry, which is what removes the hard intersection line on the floor.
  if (uSoftEnabled > 0.5) {
    vec2 screenUv = vClip.xy / vClip.w * 0.5 + 0.5;
    vec4 sampled = texture(uSceneDepth, screenUv);
    float depth = uDepthMode == 0 ? unpackDepth(sampled) : sampled.r;
    float sceneViewZ = viewZFromDepth(depth, uCameraPlanes.x, uCameraPlanes.y);
    float delta = vViewPos.z - sceneViewZ;
    alpha *= clamp(delta / vSoftness, 0.0, 1.0);
  }

  // Fade out as the particle approaches the near plane so nothing pops when
  // a puff drifts through the camera.
  float distanceToCamera = -vViewPos.z;
  alpha *= smoothstep(uCameraPlanes.x, uCameraPlanes.x + 0.35, distanceToCamera);
  if (alpha < 0.002) discard;

  vec3 rgb = vColor.rgb * texel.rgb;

  if (vLightMix > 0.001) {
    // Treat the billboard as a sphere cross-section. A flat quad lit by a
    // single N.L looks like paper; a spherical normal gives smoke volume.
    vec2 p = vUv * 2.0 - 1.0;
    float r2 = min(dot(p, p), 1.0);
    vec3 normal = normalize(vBasisX * p.x + vBasisY * p.y + vToCamera * sqrt(max(0.04, 1.0 - r2)));

    float ndl = dot(normal, uSunDirection);
    vec3 direct = uSunColor * max(ndl, 0.0);
    vec3 ambient = mix(uGroundColor, uSkyColor, normal.y * 0.5 + 0.5);
    // Forward scatter: a puff between the viewer and the sun glows through.
    float through = pow(max(dot(-vToCamera, uSunDirection), 0.0), 5.0);
    vec3 scatter = uSunColor * through * 0.85;
    // Cheap self-occlusion so the underside of a puff is not as bright.
    float occlusion = mix(0.46, 1.08, normal.y * 0.5 + 0.5);

    vec3 lit = (direct + ambient + scatter) * occlusion;
    rgb *= mix(vec3(1.0), lit, vLightMix);
  }

  fragColor = vec4(rgb * alpha, alpha);
}
`;
