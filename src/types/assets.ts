/**
 * Asset pipeline contracts.
 *
 * The offline tooling in `tools/assets/` writes a manifest matching these
 * shapes; the runtime `ResourceManager` consumes it.
 */

import type * as THREE from 'three';

export type TextureChannel = 'albedo' | 'normal' | 'orm' | 'emissive' | 'height';

/**
 * A physically-based material set. `orm` packs occlusion (R), roughness (G)
 * and metalness (B) into one texture, which is the standard glTF layout and
 * saves two samplers per material.
 */
export interface MaterialAsset {
  id: string;
  /** Path relative to `public/`, KTX2-compressed. */
  albedo: string;
  normal: string;
  orm: string;
  emissive?: string;
  height?: string;
  /** World-space size of one texture repeat, in metres. */
  tileScale: number;
  /** Source name and licence, recorded for provenance. */
  source: AssetProvenance;
}

export interface ModelAsset {
  id: string;
  /** Path relative to `public/`, glTF with meshopt + KTX2. */
  url: string;
  /** Screen-space-error thresholds for each LOD, descending. */
  lodDistances?: number[];
  source: AssetProvenance;
}

export interface AudioAsset {
  id: string;
  url: string;
  /** Decoded eagerly at load rather than streamed. */
  preload: boolean;
  /** Base gain applied on playback, in [0,1]. */
  gain: number;
  source: AssetProvenance;
}

export interface EnvironmentAsset {
  id: string;
  /** Equirectangular HDR, used for both skybox and IBL. */
  url: string;
  /** Multiplier applied to the HDR before PMREM filtering. */
  intensity: number;
  source: AssetProvenance;
}

export interface AssetProvenance {
  name: string;
  author: string;
  /** SPDX identifier where one applies, e.g. `CC0-1.0`. */
  license: string;
  url: string;
}

/** Root manifest, written to `public/assets/manifest.json`. */
export interface AssetManifest {
  version: number;
  generatedAt: string;
  materials: MaterialAsset[];
  models: ModelAsset[];
  audio: AudioAsset[];
  environments: EnvironmentAsset[];
}

export interface LoadProgress {
  loaded: number;
  total: number;
  /** Identifier of the asset that just completed. */
  current: string;
}

export interface ResourceManager {
  readonly manifest: AssetManifest;

  /** Loads the manifest and every asset marked for preload. */
  preload(onProgress?: (p: LoadProgress) => void): Promise<void>;

  /** Returns a ready-to-use PBR material. Cached by id. */
  getMaterial(id: string): THREE.MeshPhysicalMaterial;
  /** Returns a cloned scene graph for the model. Cached and instanced. */
  getModel(id: string): THREE.Group;
  /** Returns the decoded audio buffer, or null if not yet loaded. */
  getAudio(id: string): AudioBuffer | null;
  /** Returns the PMREM-filtered environment for image-based lighting. */
  getEnvironment(id: string): THREE.Texture;

  /** Loads a single texture on demand, outside the manifest. */
  loadTexture(url: string, srgb?: boolean): Promise<THREE.Texture>;

  dispose(): void;
}
