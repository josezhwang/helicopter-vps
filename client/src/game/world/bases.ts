import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { heightAt } from './terrain'
import { createGemStand, type GemStand } from './gem'
import type { TurretPlacement } from './turrets'

export type Team = 'blue' | 'red'

export const BASE_HALF = 42 // base walls span ±BASE_HALF around the center

/** Where each base's gem sits, in base-local space (the server's capture check uses the same spot). */
export const GEM_LOCAL = new THREE.Vector3(-12, 0, 0)

export interface BaseObjects {
  group: THREE.Group
  gem: GemStand
  colliders: THREE.Box3[]
}

const BLUE = {
  wall: 0x5d6d80,
  accent: 0x2e6fbd,
}

const RED = {
  wall: 0x7d5a52,
  accent: 0xb03a2e,
}

/**
 * Machine-gun emplacements just outside the walls, barrels pointing away from the base: left, right,
 * back, and one on each side of the gate. All within ~51m of the centre, where no trees/rocks/bushes grow.
 */
export function turretPlacements(team: Team, center: THREE.Vector3): TurretPlacement[] {
  const g = team === 'blue' ? 1 : -1 // blue's gate faces +X, red's faces -X
  const local: Array<[number, number]> = [[0, 50], [0, -50], [-50 * g, 0], [47 * g, 19], [47 * g, -19]]
  return local.map(([x, z]) => ({ x: center.x + x, z: center.z + z, facing: Math.atan2(x, z) }))
}

export function createBase(team: Team, position: THREE.Vector3): BaseObjects {
  const colors = team === 'blue' ? BLUE : RED
  const group = new THREE.Group()
  group.position.copy(position)
  const groundY = heightAt(position.x, position.z)
  group.position.y = groundY

  const colliders: THREE.Box3[] = []
  const wallMat = new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.9 })
  const trimMat = new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.6, metalness: 0.2 })

  // --- Walls: perimeter with a gate opening on the side facing midfield ---
  const WALL_H = 7
  const WALL_T = 2
  const SEG_LEN = BASE_HALF - 4 // leave room for corner towers
  const gateOnPositiveX = team === 'blue' // gates face the midfield diagonal

  function addWall(cx: number, cz: number, w: number, d: number, h: number) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat)
    wall.position.set(cx, h / 2, cz)
    wall.castShadow = true
    wall.receiveShadow = true
    group.add(wall)
    colliders.push(
      new THREE.Box3().setFromObject(wall).expandByScalar(0),
    )
  }

  const mid = BASE_HALF
  // North/South walls (spanning x)
  addWall(-mid / 2, -mid, SEG_LEN, WALL_T, WALL_H)
  addWall(mid / 2, -mid, SEG_LEN, WALL_T, WALL_H)
  addWall(-mid / 2, mid, SEG_LEN, WALL_T, WALL_H)
  addWall(mid / 2, mid, SEG_LEN, WALL_T, WALL_H)
  // East/West walls (spanning z), one gap = gate
  const gateHalf = 7
  for (const side of [-1, 1]) {
    const x = side * mid
    if ((side > 0) === gateOnPositiveX) {
      // wall with gate in middle
      const wallLen = (BASE_HALF * 2 - gateHalf * 2) / 2
      addWall(x, -(gateHalf + wallLen / 2), WALL_T, wallLen, WALL_H)
      addWall(x, gateHalf + wallLen / 2, WALL_T, wallLen, WALL_H)
      // gate posts
      const postMat = trimMat
      for (const zz of [-gateHalf, gateHalf]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(WALL_T + 1.5, WALL_H + 3, 2.5), postMat)
        post.position.set(x, (WALL_H + 3) / 2, zz)
        post.castShadow = true
        group.add(post)
      }
      // lintel
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, 3, gateHalf * 2), trimMat)
      lintel.position.set(x, WALL_H + 1.5, 0)
      lintel.castShadow = true
      group.add(lintel)
    } else {
      addWall(x, 0, WALL_T, BASE_HALF * 2, WALL_H)
    }
  }

  // --- Corner watchtowers ---
  const towerMat = new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.85 })
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 14, 8), towerMat)
      tower.position.set(sx * mid, 7, sz * mid)
      tower.castShadow = true
      group.add(tower)
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.6, 4, 8), trimMat)
      roof.position.set(sx * mid, 16, sz * mid)
      roof.castShadow = true
      group.add(roof)
      colliders.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(sx * mid, 7, sz * mid), new THREE.Vector3(8, 14, 8)))
    }
  }

  // --- Central command bunker ---
  const bunker = new THREE.Group()
  const bunkerBase = new THREE.Mesh(new THREE.BoxGeometry(16, 5, 12), wallMat)
  bunkerBase.position.y = 2.5
  bunkerBase.castShadow = true
  bunkerBase.receiveShadow = true
  bunker.add(bunkerBase)
  const bunkerTop = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 8), wallMat)
  bunkerTop.position.y = 7
  bunkerTop.castShadow = true
  bunker.add(bunkerTop)
  const bunkerAntenna = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6, 6), trimMat)
  bunkerAntenna.position.set(3, 12, 0)
  bunker.add(bunkerAntenna)
  bunker.position.set(0, 0, 0)
  group.add(bunker)
  colliders.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(0, 4.5, 0), new THREE.Vector3(17, 9, 13)))

  // --- Gem pedestal in front of the bunker (added after the static merge below: it animates) ---
  const gem = createGemStand(team)
  gem.group.position.copy(GEM_LOCAL)
  colliders.push(gem.collider.clone().translate(GEM_LOCAL))

  // --- Helipad ---
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 9, 0.6, 24),
    new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.95 }),
  )
  pad.position.set(20, 0.3, -18)
  pad.receiveShadow = true
  group.add(pad)
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(7, 0.25, 8, 32),
    new THREE.MeshStandardMaterial({ color: colors.accent, emissive: colors.accent, emissiveIntensity: 0.35 }),
  )
  ring.rotation.x = Math.PI / 2
  ring.position.set(20, 0.65, -18)
  group.add(ring)

  // --- Supply crates + sandbags for life ---
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x7a5c3a, roughness: 0.9 })
  const sandbagMat = new THREE.MeshStandardMaterial({ color: 0x9a8f6a, roughness: 1 })
  const rng = mulberry32(team === 'blue' ? 1234 : 5678)
  for (let i = 0; i < 6; i++) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), crateMat)
    crate.position.set(10 + rng() * 24 - 12, 1.1, -30 + rng() * 20)
    crate.rotation.y = rng() * Math.PI
    crate.castShadow = true
    group.add(crate)
    colliders.push(new THREE.Box3().setFromCenterAndSize(crate.position.clone(), new THREE.Vector3(2.6, 2.6, 2.6)))
  }
  for (let i = 0; i < 5; i++) {
    const bag = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), sandbagMat)
    bag.scale.set(1.6, 0.55, 1)
    bag.position.set(-26 + rng() * 12, 0.55, 18 + rng() * 16)
    bag.castShadow = true
    group.add(bag)
  }

  // Colliders were built in group-local space — move them into world space
  for (const box of colliders) {
    box.translate(new THREE.Vector3(group.position.x, group.position.y, group.position.z))
  }

  mergeStaticMeshes(group, new Set())
  group.add(gem.group)

  return { group, gem, colliders }
}

/**
 * Walls, towers, crates… never move, so merge them into one mesh per material (a handful of draw calls
 * instead of ~45 per base). Colliders were already built from the individual meshes.
 */
function mergeStaticMeshes(group: THREE.Group, keep: Set<THREE.Object3D>) {
  group.updateMatrixWorld(true)
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert()
  const buckets = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; geometries: THREE.BufferGeometry[] }>()
  const merged: THREE.Mesh[] = []
  group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || keep.has(mesh) || Array.isArray(mesh.material)) return
    const key = `${mesh.material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}`
    let bucket = buckets.get(key)
    if (!bucket) buckets.set(key, (bucket = { material: mesh.material, cast: mesh.castShadow, receive: mesh.receiveShadow, geometries: [] }))
    bucket.geometries.push(mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld)))
    merged.push(mesh)
  })
  for (const mesh of merged) mesh.removeFromParent()
  for (const bucket of buckets.values()) {
    const geometry = mergeGeometries(bucket.geometries)
    for (const g of bucket.geometries) g.dispose()
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, bucket.material)
    mesh.castShadow = bucket.cast
    mesh.receiveShadow = bucket.receive
    group.add(mesh)
  }
}

// Deterministic PRNG so both clients/worlds build identically.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
