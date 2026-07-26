import * as THREE from 'three';
import { box, cylinder, dome, limb, mergeAll, normalise, place } from './GeometryKit.ts';

/**
 * A procedurally generated, skinned soldier.
 *
 * No rigged character assets are vendored and none of the CC0 libraries ship
 * a model with a skeleton whose proportions and bone names could be relied on
 * sight-unseen, so the character is built here: primitives assembled in bind
 * pose, auto-skinned to a hand-authored skeleton, and merged into one buffer
 * per material. Every bot then shares that buffer and owns only its skeleton,
 * which is what keeps twelve of them inside the draw-call budget.
 *
 * The silhouette is doing the work. Helmet, plate carrier, backpack and
 * shoulder pads are what make a distant figure read as "soldier" in a
 * fraction of a second; the limbs underneath are deliberately simple.
 */

export const BONE_NAMES = [
  'root',
  'pelvis',
  'spine',
  'chest',
  'neck',
  'head',
  'clavicleR',
  'armR',
  'forearmR',
  'handR',
  'clavicleL',
  'armL',
  'forearmL',
  'handL',
  'thighR',
  'shinR',
  'footR',
  'toeR',
  'thighL',
  'shinL',
  'footL',
  'toeL',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/**
 * Bind pose, in world space with the soldier standing at the origin facing
 * -Z. Arms hang at the sides: an A-pose keeps the auto-skinning unambiguous
 * and the two-bone IK well conditioned in every direction it is asked for.
 */
const BIND: Record<BoneName, { parent: BoneName | null; pos: [number, number, number] }> = {
  root: { parent: null, pos: [0, 0, 0] },
  pelvis: { parent: 'root', pos: [0, 0.94, 0] },
  spine: { parent: 'pelvis', pos: [0, 1.08, 0] },
  chest: { parent: 'spine', pos: [0, 1.24, 0] },
  neck: { parent: 'chest', pos: [0, 1.475, 0] },
  head: { parent: 'neck', pos: [0, 1.555, 0] },

  clavicleR: { parent: 'chest', pos: [0.075, 1.42, 0] },
  armR: { parent: 'clavicleR', pos: [0.185, 1.395, 0] },
  forearmR: { parent: 'armR', pos: [0.185, 1.135, 0] },
  handR: { parent: 'forearmR', pos: [0.185, 0.895, 0] },

  clavicleL: { parent: 'chest', pos: [-0.075, 1.42, 0] },
  armL: { parent: 'clavicleL', pos: [-0.185, 1.395, 0] },
  forearmL: { parent: 'armL', pos: [-0.185, 1.135, 0] },
  handL: { parent: 'forearmL', pos: [-0.185, 0.895, 0] },

  thighR: { parent: 'pelvis', pos: [0.105, 0.9, 0] },
  shinR: { parent: 'thighR', pos: [0.105, 0.475, 0] },
  footR: { parent: 'shinR', pos: [0.105, 0.075, 0] },
  toeR: { parent: 'footR', pos: [0.105, 0.04, -0.135] },

  thighL: { parent: 'pelvis', pos: [-0.105, 0.9, 0] },
  shinL: { parent: 'thighL', pos: [-0.105, 0.475, 0] },
  footL: { parent: 'shinL', pos: [-0.105, 0.075, 0] },
  toeL: { parent: 'footL', pos: [-0.105, 0.04, -0.135] },
};

/** Segment lengths the IK solver needs, derived from the bind pose. */
export const LIMB = {
  thigh: BIND.thighR.pos[1] - BIND.shinR.pos[1],
  shin: BIND.shinR.pos[1] - BIND.footR.pos[1],
  upperArm: BIND.armR.pos[1] - BIND.forearmR.pos[1],
  forearm: BIND.forearmR.pos[1] - BIND.handR.pos[1],
  ankleHeight: BIND.footR.pos[1],
  hipHeight: BIND.pelvis.pos[1],
  hipHalfWidth: BIND.thighR.pos[0],
  shoulderHeight: BIND.armR.pos[1],
} as const;

const PALETTE = {
  fatigue: 0x6d6b52,
  fatigueDark: 0x54523f,
  carrier: 0x3f4436,
  gear: 0x2b2d27,
  helmet: 0x4c5143,
  glass: 0x14161a,
  boot: 0x22221f,
  skin: 0x2f2d2a,
  steel: 0x3a3d40,
  polymer: 0x232520,
} as const;

/** Material slots. Two is the sweet spot: cloth and hard kit shade nothing alike. */
const CLOTH = 0;
const GEAR = 1;

interface Part {
  geometry: THREE.BufferGeometry;
  bone: BoneName;
  slot: number;
  colour: number;
  /**
   * Blends weight into a second bone across a world-Y band, so joints crease
   * instead of shearing. `from` gets none of it, `to` gets all of it.
   */
  blend?: { bone: BoneName; from: number; to: number };
}

export interface SoldierAssets {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  weaponGeometry: THREE.BufferGeometry;
  weaponMaterial: THREE.Material;
  boneInverses: THREE.Matrix4[];
  /** Muzzle position in weapon-local space. */
  muzzle: THREE.Vector3;
  gripRight: THREE.Vector3;
  gripLeft: THREE.Vector3;
  triangles: number;
  dispose(): void;
}

export interface SoldierInstance {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
  weapon: THREE.Mesh;
  bones: Record<BoneName, THREE.Bone>;
  dispose(): void;
}

function buildParts(): Part[] {
  const parts: Part[] = [];
  const add = (
    geometry: THREE.BufferGeometry,
    bone: BoneName,
    slot: number,
    colour: number,
    blend?: Part['blend']
  ): void => {
    parts.push({ geometry, bone, slot, colour, blend });
  };

  // -- head ----------------------------------------------------------------
  add(
    place(box(0.175, 0.2, 0.2, 0.055, 1), { position: [0, 1.645, 0.005] }),
    'head',
    CLOTH,
    PALETTE.skin
  );
  add(
    place(dome(0.128, Math.PI * 0.58, 16, 8), {
      position: [0, 1.648, 0.008],
      scale: [1, 0.95, 1.1],
    }),
    'head',
    GEAR,
    PALETTE.helmet
  );
  // Helmet rim: the hard horizontal line under the dome is most of what
  // makes a head read as helmeted rather than bald at 30m.
  add(
    place(cylinder(0.132, 0.126, 0.032, 16), { position: [0, 1.652, 0.008], scale: [1, 1, 1.1] }),
    'head',
    GEAR,
    PALETTE.helmet
  );
  add(
    place(box(0.155, 0.05, 0.03, 0.012, 1), { position: [0, 1.652, -0.098] }),
    'head',
    GEAR,
    PALETTE.glass
  );
  // Night-vision shroud. Small, but it breaks the silhouette's dome.
  add(
    place(box(0.05, 0.045, 0.05, 0.01, 1), { position: [0, 1.712, -0.082] }),
    'head',
    GEAR,
    PALETTE.gear
  );
  add(
    place(box(0.045, 0.075, 0.075, 0.018, 1), { position: [0.118, 1.645, 0.01] }),
    'head',
    GEAR,
    PALETTE.gear
  );
  add(
    place(box(0.045, 0.075, 0.075, 0.018, 1), { position: [-0.118, 1.645, 0.01] }),
    'head',
    GEAR,
    PALETTE.gear
  );
  add(
    place(cylinder(0.058, 0.062, 0.1, 10), { position: [0, 1.51, 0.005] }),
    'neck',
    CLOTH,
    PALETTE.skin,
    { bone: 'head', from: 1.53, to: 1.58 }
  );

  // -- torso ---------------------------------------------------------------
  add(
    place(box(0.34, 0.42, 0.22, 0.075, 1), { position: [0, 1.3, 0] }),
    'chest',
    CLOTH,
    PALETTE.fatigue,
    { bone: 'spine', from: 1.24, to: 1.12 }
  );
  add(
    place(box(0.365, 0.34, 0.265, 0.045, 1), { position: [0, 1.305, -0.005] }),
    'chest',
    GEAR,
    PALETTE.carrier
  );
  for (const x of [-0.105, 0, 0.105]) {
    add(
      place(box(0.09, 0.115, 0.06, 0.016, 1), { position: [x, 1.215, -0.155] }),
      'chest',
      GEAR,
      PALETTE.gear
    );
  }
  add(
    place(box(0.13, 0.07, 0.045, 0.016, 1), { position: [-0.095, 1.375, -0.152] }),
    'chest',
    GEAR,
    PALETTE.gear
  );
  // Backpack plus a rolled mat: reads instantly from behind, and gives the
  // upper body a mass that a bare torso box never has.
  add(
    place(box(0.27, 0.32, 0.17, 0.04, 1), { position: [0, 1.29, 0.185] }),
    'chest',
    GEAR,
    PALETTE.carrier
  );
  add(
    place(cylinder(0.055, 0.055, 0.3, 8), {
      position: [0, 1.44, 0.19],
      rotation: [0, 0, Math.PI / 2],
    }),
    'chest',
    GEAR,
    PALETTE.gear
  );
  add(
    place(cylinder(0.006, 0.004, 0.42, 5), {
      position: [0.1, 1.62, 0.2],
      rotation: [-0.22, 0, -0.1],
    }),
    'chest',
    GEAR,
    PALETTE.gear
  );
  add(
    place(box(0.29, 0.2, 0.19, 0.06, 1), { position: [0, 1.115, 0] }),
    'spine',
    CLOTH,
    PALETTE.fatigue,
    { bone: 'pelvis', from: 1.1, to: 0.99 }
  );

  // -- hips ----------------------------------------------------------------
  add(
    place(box(0.31, 0.24, 0.21, 0.065, 1), { position: [0, 0.95, 0] }),
    'pelvis',
    CLOTH,
    PALETTE.fatigue
  );
  add(
    place(box(0.325, 0.065, 0.225, 0.02, 1), { position: [0, 1.03, 0] }),
    'pelvis',
    GEAR,
    PALETTE.gear
  );
  add(
    place(box(0.1, 0.14, 0.09, 0.02, 1), { position: [0.16, 0.955, 0.03] }),
    'pelvis',
    GEAR,
    PALETTE.gear
  );
  add(
    place(box(0.085, 0.15, 0.075, 0.02, 1), { position: [-0.16, 0.94, 0.01] }),
    'pelvis',
    GEAR,
    PALETTE.gear
  );

  // -- arms ----------------------------------------------------------------
  for (const side of [1, -1] as const) {
    const suffix = side > 0 ? 'R' : 'L';
    const x = 0.185 * side;
    add(
      place(dome(0.088, Math.PI * 0.62, 12, 6), {
        position: [x * 0.95, 1.4, 0],
        rotation: [0, 0, -side * 0.35],
        scale: [1, 0.85, 1.05],
      }),
      `clavicle${suffix}` as BoneName,
      GEAR,
      PALETTE.carrier
    );
    add(limb(1.135, 1.395, 0.052, 0.066, x, 0, 9), `arm${suffix}` as BoneName, CLOTH, PALETTE.fatigue, {
      bone: `clavicle${suffix}` as BoneName,
      from: 1.3,
      to: 1.4,
    });
    add(limb(0.9, 1.14, 0.044, 0.053, x, 0, 9), `forearm${suffix}` as BoneName, CLOTH, PALETTE.fatigueDark, {
      bone: `arm${suffix}` as BoneName,
      from: 1.07,
      to: 1.15,
    });
    add(
      place(box(0.072, 0.105, 0.062, 0.022, 1), { position: [x, 0.865, -0.01] }),
      `hand${suffix}` as BoneName,
      GEAR,
      PALETTE.gear
    );
  }

  // -- legs ----------------------------------------------------------------
  for (const side of [1, -1] as const) {
    const suffix = side > 0 ? 'R' : 'L';
    const x = 0.105 * side;
    add(limb(0.475, 0.925, 0.062, 0.092, x, 0, 9), `thigh${suffix}` as BoneName, CLOTH, PALETTE.fatigue, {
      bone: 'pelvis',
      from: 0.8,
      to: 0.93,
    });
    add(
      place(box(0.1, 0.145, 0.075, 0.02, 1), { position: [x + side * 0.055, 0.79, 0.02] }),
      `thigh${suffix}` as BoneName,
      GEAR,
      PALETTE.gear
    );
    add(limb(0.14, 0.48, 0.048, 0.064, x, 0, 9), `shin${suffix}` as BoneName, CLOTH, PALETTE.fatigue, {
      bone: `thigh${suffix}` as BoneName,
      from: 0.42,
      to: 0.5,
    });
    add(
      place(box(0.098, 0.11, 0.085, 0.028, 1), { position: [x, 0.475, -0.04] }),
      `shin${suffix}` as BoneName,
      GEAR,
      PALETTE.gear,
      { bone: `thigh${suffix}` as BoneName, from: 0.47, to: 0.53 }
    );
    add(
      place(box(0.105, 0.135, 0.19, 0.03, 1), { position: [x, 0.068, -0.015] }),
      `foot${suffix}` as BoneName,
      GEAR,
      PALETTE.boot
    );
    add(
      place(box(0.098, 0.075, 0.11, 0.03, 1), { position: [x, 0.04, -0.16] }),
      `toe${suffix}` as BoneName,
      GEAR,
      PALETTE.boot
    );
  }

  return parts;
}

/**
 * A carbine, built in weapon space with the barrel along -Z and the receiver
 * at the origin. Kept as an unskinned mesh: it is rigid, and posing it from
 * the aim solution directly — then IK-ing the hands onto it — is both cheaper
 * and far more reliable than hanging it off a hand bone.
 */
function buildWeapon(): {
  geometry: THREE.BufferGeometry;
  muzzle: THREE.Vector3;
  gripRight: THREE.Vector3;
  gripLeft: THREE.Vector3;
} {
  const pieces: Array<{ geometry: THREE.BufferGeometry; colour: number }> = [];
  const add = (geometry: THREE.BufferGeometry, colour: number): void => {
    pieces.push({ geometry: normalise(geometry), colour });
  };

  add(place(box(0.05, 0.085, 0.3, 0.012, 1), { position: [0, 0, 0.02] }), PALETTE.polymer);
  add(place(box(0.046, 0.055, 0.31, 0.014, 1), { position: [0, 0.006, -0.29] }), PALETTE.polymer);
  add(
    place(cylinder(0.011, 0.011, 0.13, 8), {
      position: [0, 0.006, -0.5],
      rotation: [Math.PI / 2, 0, 0],
    }),
    PALETTE.steel
  );
  add(
    place(cylinder(0.018, 0.016, 0.055, 8), {
      position: [0, 0.006, -0.58],
      rotation: [Math.PI / 2, 0, 0],
    }),
    PALETTE.steel
  );
  add(place(box(0.042, 0.08, 0.22, 0.018, 1), { position: [0, -0.01, 0.27] }), PALETTE.polymer);
  add(
    place(box(0.038, 0.115, 0.05, 0.014, 1), { position: [0, -0.085, 0.09], rotation: [0.28, 0, 0] }),
    PALETTE.polymer
  );
  add(
    place(box(0.032, 0.17, 0.072, 0.012, 1), {
      position: [0, -0.115, -0.05],
      rotation: [-0.12, 0, 0],
    }),
    PALETTE.polymer
  );
  add(place(box(0.032, 0.05, 0.12, 0.008, 1), { position: [0, 0.072, -0.06] }), PALETTE.steel);
  add(
    place(cylinder(0.019, 0.019, 0.045, 8), {
      position: [0, 0.082, -0.115],
      rotation: [Math.PI / 2, 0, 0],
    }),
    PALETTE.glass
  );
  add(
    place(box(0.028, 0.085, 0.038, 0.01, 1), {
      position: [0, -0.058, -0.31],
      rotation: [-0.18, 0, 0],
    }),
    PALETTE.polymer
  );

  const colour = new THREE.Color();
  for (const piece of pieces) {
    const count = piece.geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    colour.setHex(piece.colour);
    for (let i = 0; i < count; i++) {
      colours[i * 3] = colour.r;
      colours[i * 3 + 1] = colour.g;
      colours[i * 3 + 2] = colour.b;
    }
    piece.geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  }

  const geometry = mergeAll(pieces.map((p) => p.geometry));
  geometry.computeBoundingSphere();
  return {
    geometry,
    muzzle: new THREE.Vector3(0, 0.006, -0.615),
    // Hands wrap under the grip and handguard rather than sitting on the
    // weapon's axis, which is what stops the forearms reading as though they
    // pass through the receiver.
    gripRight: new THREE.Vector3(0.012, -0.108, 0.098),
    gripLeft: new THREE.Vector3(-0.012, -0.088, -0.3),
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

export function buildSoldierAssets(): SoldierAssets {
  const boneIndex = new Map<BoneName, number>();
  BONE_NAMES.forEach((name, i) => boneIndex.set(name, i));

  const parts = buildParts();
  const slots: THREE.BufferGeometry[][] = [[], []];
  const colour = new THREE.Color();

  for (const part of parts) {
    const geometry = normalise(part.geometry);
    const position = geometry.getAttribute('position');
    const count = position.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const colours = new Float32Array(count * 3);

    const primary = boneIndex.get(part.bone) ?? 0;
    const secondary = part.blend ? (boneIndex.get(part.blend.bone) ?? primary) : primary;
    colour.setHex(part.colour);

    for (let i = 0; i < count; i++) {
      const blend = part.blend
        ? smoothstep(part.blend.from, part.blend.to, position.getY(i))
        : 0;
      skinIndex[i * 4] = primary;
      skinIndex[i * 4 + 1] = secondary;
      skinWeight[i * 4] = 1 - blend;
      skinWeight[i * 4 + 1] = blend;
      colours[i * 3] = colour.r;
      colours[i * 3 + 1] = colour.g;
      colours[i * 3 + 2] = colour.b;
    }

    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    (slots[part.slot] as THREE.BufferGeometry[]).push(geometry);
  }

  const clothGeometry = mergeAll(slots[CLOTH] as THREE.BufferGeometry[]);
  const gearGeometry = mergeAll(slots[GEAR] as THREE.BufferGeometry[]);
  const clothVertices = clothGeometry.getAttribute('position').count;
  const geometry = mergeAll([clothGeometry, gearGeometry]);
  geometry.clearGroups();
  const totalVertices = geometry.getAttribute('position').count;
  geometry.addGroup(0, clothVertices, CLOTH);
  geometry.addGroup(clothVertices, totalVertices - clothVertices, GEAR);
  // Bots are animated well outside their bind pose; a tight sphere pops them
  // out of the frustum mid-stride.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.6);
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-1, -0.4, -1),
    new THREE.Vector3(1, 2.2, 1)
  );

  const materials: THREE.Material[] = [
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.93,
      metalness: 0,
      name: 'ai_cloth',
    }),
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.58,
      metalness: 0.14,
      name: 'ai_gear',
    }),
  ];

  const weapon = buildWeapon();
  const weaponMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.55,
    name: 'ai_weapon',
  });

  // Bind matrices come from a throwaway hierarchy so every instance binds
  // identically no matter where it spawns.
  const template = createBones();
  template.root.updateMatrixWorld(true);
  const boneInverses = BONE_NAMES.map((name) =>
    new THREE.Matrix4().copy(template.bones[name].matrixWorld).invert()
  );

  const triangles =
    geometry.getAttribute('position').count / 3 +
    weapon.geometry.getAttribute('position').count / 3;

  return {
    geometry,
    materials,
    weaponGeometry: weapon.geometry,
    weaponMaterial,
    boneInverses,
    muzzle: weapon.muzzle,
    gripRight: weapon.gripRight,
    gripLeft: weapon.gripLeft,
    triangles,
    dispose(): void {
      geometry.dispose();
      weapon.geometry.dispose();
      weaponMaterial.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

function createBones(): { root: THREE.Bone; bones: Record<BoneName, THREE.Bone> } {
  const bones = {} as Record<BoneName, THREE.Bone>;
  for (const name of BONE_NAMES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bones[name] = bone;
  }
  for (const name of BONE_NAMES) {
    const spec = BIND[name];
    const bone = bones[name];
    if (spec.parent) {
      const parent = bones[spec.parent];
      const parentPos = BIND[spec.parent].pos;
      bone.position.set(
        spec.pos[0] - parentPos[0],
        spec.pos[1] - parentPos[1],
        spec.pos[2] - parentPos[2]
      );
      parent.add(bone);
    } else {
      bone.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    }
  }
  return { root: bones.root, bones };
}

export function createSoldier(assets: SoldierAssets): SoldierInstance {
  const { root, bones } = createBones();

  const mesh = new THREE.SkinnedMesh(assets.geometry, assets.materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.add(root);
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(
    BONE_NAMES.map((name) => bones[name]),
    assets.boneInverses
  );
  mesh.bind(skeleton, new THREE.Matrix4());

  const weapon = new THREE.Mesh(assets.weaponGeometry, assets.weaponMaterial);
  weapon.castShadow = true;
  weapon.matrixAutoUpdate = false;

  const group = new THREE.Group();
  group.name = 'ai-soldier';
  group.add(mesh);
  group.add(weapon);

  return {
    root: group,
    mesh,
    weapon,
    bones,
    dispose(): void {
      skeleton.dispose();
      group.removeFromParent();
    },
  };
}

/** Bind-pose local rest rotations are all identity; exposed for the animator. */
export function resetPose(bones: Record<BoneName, THREE.Bone>): void {
  for (const name of BONE_NAMES) {
    const bone = bones[name];
    const spec = BIND[name];
    const parent = spec.parent;
    if (parent) {
      const parentPos = BIND[parent].pos;
      bone.position.set(
        spec.pos[0] - parentPos[0],
        spec.pos[1] - parentPos[1],
        spec.pos[2] - parentPos[2]
      );
    } else {
      bone.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    }
    bone.quaternion.identity();
    bone.scale.set(1, 1, 1);
  }
}
