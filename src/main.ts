import { Engine } from '@/engine/Engine.ts';
import { RapierPhysics } from '@/engine/Physics.ts';
import { Resources } from '@/engine/Resources.ts';
import { ForwardPipeline } from '@/render/Pipeline.ts';
import { CaptureBridge, parseCaptureParams } from '@/engine/CaptureBridge.ts';
import { RenderModule } from '@/render/RenderModule.ts';
import { PostModule } from '@/render/post/PostModule.ts';
import { WorldModule } from '@/world/WorldModule.ts';
import { PlayerModule } from '@/player/PlayerModule.ts';
import { WeaponModule } from '@/weapon/WeaponModule.ts';
import { AiModule } from '@/ai/AiModule.ts';
import { VfxModule } from '@/vfx/VfxModule.ts';
import { AudioModule } from '@/audio/AudioModule.ts';
import { UiModule } from '@/ui/UiModule.ts';

/**
 * Resolves once a frame has actually been presented.
 *
 * Booting and compiling shaders both finish before the compositor has drawn
 * anything, so signalling readiness at that point lets a screenshot catch the
 * loading screen. The second callback only runs after the first frame has
 * been committed, which is the earliest moment the canvas is guaranteed to
 * show the scene.
 */
function nextPresentedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Module ordering.
 *
 * Fixed and per-frame updates run in this sequence, so anything that reads
 * player state must sort after the player module.
 */
const ORDER = {
  render: -100,
  world: -50,
  player: 0,
  weapon: 10,
  ai: 20,
  vfx: 30,
  audio: 40,
  ui: 50,
  post: 100,
} as const;

function setStatus(text: string): void {
  const el = document.getElementById('loader-status');
  if (el) el.textContent = text;
}

function setProgress(fraction: number): void {
  const el = document.getElementById('bar-fill');
  if (el) el.style.width = `${Math.round(fraction * 100)}%`;
}

function showError(err: unknown): void {
  const box = document.getElementById('error');
  const text = document.getElementById('error-text');
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  if (text) text.textContent = message;
  box?.classList.add('visible');
  console.error(err);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('viewport canvas missing');

  const params = parseCaptureParams();

  const engine = new Engine({
    canvas,
    fixedHz: 120,
    seed: params.seed ?? 0x5eed,
    capture: params.capture,
  });
  engine.settings.load();

  const bridge = new CaptureBridge(engine);

  setStatus('Starting physics');
  const physics = new RapierPhysics();
  await physics.init();

  setStatus('Building pipeline');
  const pipeline = new ForwardPipeline(
    engine.renderer,
    Math.floor(window.innerWidth * Math.min(window.devicePixelRatio, 2)),
    Math.floor(window.innerHeight * Math.min(window.devicePixelRatio, 2))
  );

  const resources = new Resources(engine.renderer);
  engine.setServices({ pipeline, physics, resources });

  setStatus('Loading assets');
  await resources.preload((p) => {
    setProgress(p.total > 0 ? p.loaded / p.total : 1);
    setStatus(`Loading ${p.current}`);
  });

  engine
    .add(new RenderModule(ORDER.render))
    .add(new WorldModule(ORDER.world, bridge))
    .add(new PlayerModule(ORDER.player))
    .add(new WeaponModule(ORDER.weapon))
    .add(new AiModule(ORDER.ai))
    .add(new VfxModule(ORDER.vfx))
    .add(new AudioModule(ORDER.audio))
    .add(new UiModule(ORDER.ui))
    .add(new PostModule(ORDER.post));

  setStatus('Compiling shaders');
  setProgress(0.96);
  await engine.boot();

  // Warm the shader cache before the player sees anything; a hitch on the
  // first shot or first enemy is far more noticeable than a longer load.
  engine.renderer.compile(engine.scene, engine.camera);
  setProgress(1);

  if (import.meta.env.DEV) {
    (window as unknown as { engine: Engine }).engine = engine;
  }

  const loader = document.getElementById('loader');
  loader?.classList.add('hidden');

  if (params.capture) {
    // Remove the loader outright rather than fading it: a capture can happen
    // mid-transition and would otherwise photograph the title card.
    loader?.remove();
    if (!params.hud) window.__hitscan?.setHud(false);
    await nextPresentedFrame();
    bridge.markReady();
    return;
  }

  await nextPresentedFrame();
  bridge.markReady();

  const prompt = document.getElementById('start-prompt');
  prompt?.classList.add('visible');
  const deploy = (): void => {
    engine.input.requestPointerLock();
  };
  prompt?.addEventListener('click', deploy);
  engine.events.on('engine:pointer-lock', ({ locked }) => {
    prompt?.classList.toggle('visible', !locked);
  });
}

main().catch(showError);
