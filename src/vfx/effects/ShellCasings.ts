import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';
import { EmitDesc, type ParticleSystem } from '../core/ParticleSystem.ts';

const GRAVITY = -22;
const RESTITUTION = 0.34;
const SETTLE_SPEED = 0.45;
const CASING_RADIUS = 0.0055;

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _delta = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _spin = new THREE.Quaternion();
const _normal = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _restBasis = new THREE.Matrix4();
const _bitangent = new THREE.Vector3();
const _euler = new THREE.Euler();

/**
 * Ejected brass.
 *
 * Simulated directly rather than through Rapier rigid bodies: a casing needs
 * a swept ray per step and a rest pose, not a full contact solver, and 16
 * dynamic bodies would cost more than the rest of the VFX module combined.
 */
export class ShellCasings {
  readonly mesh: THREE.InstancedMesh;

  #capacity: number;
  #px: Float32Array;
  #py: Float32Array;
  #pz: Float32Array;
  #vx: Float32Array;
  #vy: Float32Array;
  #vz: Float32Array;
  #qx: Float32Array;
  #qy: Float32Array;
  #qz: Float32Array;
  #qw: Float32Array;
  #wx: Float32Array;
  #wy: Float32Array;
  #wz: Float32Array;
  #age: Float32Array;
  #active: Uint8Array;
  #settled: Uint8Array;
  #cursor = 0;

  #life: number;
  #fadeOut = 0.45;
  #rng: Rng;
  #particles: ParticleSystem;
  #glint: number;
  #desc = new EmitDesc();

  constructor(rng: Rng, particles: ParticleSystem, capacity = 18, life = 7) {
    this.#rng = rng;
    this.#particles = particles;
    this.#glint = particles.id('shell.glint');
    this.#capacity = capacity;
    this.#life = life;

    const n = capacity;
    this.#px = new Float32Array(n);
    this.#py = new Float32Array(n);
    this.#pz = new Float32Array(n);
    this.#vx = new Float32Array(n);
    this.#vy = new Float32Array(n);
    this.#vz = new Float32Array(n);
    this.#qx = new Float32Array(n);
    this.#qy = new Float32Array(n);
    this.#qz = new Float32Array(n);
    this.#qw = new Float32Array(n);
    this.#wx = new Float32Array(n);
    this.#wy = new Float32Array(n);
    this.#wz = new Float32Array(n);
    this.#age = new Float32Array(n);
    this.#active = new Uint8Array(n);
    this.#settled = new Uint8Array(n);

    const geometry = new THREE.CylinderGeometry(
      CASING_RADIUS,
      CASING_RADIUS * 0.92,
      0.0235,
      9,
      1,
      false
    );
    const material = new THREE.MeshStandardMaterial({
      color: 0xb08a45,
      metalness: 1,
      roughness: 0.31,
      envMapIntensity: 1.1,
    });
    material.name = 'vfx.shell';

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = 'vfx.shells';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = (): void => {};

    _scale.set(0, 0, 0);
    _matrix.compose(_position.set(0, -1000, 0), _quaternion.identity(), _scale);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get material(): THREE.Material {
    return this.mesh.material as THREE.Material;
  }

  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.#capacity; i++) n += this.#active[i]!;
    return n;
  }

  eject(position: THREE.Vector3, velocity: THREE.Vector3): void {
    const i = this.#cursor % this.#capacity;
    this.#cursor++;
    const rng = this.#rng;

    this.#px[i] = position.x;
    this.#py[i] = position.y;
    this.#pz[i] = position.z;
    this.#vx[i] = velocity.x + rng.gaussian(0, 0.22);
    this.#vy[i] = velocity.y + rng.gaussian(0, 0.18);
    this.#vz[i] = velocity.z + rng.gaussian(0, 0.22);

    _euler.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28));
    _quaternion.setFromEuler(_euler);
    this.#qx[i] = _quaternion.x;
    this.#qy[i] = _quaternion.y;
    this.#qz[i] = _quaternion.z;
    this.#qw[i] = _quaternion.w;
    this.#wx[i] = rng.range(-26, 26);
    this.#wy[i] = rng.range(-14, 14);
    this.#wz[i] = rng.range(-26, 26);

    this.#age[i] = 0;
    this.#active[i] = 1;
    this.#settled[i] = 0;
  }

  fixedUpdate(dt: number, physics: PhysicsWorld): void {
    for (let i = 0; i < this.#capacity; i++) {
      if (this.#active[i] === 0) continue;
      const age = this.#age[i]! + dt;
      this.#age[i] = age;
      if (age >= this.#life) {
        this.#active[i] = 0;
        continue;
      }
      if (this.#settled[i] === 1) continue;

      let vx = this.#vx[i]!;
      let vy = this.#vy[i]! + GRAVITY * dt;
      let vz = this.#vz[i]!;

      _delta.set(vx * dt, vy * dt, vz * dt);
      const distance = _delta.length();

      if (distance > 1e-6) {
        _position.set(this.#px[i]!, this.#py[i]!, this.#pz[i]!);
        _direction.copy(_delta).divideScalar(distance);
        const hit = physics.ready
          ? physics.raycast({
              origin: _position,
              direction: _direction,
              maxDistance: distance + CASING_RADIUS,
              groups: CollisionGroup.World,
            })
          : null;

        if (hit) {
          _normal.copy(hit.normal);
          if (_normal.dot(_direction) > 0) _normal.negate();
          this.#px[i] = hit.point.x + _normal.x * CASING_RADIUS * 1.2;
          this.#py[i] = hit.point.y + _normal.y * CASING_RADIUS * 1.2;
          this.#pz[i] = hit.point.z + _normal.z * CASING_RADIUS * 1.2;

          const along = vx * _normal.x + vy * _normal.y + vz * _normal.z;
          vx -= _normal.x * (1 + RESTITUTION) * along;
          vy -= _normal.y * (1 + RESTITUTION) * along;
          vz -= _normal.z * (1 + RESTITUTION) * along;
          // Brass loses most of its energy on the first bounce and skitters.
          vx *= 0.68;
          vy *= 0.68;
          vz *= 0.68;
          this.#wx[i] = this.#wx[i]! * 0.55 + this.#rng.range(-6, 6);
          this.#wy[i] = this.#wy[i]! * 0.55;
          this.#wz[i] = this.#wz[i]! * 0.55 + this.#rng.range(-6, 6);

          const speed = Math.hypot(vx, vy, vz);
          if (speed > 1.1) this.#sparkle(i);
          if (speed < SETTLE_SPEED && _normal.y > 0.55) {
            this.#settle(i, _normal);
            continue;
          }
        } else {
          this.#px[i] = this.#px[i]! + _delta.x;
          this.#py[i] = this.#py[i]! + _delta.y;
          this.#pz[i] = this.#pz[i]! + _delta.z;
        }
      }

      this.#vx[i] = vx;
      this.#vy[i] = vy;
      this.#vz[i] = vz;

      const wx = this.#wx[i]!;
      const wy = this.#wy[i]!;
      const wz = this.#wz[i]!;
      const omega = Math.hypot(wx, wy, wz);
      if (omega > 1e-4) {
        const angle = omega * dt;
        _direction.set(wx / omega, wy / omega, wz / omega);
        _spin.setFromAxisAngle(_direction, angle);
        _quaternion.set(this.#qx[i]!, this.#qy[i]!, this.#qz[i]!, this.#qw[i]!);
        _quaternion.premultiply(_spin).normalize();
        this.#qx[i] = _quaternion.x;
        this.#qy[i] = _quaternion.y;
        this.#qz[i] = _quaternion.z;
        this.#qw[i] = _quaternion.w;
      }
    }
  }

  /** Writes instance transforms. Cheap enough to run every rendered frame. */
  update(): void {
    let dirty = false;
    for (let i = 0; i < this.#capacity; i++) {
      if (this.#active[i] === 0) {
        _scale.set(0, 0, 0);
        _matrix.compose(_position.set(0, -1000, 0), _quaternion.identity(), _scale);
        this.mesh.setMatrixAt(i, _matrix);
        dirty = true;
        continue;
      }
      const age = this.#age[i]!;
      // Shrink out rather than vanish: a casing that blinks off in the
      // player's peripheral vision is more distracting than one that sinks.
      const remaining = this.#life - age;
      const s = remaining < this.#fadeOut ? Math.max(0, remaining / this.#fadeOut) : 1;
      _position.set(this.#px[i]!, this.#py[i]!, this.#pz[i]!);
      _quaternion.set(this.#qx[i]!, this.#qy[i]!, this.#qz[i]!, this.#qw[i]!);
      _scale.set(s, s, s);
      _matrix.compose(_position, _quaternion, _scale);
      this.mesh.setMatrixAt(i, _matrix);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.#active.fill(0);
    this.update();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }

  /** Lays the casing flat on the surface it came to rest against. */
  #settle(i: number, normal: THREE.Vector3): void {
    this.#settled[i] = 1;
    this.#vx[i] = 0;
    this.#vy[i] = 0;
    this.#vz[i] = 0;
    this.#wx[i] = 0;
    this.#wy[i] = 0;
    this.#wz[i] = 0;

    // The cylinder's axis is local Y, so resting means aligning local Y with
    // a tangent of the surface and local X or Z with the normal.
    if (Math.abs(normal.y) < 0.985) _tangent.set(0, 1, 0);
    else _tangent.set(1, 0, 0);
    _tangent.crossVectors(_tangent, normal).normalize();
    const roll = this.#rng.range(0, Math.PI * 2);
    _bitangent.crossVectors(normal, _tangent).normalize();
    _tangent.multiplyScalar(Math.cos(roll)).addScaledVector(_bitangent, Math.sin(roll)).normalize();
    _bitangent.crossVectors(normal, _tangent).normalize();
    _restBasis.makeBasis(_bitangent, _tangent, normal);
    _quaternion.setFromRotationMatrix(_restBasis);
    this.#qx[i] = _quaternion.x;
    this.#qy[i] = _quaternion.y;
    this.#qz[i] = _quaternion.z;
    this.#qw[i] = _quaternion.w;
    this.#py[i] = this.#py[i]! + CASING_RADIUS * 0.2;
  }

  #sparkle(i: number): void {
    if (!this.#rng.chance(0.5)) return;
    const desc = this.#desc;
    desc.reset(this.#glint, 1);
    desc.position.set(this.#px[i]!, this.#py[i]!, this.#pz[i]!);
    desc.direction.set(0, 1, 0);
    desc.spread = Math.PI;
    desc.speed = 0.6;
    desc.speedSpread = 0.6;
    this.#particles.emit(desc);
  }
}
