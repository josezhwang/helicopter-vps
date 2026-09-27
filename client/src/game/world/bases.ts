import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { baseGroundHeight } from './terrain'
import { createGemStand, type GemStand } from './gem'
import { loadModel, toStandardMaterial } from './assets'
import { BASE_CENTER, BASE_ROTATION, LAYOUT, type Team } from './layout'

export type { Team }
export { BASE_HALF } from './layout'

const BASE_URL = '/models/base.glb'
/** Solid parts of the base model (walls, buildings, towers, crates...) as boxes in the model's frame. */
const COLLIDERS_URL = '/models/base_colliders.json'

/** Where each base's gem sits, in base-local space (the server's capture check uses the same spot). */
export const GEM_LOCAL = new THREE.Vector3(LAYOUT.gem[0], 0, LAYOUT.gem[1])

const TEAM_ACCENT: Record<Team, number> = { blue: 0x2e6fbd, red: 0xb03a2e }

export interface BaseObjects {
  group: THREE.Group
  gem: GemStand
  /** World-space boxes that block walking and driving; filled in once the collision data has loaded. */
  colliders: THREE.Box3[]
}

const noRaycast = () => {}

/** A box given in the base's frame, as a world-space box (the base only turns in quarter turns, so it stays axis-aligned). */
function toWorldBox(group: THREE.Object3D, min: THREE.Vector3Tuple, max: THREE.Vector3Tuple): THREE.Box3 {
  group.updateMatrixWorld(true)
  return new THREE.Box3().setFromPoints([
    new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], min[1], min[2]),
    new THREE.Vector3(min[0], max[1], max[2]), new THREE.Vector3(max[0], max[1], max[2]),
    new THREE.Vector3(min[0], min[1], max[2]), new THREE.Vector3(max[0], max[1], min[2]),
  ].map((p) => p.applyMatrix4(group.matrixWorld)))
}

/** `colliders`: where to put this base's solid boxes (share one array between bases to collide with both). */
export function createBase(team: Team, colliders: THREE.Box3[] = []): BaseObjects {
  const group = new THREE.Group()
  group.name = `base-${team}`
  // Floor a hair above the flattened ground so the two never flicker
  group.position.set(BASE_CENTER[team].x, baseGroundHeight(team) - 0.02, BASE_CENTER[team].z)
  group.rotation.y = BASE_ROTATION[team]

  // Gem pedestal (animated, so it is added after the static merge)
  const gem = createGemStand(team)
  gem.group.position.copy(GEM_LOCAL)
  const gemBox = gem.collider.clone().translate(GEM_LOCAL)
  colliders.push(toWorldBox(group, gemBox.min.toArray(), gemBox.max.toArray()))

  // Team flags either side of the gate, so the two identical bases can be told apart from afar
  const flags = new THREE.Group()
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.6 })
  const clothMat = new THREE.MeshStandardMaterial({ color: TEAM_ACCENT[team], roughness: 0.8, side: THREE.DoubleSide })
  for (const x of [-14, 14]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 9, 8), poleMat)
    pole.position.set(x, 4.5, 49)
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 2.6), clothMat)
    cloth.position.set(x, 8, 50.35)
    pole.castShadow = cloth.castShadow = true
    flags.add(pole, cloth)
  }
  group.add(flags)

  void (async () => {
    const [gltf, boxes] = await Promise.all([
      loadModel(BASE_URL),
      fetch(COLLIDERS_URL).then((r) => r.json() as Promise<Array<{ min: THREE.Vector3Tuple; max: THREE.Vector3Tuple }>>),
    ])
    const model = gltf.scene.clone(true)
    model.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toStandardMaterial) : toStandardMaterial(mesh.material)
    })
    group.add(model)
    mergeStaticMeshes(group, new Set([...flags.children, gem.group]))
    model.removeFromParent()
    // Bullets test simple boxes, not the ~45k-triangle model (the gem pedestal still stops them itself)
    const underGem = (node: THREE.Object3D) => { for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n === gem.group) return true; return false }
    group.traverse((node) => { if ((node as THREE.Mesh).isMesh && !underGem(node)) node.raycast = noRaycast })

    const blockers = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }), boxes.length)
    blockers.name = 'base-blockers'
    const box = new THREE.Box3(), center = new THREE.Vector3(), size = new THREE.Vector3()
    boxes.forEach((b, i) => {
      box.set(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max))
      blockers.setMatrixAt(i, new THREE.Matrix4().compose(box.getCenter(center), new THREE.Quaternion(), box.getSize(size)))
      colliders.push(toWorldBox(group, b.min, b.max))
    })
    blockers.computeBoundingSphere()
    group.add(blockers)
  })().catch((error) => console.error('[base] base model failed to load:', error))

  group.add(gem.group)
  return { group, gem, colliders }
}

/**
 * The base never moves, so merge it into one mesh per material (a dozen draw calls instead of hundreds).
 */
function mergeStaticMeshes(group: THREE.Group, keep: Set<THREE.Object3D>) {
  group.updateMatrixWorld(true)
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert()
  const buckets = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; geometries: THREE.BufferGeometry[] }>()
  const merged: THREE.Mesh[] = []
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || keep.has(mesh) || Array.isArray(mesh.material)) return
    for (let n: THREE.Object3D | null = mesh; n; n = n.parent) if (keep.has(n)) return
    const layout = Object.keys(mesh.geometry.attributes).sort().join(',') + (mesh.geometry.index ? '|i' : '|n')
    const key = `${mesh.material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${layout}`
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, (bucket = { material: mesh.material, cast: mesh.castShadow, receive: mesh.receiveShadow, geometries: [] }))
    bucket.geometries.push(mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld)))
    merged.push(mesh)
  })
  for (const mesh of merged) mesh.removeFromParent()
  for (const bucket of buckets.values()) {
    const geometry = bucket.geometries.length === 1 ? bucket.geometries[0] : mergeGeometries(bucket.geometries)
    if (geometry !== bucket.geometries[0]) for (const g of bucket.geometries) g.dispose()
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, bucket.material)
    mesh.castShadow = bucket.cast
    mesh.receiveShadow = bucket.receive
    group.add(mesh)
  }
}
