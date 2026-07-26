import * as THREE from 'three';
import { GeometryBuilder, apertureFace, lathe, roundedBox, tube } from './GeometryBuilder.ts';
import { applyEdgeWear } from './EdgeWear.ts';
import { type SurfaceMaps, createWeaponTextures } from './WeaponTextures.ts';

/**
 * Procedural MK4 carbine: an AR-15 pattern 5.56 carbine with a 14.5in barrel,
 * a free-float M-LOK rail and a collapsible stock.
 *
 * Local frame: origin at the web of the firing hand (top rear of the pistol
 * grip), -Z down the bore, +Y up, +X to the shooter's right.
 *
 * The layout below is not eyeballed. Every datum is derived from published
 * M4A1 dimensions, because proportion is most of what makes a weapon read as
 * a weapon and it is the one part of the job that can be checked rather than
 * argued about. Working by eye had produced a receiver 26% too long, a rail
 * sitting 44% too high over the bore and an overall length correct only by
 * accident — which together is why the thing read as a blocky prop. The
 * anchors, in inches as published and metres as used:
 *
 *   barrel, bolt face to muzzle          14.5in    368mm
 *   overall length, stock collapsed      29.75in   756mm
 *   length of pull, stock collapsed      10.5in    267mm
 *   pivot to takedown pin centres         6.375in  161.9mm
 *   flat-top rail over bore               1.222in   31.0mm   (GI spec)
 *   magazine well internal width          0.905in   23.0mm
 *   buffer tube outside diameter          1.148in   29.2mm
 *
 * Those over-constrain the layout, which is the point: the trigger-to-muzzle
 * and trigger-to-butt distances follow from overall length and length of
 * pull, and everything else is pinned between them. Where a dimension had to
 * be chosen rather than looked up it is called out at its constant.
 */

const BORE_Y = 0.045;

// -- longitudinal datums, +Z rearward ---------------------------------------
/** Finger face of the trigger. The one number the hands are posed around. */
const TRIGGER_Z = 0.05;
/** Rear face of the upper, where the buffer tube threads in. */
const RECEIVER_BACK = 0.127;
/** Upper receiver, rear face to front face. */
const UPPER_LENGTH = 0.194;
const RECEIVER_FRONT = RECEIVER_BACK - UPPER_LENGTH;
/** Takedown pin aft, pivot pin forward, at the published 161.9mm spacing. */
const PIN_REAR_Z = RECEIVER_BACK - 0.012;
const PIN_FRONT_Z = PIN_REAR_Z - 0.1619;
/**
 * Free-float rail, 11.5in. Chosen rather than looked up: long enough to cover
 * a carbine-length gas block the way a current-issue carbine does, short
 * enough to leave the barrel shoulder and the flash hider in silhouette.
 */
const HANDGUARD_FRONT = RECEIVER_FRONT - 0.292;
const HANDGUARD_RADIUS = 0.0255;
/** Muzzle crown: 328mm of barrel forward of the receiver face. */
const BARREL_END = -0.395;
/** Tip of the A2 birdcage, and the front of the weapon. */
const MUZZLE_END = -0.439;
/** Buffer tube protrusion behind the receiver, 7in of a 7.75in tube. */
const BUFFER_END = RECEIVER_BACK + 0.178;
/** Butt pad face. Sets length of pull to the published 267mm collapsed. */
const BUTT_Z = TRIGGER_Z + 0.267;

// -- vertical datums, all quoted over the bore ------------------------------
/** Top of the flat-top rail teeth. */
const RAIL_TOP = BORE_Y + 0.031;
/**
 * Optical centre of the red dot: 39mm of mount over a 31mm rail, which is the
 * lower-third co-witness height every modern carbine runs. ADS alignment is
 * derived from this marker, so the pose follows the optic automatically.
 */
const SIGHT_Y = BORE_Y + 0.07;
/** Optic sits over the rear of the upper, where a shooter would clamp it. */
const SIGHT_Z = 0.024;

export interface RifleParts {
  root: THREE.Group;
  /** Detachable magazine, animated during reloads. */
  magazine: THREE.Group;
  /** Charging handle assembly, pulled on the empty reload. */
  chargingHandle: THREE.Group;
  /** Reciprocating bolt carrier seen through the ejection port. */
  bolt: THREE.Group;
  trigger: THREE.Group;
  /** Left hand on the handguard. Leaves the weapon during a reload. */
  supportHand: THREE.Group;
  firingHand: THREE.Group;
  /** Marker at the muzzle crown: flash, smoke and tracer origin. */
  muzzle: THREE.Object3D;
  /** Marker at the ejection port, oriented so +X is the eject direction. */
  ejectionPort: THREE.Object3D;
  /** Marker at the red dot's optical centre, used to derive the ADS pose. */
  aimPoint: THREE.Object3D;
  /** Emissive reticle, dimmed out of ADS so it does not read as a lamp. */
  reticle: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  materials: RifleMaterials;
  dispose(): void;
}

export interface RifleMaterials extends Record<string, THREE.Material> {
  steel: THREE.MeshPhysicalMaterial;
  alloy: THREE.MeshPhysicalMaterial;
  polymer: THREE.MeshPhysicalMaterial;
  rail: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshPhysicalMaterial;
  glass: THREE.MeshPhysicalMaterial;
  brass: THREE.MeshPhysicalMaterial;
  glove: THREE.MeshPhysicalMaterial;
  sleeve: THREE.MeshPhysicalMaterial;
  reticleMat: THREE.MeshBasicMaterial;
}

/**
 * Material response is what separates a toy from a weapon.
 *
 * Every body material now takes its albedo, roughness, metalness and cavity
 * occlusion straight from its own baked map set, so `color`, `roughness` and
 * `metalness` are left at their identity values and the texture carries the
 * authored response. On top of that each metal gets a curvature-driven wear
 * layer that rubs its chamfers back to bright substrate — anodising to bare
 * aluminium, phosphate to white steel — which is what stops the rifle reading
 * as a freshly moulded prop.
 */
function createMaterials(): { materials: RifleMaterials; disposeTextures: () => void } {
  const textures = createWeaponTextures();
  const surfaced = (
    maps: SurfaceMaps
  ): {
    map: THREE.Texture;
    normalMap: THREE.Texture;
    roughnessMap: THREE.Texture;
    metalnessMap: THREE.Texture;
    aoMap: THREE.Texture;
    color: number;
    roughness: number;
    metalness: number;
  } => ({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.orm,
    metalnessMap: maps.orm,
    aoMap: maps.orm,
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
  });

  const steel = new THREE.MeshPhysicalMaterial({
    ...surfaced(textures.parkerised),
    normalScale: new THREE.Vector2(0.5, 0.5),
    envMapIntensity: 1.15,
  });
  const alloy = new THREE.MeshPhysicalMaterial({
    ...surfaced(textures.anodised),
    normalScale: new THREE.Vector2(0.55, 0.55),
    envMapIntensity: 1.1,
    // Clearcoat stands in for the hard-anodised finish, which holds a tight
    // specular even though the base is fairly rough. It matters most on the
    // optic: a clearcoat lobe is dielectric, so unlike the metal underneath it
    // responds to the direct rig rather than only to what it can mirror, and
    // it is what keeps the housing's rear face from going flat black.
    clearcoat: 0.34,
    clearcoatRoughness: 0.38,
  });
  const rail = new THREE.MeshPhysicalMaterial({
    ...surfaced(textures.hardcoat),
    normalScale: new THREE.Vector2(0.5, 0.5),
    envMapIntensity: 0.85,
  });
  const polymer = new THREE.MeshPhysicalMaterial({
    ...surfaced(textures.polymer),
    // Moulded polymer has a coarser, more visible texture than machined metal.
    normalScale: new THREE.Vector2(0.85, 0.85),
    envMapIntensity: 0.9,
    clearcoat: 0.14,
    clearcoatRoughness: 0.55,
    sheen: 0.2,
    sheenColor: new THREE.Color(0x454b54),
  });
  const rubber = new THREE.MeshPhysicalMaterial({
    ...surfaced(textures.rubber),
    normalScale: new THREE.Vector2(1, 1),
    envMapIntensity: 0.55,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    // Reflex lenses are coated to pass red and reject everything else, so
    // they carry a faint blue-green cast. The player has to be able to shoot
    // through this, so the tint is kept far lighter than a real coating: any
    // more opacity and the sight picture turns to frosted plastic.
    color: 0x14312e,
    metalness: 0.1,
    roughness: 0.04,
    envMapIntensity: 1.3,
    // The coating shimmer comes from iridescence rather than base colour,
    // which keeps it on the glancing angles where it belongs.
    iridescence: 0.4,
    iridescenceIOR: 1.5,
    iridescenceThicknessRange: [240, 460],
    transparent: true,
    opacity: 0.3,
    // Transparent surfaces must not occlude what is behind them: with depth
    // writes on, the rear lens hides the reticle sitting at the front lens.
    depthWrite: false,
  });
  const brass = new THREE.MeshPhysicalMaterial({
    color: 0xb08d4a,
    metalness: 1,
    roughness: 0.28,
    envMapIntensity: 1.2,
  });
  // The hands are the only warm, non-metallic mass on screen. They carry the
  // colour contrast that stops the viewmodel reading as one grey object, and
  // they are what gives the weapon a sense of being held rather than floating.
  const glove = new THREE.MeshPhysicalMaterial({
    ...surfaced(textures.glove),
    normalScale: new THREE.Vector2(0.9, 0.9),
    envMapIntensity: 0.8,
    sheen: 0.35,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0x7a6e5c),
  });
  const sleeve = new THREE.MeshPhysicalMaterial({
    ...surfaced(textures.ripstop),
    normalScale: new THREE.Vector2(1.1, 1.1),
    envMapIntensity: 0.7,
    sheen: 0.5,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0x7d7663),
  });

  // Wear layers. Aluminium rubs to a bright warm-neutral, steel to a colder
  // white; the polymer and fabrics only get their cavities darkened, since
  // plastic and cloth do not expose a brighter substrate when they scuff.
  // Amounts are low on purpose, for two reasons. Against the dark receiver
  // even a weak rub reads clearly, and the chamfer mask is per-triangle, so
  // pushing the strength up makes the individual bevel facets visible as a
  // mosaic along the edge instead of as a continuous polished line.
  const wear = { noise: textures.wearNoise, scale: 5.5 };
  applyEdgeWear(alloy, {
    ...wear,
    color: 0x767b83,
    roughness: 0.3,
    metalness: 1,
    amount: 0.18,
    cavity: 0.5,
  });
  applyEdgeWear(steel, {
    ...wear,
    color: 0x7d838c,
    roughness: 0.26,
    metalness: 1,
    amount: 0.2,
    cavity: 0.48,
  });
  applyEdgeWear(rail, {
    ...wear,
    scale: 7,
    color: 0x686d75,
    roughness: 0.3,
    metalness: 1,
    amount: 0.16,
    cavity: 0.45,
  });
  applyEdgeWear(polymer, {
    ...wear,
    scale: 1.4,
    color: 0x5c5f65,
    roughness: 0.52,
    metalness: 0.05,
    amount: 0.26,
    cavity: 0.5,
  });
  applyEdgeWear(rubber, { ...wear, color: 0x3c3f44, roughness: 0.7, metalness: 0, amount: 0.2, cavity: 0.55 });
  applyEdgeWear(glove, { ...wear, scale: 1.1, color: 0x8b7a63, roughness: 0.62, metalness: 0, amount: 0.3, cavity: 0.42 });
  applyEdgeWear(sleeve, { ...wear, scale: 0.9, color: 0x8f886d, roughness: 0.82, metalness: 0, amount: 0.22, cavity: 0.5 });

  const reticleMat = new THREE.MeshBasicMaterial({
    // Overdriven well past white-point: the viewmodel composites over an
    // already-tonemapped sunlit frame, and an additive dot at nominal
    // intensity simply tints the sky pink instead of reading as an emitter.
    // Kept saturated rather than pushed further, because past about 2x the
    // core clips to white and the dot reads as an orange blob.
    color: new THREE.Color(0xff1a0c).multiplyScalar(2.1),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  return {
    materials: { steel, alloy, polymer, rail, rubber, glass, brass, glove, sleeve, reticleMat },
    disposeTextures: textures.dispose,
  };
}

/** Picatinny teeth along Z, cut at `gaps` so the rail reads as sectioned. */
function addRail(
  builder: GeometryBuilder,
  from: number,
  to: number,
  y: number,
  width = 0.0212
): void {
  const length = from - to;
  builder.add('rail', roundedBox(width, 0.0055, length, 0.0008), [0, y - 0.0028, (from + to) / 2]);
  const pitch = 0.0102;
  const count = Math.floor(length / pitch);
  const start = from - (length - (count - 1) * pitch) / 2;
  for (let i = 0; i < count; i++) {
    builder.add('rail', roundedBox(width, 0.0052, 0.0062, 0.0009), [0, y + 0.0026, start - i * pitch]);
  }
}

/** Recessed M-LOK slots, three to a face. */
function addMlokSlots(builder: GeometryBuilder, faceAngle: number, zCentres: number[]): void {
  for (const z of zCentres) {
    const r = HANDGUARD_RADIUS - 0.004;
    builder.add(
      'polymer',
      roundedBox(0.011, 0.006, 0.03, 0.0015),
      [Math.sin(faceAngle) * r, BORE_Y + Math.cos(faceAngle) * r, z],
      [0, 0, -faceAngle]
    );
  }
}

export function buildAssaultRifle(): RifleParts {
  const { materials, disposeTextures } = createMaterials();
  const root = new THREE.Group();
  root.name = 'mk4_carbine';

  const body = new GeometryBuilder();

  // -- upper receiver -------------------------------------------------------
  //
  // Sectioned into a lower tube and an upper flat-top deck rather than built
  // as one box. The real part has that step, and more to the point a single
  // slab of the full height is what made the largest object on screen read as
  // a featureless rectangle: the step gives the flank a horizontal line and
  // the deck a lit top face.
  const upperZ = (RECEIVER_BACK + RECEIVER_FRONT) / 2;
  const upperY = BORE_Y + 0.006;
  // Receiver tube around the bolt carrier: 1.35in across, the widest part.
  body.add('alloy', roundedBox(0.0342, 0.036, UPPER_LENGTH, 0.006, 3), [0, upperY, upperZ]);
  // Flat-top deck, narrower than the tube so the step reads from the side.
  body.add('alloy', roundedBox(0.0272, 0.014, UPPER_LENGTH, 0.0025), [0, RAIL_TOP - 0.012, upperZ]);
  addRail(body, RECEIVER_BACK - 0.004, RECEIVER_FRONT + 0.004, RAIL_TOP);

  // Ejection port. The single most recognisable feature on this side of an
  // AR, so it gets a real recess, a hinged dust cover standing proud of the
  // flank, and the brass deflector bump behind it.
  {
    const portZ = -0.012;
    body.add('rubber', roundedBox(0.006, 0.026, 0.058, 0.002), [0.0163, BORE_Y + 0.006, portZ]);
    body.add('steel', roundedBox(0.005, 0.019, 0.05, 0.0015), [0.0166, BORE_Y + 0.005, portZ]);
    // Dust cover, hanging open below the port on its hinge rod.
    body.add('alloy', roundedBox(0.005, 0.026, 0.056, 0.0022), [0.0198, BORE_Y - 0.012, portZ], [0.0, 0, 0.5]);
    body.add('steel', tube(0.0022, 0.0022, 0.062, 10), [0.0186, BORE_Y - 0.011, portZ], [0, Math.PI / 2, 0]);
    // Brass deflector: the wedge aft of the port that keeps cases off a
    // left-handed shooter's face.
    body.add('alloy', roundedBox(0.011, 0.021, 0.03, 0.005), [0.0196, BORE_Y + 0.009, portZ + 0.044], [0, 0, -0.3]);
  }
  // Forward assist, plunger and its housing boss.
  body.add('alloy', roundedBox(0.014, 0.019, 0.026, 0.006), [0.017, BORE_Y + 0.006, RECEIVER_BACK - 0.03]);
  body.add('steel', tube(0.0062, 0.0072, 0.019, 18), [0.0245, BORE_Y + 0.006, RECEIVER_BACK - 0.03], [0, Math.PI / 2, 0]);
  body.add('steel', tube(0.0084, 0.0084, 0.004, 18), [0.0335, BORE_Y + 0.006, RECEIVER_BACK - 0.03], [0, Math.PI / 2, 0]);
  // Charging handle housing at the rear, and the parting line between the
  // two receiver halves running the length of the flank.
  body.add('alloy', roundedBox(0.0352, 0.026, 0.026, 0.005), [0, BORE_Y + 0.011, RECEIVER_BACK - 0.011]);
  for (const side of [-1, 1]) {
    body.add(
      'rail',
      roundedBox(0.0018, 0.0032, UPPER_LENGTH - 0.014, 0.0006),
      [side * 0.0172, BORE_Y - 0.0115, upperZ]
    );
  }

  // -- lower receiver -------------------------------------------------------
  // Fire-control housing, from the rear of the magwell back to the buffer
  // tower. Narrower than the upper, as it is on the real part.
  body.add('alloy', roundedBox(0.0298, 0.032, 0.104, 0.005, 3), [0, BORE_Y - 0.03, TRIGGER_Z + 0.033]);
  // Buffer tower: the ramp that carries the tube up to the bore line. Its
  // diagonal is the shape that reads as "AR" from the side more than any
  // other single line on the weapon.
  body.add('alloy', roundedBox(0.0298, 0.05, 0.05, 0.006, 3), [0, BORE_Y - 0.019, RECEIVER_BACK - 0.017]);
  body.add('alloy', roundedBox(0.0284, 0.03, 0.042, 0.006, 3), [0, BORE_Y - 0.038, RECEIVER_BACK - 0.046], [0.7, 0, 0]);
  // Magwell, raked forward so a magazine drops free, with the flared lip a
  // shooter's hand indexes on.
  {
    const wellZ = RECEIVER_FRONT + 0.038;
    body.add('alloy', roundedBox(0.0298, 0.062, 0.062, 0.004, 3), [0, BORE_Y - 0.045, wellZ], [0.09, 0, 0]);
    body.add('alloy', roundedBox(0.0336, 0.014, 0.07, 0.004), [0, BORE_Y - 0.074, wellZ + 0.003], [0.09, 0, 0]);
    // Trigger-guard fence and the magazine release button in its housing.
    body.add('alloy', roundedBox(0.0298, 0.02, 0.026, 0.005), [0, BORE_Y - 0.017, wellZ + 0.036]);
    body.add('alloy', roundedBox(0.01, 0.016, 0.017, 0.004), [0.017, BORE_Y - 0.021, wellZ + 0.036]);
    body.add('steel', tube(0.0055, 0.0055, 0.008, 16), [0.0225, BORE_Y - 0.021, wellZ + 0.036], [0, Math.PI / 2, 0]);
    // Bolt catch on the left flank: paddle, shelf and pivot.
    body.add('steel', roundedBox(0.005, 0.011, 0.03, 0.002), [-0.0172, BORE_Y - 0.02, wellZ + 0.036], [0, 0, 0.1]);
    body.add('steel', roundedBox(0.005, 0.017, 0.011, 0.002), [-0.0176, BORE_Y - 0.023, wellZ + 0.047]);
  }
  // Takedown and pivot pins, at the published 161.9mm spacing.
  for (const z of [PIN_REAR_Z, PIN_FRONT_Z]) {
    body.add('steel', tube(0.0038, 0.0038, 0.0338, 14), [0, BORE_Y - 0.014, z], [0, Math.PI / 2, 0]);
    for (const side of [-1, 1]) {
      body.add('steel', tube(0.0046, 0.0046, 0.0035, 14), [side * 0.0166, BORE_Y - 0.014, z], [0, Math.PI / 2, 0]);
    }
  }
  // Trigger guard, drawn in the side plane and extruded across the receiver.
  {
    const shape = new THREE.Shape();
    shape.moveTo(-0.008, 0.006);
    shape.lineTo(0.052, 0.006);
    shape.lineTo(0.052, -0.004);
    shape.quadraticCurveTo(0.052, -0.03, 0.03, -0.032);
    shape.lineTo(0.004, -0.032);
    shape.quadraticCurveTo(-0.014, -0.03, -0.008, -0.004);
    shape.lineTo(-0.008, 0.006);
    const hole = new THREE.Path();
    hole.moveTo(-0.001, 0.0);
    hole.lineTo(0.045, 0.0);
    hole.quadraticCurveTo(0.045, -0.024, 0.028, -0.025);
    hole.lineTo(0.006, -0.025);
    hole.quadraticCurveTo(-0.006, -0.024, -0.001, 0.0);
    shape.holes.push(hole);
    const guard = new THREE.ExtrudeGeometry(shape, {
      depth: 0.0115,
      bevelEnabled: true,
      bevelSize: 0.0012,
      bevelThickness: 0.0012,
      bevelSegments: 1,
      curveSegments: 4,
      steps: 1,
    });
    guard.computeVertexNormals();
    // Extruded across the receiver: the profile's +X becomes the weapon's
    // rearward axis, so the loop sits behind the magwell around the trigger.
    body.add('alloy', guard, [0.00575, BORE_Y - 0.046, TRIGGER_Z - 0.001], [0, -Math.PI / 2, 0]);
  }
  // Safety selector: the shaft through the receiver with a lever both sides.
  {
    const selZ = TRIGGER_Z + 0.031;
    const selY = BORE_Y - 0.029;
    body.add('steel', tube(0.0075, 0.0075, 0.036, 18), [0, selY, selZ], [0, Math.PI / 2, 0]);
    for (const side of [-1, 1]) {
      body.add('steel', tube(0.0092, 0.0092, 0.0045, 18), [side * 0.0186, selY, selZ], [0, Math.PI / 2, 0]);
      // Lever swept back and down to SAFE, with a thumb pad on its end.
      body.add('polymer', roundedBox(0.0055, 0.0092, 0.026, 0.002), [side * 0.0212, selY - 0.005, selZ + 0.009], [-0.5, 0, 0]);
      body.add('polymer', roundedBox(0.0075, 0.008, 0.009, 0.002), [side * 0.0218, selY - 0.0135, selZ + 0.0205], [-0.5, 0, 0]);
    }
  }

  // -- pistol grip ----------------------------------------------------------
  {
    const rake = -0.38;
    const gx = 0;
    const gy = -0.055;
    const gz = 0.074;
    body.add('polymer', roundedBox(0.0335, 0.118, 0.045, 0.011, 4), [gx, gy, gz], [rake, 0, 0]);
    // Beavertail into the receiver and the flared base plate.
    body.add('polymer', roundedBox(0.036, 0.02, 0.05, 0.008), [0, 0.006, 0.062], [rake, 0, 0]);
    body.add('polymer', roundedBox(0.037, 0.008, 0.05, 0.003), [0, -0.113, 0.096], [rake, 0, 0]);
    // Finger grooves, stepped down the grip's own axis and pushed out to its
    // front face rather than placed in weapon space, so they follow the rake.
    const downY = -Math.cos(rake);
    const downZ = -Math.sin(rake);
    const frontY = Math.sin(rake);
    const frontZ = -Math.cos(rake);
    for (let i = 0; i < 3; i++) {
      const s = 0.008 + i * 0.022;
      body.add(
        'rubber',
        tube(0.0052, 0.0052, 0.03, 16),
        [0, gy + downY * s + frontY * 0.0215, gz + downZ * s + frontZ * 0.0215],
        [0, Math.PI / 2, 0]
      );
    }
    // Palm swell texture panels.
    for (const side of [-1, 1]) {
      body.add(
        'rubber',
        roundedBox(0.004, 0.062, 0.03, 0.004),
        [side * 0.0165, gy - 0.004, gz + 0.002],
        [rake, 0, 0]
      );
    }
  }

  // -- stock ----------------------------------------------------------------
  {
    const tubeStart = RECEIVER_BACK + 0.018;
    body.add('alloy', roundedBox(0.042, 0.042, 0.016, 0.004), [0, BORE_Y + 0.004, tubeStart - 0.006]);
    body.add('steel', tube(0.0185, 0.0185, 0.014, 28), [0, BORE_Y + 0.004, tubeStart + 0.008]);
    body.add('steel', tube(0.0158, 0.0158, 0.135, 32), [0, BORE_Y + 0.004, tubeStart + 0.066]);
    // Length-of-pull detents.
    for (let i = 0; i < 4; i++) {
      body.add(
        'steel',
        tube(0.0168, 0.0168, 0.004, 28),
        [0, BORE_Y + 0.004, tubeStart + 0.03 + i * 0.026]
      );
    }
    // Sliding stock body, run all the way in to its shortest length of pull.
    //
    // This is a framing decision as much as a loadout one. The stock is the
    // part of the weapon nearest the eye at hip, so every millimetre of length
    // of pull costs several times its share of the frame, and fully extended
    // it filled the entire right third with a featureless slab. Collapsed, it
    // tucks into the corner where a carbine's stock belongs.
    const sz = tubeStart + 0.076;
    body.add('polymer', roundedBox(0.047, 0.058, 0.115, 0.008, 3), [0, BORE_Y + 0.002, sz]);
    // Comb, cheek rest and the toe that hooks under the shoulder.
    body.add('polymer', roundedBox(0.036, 0.014, 0.1, 0.005), [0, BORE_Y + 0.033, sz + 0.004]);
    body.add('polymer', roundedBox(0.04, 0.05, 0.03, 0.006), [0, BORE_Y - 0.038, sz + 0.036], [0.28, 0, 0]);
    // Sling loop and release lever.
    body.add('polymer', roundedBox(0.052, 0.012, 0.02, 0.004), [0, BORE_Y - 0.028, sz - 0.05], [-0.2, 0, 0]);
    body.add('rubber', roundedBox(0.049, 0.078, 0.014, 0.006), [0, BORE_Y - 0.004, sz + 0.062], [0.1, 0, 0]);
    // Butt pad ribs.
    for (let i = 0; i < 4; i++) {
      body.add(
        'rubber',
        roundedBox(0.05, 0.005, 0.006, 0.002),
        [0, BORE_Y + 0.028 - i * 0.018, sz + 0.069],
        [0.1, 0, 0]
      );
    }
  }

  // -- handguard ------------------------------------------------------------
  {
    const length = RECEIVER_FRONT - HANDGUARD_FRONT;
    const centre = (RECEIVER_FRONT + HANDGUARD_FRONT) / 2;
    // Barrel nut collar at the receiver joint.
    body.add('alloy', tube(0.0315, 0.0315, 0.022, 32), [0, BORE_Y, RECEIVER_FRONT - 0.012]);
    // Octagonal free-float tube; the flats catch the key light and give the
    // handguard a machined read that a smooth cylinder does not.
    const hg = tube(HANDGUARD_RADIUS, HANDGUARD_RADIUS, length - 0.024, 8, false);
    hg.rotateZ(Math.PI / 8);
    body.add('rail', hg, [0, BORE_Y, centre - 0.012], [0, 0, 0], [1, 1, 1], true);
    addRail(body, RECEIVER_FRONT + 0.002, HANDGUARD_FRONT + 0.008, RAIL_TOP - 0.005);

    addMlokSlots(body, Math.PI / 2, [-0.2, -0.245, -0.29, -0.335]);
    addMlokSlots(body, -Math.PI / 2, [-0.2, -0.245, -0.29, -0.335]);
    addMlokSlots(body, Math.PI, [-0.2, -0.245, -0.29]);
    // QD sling socket.
    body.add('steel', tube(0.007, 0.007, 0.008, 12), [-0.026, BORE_Y - 0.012, -0.38], [0, Math.PI / 2, 0]);
    // Handstop, which also reads as the front of the silhouette from the side.
    body.add('polymer', roundedBox(0.026, 0.03, 0.036, 0.006), [0, BORE_Y - 0.038, -0.318], [0.45, 0, 0]);
    body.add('rubber', roundedBox(0.028, 0.006, 0.03, 0.003), [0, BORE_Y - 0.051, -0.312], [0.45, 0, 0]);
  }

  // -- barrel and muzzle device --------------------------------------------
  body.add('steel', tube(0.0115, 0.0115, 0.32, 32), [0, BORE_Y, (RECEIVER_FRONT + BARREL_END) / 2]);
  body.add('steel', tube(0.0135, 0.0135, 0.012, 28), [0, BORE_Y, HANDGUARD_FRONT - 0.008]);
  // Gas block peeking out under the handguard lip.
  body.add('steel', roundedBox(0.022, 0.024, 0.03, 0.003), [0, BORE_Y + 0.002, -0.408]);
  {
    const z = (BARREL_END + MUZZLE_END) / 2;
    body.add(
      'steel',
      lathe(
        [
          [0.0125, 0.0275],
          [0.0155, 0.024],
          [0.0155, 0.012],
          [0.0132, 0.008],
          [0.0155, 0.002],
          [0.0155, -0.012],
          [0.0132, -0.016],
          [0.0155, -0.021],
          [0.0155, -0.0265],
          [0.0092, -0.0275],
        ],
        36
      ),
      [0, BORE_Y, z]
    );
    // Crown: a dark disc set back inside the bore so the muzzle reads hollow.
    body.add('rubber', tube(0.0085, 0.0085, 0.001, 28), [0, BORE_Y, MUZZLE_END + 0.004]);
    // Birdcage ports.
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.5;
      body.add(
        'rubber',
        roundedBox(0.004, 0.005, 0.016, 0.0008),
        [Math.cos(a) * 0.0145, BORE_Y + Math.sin(a) * 0.0145, z - 0.004],
        [0, 0, a - Math.PI / 2]
      );
    }
  }

  // -- optic ----------------------------------------------------------------
  {
    const mountY = RAIL_TOP + 0.005;
    body.add('rail', roundedBox(0.03, 0.012, 0.07, 0.003), [0, mountY, SIGHT_Z]);
    body.add('rail', roundedBox(0.038, 0.01, 0.016, 0.003), [0, RAIL_TOP - 0.001, SIGHT_Z + 0.02]);
    body.add('rail', roundedBox(0.038, 0.01, 0.016, 0.003), [0, RAIL_TOP - 0.001, SIGHT_Z - 0.02]);
    // Cross-bolt clamp nuts.
    for (const z of [SIGHT_Z + 0.02, SIGHT_Z - 0.02]) {
      body.add('steel', tube(0.006, 0.006, 0.009, 6), [0.021, RAIL_TOP - 0.001, z], [0, Math.PI / 2, 0]);
    }

    const bodyY = SIGHT_Y;
    // Open-hood reflex: two side plates, a top bridge and a solid floor. The
    // aperture between the bezels is the only place the world shows through,
    // which is the whole point of a red dot — but the hood around it is a
    // closed box, so the housing reads as mass rather than as a wire frame.
    for (const side of [-1, 1]) {
      body.add('alloy', roundedBox(0.006, 0.038, 0.062, 0.0035), [side * 0.0185, bodyY, SIGHT_Z]);
    }
    body.add('alloy', roundedBox(0.043, 0.008, 0.062, 0.0035), [0, bodyY + 0.02, SIGHT_Z]);
    body.add('alloy', roundedBox(0.043, 0.008, 0.062, 0.0035), [0, bodyY - 0.02, SIGHT_Z]);
    body.add('alloy', roundedBox(0.043, 0.012, 0.024, 0.004), [0, bodyY - 0.024, SIGHT_Z + 0.004]);
    // Front and rear face plates: the full housing section with the lens
    // aperture bored through it, rather than a floating ring that leaves the
    // corners of the housing open to the sky. Segment count matters here more
    // than anywhere else on the weapon, since this bore frames the sight
    // picture and fills a quarter of the screen in ADS.
    for (const z of [SIGHT_Z - 0.029, SIGHT_Z + 0.029]) {
      body.add('alloy', apertureFace(0.043, 0.048, 0.0132, 0.005), [0, bodyY, z]);
    }
    // Bore wall between the plates. The profile closes back on itself so the
    // ring has a real inner surface facing the eye; an open cylinder would
    // present only back faces and read as a hole into nothing.
    body.add(
      'rail',
      lathe(
        [
          [0.0132, 0.0275],
          [0.0168, 0.0275],
          [0.0168, -0.0275],
          [0.0132, -0.0275],
          [0.0132, 0.0275],
        ],
        48
      ),
      [0, bodyY, SIGHT_Z]
    );
    // Everything below is detail rather than form, and it is here because the
    // optic is the nearest object to the eye in the entire game. In ADS it is
    // the only part of the weapon the player looks at for minutes at a time,
    // so it carries a detail budget far out of proportion to its volume: at
    // any other place on the rifle this many parts would be waste.

    /** Knurled cap: a ribbed cylinder with a coin-slot kerf across the top. */
    const turret = (
      position: [number, number, number],
      rotation: [number, number, number],
      radius: number,
      height: number,
      ribs: number
    ): void => {
      body.add('alloy', tube(radius, radius * 1.04, height, 28), position, rotation);
      body.add('alloy', tube(radius * 1.16, radius * 1.16, height * 0.3, 28), position, rotation);
      const axis = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...rotation));
      const u = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(...rotation));
      const v = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...rotation));
      const base = new THREE.Vector3(...position);
      for (let i = 0; i < ribs; i++) {
        const a = (i / ribs) * Math.PI * 2;
        const p = base
          .clone()
          .addScaledVector(u, Math.cos(a) * radius)
          .addScaledVector(v, Math.sin(a) * radius);
        body.add(
          'alloy',
          roundedBox(0.0016, height * 0.7, 0.0016, 0.0005),
          [p.x, p.y, p.z],
          rotation
        );
      }
      // Adjustment kerf, sunk into the crown so it catches a shadow.
      const top = base.clone().addScaledVector(axis, height * 0.5);
      body.add(
        'rail',
        roundedBox(radius * 1.7, 0.0016, 0.0022, 0.0004),
        [top.x, top.y, top.z],
        rotation
      );
    };

    // Elevation on top, windage on the right, battery cap on the left. The
    // caps are tethered by their own bosses so they read as removable parts.
    turret([0, bodyY + 0.0285, SIGHT_Z + 0.016], [0, 0, 0], 0.0072, 0.011, 12);
    turret([0.0255, bodyY, SIGHT_Z + 0.016], [0, 0, Math.PI / 2], 0.0072, 0.011, 12);
    turret([-0.027, bodyY, SIGHT_Z + 0.016], [0, 0, Math.PI / 2], 0.0092, 0.014, 16);

    // Brightness rocker below the battery cap: two pads and the dot between.
    for (const dy of [0.011, -0.011]) {
      body.add(
        'rubber',
        roundedBox(0.004, 0.006, 0.006, 0.0015),
        [-0.0225, bodyY + dy, SIGHT_Z - 0.006],
        [0, Math.PI / 2, 0]
      );
    }

    /** Countersunk fastener. Six-sided so the flats catch the key light. */
    const screw = (x: number, y: number, z: number, r: number, ry = 0): void => {
      body.add('steel', tube(r, r * 1.25, 0.0022, 6), [x, y, z], [Math.PI / 2, ry, 0]);
      body.add('rail', roundedBox(r * 1.3, r * 0.36, 0.0009, 0.0002), [x, y, z + 0.0012]);
    };
    // Bezel screws, one per corner of each face plate. Four small bright
    // points around the aperture do more to sell a machined housing than any
    // amount of surface noise.
    for (const z of [SIGHT_Z - 0.0315, SIGHT_Z + 0.0315]) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          screw(sx * 0.0166, bodyY + sy * 0.019, z, 0.0018);
        }
      }
    }

    // Raised boss around each aperture. The face plates are the largest flat
    // areas the player ever sees at ADS, and in the frame they were a plain
    // dark rectangle with a hole in it. The boss costs one part per face and
    // buys a lit edge and a cast shadow across the middle of that rectangle,
    // which is what breaks it up.
    for (const [z, d] of [
      [SIGHT_Z - 0.0335, -0.0022],
      [SIGHT_Z + 0.0335, 0.0022],
    ]) {
      body.add('alloy', apertureFace(0.0335, 0.0375, 0.0142, Math.abs(d), 0.0055), [0, bodyY, z + d * 0.5]);
    }

    // Clamshell seam: the housing is two castings, and the parting line runs
    // around it just aft of the bezel. Modelled as a recessed dark band
    // rather than a groove, which costs three boxes instead of a boolean.
    for (const side of [-1, 1]) {
      body.add('rail', roundedBox(0.0016, 0.0405, 0.0035, 0.0006), [side * 0.0207, bodyY, SIGHT_Z + 0.008]);
    }
    body.add('rail', roundedBox(0.0365, 0.0016, 0.0035, 0.0006), [0, bodyY + 0.0235, SIGHT_Z + 0.008]);

    // Maker's plate on the left flank, which is the side the camera sees at
    // hip. Three engraved bars stand in for a logo and a serial.
    body.add('rail', roundedBox(0.0014, 0.011, 0.026, 0.0004), [-0.0212, bodyY - 0.004, SIGHT_Z - 0.006]);
    for (let i = 0; i < 3; i++) {
      body.add(
        'alloy',
        roundedBox(0.0008, 0.0014, 0.0175 - i * 0.004, 0.0003),
        [-0.0219, bodyY - 0.0008 - i * 0.0035, SIGHT_Z - 0.008],
        [0, 0, 0]
      );
    }

    // Sunshade lip standing proud of the front bezel, and a matching rear
    // eyepiece ring. Both give the aperture a thickness in silhouette.
    body.add(
      'alloy',
      lathe(
        [
          [0.0132, 0.004],
          [0.0182, 0.004],
          [0.0176, -0.0012],
          [0.0132, -0.0022],
        ],
        40
      ),
      [0, bodyY, SIGHT_Z - 0.0335]
    );
    body.add(
      'rail',
      lathe(
        [
          [0.0134, 0.0022],
          [0.0166, 0.0022],
          [0.0166, -0.0016],
          [0.0134, -0.0016],
        ],
        40
      ),
      [0, bodyY, SIGHT_Z + 0.0332]
    );

    // Mount clamp: knurled tension nut and a throw lever folded back along
    // the rail, on the camera side.
    body.add('steel', tube(0.0062, 0.0062, 0.004, 20), [-0.0225, mountY - 0.002, SIGHT_Z + 0.02], [0, 0, Math.PI / 2]);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      body.add(
        'steel',
        roundedBox(0.004, 0.0012, 0.0012, 0.0004),
        [-0.0225, mountY - 0.002 + Math.cos(a) * 0.0062, SIGHT_Z + 0.02 + Math.sin(a) * 0.0062],
        [0, 0, Math.PI / 2]
      );
    }
    body.add('steel', roundedBox(0.0035, 0.006, 0.026, 0.0012), [-0.0235, mountY - 0.002, SIGHT_Z + 0.006], [0.12, 0, 0]);
  }

  body.build(root, materials, '', 30);

  // Lenses stay separate: they are transparent, so they must sort after the
  // opaque body rather than merge into it.
  const lensGeometry = new THREE.CircleGeometry(0.0129, 48);
  const frontLens = new THREE.Mesh(lensGeometry, materials.glass);
  frontLens.position.set(0, SIGHT_Y, SIGHT_Z - 0.026);
  frontLens.rotation.y = Math.PI;
  frontLens.rotation.x = 0.06;
  frontLens.renderOrder = 2;
  frontLens.frustumCulled = false;
  root.add(frontLens);

  const rearLens = new THREE.Mesh(lensGeometry.clone(), materials.glass);
  rearLens.position.set(0, SIGHT_Y, SIGHT_Z + 0.026);
  rearLens.renderOrder = 2;
  rearLens.frustumCulled = false;
  root.add(rearLens);

  // Reticle: a hard core plus a tight bloom disc, drawn on top of the glass.
  // Geometrically a 2 MOA dot is about one pixel at this eye relief, so the
  // dot is drawn oversized like every shooter does; a truthful one is
  // invisible. It is still kept small and round, because the previous
  // combination of an over-driven core and a wide halo bloomed into a soft
  // orange blob that hid the target rather than marking it.
  const reticle = new THREE.Mesh(new THREE.CircleGeometry(0.00082, 32), materials.reticleMat);
  reticle.position.set(0, SIGHT_Y, SIGHT_Z - 0.0255);
  reticle.renderOrder = 4;
  reticle.frustumCulled = false;
  root.add(reticle);

  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(0.0019, 32),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xff1a0c).multiplyScalar(1.1),
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
  );
  halo.renderOrder = 3;
  halo.frustumCulled = false;
  reticle.add(halo);
  halo.position.set(0, 0, 0.0001);

  // -- magazine (animated) --------------------------------------------------
  const magazine = new THREE.Group();
  magazine.name = 'magazine';
  magazine.position.set(0, 0.012, -0.038);
  {
    const mag = new GeometryBuilder();
    const segments = 8;
    const segLength = 0.0235;
    let y = 0;
    let z = 0;
    let angle = 0;
    for (let i = 0; i < segments; i++) {
      const cy = y - (Math.cos(angle) * segLength) / 2;
      const cz = z - (Math.sin(angle) * segLength) / 2;
      const width = 0.0262;
      mag.add('polymer', roundedBox(width, segLength + 0.001, 0.0405, 0.003), [0, cy, cz], [angle, 0, 0]);
      // Grip ribs down both sides.
      if (i > 0 && i < segments) {
        for (const side of [-1, 1]) {
          mag.add(
            'polymer',
            roundedBox(0.0022, 0.016, 0.03, 0.001),
            [side * (width / 2), cy, cz],
            [angle, 0, 0]
          );
        }
      }
      y -= Math.cos(angle) * segLength;
      z -= Math.sin(angle) * segLength;
      angle += 0.042;
    }
    // Feed lips and the follower visible at the top.
    mag.add('polymer', roundedBox(0.029, 0.012, 0.043, 0.002), [0, 0.006, 0]);
    mag.add('steel', roundedBox(0.021, 0.005, 0.032, 0.001), [0, 0.009, -0.001]);
    // Floor plate.
    mag.add('polymer', roundedBox(0.031, 0.011, 0.046, 0.003), [0, y + 0.004, z], [angle, 0, 0]);
    mag.add('rubber', roundedBox(0.0325, 0.006, 0.048, 0.003), [0, y - 0.002, z], [angle, 0, 0]);
    // Witness holes.
    for (let i = 0; i < 3; i++) {
      mag.add('rubber', roundedBox(0.005, 0.005, 0.004, 0.001), [0.0132, -0.05 - i * 0.035, -0.004]);
    }
    mag.build(magazine, materials, 'mag_', 30);
  }
  root.add(magazine);

  // -- charging handle (animated) ------------------------------------------
  const chargingHandle = new THREE.Group();
  chargingHandle.name = 'charging_handle';
  {
    const ch = new GeometryBuilder();
    ch.add('alloy', roundedBox(0.052, 0.011, 0.016, 0.003), [0, BORE_Y + 0.03, RECEIVER_BACK + 0.012]);
    ch.add('alloy', roundedBox(0.02, 0.009, 0.014, 0.003), [-0.03, BORE_Y + 0.03, RECEIVER_BACK + 0.008], [0, 0, 0.25]);
    for (const side of [-1, 1]) {
      ch.add('steel', roundedBox(0.007, 0.007, 0.075, 0.001), [
        side * 0.014,
        BORE_Y + 0.03,
        RECEIVER_BACK - 0.03,
      ]);
    }
    ch.build(chargingHandle, materials, 'ch_', 30);
  }
  root.add(chargingHandle);

  // -- bolt carrier (animated) ---------------------------------------------
  const bolt = new THREE.Group();
  bolt.name = 'bolt';
  {
    const bg = new GeometryBuilder();
    bg.add('steel', roundedBox(0.019, 0.021, 0.046, 0.002), [0.0195, 0.053, -0.028]);
    bg.add('brass', tube(0.0028, 0.0028, 0.012, 8), [0.0205, 0.0485, -0.014], [0, Math.PI / 2, 0.2]);
    bg.build(bolt, materials, 'bolt_', 30);
  }
  root.add(bolt);

  // -- trigger (animated) ---------------------------------------------------
  const trigger = new THREE.Group();
  trigger.name = 'trigger';
  trigger.position.set(0, 0.006, 0.021);
  {
    const tg = new GeometryBuilder();
    tg.add('steel', roundedBox(0.0075, 0.026, 0.009, 0.002), [0, -0.014, 0.001], [0.25, 0, 0]);
    tg.add('steel', roundedBox(0.0075, 0.008, 0.012, 0.002), [0, -0.025, 0.004], [0.8, 0, 0]);
    tg.build(trigger, materials, 'trigger_', 30);
  }
  root.add(trigger);

  // -- support hand ---------------------------------------------------------
  // A thumb-over-bore grip high on the handguard: it puts the back of the
  // hand toward the camera, where it actually reads, instead of hiding the
  // whole hand behind the weapon the way an under-grip would.
  const supportHand = new THREE.Group();
  supportHand.name = 'support_hand';
  {
    const hand = new GeometryBuilder();
    const gripZ = -0.283;
    /** Radius the glove sits at: the handguard plus a millimetre of leather. */
    const grip = HANDGUARD_RADIUS + 0.002;

    /**
     * Places a part tangent to the handguard.
     *
     * Building the hand in cylindrical coordinates rather than by hand-placed
     * boxes is what makes it actually wrap: every digit sits at the same
     * standoff from the tube and turns with it, so the knuckles form one
     * continuous ridge instead of four unrelated lumps.
     *
     * `angle` is measured from the weapon's +X axis, `lift` is the standoff
     * beyond the handguard surface, and the size is
     * (tangential, radial, along the bore).
     */
    const around = (
      angle: number,
      lift: number,
      z: number,
      size: readonly [number, number, number],
      radius: number
    ): void => {
      const r = grip + lift + size[1] / 2;
      hand.add(
        'glove',
        roundedBox(size[0], size[1], size[2], radius, 3),
        [Math.cos(angle) * r, BORE_Y + Math.sin(angle) * r, z],
        [0, 0, angle - Math.PI / 2]
      );
    };

    const D = Math.PI / 180;
    // Palm and the back of the hand, laid down the left face of the handguard.
    around(186 * D, 0, gripZ + 0.004, [0.05, 0.019, 0.086], 0.013);
    // Metacarpal mass above it, which is what gives the hand a wrist-to-
    // knuckle taper rather than a constant-section slab.
    around(150 * D, 0.001, gripZ - 0.004, [0.03, 0.016, 0.074], 0.011);

    for (let i = 0; i < 4; i++) {
      const z = gripZ - 0.034 + i * 0.0225;
      const taper = 1 - i * 0.08;
      // Knuckle: the ridge the key light catches, and the single clearest
      // signal that what is on the handguard is a hand. It is deliberately
      // proud of the metacarpals and shorter than the finger pitch, so the
      // four of them read as four rather than as one welt.
      around(141 * D, 0.008, z, [0.023, 0.014, 0.0155 * taper], 0.0062);
      // Three phalanges wrapping under the tube from left to right. Each is
      // shorter than the 22.5mm pitch, which leaves a visible gap between
      // fingers — without it the hand is a single mitt.
      around(196 * D, 0.004, z, [0.026, 0.019, 0.0165 * taper], 0.0075);
      around(243 * D, 0.004, z, [0.028, 0.019, 0.016 * taper], 0.0075);
      around(292 * D, 0.001, z, [0.024, 0.016, 0.015 * taper], 0.0062);
    }

    // Thumb over the bore, angled forward along the rail. This is the grip
    // the pose is named for and the part that sits highest in frame.
    around(118 * D, 0.003, gripZ - 0.028, [0.026, 0.021, 0.036], 0.009);
    around(104 * D, 0.001, gripZ - 0.066, [0.022, 0.018, 0.042], 0.008);

    // Wrist and forearm, aligned to a single axis running back, down and left
    // toward the shooter's body so the arm leaves frame instead of floating.
    hand.add('glove', roundedBox(0.03, 0.042, 0.05, 0.014, 3), [-0.043, BORE_Y - 0.025, gripZ + 0.03], [0.6, -0.24, 0.2]);
    // Cuff: the seam between glove and sleeve, which stops the forearm
    // reading as one continuous tan pipe running out of the frame.
    hand.add('glove', tube(0.028, 0.03, 0.016, 20), [-0.0475, BORE_Y - 0.049, gripZ + 0.049], [1.12, -0.1415, 0]);
    // Steeply raked so the arm clears the bottom of the frame quickly: a
    // shallower angle drags a long beige diagonal across the whole viewport.
    hand.add('sleeve', tube(0.026, 0.029, 0.1, 20), [-0.053, BORE_Y - 0.092, gripZ + 0.072], [1.12, -0.1415, 0]);
    hand.add('sleeve', tube(0.029, 0.033, 0.11, 20), [-0.068, BORE_Y - 0.185, gripZ + 0.117], [1.12, -0.1415, 0]);
    // Rolled cuff, two fabric folds and a wrist strap. The forearm is the
    // largest single silhouette the support arm puts on screen and it was a
    // smooth beige pipe: at hip the eye reads it as a length of dowel before
    // it reads it as an arm. These cost four parts and give the light
    // somewhere to break, which is all the read needs.
    hand.add('sleeve', tube(0.032, 0.031, 0.013, 20), [-0.0495, BORE_Y - 0.056, gripZ + 0.0525], [1.12, -0.1415, 0]);
    for (const [t, r] of [
      [0.055, 0.0305],
      [0.105, 0.0325],
    ]) {
      hand.add(
        'sleeve',
        tube(r, r, 0.009, 20),
        [-0.0495 - t * 0.145, BORE_Y - 0.056 - t * 0.9, gripZ + 0.0525 + t * 0.44],
        [1.12, -0.1415, 0]
      );
    }
    hand.add('rubber', tube(0.0315, 0.0315, 0.007, 20), [-0.0555, BORE_Y - 0.1, gripZ + 0.0765], [1.12, -0.1415, 0]);
    hand.build(supportHand, materials, 'hand_', 26);
  }
  root.add(supportHand);

  // -- firing hand ----------------------------------------------------------
  // Right hand on the pistol grip. Everything is placed along the grip's own
  // raked axis: the palm on the far side, the fingers wrapping its front face
  // toward the camera, and the trigger finger reaching into the guard.
  const firingHand = new THREE.Group();
  firingHand.name = 'firing_hand';
  {
    const hand = new GeometryBuilder();
    const rake = -0.38;
    const gy = -0.055;
    const gz = 0.074;
    const downY = -Math.cos(rake);
    const downZ = -Math.sin(rake);
    const frontY = Math.sin(rake);
    const frontZ = -Math.cos(rake);
    /** `s` runs down the grip from the web, `f` toward its front face. */
    const at = (s: number, f: number, x: number): [number, number, number] => [
      x,
      gy + downY * s + frontY * f,
      gz + downZ * s + frontZ * f,
    ];

    // Heel of the palm, on the far side of the grip from the camera.
    hand.add('glove', roundedBox(0.02, 0.082, 0.048, 0.013, 3), at(0.036, 0.002, 0.023), [rake, 0, 0.05]);
    // Web of the thumb over the top of the grip, and the thumb itself laid
    // forward along the receiver.
    hand.add('glove', roundedBox(0.042, 0.028, 0.044, 0.012, 3), at(-0.004, 0.004, 0.006), [rake, 0, 0.12]);
    hand.add('glove', roundedBox(0.019, 0.02, 0.036, 0.008), at(0.014, 0.022, -0.011), [rake + 0.5, 0, 0.2]);

    // Three fingers wrapping the front of the grip, tapering down the hand.
    for (let i = 0; i < 3; i++) {
      const s = 0.019 + i * 0.023;
      const taper = 1 - i * 0.09;
      hand.add('glove', roundedBox(0.046, 0.021 * taper, 0.021, 0.008), at(s, 0.03, 0.002), [rake, 0, 0]);
      hand.add('glove', roundedBox(0.018, 0.02 * taper, 0.02, 0.007), at(s + 0.002, 0.023, -0.024), [rake, 0, -0.5]);
    }

    // Trigger finger: proximal along the outside of the guard, pad inside it.
    hand.add('glove', roundedBox(0.02, 0.02, 0.04, 0.008), [0.015, 0.002, 0.05], [0.2, 0, 0.12]);
    hand.add('glove', roundedBox(0.017, 0.018, 0.03, 0.007), [0.006, -0.006, 0.028], [0.45, 0, 0.05]);

    // Wrist and sleeve, running back and down to the shoulder.
    hand.add('glove', tube(0.031, 0.033, 0.018, 20), [0.005, -0.118, 0.113], [0.823, 0.191, 0]);
    hand.add('sleeve', tube(0.031, 0.035, 0.11, 20), [0.013, -0.163, 0.145], [0.823, 0.191, 0]);
    hand.build(firingHand, materials, 'fhand_', 26);
  }
  root.add(firingHand);

  // -- markers --------------------------------------------------------------
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, BORE_Y, MUZZLE_END);
  root.add(muzzle);

  const ejectionPort = new THREE.Object3D();
  ejectionPort.name = 'ejection_port';
  ejectionPort.position.set(0.028, 0.055, -0.02);
  root.add(ejectionPort);

  const aimPoint = new THREE.Object3D();
  aimPoint.name = 'aim_point';
  aimPoint.position.set(0, SIGHT_Y, SIGHT_Z - 0.026);
  root.add(aimPoint);

  const dispose = (): void => {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    for (const material of Object.values(materials)) material.dispose();
    halo.material.dispose();
    disposeTextures();
  };

  return {
    root,
    magazine,
    chargingHandle,
    bolt,
    trigger,
    supportHand,
    firingHand,
    muzzle,
    ejectionPort,
    aimPoint,
    reticle: reticle as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
    materials,
    dispose,
  };
}
