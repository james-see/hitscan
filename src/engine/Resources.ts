import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type {
  AssetManifest,
  LoadProgress,
  MaterialAsset,
  ResourceManager,
} from '@/types/assets.ts';

const EMPTY_MANIFEST: AssetManifest = {
  version: 0,
  generatedAt: '',
  materials: [],
  models: [],
  audio: [],
  environments: [],
};

/**
 * Loads and caches every runtime asset.
 *
 * Textures are KTX2 (transcoded on the GPU's native format) and models are
 * meshopt-compressed glTF, both produced by `tools/assets`. Missing assets
 * resolve to a magenta checker rather than throwing, so a partially built
 * asset set still boots.
 */
export class Resources implements ResourceManager {
  manifest: AssetManifest = EMPTY_MANIFEST;

  #renderer: THREE.WebGLRenderer;
  #gltf: GLTFLoader;
  #ktx2: KTX2Loader;
  #rgbe = new RGBELoader();
  #pmrem: THREE.PMREMGenerator;
  #audioContext: AudioContext | null = null;

  #materials = new Map<string, THREE.MeshPhysicalMaterial>();
  #models = new Map<string, THREE.Group>();
  #audio = new Map<string, AudioBuffer>();
  #environments = new Map<string, THREE.Texture>();
  #textures = new Map<string, Promise<THREE.Texture>>();
  #fallback: THREE.Texture | null = null;
  #anisotropy: number;

  constructor(renderer: THREE.WebGLRenderer, audioContext?: AudioContext) {
    this.#renderer = renderer;
    this.#audioContext = audioContext ?? null;
    this.#anisotropy = renderer.capabilities.getMaxAnisotropy();

    this.#ktx2 = new KTX2Loader()
      .setTranscoderPath('/basis/')
      .detectSupport(renderer);

    this.#gltf = new GLTFLoader();
    this.#gltf.setKTX2Loader(this.#ktx2);
    this.#gltf.setMeshoptDecoder(MeshoptDecoder);

    this.#pmrem = new THREE.PMREMGenerator(renderer);
    this.#pmrem.compileEquirectangularShader();
  }

  async preload(onProgress?: (p: LoadProgress) => void): Promise<void> {
    try {
      const res = await fetch('/assets/manifest.json');
      if (res.ok) this.manifest = (await res.json()) as AssetManifest;
    } catch {
      console.warn('[Resources] no asset manifest found; running with fallbacks');
      return;
    }

    const jobs: Array<{ id: string; run: () => Promise<void> }> = [];

    for (const env of this.manifest.environments) {
      jobs.push({
        id: env.id,
        run: async () => {
          const texture = await this.#rgbe.loadAsync(env.url);
          texture.mapping = THREE.EquirectangularReflectionMapping;
          const target = this.#pmrem.fromEquirectangular(texture);
          texture.dispose();
          this.#environments.set(env.id, target.texture);
        },
      });
    }

    for (const material of this.manifest.materials) {
      jobs.push({
        id: material.id,
        run: async () => {
          this.#materials.set(material.id, await this.#buildMaterial(material));
        },
      });
    }

    for (const model of this.manifest.models) {
      jobs.push({
        id: model.id,
        run: async () => {
          const gltf = await this.#gltf.loadAsync(model.url);
          this.#models.set(model.id, gltf.scene);
        },
      });
    }

    for (const clip of this.manifest.audio.filter((a) => a.preload)) {
      jobs.push({
        id: clip.id,
        run: async () => {
          const ctx = this.#ensureAudioContext();
          if (!ctx) return;
          const res = await fetch(clip.url);
          const buffer = await res.arrayBuffer();
          this.#audio.set(clip.id, await ctx.decodeAudioData(buffer));
        },
      });
    }

    let loaded = 0;
    const total = jobs.length;
    // Bounded concurrency: enough to saturate the connection without
    // starving the main thread with simultaneous GPU uploads.
    const CONCURRENCY = 8;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        if (!job) break;
        try {
          await job.run();
        } catch (err) {
          console.error(`[Resources] failed to load "${job.id}":`, err);
        }
        loaded++;
        onProgress?.({ loaded, total, current: job.id });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  }

  async #buildMaterial(asset: MaterialAsset): Promise<THREE.MeshPhysicalMaterial> {
    const [albedo, normal, orm, emissive] = await Promise.all([
      this.loadTexture(asset.albedo, true),
      this.loadTexture(asset.normal, false),
      this.loadTexture(asset.orm, false),
      asset.emissive ? this.loadTexture(asset.emissive, true) : Promise.resolve(null),
    ]);

    for (const t of [albedo, normal, orm, emissive]) {
      if (!t) continue;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this.#anisotropy;
    }

    const material = new THREE.MeshPhysicalMaterial({
      map: albedo,
      normalMap: normal,
      // A single ORM texture feeds all three channels; three.js samples the
      // correct channel per slot automatically.
      aoMap: orm,
      roughnessMap: orm,
      metalnessMap: orm,
      emissiveMap: emissive ?? undefined,
      emissive: emissive ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
      roughness: 1,
      metalness: 1,
      envMapIntensity: 1,
    });
    material.name = asset.id;
    return material;
  }

  getMaterial(id: string): THREE.MeshPhysicalMaterial {
    const existing = this.#materials.get(id);
    if (existing) return existing;
    const fallback = new THREE.MeshPhysicalMaterial({
      map: this.#getFallbackTexture(),
      roughness: 0.8,
      metalness: 0,
    });
    fallback.name = `${id}:missing`;
    this.#materials.set(id, fallback);
    return fallback;
  }

  getModel(id: string): THREE.Group {
    const source = this.#models.get(id);
    if (!source) {
      console.warn(`[Resources] missing model "${id}"`);
      return new THREE.Group();
    }
    return source.clone(true);
  }

  getAudio(id: string): AudioBuffer | null {
    return this.#audio.get(id) ?? null;
  }

  getEnvironment(id: string): THREE.Texture {
    const env = this.#environments.get(id);
    if (env) return env;
    // A neutral grey environment is a better failure mode than a black scene.
    const target = this.#pmrem.fromScene(new THREE.Scene());
    this.#environments.set(id, target.texture);
    return target.texture;
  }

  loadTexture(url: string, srgb = false): Promise<THREE.Texture> {
    const key = `${url}|${srgb}`;
    const cached = this.#textures.get(key);
    if (cached) return cached;

    const promise = new Promise<THREE.Texture>((resolve) => {
      const onLoad = (texture: THREE.Texture): void => {
        texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.anisotropy = this.#anisotropy;
        texture.needsUpdate = true;
        resolve(texture);
      };
      const onError = (): void => {
        console.warn(`[Resources] missing texture "${url}"`);
        resolve(this.#getFallbackTexture());
      };
      if (url.endsWith('.ktx2')) {
        this.#ktx2.load(url, onLoad, undefined, onError);
      } else {
        new THREE.TextureLoader().load(url, onLoad, undefined, onError);
      }
    });

    this.#textures.set(key, promise);
    return promise;
  }

  #getFallbackTexture(): THREE.Texture {
    if (this.#fallback) return this.#fallback;
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const check = ((x >> 3) + (y >> 3)) % 2 === 0;
        data[i] = check ? 255 : 32;
        data[i + 1] = check ? 0 : 32;
        data[i + 2] = check ? 255 : 32;
        data[i + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    this.#fallback = texture;
    return texture;
  }

  #ensureAudioContext(): AudioContext | null {
    if (!this.#audioContext) {
      try {
        this.#audioContext = new AudioContext();
      } catch {
        return null;
      }
    }
    return this.#audioContext;
  }

  dispose(): void {
    for (const m of this.#materials.values()) m.dispose();
    for (const e of this.#environments.values()) e.dispose();
    this.#materials.clear();
    this.#models.clear();
    this.#audio.clear();
    this.#environments.clear();
    this.#textures.clear();
    this.#fallback?.dispose();
    this.#pmrem.dispose();
    this.#ktx2.dispose();
  }
}
