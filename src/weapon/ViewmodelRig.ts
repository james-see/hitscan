import * as THREE from 'three';
import type { EngineContext } from '@/types/engine.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type { RifleParts } from './models/AssaultRifle.ts';
import { buildAssaultRifle } from './models/AssaultRifle.ts';
import { createViewmodelEnvironment } from './models/ViewmodelEnvironment.ts';
import type { AnimationOutput } from './WeaponAnimator.ts';
import { Pose, Spring1, Spring3, blendPose, damp, remap01, smoothstep } from './Springs.ts';

/** Everything the rig needs to know about the world for one fixed step. */
export interface RigInput {
  /** Eased ADS weight in [0,1]. */
  ads: number;
  /** Sprint pose weight in [0,1]. */
  sprint: number;
  speed: number;
  maxSpeed: number;
  grounded: boolean;
  crouching: boolean;
  /** View rotation applied since the last step, excluding weapon recoil. */
  yawDelta: number;
  pitchDelta: number;
  /** Player velocity in world space, for strafe lag. */
  velocity: THREE.Vector3;
  yaw: number;
  animation: AnimationOutput;
  /** 0 = released, 1 = fully pressed. */
  triggerPull: number;
  /** Multiplier from the user's viewmodel sway preference. */
  swayScale: number;
  /** False during deterministic captures, which freezes idle motion. */
  idle: boolean;
  elapsed: number;
}

/**
 * Hip pose, in the viewmodel camera's space.
 *
 * What this pose has to show, in priority order: both gloved hands, the
 * length of the receiver, and the cant. The hands come first because they are
 * the only thing that tells the player the weapon is held rather than
 * floating, and they are only legible near the centre of the frame — pushed
 * into the right margin they become two dark lumps against the weapon no
 * matter how well they are modelled.
 *
 * The yaw was previously 0.5rad, chosen so the barrel and flash hider cleared
 * the silhouette of the handguard in front of them and the whole weapon could
 * be read in a still. That is 29 degrees off the view axis, and it is wrong:
 * rounds leave along the bore and land in the centre of the screen, so the
 * weapon was visibly not pointing where it shot. It is the pose of someone
 * showing you a rifle, not firing one.
 *
 * 0.13rad points it down range and accepts the consequence, which is that the
 * front end is foreshortened behind its own handguard. That is what a carbine
 * looks like from behind, and every game in this genre lives with it. The
 * muzzle device earns its detail at ADS and on the inspect animation instead
 * of by twisting the weapon across the frame to display it.
 *
 * The roll is positive — the top cants inboard, toward the player's
 * centreline, the way a right-handed shooter carries one.
 *
 * Position and distance carry everything the yaw used to. Turning the weapon
 * across the frame slimmed it for free, and giving that up cost 76mm of drop
 * and 70mm of standoff to buy back: the optic used to break the horizon at
 * 44% of frame height and the viewmodel ate 10.5% of the pixels, against 55%
 * and 8.3% now. Distance and drop are not interchangeable and both are
 * needed — pushing it away alone converges the whole weapon on the vanishing
 * point at the centre of the screen, which shrinks it but also makes it read
 * as floating out in front of the player rather than being carried.
 */
const HIP_POSE = new Pose(0.202, -0.188, -0.805, 0.025, 0.13, 0.05);

/**
 * Hip fire. The weapon squares up and rises the last few degrees onto the
 * line of the shot, driven by the trigger rather than by the recoil impulse
 * so that it leads the first round instead of trailing it.
 *
 * Small on purpose. The pose it starts from already points down range, so
 * this is the difference between held ready and pressed out, not a snap to a
 * second position. What matters is its offset from `HIP_POSE` — 24mm of
 * rise, 35mm back toward the shoulder and half the cant — so when the hold
 * is re-framed this moves with it. Left where it was, re-framing would have
 * quietly turned the press-out into a lunge.
 */
const HIP_FIRE_POSE = new Pose(0.18, -0.164, -0.77, 0.013, 0.055, 0.027);
/**
 * Low ready. The weapon drops out of the line of sight and cants across the
 * body, which is both the real technique and the clearest possible signal
 * that the player cannot currently shoot.
 *
 * Dropped and pushed out alongside the hip hold rather than left where it
 * was. It is authored in camera space, not as an offset, so lowering the
 * base without touching it would have made the weapon rise as the player
 * broke into a run. It still comes closer to the eye than the hold does,
 * which is the point of a low ready — the weapon is tucked in against the
 * body — but not by the two-to-one it worked out at once the hold moved.
 */
const SPRINT_POSE = new Pose(0.17, -0.19, -0.45, -0.25, 0.5, 0.45);

/**
 * Distance from the eye to the optic's reticle while aiming, in metres.
 *
 * This is the single most consequential number in the whole viewmodel: with
 * the ADS field of view it sets how much of the screen the optic eats, and
 * therefore whether the player can see a flanker while aiming. At this
 * distance the hood measures a fifth of the frame and the whole optic with
 * its mount rather under two fifths. Much closer and the sight becomes a
 * black frame with a letterbox of scene around it, which is a sight picture
 * only in the sense that a periscope is one.
 *
 * Far longer than a real cheek weld, and not as a fudge. Eye relief on an
 * actual reflex sight is 60-80mm, but the eye sees roughly 120 degrees
 * vertically where this lens sees 50, and apparent size scales with the ratio
 * of the half-angle tangents. 70mm of real eye relief through a 50-degree
 * lens is about 260mm, so 285mm is if anything slightly conservative. Treat
 * it as the correct distance rather than a knob: if the optic is the wrong
 * size in frame, the model or the lens is wrong, and pulling the eye back
 * only hides it.
 */
const ADS_EYE_DISTANCE = 0.285;

/**
 * Viewmodel field of view, vertical degrees.
 *
 * Deliberately much narrower than the world camera's 90. At 16:9 a vertical
 * 50 is ~82 horizontal, which is the band modern shooters use for weapons:
 * wide enough to fit the whole rifle, narrow enough that the near end of the
 * receiver is not smeared across the frame by perspective.
 *
 * ADS does not narrow at all. The old 46 was the last of an instinct to
 * narrow for a scoped feel, and since the viewmodel FOV does not change what
 * the player sees of the world, all it did was draw the weapon 9% larger at
 * exactly the moment it is already closest to the eye — a magnifier applied
 * to the one pose that could least afford it.
 *
 * Widening past the hip value would shrink the optic further and photograph
 * better still, and it is the wrong thing to do: the weapon would visibly
 * contract as the player pulls it in to aim, which reads as it retreating.
 * Equal is the only value that costs nothing in motion.
 */
const VIEWMODEL_FOV_HIP = 50;
const VIEWMODEL_FOV_ADS = 50;

/** How far ahead to probe for walls, roughly the weapon's length. */
const COLLISION_PROBE = 0.9;

const _forward = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _vector = new THREE.Vector3();
const _origin = new THREE.Vector3();

/**
 * The viewmodel rig: hierarchy, lighting, and every procedural layer that
 * moves the weapon.
 *
 * Layers compose in a fixed order — base pose (hip/ADS/sprint), then the
 * keyframed clip, then the reactive springs (sway, bob, recoil, collision).
 * Reactive layers are additive so they never fight the authored poses, and
 * each is scaled down by the ADS weight: a sight picture that wanders is
 * unusable, but a hip-fire weapon that does not wander is dead.
 */
export class ViewmodelRig {
  readonly root = new THREE.Group();
  readonly holder = new THREE.Group();
  readonly parts: RifleParts;

  #adsPose = new Pose();
  #basePose = new Pose();

  // Reactive layers.
  #swayRotation = new Spring3(3.1, 0.58);
  #swayPosition = new Spring3(3.6, 0.7);
  #recoilRotation = new Spring3(6.4, 0.46);
  #recoilPosition = new Spring3(7.2, 0.5);
  #landing = new Spring1(4.2, 0.42);
  #bobPhase = 0;
  #collision = 0;
  #hipFire = 0;
  #breathPhase = 0;

  // Fixed-step pose history, interpolated at render time.
  #previousPosition = new THREE.Vector3();
  #previousQuaternion = new THREE.Quaternion();
  #currentPosition = new THREE.Vector3();
  #currentQuaternion = new THREE.Quaternion();

  #environment: THREE.Texture | null = null;
  #lights: THREE.Object3D[] = [];
  #reticleBase = 0.85;
  #debugMaterial: THREE.MeshBasicMaterial | null = null;

  constructor() {
    this.parts = buildAssaultRifle();
    this.root.name = 'viewmodel_root';
    this.holder.name = 'viewmodel_holder';
    this.root.add(this.holder);
    this.holder.add(this.parts.root);
    this.root.matrixAutoUpdate = true;

    // Derive the ADS pose from the optic instead of hand-tuning it: the
    // reticle has to land exactly on the screen centre, and any authored
    // number drifts the moment the optic moves a millimetre.
    const aim = this.parts.aimPoint.position;
    this.#adsPose.rotation.set(0, 0, 0, 'YXZ');
    this.#adsPose.position.set(-aim.x, -aim.y, -ADS_EYE_DISTANCE - aim.z);
  }

  /** Attaches the rig to the viewmodel scene and builds its lighting. */
  init(ctx: EngineContext): void {
    ctx.viewmodelScene.add(this.root);

    // The render module publishes the world's sky probe here, and the weapon
    // deliberately does not use it. That probe is a sky dome: it has no ground
    // hemisphere, so a metal receiver at any useful roughness mirrors blue sky
    // over almost its whole surface and reads as pale chalk against the warm
    // ground it is standing on. This probe carries the same radiance
    // calibration but includes the sand bounce and a hot horizon band, which
    // is what gives the flanks somewhere dark to reflect.
    this.#environment = createViewmodelEnvironment(ctx.renderer);
    ctx.viewmodelScene.environment = this.#environment;
    ctx.viewmodelScene.environmentIntensity = 1;

    // Lighting is parented to the rig so it travels with the camera. A
    // viewmodel lit by the world sun goes black whenever the player faces
    // away from it, which is exactly when they most need to read the weapon.
    const addLight = (
      light: THREE.DirectionalLight,
      x: number,
      y: number,
      z: number
    ): void => {
      light.position.set(x, y, z);
      light.castShadow = false;
      this.root.add(light);
      this.root.add(light.target);
      light.target.position.set(0.1, -0.1, -0.35);
      this.#lights.push(light);
    };

    // With a bright outdoor probe carrying the metals, the direct lights are
    // mostly here to shape the dielectrics — the gloves and polymer furniture
    // — and to put a specular edge on the machined parts.
    //
    // All four are far less saturated than the sources they stand for, and
    // that is the whole trick. A saturated warm key opposite a saturated cool
    // rim leaves green short on every surface that catches both, and a grey
    // short of green is a magenta: the weapon turns the colour of purple-grey
    // plastic even though no material on it is tinted. The hemisphere probe
    // already carries an honest warm-below/cool-above split, so the direct
    // rig can afford to stay close to neutral and only hint at direction.
    addLight(new THREE.DirectionalLight(0xfff6ea, 1.3), -0.6, 0.9, 0.35);
    addLight(new THREE.DirectionalLight(0xc3d2ea, 0.38), 0.85, -0.25, 0.4);
    // Rim from ahead-above picks out the top rail and the optic housing,
    // which is what makes the silhouette legible against a bright wall. It is
    // deliberately the strongest single term: with no rim the whole viewmodel
    // collapses into one black shape wherever the background is bright.
    addLight(new THREE.DirectionalLight(0xe8eef4, 1.05), 0.35, 0.55, -1);
    // Warm bounce off the ground, which separates the underside of the
    // receiver and the magazine from the shadow they otherwise sit in.
    addLight(new THREE.DirectionalLight(0xffd2ac, 0.32), -0.15, -0.95, -0.25);
    // Eye light. Every face pointing back at the camera — the whole rear of
    // the optic, which is the surface the player stares at for the entire
    // time they are aiming — reflects only whatever is behind the player's
    // head, and a dark anodised housing with nothing to reflect renders as a
    // featureless black cutout no matter how much geometry is on it. This is
    // slightly above and right of the lens so the boss and the turret caps
    // cast across the face rather than lighting it flat.
    addLight(new THREE.DirectionalLight(0xd7dde4, 0.5), 0.3, 0.45, 1.0);

    this.#reticleBase = this.parts.reticle.material.opacity;
    this.#syncTransform();
    this.#previousPosition.copy(this.#currentPosition);
    this.#previousQuaternion.copy(this.#currentQuaternion);
  }

  /** Impulse from a fired round. `strength` is relative to the nominal kick. */
  addRecoil(strength: number, ads: number, rng: { range(a: number, b: number): number }): void {
    // ADS braces the weapon against the shoulder and the cheek: the same
    // impulse produces roughly half the visible movement.
    const scale = THREE.MathUtils.lerp(1, 0.44, ads) * strength;
    this.#recoilPosition.impulse(
      rng.range(-0.06, 0.06) * scale,
      rng.range(0.02, 0.09) * scale,
      0.42 * scale
    );
    this.#recoilRotation.impulse(
      rng.range(2.6, 3.6) * scale,
      rng.range(-0.9, 0.9) * scale,
      rng.range(-1.5, 1.5) * scale
    );
  }

  /** Vertical impulse from a landing, scaled by impact speed. */
  addLandingImpact(speed: number): void {
    const t = remap01(speed, 2, 14);
    this.#landing.impulse(-1.1 * t - 0.15);
  }

  /** Kick from a step-off, used when the player jumps. */
  addJumpImpulse(): void {
    this.#landing.impulse(0.45);
  }

  fixedStep(dt: number, input: RigInput, ctx: EngineContext): void {
    this.#previousPosition.copy(this.#currentPosition);
    this.#previousQuaternion.copy(this.#currentQuaternion);

    const ads = input.ads;
    const sway = input.swayScale * (1 - 0.72 * ads);

    // -- base pose ----------------------------------------------------------
    // The press-out is damped rather than tracking the trigger directly: at
    // the weapon's rate of fire the trigger signal is a square wave, and
    // following it exactly would vibrate the pose once per round.
    this.#hipFire = damp(
      this.#hipFire,
      input.triggerPull * (1 - ads),
      input.triggerPull > this.#hipFire ? 16 : 5,
      dt
    );
    blendPose(this.#basePose, HIP_POSE, HIP_FIRE_POSE, this.#hipFire);
    blendPose(this.#basePose, this.#basePose, this.#adsPose, ads);
    if (input.sprint > 1e-3) {
      blendPose(this.#basePose, this.#basePose, SPRINT_POSE, input.sprint);
    }

    // -- sway ---------------------------------------------------------------
    // Targets are proportional to angular velocity, so a slow pan produces a
    // steady offset and a flick produces an overshoot the spring resolves.
    const yawRate = THREE.MathUtils.clamp(input.yawDelta / dt, -9, 9);
    const pitchRate = THREE.MathUtils.clamp(input.pitchDelta / dt, -9, 9);
    this.#swayRotation.target.set(
      -pitchRate * 0.028 * sway,
      -yawRate * 0.034 * sway,
      yawRate * 0.02 * sway
    );
    this.#swayPosition.target.set(
      yawRate * 0.0045 * sway,
      pitchRate * 0.0035 * sway - Math.abs(yawRate) * 0.0008 * sway,
      0
    );
    this.#swayRotation.step(dt);
    this.#swayPosition.step(dt);

    // -- movement bob -------------------------------------------------------
    const speedRatio = THREE.MathUtils.clamp(input.speed / Math.max(input.maxSpeed, 0.01), 0, 1.6);
    const moving = input.grounded ? speedRatio : 0;
    // Phase advances with distance travelled, not time, so the bob stays
    // locked to the stride when the player accelerates or slows.
    this.#bobPhase += input.speed * 2.05 * dt;
    if (this.#bobPhase > Math.PI * 4) this.#bobPhase -= Math.PI * 4;

    // Classic figure-eight: the horizontal term runs at the stride rate and
    // the vertical at twice it, so the weapon traces a lazy 8 rather than a
    // circle. A circle reads as a wobble; the 8 reads as walking.
    const bobAmount = moving * (1 - 0.68 * ads) * input.swayScale;
    const bobX = Math.sin(this.#bobPhase) * 0.013 * bobAmount;
    const bobY = Math.sin(this.#bobPhase * 2) * 0.0075 * bobAmount;
    const bobRoll = Math.sin(this.#bobPhase) * 0.026 * bobAmount;
    const bobPitch = Math.sin(this.#bobPhase * 2 + 0.6) * 0.014 * bobAmount;

    // Strafing drags the muzzle: a lateral lag that is separate from look sway.
    _vector.copy(input.velocity);
    _vector.y = 0;
    const lateral = _vector.x * Math.cos(input.yaw) - _vector.z * Math.sin(input.yaw);
    const strafeLag = THREE.MathUtils.clamp(lateral / Math.max(input.maxSpeed, 0.01), -1, 1);

    // -- landing and breathing ---------------------------------------------
    this.#landing.step(dt);
    if (input.idle) this.#breathPhase += dt;
    const breathY = Math.sin(this.#breathPhase * 1.15) * 0.0016 * (1 - 0.75 * ads);
    const breathPitch = Math.sin(this.#breathPhase * 0.92 + 1.1) * 0.0055 * (1 - 0.8 * ads);
    const breathYaw = Math.sin(this.#breathPhase * 0.61) * 0.0065 * (1 - 0.8 * ads);

    // -- wall collision -----------------------------------------------------
    const distance = this.#probeWall(ctx);
    const target = 1 - smoothstep(0.28, COLLISION_PROBE, distance);
    // Asymmetric response: snap away from a wall quickly, return slowly, so
    // brushing past geometry does not make the weapon flutter.
    this.#collision = damp(this.#collision, target, target > this.#collision ? 22 : 9, dt);
    const collide = this.#collision;

    // -- recoil springs -----------------------------------------------------
    this.#recoilPosition.step(dt);
    this.#recoilRotation.step(dt);

    // -- compose ------------------------------------------------------------
    const anim = input.animation;
    const recoilPos = this.#recoilPosition.value;
    const recoilRot = this.#recoilRotation.value;
    const swayPos = this.#swayPosition.value;
    const swayRot = this.#swayRotation.value;

    _euler.set(
      this.#basePose.rotation.x +
        swayRot.x +
        bobPitch +
        breathPitch +
        anim.rotation.x +
        recoilRot.x * 0.06 +
        collide * 0.52 +
        this.#landing.value * 0.09,
      this.#basePose.rotation.y + swayRot.y + breathYaw + anim.rotation.y + recoilRot.y * 0.05 + collide * 0.24,
      this.#basePose.rotation.z +
        swayRot.z +
        bobRoll +
        anim.rotation.z +
        recoilRot.z * 0.05 -
        strafeLag * 0.035 * (1 - 0.7 * ads) +
        collide * 0.16,
      'YXZ'
    );
    _quaternion.setFromEuler(_euler);

    // Recoil translation acts along the weapon's own axis, not the camera's,
    // so a canted weapon kicks back into the shoulder rather than the screen.
    _vector.set(recoilPos.x * 0.06, recoilPos.y * 0.05, recoilPos.z * 0.055).applyQuaternion(_quaternion);

    this.#currentPosition.set(
      this.#basePose.position.x + swayPos.x + bobX + anim.position.x - strafeLag * 0.012 * (1 - 0.6 * ads),
      this.#basePose.position.y +
        swayPos.y +
        bobY +
        breathY +
        anim.position.y +
        this.#landing.value * 0.022 -
        collide * 0.035,
      this.#basePose.position.z + swayPos.z + anim.position.z + collide * 0.13
    );
    this.#currentPosition.add(_vector);
    this.#currentQuaternion.copy(_quaternion);

    // -- animated parts -----------------------------------------------------
    const magazine = this.parts.magazine;
    magazine.position.set(anim.magazineOffset.x, 0.012 + anim.magazineOffset.y, -0.038 + anim.magazineOffset.z);
    magazine.rotation.set(anim.magazinePitch, 0, anim.magazineRoll);
    magazine.visible = anim.magazineVisible;

    // The bolt rides back on its own spring after a shot and follows the
    // charging handle during a reload; the larger of the two wins.
    const cycleFromFire = Math.max(0, this.#recoilPosition.value.z) * 0.12;
    this.parts.chargingHandle.position.z = anim.chargeOffset;
    this.parts.bolt.position.z = Math.max(anim.boltOffset, Math.min(cycleFromFire, 0.05));
    this.parts.trigger.rotation.x = -input.triggerPull * 0.28;
  }

  /** Interpolates the fixed-step pose and follows the viewmodel camera. */
  render(alpha: number, ctx: EngineContext): void {
    this.root.position.copy(ctx.viewmodelCamera.position);
    this.root.quaternion.copy(ctx.viewmodelCamera.quaternion);

    this.holder.position.lerpVectors(this.#previousPosition, this.#currentPosition, alpha);
    this.holder.quaternion
      .copy(this.#previousQuaternion)
      .slerp(this.#currentQuaternion, alpha);
  }

  /** Applies the viewmodel camera's ADS field of view. */
  applyFov(ctx: EngineContext, ads: number): void {
    const fov = THREE.MathUtils.lerp(VIEWMODEL_FOV_HIP, VIEWMODEL_FOV_ADS, ads);
    if (Math.abs(ctx.viewmodelCamera.fov - fov) > 1e-3) {
      ctx.viewmodelCamera.fov = fov;
      ctx.viewmodelCamera.updateProjectionMatrix();
    }
  }

  /**
   * Reticle brightness. Off the sights the dot is a distraction and reads as
   * a light source; on the sights it needs to punch through bloom.
   */
  setReticleIntensity(ads: number): void {
    this.parts.reticle.material.opacity = this.#reticleBase * (0.25 + 0.75 * ads);
  }

  /**
   * Silhouette probe, driven by `?vmdebug=` during a capture.
   *
   * `flat` replaces every shaded material with an unlit opaque fill and hides
   * the lens and reticle. A shaded frame cannot distinguish "the hood is open
   * here" from "this surface is blending"; against this render it can, since
   * any pixel that shows the world inside the fill is genuinely not covered
   * by geometry. `hide` gives the matching background plate.
   *
   * `hands` fills only the two hand groups, which answers the separate
   * question of whether a hand is missing, off-frame or merely occluded — all
   * three look identical in a shaded frame.
   */
  setDebugSilhouette(mode: 'flat' | 'hide' | 'hands'): void {
    if (mode === 'hide') {
      this.root.visible = false;
      return;
    }
    const flat = new THREE.MeshBasicMaterial({ color: 0xff00e0, toneMapped: false });
    this.#debugMaterial = flat;
    const handMeshes = new Set<THREE.Object3D>();
    if (mode === 'hands') {
      for (const group of [this.parts.supportHand, this.parts.firingHand]) {
        group.traverse((object) => handMeshes.add(object));
      }
    }
    this.parts.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.Material;
      if (material.transparent) mesh.visible = false;
      else if (mode === 'flat' || handMeshes.has(mesh)) mesh.material = flat;
    });
  }

  #probeWall(ctx: EngineContext): number {
    if (!ctx.physics.ready) return Infinity;
    _origin.copy(ctx.camera.position);
    _forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    const hit = ctx.physics.raycast({
      origin: _origin,
      direction: _forward,
      maxDistance: COLLISION_PROBE,
      groups: CollisionGroup.World,
    });
    return hit ? hit.distance : Infinity;
  }

  #syncTransform(): void {
    this.#currentPosition.copy(HIP_POSE.position);
    _euler.copy(HIP_POSE.rotation);
    this.#currentQuaternion.setFromEuler(_euler);
    this.holder.position.copy(this.#currentPosition);
    this.holder.quaternion.copy(this.#currentQuaternion);
  }

  /** World-space position of a marker, expressed through the player camera. */
  markerToWorld(marker: THREE.Object3D, ctx: EngineContext, out: THREE.Vector3): THREE.Vector3 {
    marker.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(marker.matrixWorld);
    // The viewmodel lives in its own scene whose camera can diverge from the
    // player camera during captures, so round-trip through camera space
    // rather than assuming the two are identical.
    ctx.viewmodelCamera.updateMatrixWorld();
    ctx.viewmodelCamera.worldToLocal(out);
    ctx.camera.updateMatrixWorld();
    return ctx.camera.localToWorld(out);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const light of this.#lights) light.removeFromParent();
    this.#lights = [];
    this.parts.dispose();
    this.#debugMaterial?.dispose();
    this.#debugMaterial = null;
    this.#environment?.dispose();
    this.#environment = null;
  }
}
