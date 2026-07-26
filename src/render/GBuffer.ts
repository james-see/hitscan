import * as THREE from 'three';
import type { GBuffer } from '@/types/render.ts';

/**
 * Thin G-buffer written by the depth prepass.
 *
 * Deliberately thin: this is a forward-clustered renderer, so the G-buffer
 * exists only to feed screen-space effects, not to shade from. Two colour
 * attachments plus depth is enough for AO, SSR, TAA and motion blur.
 *
 *   attachment 0 - RGBA16F : view-space normal (rgb), roughness (a)
 *   attachment 1 - RG16F   : screen-space motion vector, in NDC per frame
 */
export class DeferredGBuffer implements GBuffer {
  readonly target: THREE.WebGLRenderTarget;
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    this.target = new THREE.WebGLRenderTarget(this.width, this.height, {
      count: 2,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      // Half float is sufficient for normals and motion, and halves the
      // bandwidth cost versus full float.
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0,
    });

    const [normal, velocity] = this.target.textures;
    if (normal) {
      normal.name = 'gbuffer.normalRoughness';
      normal.format = THREE.RGBAFormat;
    }
    if (velocity) {
      velocity.name = 'gbuffer.velocity';
      velocity.format = THREE.RGFormat;
    }

    // A depth texture rather than a renderbuffer, so effects can sample it.
    const depthTexture = new THREE.DepthTexture(this.width, this.height);
    depthTexture.type = THREE.UnsignedInt248Type;
    depthTexture.format = THREE.DepthStencilFormat;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    depthTexture.name = 'gbuffer.depth';
    this.target.depthTexture = depthTexture;
    this.target.stencilBuffer = true;
  }

  get depth(): THREE.Texture {
    return this.target.depthTexture as THREE.Texture;
  }

  get normalRoughness(): THREE.Texture {
    return this.target.textures[0] as THREE.Texture;
  }

  get velocity(): THREE.Texture {
    return this.target.textures[1] as THREE.Texture;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.setSize(w, h);
  }

  dispose(): void {
    this.target.dispose();
    this.target.depthTexture?.dispose();
  }
}
