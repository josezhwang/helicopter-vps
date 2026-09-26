import * as THREE from 'three'

export const WORLD_SIZE = 1000
export const HALF_WORLD = WORLD_SIZE / 2

export const OUR_BASE: THREE.Vector3 = new THREE.Vector3(-380, 0, -380)
export const ENEMY_BASE: THREE.Vector3 = new THREE.Vector3(380, 0, 380)

/** Analytic battlefield height — shared by terrain mesh, player, and vehicles. */
export function heightAt(x: number, z: number): number {
  const hills = Math.sin(x * 0.008) * Math.cos(z * 0.009) * 14
  const dunes = Math.sin(x * 0.02 + z * 0.013) * Math.cos(z * 0.017 - x * 0.011) * 5
  const ridges = Math.cos((x - z) * 0.004) * 8
  const valleys = Math.sin((x + z) * 0.005) * Math.cos((x - z) * 0.007) * 3
  return hills + dunes + ridges + valleys
}

export function createTerrain(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 128, 128)
  geometry.rotateX(-Math.PI / 2)
  const pos = geometry.attributes.position as THREE.BufferAttribute
  const colors = new Float32Array(pos.count * 3)

  const grass = new THREE.Color(0x4a8236)
  const dry = new THREE.Color(0x8a7f4f)
  const dirt = new THREE.Color(0x6b543c)
  const rock = new THREE.Color(0x7d7f82)
  const sand = new THREE.Color(0xb9a77b)
  const tmp = new THREE.Color()

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const h = heightAt(x, z)
    pos.setY(i, h)

    tmp.copy(grass)
    // Mostly green land: rock only on the highest hills, sand only right at the water
    if (h > 18) tmp.lerp(rock, THREE.MathUtils.clamp((h - 18) / 16, 0, 1))
    if (h < -1.5) tmp.lerp(sand, THREE.MathUtils.clamp((-1.5 - h) / 2, 0, 1))
    const noise = Math.sin(x * 0.05) * Math.cos(z * 0.043) * 0.5 + Math.sin((x + z) * 0.021) * 0.5
    tmp.lerp(dry, THREE.MathUtils.clamp(0.08 + noise * 0.1, 0, 1))
    if (Math.abs(x + z) > 660) tmp.lerp(dirt, 0.15)

    colors[i * 3] = tmp.r
    colors[i * 3 + 1] = tmp.g
    colors[i * 3 + 2] = tmp.b
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.computeVertexNormals()

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  mesh.name = 'terrain'
  return mesh
}

export function createWater(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE * 1.6, WORLD_SIZE * 1.6)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.MeshStandardMaterial({
    color: 0x2c6d8f,
    transparent: true,
    opacity: 0.85,
    roughness: 0.15,
    metalness: 0.6,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = -6
  mesh.name = 'water'
  return mesh
}

export const SHADOW_RANGE = 160
/** Direction from the ground towards the sun (the original fixed sun position). */
export const SUN_OFFSET = new THREE.Vector3(-260, 320, 160)
/** Beyond this the fog is solid sky colour, so nothing further needs drawing. */
export const FOG_FAR = 1500

export function createSkyAndLights(scene: THREE.Scene): THREE.DirectionalLight {
  scene.background = new THREE.Color(0x9db8d9)
  scene.fog = new THREE.Fog(0x9db8d9, 300, FOG_FAR)

  const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x4a5a33, 0.85)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.2)
  sun.position.set(-260, 320, 160)
  sun.castShadow = true
  // Shadows cover the area around the player (the game moves this box with the camera):
  // far fewer objects to render into the shadow map, and sharper shadows than one map for the whole world
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 50
  sun.shadow.camera.far = 900
  sun.shadow.camera.left = -SHADOW_RANGE
  sun.shadow.camera.right = SHADOW_RANGE
  sun.shadow.camera.top = SHADOW_RANGE
  sun.shadow.camera.bottom = -SHADOW_RANGE
  sun.shadow.bias = -0.0005
  scene.add(sun)
  scene.add(sun.target)

  return sun
}
