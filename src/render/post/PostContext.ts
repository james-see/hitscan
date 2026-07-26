import * as THREE from 'three';

/**
 * Per-frame state shared by every post pass.
 *
 * `FrameContext` carries the camera and the G-buffer, but the temporal
 * effects need matrices that it does not expose: the *unjittered* view
 * projection of this frame and the last one. Velocity has to be derived from
 * unjittered clip positions or the jitter itself shows up as motion, while
 * depth reconstruction has to use the jittered inverse because that is the
 * projection the depth buffer was rasterised with. Keeping both here means
 * each pass reads the right one instead of re-deriving it.
 */
export class PostContext {
  width = 1;
  height = 1;

  /** Projection without the TAA jitter, for reprojection and velocity. */
  readonly projection = new THREE.Matrix4();
  readonly viewProjection = new THREE.Matrix4();
  readonly prevViewProjection = new THREE.Matrix4();

  /** Projection as rasterised this frame, for depth reconstruction. */
  readonly jitteredProjection = new THREE.Matrix4();
  readonly jitteredProjectionInverse = new THREE.Matrix4();

  readonly view = new THREE.Matrix4();
  readonly viewInverse = new THREE.Matrix4();
  readonly prevView = new THREE.Matrix4();

  /** Sub-pixel offset applied to the projection, in NDC. */
  readonly jitter = new THREE.Vector2();
  readonly prevJitter = new THREE.Vector2();

  near = 0.05;
  far = 1000;
  fieldOfViewY = 1;

  /** Scales a world-space radius at unit depth to pixels. */
  projectionScale = 1;

  depth: THREE.Texture | null = null;
  normalRoughness: THREE.Texture | null = null;
  velocity: THREE.Texture | null = null;

  /** Depth and normals are populated and safe to sample. */
  geometryValid = false;
  /** The velocity texture carries per-object motion, not just camera motion. */
  velocityValid = false;
  /** Depth and normals come from the post chain's own prepass. */
  usingFallbackGeometry = false;

  /** 1x1 target holding the adapted exposure multiplier in r. */
  exposureTexture: THREE.Texture | null = null;
  /** False while auto-exposure is disabled; consumers use the scalar. */
  exposureEnabled = false;
  /** Manual exposure, and the value the adaptation starts from. */
  exposureFallback = 1;

  /** PMREM-filtered sky, for reflection fallback. Null until lighting boots. */
  environment: THREE.Texture | null = null;

  frame = 0;
  deltaTime = 1 / 60;

  update(camera: THREE.PerspectiveCamera, jitter: THREE.Vector2): void {
    this.prevViewProjection.copy(this.viewProjection);
    this.prevView.copy(this.view);
    this.prevJitter.copy(this.jitter);
    this.jitter.copy(jitter);

    this.view.copy(camera.matrixWorldInverse);
    this.viewInverse.copy(camera.matrixWorld);

    this.jitteredProjection.copy(camera.projectionMatrix);
    this.jitteredProjectionInverse.copy(this.jitteredProjection).invert();

    // Strip the jitter back out: it lives entirely in the two clip-space
    // offset terms of the projection.
    this.projection.copy(camera.projectionMatrix);
    this.projection.elements[8] -= jitter.x;
    this.projection.elements[9] -= jitter.y;
    this.viewProjection.multiplyMatrices(this.projection, this.view);

    this.near = camera.near;
    this.far = camera.far;
    this.fieldOfViewY = THREE.MathUtils.degToRad(camera.fov);
    // proj[1][1] * halfHeight converts a world radius at depth 1 into pixels.
    this.projectionScale = 0.5 * this.height * this.projection.elements[5];
  }
}
