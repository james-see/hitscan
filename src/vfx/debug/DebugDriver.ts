import * as THREE from 'three';
import type { EngineContext } from '@/types/engine.ts';
import type { HitResult, SurfaceKind } from '@/types/gameplay.ts';
import { CollisionGroup } from '@/types/physics.ts';

export interface VfxCounts {
  particles: number;
  alpha: number;
  additive: number;
  decalsPlaced: number;
  decalsNoTarget: number;
  decalsNoClip: number;
  shells: number;
  /** 0 = private packed prepass, 1 = adopted G-buffer depth. */
  depthMode: number;
}

export interface VfxDebugApi {
  /** Fires `count` rounds from `origin` towards `target`, through the event bus. */
  fire(
    origin: [number, number, number],
    target: [number, number, number],
    count?: number,
    options?: { surface?: SurfaceKind; weaponId?: string; spread?: number }
  ): void;
  /** Places a single impact at a point, with an explicit surface. */
  impact(point: [number, number, number], normal: [number, number, number], surface: SurfaceKind): void;
  /**
   * Fires from the current camera, so scenarios stay valid as the arena moves.
   * The muzzle sits where a viewmodel barrel would.
   */
  fireForward(count?: number, options?: { spread?: number; weaponId?: string }): void;
  /** Fans one impact of every surface kind along a line, for A/B comparison. */
  surfaceRow(origin: [number, number, number], step?: number): void;
  /** The same fan, laid across the ground in front of the camera. */
  surfaceRowForward(distance?: number, step?: number): void;
  footstep(point: [number, number, number], surface?: SurfaceKind): void;
  /** Clears every live effect, so scenarios do not leak into each other. */
  reset(): void;
  /** The last hit the driver resolved, for diagnosing placement. */
  lastImpact(): {
    point: [number, number, number];
    normal: [number, number, number];
    surface: SurfaceKind;
    actorId: string | null;
    distance: number;
    fromPhysics: boolean;
  } | null;
  counts(): VfxCounts;
}

declare global {
  interface Window {
    __vfxDebug?: VfxDebugApi;
  }
}

const SURFACES: SurfaceKind[] = [
  'concrete',
  'metal',
  'wood',
  'dirt',
  'sand',
  'glass',
  'water',
  'fabric',
  'foliage',
  'flesh',
];

const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _point = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

const _raycaster = new THREE.Raycaster();
const _intersections: THREE.Intersection[] = [];
const _hitNormal = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();

/** Surface guessed from the world module's mesh naming. */
const NAME_SURFACE: Array<[string, SurfaceKind]> = [
  ['wood', 'wood'],
  ['crate', 'wood'],
  ['pallet', 'wood'],
  ['plank', 'wood'],
  ['metal', 'metal'],
  ['barrel', 'metal'],
  ['rail', 'metal'],
  ['bollard', 'metal'],
  ['sandbag', 'sand'],
  ['foliage', 'foliage'],
  ['ground', 'dirt'],
  ['glass', 'glass'],
  ['lens', 'glass'],
];

function surfaceForName(name: string): SurfaceKind {
  const lower = name.toLowerCase();
  for (const [needle, surface] of NAME_SURFACE) {
    if (lower.includes(needle)) return surface;
  }
  return 'concrete';
}

function raycastScene(
  scene: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): { point: THREE.Vector3; normal: THREE.Vector3; distance: number; surface: SurfaceKind } | null {
  _raycaster.set(origin, direction);
  _raycaster.near = 0.05;
  _raycaster.far = 120;
  _intersections.length = 0;
  _raycaster.intersectObject(scene, true, _intersections);

  for (const hit of _intersections) {
    const object = hit.object as THREE.Mesh;
    if (!object.isMesh || object.name.startsWith('vfx') || object.name === 'sky') continue;
    if (!hit.face) continue;
    _normalMatrix.getNormalMatrix(object.matrixWorld);
    _hitNormal.copy(hit.face.normal).applyMatrix3(_normalMatrix).normalize();
    if (_hitNormal.dot(direction) > 0) _hitNormal.negate();
    return {
      point: hit.point.clone(),
      normal: _hitNormal.clone(),
      distance: hit.distance,
      surface: surfaceForName(object.name),
    };
  }
  return null;
}

/**
 * Inspection harness for the VFX module, installed only when the page is
 * loaded with `?vfx=debug`.
 *
 * The weapon module owns the real emitters; this drives the same events so
 * effects can be triggered and stepped from the capture harness while that
 * work lands independently.
 */
export function installDebugDriver(ctx: EngineContext, counts: () => VfxCounts): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('vfx') !== 'debug') return false;

  let shotIndex = 0;
  let lastHit: HitResult | null = null;
  // Forked once: re-forking per shot would replay the same stream and put
  // every round of a burst through the same hole.
  const rng = ctx.rng.fork('vfx.debug');
  let lastFromPhysics = false;

  const resolve = (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    forced: SurfaceKind | undefined
  ): HitResult => {
    const hit = ctx.physics.ready
      ? ctx.physics.raycast({
          origin,
          direction,
          maxDistance: 120,
          groups: CollisionGroup.World,
        })
      : null;
    lastFromPhysics = hit !== null;
    if (hit) {
      return (lastHit = {
        point: hit.point,
        normal: hit.normal,
        distance: hit.distance,
        surface: forced ?? hit.surface,
        actorId: hit.actorId,
        hitbox: null,
        direction: direction.clone(),
        penetrationDepth: 0,
      });
    }

    // Nothing owns stepping the physics world outside of a live match, so
    // scene queries come back empty during capture. Fall back to the render
    // meshes, which is enough to put effects on real geometry.
    const visual = raycastScene(ctx.scene, origin, direction);
    if (visual) {
      return (lastHit = {
        point: visual.point,
        normal: visual.normal,
        distance: visual.distance,
        surface: forced ?? visual.surface,
        actorId: null,
        hitbox: null,
        direction: direction.clone(),
        penetrationDepth: 0,
      });
    }

    return (lastHit = {
      point: origin.clone().addScaledVector(direction, 40),
      normal: direction.clone().negate(),
      distance: 40,
      surface: forced ?? 'concrete',
      actorId: null,
      hitbox: null,
      direction: direction.clone(),
      penetrationDepth: 0,
    });
  };

  const shoot = (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    index: number,
    options: { surface?: SurfaceKind; weaponId?: string }
  ): void => {
    ctx.events.emit('weapon:fired', {
      weaponId: options.weaponId ?? 'ar',
      origin: origin.clone(),
      direction: direction.clone(),
      ammo: 30 - index,
      shotIndex: shotIndex++,
    });
    ctx.events.emit('weapon:impact', resolve(origin, direction, options.surface));
    ctx.events.emit('weapon:shell-ejected', {
      position: origin.clone().addScaledVector(_right, 0.06).addScaledVector(_up, 0.02),
      // Camera-relative so brass lands in frame whichever way the shot faces.
      velocity: new THREE.Vector3()
        .addScaledVector(_right, rng.range(1.3, 2.2))
        .addScaledVector(_up, rng.range(1.2, 1.9))
        .addScaledVector(_forward, rng.range(0.2, 0.9)),
    });
  };

  const scatter = (direction: THREE.Vector3, spread: number): void => {
    if (spread <= 0) return;
    direction
      .addScaledVector(_right, rng.gaussian(0, spread))
      .addScaledVector(_up, rng.gaussian(0, spread))
      .normalize();
  };

  const cameraBasis = (): void => {
    ctx.camera.updateMatrixWorld(true);
    _forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion).normalize();
    _right.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion).normalize();
    _up.crossVectors(_right, _forward).normalize();
  };

  const api: VfxDebugApi = {
    fire(origin, target, count = 1, options = {}) {
      cameraBasis();
      _origin.set(origin[0], origin[1], origin[2]);
      for (let i = 0; i < count; i++) {
        _point.set(target[0], target[1], target[2]);
        _direction.subVectors(_point, _origin).normalize();
        scatter(_direction, options.spread ?? 0);
        shoot(_origin, _direction, i, options);
      }
    },

    fireForward(count = 1, options = {}) {
      cameraBasis();
      for (let i = 0; i < count; i++) {
        // Roughly where a rifle barrel sits relative to the eye.
        _muzzle
          .copy(ctx.camera.position)
          .addScaledVector(_right, 0.16)
          .addScaledVector(_up, -0.12)
          .addScaledVector(_forward, 0.62);
        _direction.copy(_forward);
        scatter(_direction, options.spread ?? 0);
        shoot(_muzzle, _direction, i, options);
      }
    },

    impact(point, normal, surface) {
      _point.set(point[0], point[1], point[2]);
      _normal.set(normal[0], normal[1], normal[2]).normalize();
      _direction.copy(_normal).negate();
      ctx.events.emit('weapon:impact', {
        point: _point.clone(),
        normal: _normal.clone(),
        distance: 10,
        surface,
        actorId: null,
        hitbox: null,
        direction: _direction.clone(),
        penetrationDepth: 0,
      });
    },

    surfaceRow(origin, step = 1.2) {
      for (let i = 0; i < SURFACES.length; i++) {
        api.impact([origin[0] + i * step, origin[1], origin[2]], [0, 1, 0], SURFACES[i]!);
      }
    },

    surfaceRowForward(distance = 4, step = 0.7) {
      cameraBasis();
      // Drop onto whatever the camera is looking at, then fan across its right.
      _origin.copy(ctx.camera.position).addScaledVector(_forward, distance);
      _origin.y += 2;
      const hit = ctx.physics.ready
        ? ctx.physics.raycast({
            origin: _origin,
            direction: _down,
            maxDistance: 12,
            groups: CollisionGroup.World,
          })
        : null;
      const base = hit ? hit.point : _origin.clone().setY(0.02);
      const start = base.clone().addScaledVector(_right, (-step * (SURFACES.length - 1)) / 2);
      for (let i = 0; i < SURFACES.length; i++) {
        _point.copy(start).addScaledVector(_right, i * step);
        api.impact([_point.x, _point.y + 0.02, _point.z], [0, 1, 0], SURFACES[i]!);
      }
    },

    footstep(point, surface = 'concrete') {
      ctx.events.emit('player:footstep', {
        position: new THREE.Vector3(point[0], point[1], point[2]),
        surface,
        running: true,
      });
    },

    reset() {
      shotIndex = 0;
      ctx.events.emit('game:restart');
    },

    lastImpact: () =>
      lastHit
        ? {
            point: lastHit.point.toArray() as [number, number, number],
            normal: lastHit.normal.toArray() as [number, number, number],
            surface: lastHit.surface,
            actorId: lastHit.actorId,
            distance: lastHit.distance,
            fromPhysics: lastFromPhysics,
          }
        : null,

    counts,
  };

  window.__vfxDebug = api;
  return true;
}
