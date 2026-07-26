import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { DamageInfo, HitResult, SurfaceKind } from '@/types/gameplay.ts';
import type { Rng } from '@/types/rng.ts';
import type { Unsubscribe } from '@/types/events.ts';
import { EmitDesc, ParticleSystem } from './core/ParticleSystem.ts';
import { SceneDepth, type DepthSourceMode } from './core/SceneDepth.ts';
import { DecalSystem } from './effects/DecalSystem.ts';
import { LightPool } from './effects/LightPool.ts';
import { MuzzleFlash } from './effects/MuzzleFlash.ts';
import { ImpactEffects } from './effects/ImpactEffects.ts';
import { TracerSystem } from './effects/TracerSystem.ts';
import { ShellCasings } from './effects/ShellCasings.ts';
import { installDebugDriver } from './debug/DebugDriver.ts';

/** Fallback sun direction, matching the render module's late-afternoon key. */
const DEFAULT_SUN = new THREE.Vector3(-0.42, 0.55, -0.72).normalize();

interface RenderModuleView extends GameModule {
  readonly sunDirection?: THREE.Vector3;
  readonly sun?: THREE.DirectionalLight;
  syncShadowMaterials?(): void;
}

const FOOTSTEP_TYPE: Partial<Record<SurfaceKind, string>> = {
  dirt: 'dirt.plume',
  sand: 'sand.plume',
  water: 'water.mist',
  foliage: 'foliage.leaf',
};

const _groundPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _sunDirection = new THREE.Vector3().copy(DEFAULT_SUN);
const _sunColor = new THREE.Color(1.55, 1.42, 1.18);
const _skyColor = new THREE.Color(0.2, 0.26, 0.36);
const _groundColor = new THREE.Color(0.13, 0.11, 0.09);

/** Owns particles, decals, tracers, shell casings and impact effects. */
export class VfxModule implements GameModule {
  readonly name = 'vfx';
  readonly order: number;

  #root = new THREE.Group();
  #particles!: ParticleSystem;
  #depth!: SceneDepth;
  #decals!: DecalSystem;
  #lights!: LightPool;
  #muzzle!: MuzzleFlash;
  #impacts!: ImpactEffects;
  #tracers!: TracerSystem;
  #shells!: ShellCasings;
  #rng!: Rng;
  #effectRng!: Rng;
  #desc = new EmitDesc();
  #unsubscribe: Unsubscribe[] = [];
  #scene: THREE.Scene | null = null;
  #footstepTypes = new Map<string, number>();
  /** Last recorded hit point per actor, used to place death effects. */
  #lastHit = new Map<string, THREE.Vector3>();
  #bloodMist = 0;
  #bloodDroplet = 0;
  #deathDust = 0;
  #footstepDefault = 0;

  constructor(order = 30) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    this.#scene = ctx.scene;
    this.#rng = ctx.rng.fork('vfx');
    this.#effectRng = this.#rng.fork('effects');
    this.#root.name = 'vfx';
    this.#root.matrixAutoUpdate = false;
    ctx.scene.add(this.#root);

    const budget = Math.min(ctx.settings.maxParticles || 12000, 20000);
    this.#particles = new ParticleSystem(this.#rng, budget);
    this.#root.add(this.#particles.root);

    this.#depth = new SceneDepth(readDepthPreference());
    this.#decals = new DecalSystem(this.#rng.fork('decals'), ctx.settings.maxDecals || 256);
    this.#root.add(this.#decals.mesh);

    this.#lights = new LightPool(this.#root, 5, this.#rng.fork('lights'));
    this.#shells = new ShellCasings(this.#rng.fork('shells'), this.#particles);
    this.#root.add(this.#shells.mesh);

    this.#muzzle = new MuzzleFlash(this.#particles, this.#lights, this.#effectRng);
    this.#impacts = new ImpactEffects(this.#particles, this.#lights, this.#effectRng);
    this.#tracers = new TracerSystem(this.#particles, this.#effectRng);

    this.#bloodMist = this.#particles.id('blood.mist');
    this.#bloodDroplet = this.#particles.id('blood.droplet');
    this.#deathDust = this.#particles.id('death.dust');
    this.#footstepDefault = this.#particles.id('footstep.dust');
    for (const [surface, id] of Object.entries(FOOTSTEP_TYPE)) {
      this.#footstepTypes.set(surface, this.#particles.id(id));
    }

    this.#readLighting(ctx);
    this.#particles.setCameraPlanes(ctx.camera.near, ctx.camera.far);
    this.#subscribe(ctx);

    // Shell casings use a standard material, which has to be patched for the
    // shadow cascades or it renders lit by every cascade light at once.
    const render = ctx.getModule<RenderModuleView>('render');
    render?.syncShadowMaterials?.();

    installDebugDriver(ctx, () => ({
      particles: this.#particles.liveCount,
      alpha: this.#particles.alpha.liveCount,
      additive: this.#particles.additive.liveCount,
      decalsPlaced: this.#decals.stats.placed,
      decalsNoTarget: this.#decals.stats.noTarget,
      decalsNoClip: this.#decals.stats.noClip,
      shells: this.#shells.liveCount,
      depthMode: this.#depth.mode,
    }));
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    if (dt <= 0) return;
    this.#particles.simulate(dt);
    this.#shells.fixedUpdate(dt, ctx.physics);
    this.#lights.update(dt);
  }

  lateUpdate(_dt: number, ctx: EngineContext): void {
    // A shot that never reported an impact still deserves its tracer.
    this.#tracers.flush();

    this.#shells.update();
    this.#decals.setTime(ctx.time.elapsed);
    this.#particles.setCameraPlanes(ctx.camera.near, ctx.camera.far);

    this.#depth.update(ctx, this.#root, this.#particles.liveCount > 0);
    this.#particles.setSceneDepth(this.#depth.texture, this.#depth.mode);
    this.#particles.write(ctx.camera);
  }

  dispose(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe.length = 0;
    this.#particles.dispose();
    this.#decals.dispose();
    this.#shells.dispose();
    this.#lights.dispose();
    this.#depth.dispose();
    this.#root.removeFromParent();
    delete window.__vfxDebug;
  }

  #subscribe(ctx: EngineContext): void {
    const events = ctx.events;
    const push = (off: Unsubscribe): void => {
      this.#unsubscribe.push(off);
    };

    push(
      events.on('weapon:fired', ({ origin, direction, shotIndex, weaponId }) => {
        this.#muzzle.fire(origin, direction, shotIndex);
        this.#tracers.onFired(origin, direction, weaponId);
      })
    );

    push(events.on('weapon:impact', (hit) => this.#onImpact(ctx, hit)));

    push(
      events.on('weapon:shell-ejected', ({ position, velocity }) => {
        this.#shells.eject(position, velocity);
      })
    );

    push(events.on('combat:damage-dealt', (info) => this.#onDamage(info)));

    push(
      events.on('combat:actor-died', ({ actorId }) => {
        // The payload carries no position, so the last place the actor was
        // hit stands in for where the body comes down.
        const last = this.#lastHit.get(actorId);
        if (!last) return;
        _groundPoint.copy(last);
        _groundPoint.y = Math.max(0, _groundPoint.y - 0.9);
        this.spawnDeathDust(_groundPoint);
        this.#lastHit.delete(actorId);
      })
    );

    push(
      events.on('player:footstep', ({ position, surface, running }) => {
        this.#onFootstep(position, surface, running);
      })
    );

    push(events.on('game:restart', () => this.#clear()));
    push(events.on('engine:quality-changed', () => this.#readLighting(ctx)));
  }

  #onImpact(ctx: EngineContext, hit: HitResult): void {
    const distance = ctx.camera.position.distanceTo(hit.point);
    // Trimesh colliders report a triangle normal that can face either way;
    // every effect below assumes it points back at the shooter.
    _hitNormal.copy(hit.normal).normalize();
    if (_hitNormal.dot(hit.direction) > 0) _hitNormal.negate();

    this.#impacts.spawn(hit, distance, _hitNormal);
    this.#tracers.onImpact(hit.distance);

    // Decals only go on static geometry: an actor hit needs a skinned
    // projector, which is the character module's surface to own.
    if (this.#scene && !hit.actorId && this.#impacts.wantsDecal(hit.surface) && distance < 60) {
      this.#decals.place(this.#scene, hit.point, _hitNormal, hit.direction, hit.surface);
    }
  }

  /**
   * Extra spray for headshots and killing blows only. The routine flesh
   * response already came from `weapon:impact`; doubling it here would make
   * every body shot twice as wet as it should be.
   */
  #onDamage(info: DamageInfo): void {
    let record = this.#lastHit.get(info.targetId);
    if (!record) {
      record = new THREE.Vector3();
      this.#lastHit.set(info.targetId, record);
    }
    record.copy(info.point);

    const headshot = info.hitbox === 'head';
    if (!headshot && !info.lethal) return;

    const desc = this.#desc;
    const count = headshot ? 14 : 8;
    desc.reset(this.#bloodMist, count);
    desc.position.copy(info.point);
    desc.direction.copy(info.direction).normalize();
    desc.spread = headshot ? 1.1 : 0.9;
    desc.speed = headshot ? 3.4 : 2.4;
    desc.speedSpread = 0.7;
    desc.radius = 0.03;
    desc.prewarm = 0.03;
    desc.sizeScale = headshot ? 1.3 : 1;
    this.#particles.emit(desc);

    desc.reset(this.#bloodDroplet, headshot ? 20 : 12);
    desc.position.copy(info.point);
    desc.direction.copy(info.direction).normalize();
    desc.spread = 0.85;
    desc.speed = headshot ? 6 : 4.2;
    desc.speedSpread = 0.8;
    this.#particles.emit(desc);
  }

  #onFootstep(position: THREE.Vector3, surface: SurfaceKind, running: boolean): void {
    const type = this.#footstepTypes.get(surface) ?? this.#footstepDefault;
    const desc = this.#desc;
    desc.reset(type, running ? 4 : 2);
    desc.position.copy(position);
    desc.direction.set(0, 1, 0);
    desc.spread = 1.4;
    desc.speed = running ? 0.9 : 0.5;
    desc.speedSpread = 0.7;
    desc.radius = 0.08;
    desc.sizeScale = running ? 1 : 0.7;
    desc.opacityScale = running ? 1 : 0.6;
    desc.prewarm = 0.05;
    desc.groundY = position.y;
    this.#particles.emit(desc);
  }

  /** Collapse dust kicked up where a body falls. */
  spawnDeathDust(position: THREE.Vector3): void {
    const desc = this.#desc;
    desc.reset(this.#deathDust, 7);
    desc.position.copy(position);
    desc.direction.set(0, 1, 0);
    desc.spread = 1.5;
    desc.speed = 0.8;
    desc.speedSpread = 0.7;
    desc.radius = 0.25;
    desc.prewarm = 0.12;
    desc.groundY = position.y;
    this.#particles.emit(desc);
  }

  #clear(): void {
    this.#particles.clear();
    this.#decals.clear();
    this.#shells.clear();
    this.#lights.clear();
  }

  #readLighting(ctx: EngineContext): void {
    const render = ctx.getModule<RenderModuleView>('render');
    const direction = render?.sunDirection;
    _sunDirection.copy(direction ?? DEFAULT_SUN).normalize();
    const sun = render?.sun;
    if (sun) {
      // Visually tuned magnitude, not a derived one. The cascades no longer
      // zero the sun's intensity, so `sun.intensity` is now readable and this
      // ought to track it — but feeding the full photometric value in
      // over-brightens the particles roughly threefold, so the coupling needs
      // doing alongside a retune of the particle shader's expected units.
      _sunColor.copy(sun.color).multiplyScalar(1.15);
    }
    this.#particles.setLighting(_sunDirection, _sunColor, _skyColor, _groundColor);
    this.#decals.setLighting(_sunDirection, 0.38);
  }
}

function readDepthPreference(): DepthSourceMode {
  try {
    const value = new URLSearchParams(window.location.search).get('vfxdepth');
    if (value === 'private' || value === 'gbuffer' || value === 'auto' || value === 'off') {
      return value;
    }
  } catch {
    // No DOM (tests); the default is safe.
  }
  return 'auto';
}
