import * as THREE from 'three';

export interface CubeLut {
  texture: THREE.Data3DTexture;
  size: number;
  title: string;
  domainMin: THREE.Vector3;
  domainMax: THREE.Vector3;
}

/**
 * Parser for Adobe/IRIDAS `.cube` 3D lookup tables.
 *
 * Only the 3D form is accepted. A 1D LUT cannot express a hue rotation or a
 * channel cross-talk, which is most of what a colourist actually delivers, so
 * silently accepting one would produce a grade that does not match the
 * reference.
 *
 * The data lands in a `Data3DTexture` with linear filtering, which gives
 * hardware trilinear interpolation for free. Tetrahedral interpolation is
 * marginally more accurate on steep gradients but has to be done in the
 * shader, and at 33^3 the difference is below the noise floor of the grain
 * pass that follows.
 */
export function parseCubeLut(source: string): CubeLut {
  let size = 0;
  let title = '';
  const domainMin = new THREE.Vector3(0, 0, 0);
  const domainMax = new THREE.Vector3(1, 1, 1);
  const values: number[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    if (line.startsWith('TITLE')) {
      title = line.slice(5).trim().replace(/^"|"$/g, '');
      continue;
    }
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number.parseInt(line.slice(11).trim(), 10);
      continue;
    }
    if (line.startsWith('LUT_1D_SIZE')) {
      throw new Error('[post] 1D .cube LUTs are not supported; export a 3D LUT');
    }
    if (line.startsWith('DOMAIN_MIN')) {
      const parts = line.slice(10).trim().split(/\s+/).map(Number);
      domainMin.set(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
      continue;
    }
    if (line.startsWith('DOMAIN_MAX')) {
      const parts = line.slice(10).trim().split(/\s+/).map(Number);
      domainMax.set(parts[0] ?? 1, parts[1] ?? 1, parts[2] ?? 1);
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const r = Number.parseFloat(parts[0] as string);
    const g = Number.parseFloat(parts[1] as string);
    const b = Number.parseFloat(parts[2] as string);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) continue;
    values.push(r, g, b);
  }

  if (size <= 1) throw new Error('[post] .cube is missing a valid LUT_3D_SIZE');
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new Error(
      `[post] .cube has ${values.length / 3} entries, expected ${expected / 3} for size ${size}`
    );
  }

  // Half float halves the upload and is well beyond 8-bit display precision.
  const data = new Uint16Array(size * size * size * 4);
  for (let i = 0, texel = 0; i < values.length; i += 3, texel += 4) {
    data[texel] = THREE.DataUtils.toHalfFloat(values[i] as number);
    data[texel + 1] = THREE.DataUtils.toHalfFloat(values[i + 1] as number);
    data[texel + 2] = THREE.DataUtils.toHalfFloat(values[i + 2] as number);
    data[texel + 3] = THREE.DataUtils.toHalfFloat(1);
  }

  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.name = title.length > 0 ? title : 'lut';
  texture.needsUpdate = true;

  return { texture, size, title, domainMin, domainMax };
}

export async function loadCubeLut(url: string): Promise<CubeLut> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[post] failed to load LUT ${url}: ${response.status}`);
  return parseCubeLut(await response.text());
}
