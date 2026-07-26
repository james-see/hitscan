import * as THREE from 'three';

/**
 * Irradiance probe for the viewmodel scene.
 *
 * The weapon is almost entirely metal, so essentially all of its brightness
 * is reflected environment rather than direct light. three.js's stock
 * RoomEnvironment is a dim grey studio, which renders a gun-metal receiver as
 * a black silhouette against a sunlit exterior. This builds a matching
 * outdoor probe instead: bright sky above, warm sand bounce below, and a sun
 * disc hot enough to throw a real specular streak along the rail.
 *
 * The gradient is built around what the weapon's flanks reflect. Those faces
 * point roughly at the horizon, and they are the largest unbroken areas on the
 * model, so whatever sits in that band sets the receiver's base value. Keeping
 * it dark is what lets the up-facing chamfers and the rail read as bright
 * against it; a hot horizon floods the flanks instead and the whole rifle
 * flattens out to the value of the ground behind it.
 */
export function createViewmodelEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();

  // Radiances are in the same linear units as the world, whose sunlit sand
  // sits near 0.26: a gun-metal receiver reflecting this probe lands around a
  // quarter of that, which is where dark parkerised steel belongs.
  // The sky is deliberately desaturated well below what the world's own sky
  // renders at. Most of the weapon's large faces point up, so whatever colour
  // sits overhead becomes the weapon's colour, and a saturated blue probe
  // turns a gunmetal receiver into blue-grey plastic. The warmth has to come
  // back somewhere, so the ground bounce carries more of it than a real sand
  // albedo would justify.
  const sky = new THREE.Color(0x9fb4cc).multiplyScalar(0.6);
  // Both lower hemisphere bands are far greyer than the sand they stand in
  // for. A faithfully warm bounce gives the receiver the same hue as the
  // ground behind it, and a weapon that shares the terrain's colour reads as
  // painted wood however dark it is. The separation the silhouette needs is
  // hue as much as value, so the bounce keeps the ground's brightness and
  // gives up most of its saturation.
  const horizon = new THREE.Color(0xb3a898).multiplyScalar(0.28);
  const ground = new THREE.Color(0xa28c74).multiplyScalar(0.2);
  const nadir = new THREE.Color(0x413830).multiplyScalar(0.1);

  const dome = new THREE.SphereGeometry(8, 24, 16);
  const position = dome.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i) / 8;
    if (y >= 0) {
      // Squared blend keeps the hot horizon band tight rather than washing
      // the whole upper hemisphere out.
      colour.copy(horizon).lerp(sky, Math.min(1, Math.sqrt(y) * 1.25));
    } else {
      colour.copy(horizon).lerp(ground, Math.min(1, -y * 4));
      colour.lerp(nadir, Math.min(1, Math.max(0, -y - 0.45) * 1.8));
    }
    colors[i * 3] = colour.r;
    colors[i * 3 + 1] = colour.g;
    colors[i * 3 + 2] = colour.b;
  }
  dome.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const domeMesh = new THREE.Mesh(
    dome,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })
  );
  scene.add(domeMesh);

  // Sun, up and to the left so the key highlight falls on the side of the
  // weapon the camera can actually see.
  const sunGeometry = new THREE.SphereGeometry(0.75, 12, 8);
  const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xfff4e2 });
  sunMaterial.color.multiplyScalar(15);
  const sun = new THREE.Mesh(sunGeometry, sunMaterial);
  sun.position.set(-3.6, 5.5, 2.6);
  scene.add(sun);

  const pmrem = new THREE.PMREMGenerator(renderer);
  // A little blur: a mirror-sharp probe makes the low-poly facets pop as
  // discrete plates instead of reading as one continuous surface.
  const texture = pmrem.fromScene(scene, 0.06).texture;
  pmrem.dispose();
  dome.dispose();
  domeMesh.material.dispose();
  sunGeometry.dispose();
  sunMaterial.dispose();
  return texture;
}
