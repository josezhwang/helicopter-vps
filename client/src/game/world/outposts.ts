import * as THREE from 'three'
import { heightAt } from './terrain'
import { loadProp, propInstances } from './props'
import { BARREL_SPOTS, OUTPOSTS, OUTPOST_WALLS, outpostToWorld, outpostYaw } from './layout'

/**
 * Cover in the open: six sandbag outposts between the bases (U-shaped walls that stop rounds and bodies), and
 * the explosive barrels by the gates, the fuel tankers and every outpost — shoot one and it goes up, taking
 * whatever is next to it along (the server decides; this draws them and reports hits).
 */
const WALL_LENGTH = 3.2
const WALL_HEIGHT = 1.2
const WALL_DEPTH = 0.8
const BARREL_RADIUS = 0.42
/** What lies about each outpost (own frame: +Z faces the enemy side; `y` stacks it on another). */
const OUTPOST_KIT: Array<{ prop: 'jersey' | 'crate' | 'jerrycan' | 'generator'; x: number; z: number; yaw: number; y?: number }> = [
  { prop: 'jersey', x: -2.3, z: -3.7, yaw: 0.08 },
  { prop: 'jersey', x: 1.4, z: -4.0, yaw: -0.18 },
  { prop: 'crate', x: -1.7, z: 0.5, yaw: 0.25 },
  { prop: 'crate', x: -1.68, z: 0.52, yaw: 0.1, y: 0.7 },
  { prop: 'crate', x: 0.9, z: 1.5, yaw: -0.5 },
  { prop: 'jerrycan', x: -3.9, z: -0.25, yaw: 1.2 },
  { prop: 'jerrycan', x: -3.55, z: 0.15, yaw: 0.85 },
  { prop: 'generator', x: 3.5, z: -2.5, yaw: -0.6 },
]
/** Solid size of each kind (width along its length, height, depth) — the jerrycans are kicked about. */
const KIT_SOLID: Partial<Record<'jersey' | 'crate' | 'jerrycan' | 'generator', [number, number, number]>> = {
  jersey: [1.57, 1.11, 0.5], crate: [0.8, 0.7, 0.8], generator: [0.82, 0.46, 0.56],
}
/** Keep trees, rocks and grass off the outposts. */
export const OUTPOST_CLEARANCE = 10

export interface Outposts {
  group: THREE.Group
  /** Invisible boxes along the walls and cylinders round the barrels: what bullets hit (barrels carry userData.barrelId). */
  blockers: THREE.Group
  /** Solid circles along the walls (players and cars can't pass). */
  circles: Array<{ x: number; z: number; r: number }>
  /** Standing barrels as solid circles (they change as barrels blow and come back). */
  barrelCircles: () => Array<{ x: number; z: number; r: number }>
  /** Where a barrel is (world, its base on the ground). */
  barrelPosition: (id: string) => THREE.Vector3 | null
  setBarrel: (id: string, alive: boolean) => void
  /** Standing barrels, and the invisible cylinder that stands in for each (bullet holes ride on it). */
  alive: (id: string) => boolean
  proxy: (id: string) => THREE.Object3D | null
  /** Near an outpost (for keeping nature away). */
  near: (x: number, z: number, margin?: number) => boolean
}

export function createOutposts(): Outposts {
  const group = new THREE.Group()
  group.name = 'outposts'
  const blockers = new THREE.Group()
  blockers.name = 'outpost-blockers'
  const circles: Outposts['circles'] = []
  const hidden = new THREE.MeshBasicMaterial({ visible: false })

  // Sandbag walls, placed on the ground and turned with their outpost
  const walls: THREE.Matrix4[] = []
  const wallBoxes = new THREE.InstancedMesh(new THREE.BoxGeometry(WALL_LENGTH, WALL_HEIGHT, WALL_DEPTH).translate(0, WALL_HEIGHT / 2, 0), hidden, OUTPOSTS.length * OUTPOST_WALLS.length)
  let slot = 0
  OUTPOSTS.forEach((_, i) => {
    const turn = outpostYaw(i)
    for (const wall of OUTPOST_WALLS) {
      const at = outpostToWorld(i, wall.x, wall.z)
      const yaw = turn + wall.yaw
      const y = heightAt(at.x, at.z) - 0.05
      const m = new THREE.Matrix4().compose(new THREE.Vector3(at.x, y, at.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1))
      walls.push(m)
      wallBoxes.setMatrixAt(slot++, m)
      // Four solid circles along the wall
      for (let k = 0; k < 4; k++) {
        const along = (k / 3 - 0.5) * (WALL_LENGTH - 0.6)
        circles.push({ x: at.x + Math.cos(yaw) * along, z: at.z - Math.sin(yaw) * along, r: 0.55 })
      }
    }
  })
  wallBoxes.computeBoundingSphere()
  blockers.add(wallBoxes)
  void loadProp('sandbags').then((prop) => {
    // The model's long side is along X, like the wall boxes
    const meshes = propInstances(prop, walls.length, true, group)
    for (const mesh of meshes) {
      walls.forEach((m, i) => mesh.setMatrixAt(i, m))
      mesh.count = walls.length
      mesh.instanceMatrix.needsUpdate = true
    }
  }).catch((error) => console.error('[outposts] sandbag model failed to load:', error))

  // Kit lying about each outpost (photographed props, Poly Haven CC0): concrete barriers at the back, ammo crates,
  // jerrycans by the barrel, a generator. Barriers and crates stop rounds and bodies.
  const kit: Record<'jersey' | 'crate' | 'jerrycan' | 'generator', THREE.Matrix4[]> = { jersey: [], crate: [], jerrycan: [], generator: [] }
  OUTPOSTS.forEach((_, i) => {
    const turn = outpostYaw(i)
    for (const item of OUTPOST_KIT) {
      const at = outpostToWorld(i, item.x, item.z)
      const yaw = turn + item.yaw
      const ground = heightAt(at.x, at.z) - 0.02
      const m = new THREE.Matrix4().compose(new THREE.Vector3(at.x, ground + (item.y ?? 0), at.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1))
      kit[item.prop].push(m)
      const solid = KIT_SOLID[item.prop]
      if (!solid || item.y) continue
      const box = new THREE.Mesh(new THREE.BoxGeometry(solid[0], solid[1], solid[2]).translate(0, solid[1] / 2, 0), hidden)
      box.matrixAutoUpdate = false
      box.matrix.copy(m)
      box.matrixWorldNeedsUpdate = true
      blockers.add(box)
      const steps = solid[0] > 1 ? 2 : 1
      for (let k = 0; k < steps; k++) {
        const along = steps === 1 ? 0 : (k - 0.5) * solid[0] * 0.5
        circles.push({ x: at.x + Math.cos(yaw) * along, z: at.z - Math.sin(yaw) * along, r: Math.max(solid[2], solid[0] / (steps * 2)) * 0.6 })
      }
    }
  })
  for (const name of Object.keys(kit) as Array<keyof typeof kit>) {
    void loadProp(name).then((prop) => {
      const meshes = propInstances(prop, kit[name].length, name !== 'jerrycan', group)
      for (const mesh of meshes) {
        kit[name].forEach((m, i) => mesh.setMatrixAt(i, m))
        mesh.count = kit[name].length
        mesh.instanceMatrix.needsUpdate = true
      }
    }).catch((error) => console.error(`[outposts] ${name} model failed to load:`, error))
  }

  // Barrels: a model each (instanced) and an invisible cylinder for bullets
  const alive = new Map(BARREL_SPOTS.map((b) => [b.id, true]))
  const positions = new Map(BARREL_SPOTS.map((b) => [b.id, new THREE.Vector3(b.x, heightAt(b.x, b.z), b.z)]))
  const proxies = new Map<string, THREE.Mesh>()
  const proxyGeometry = new THREE.CylinderGeometry(BARREL_RADIUS, BARREL_RADIUS, 1.1, 10).translate(0, 0.55, 0)
  for (const b of BARREL_SPOTS) {
    const proxy = new THREE.Mesh(proxyGeometry, hidden)
    proxy.position.copy(positions.get(b.id)!)
    proxy.userData.barrelId = b.id
    blockers.add(proxy)
    proxies.set(b.id, proxy)
  }
  let barrelMeshes: THREE.InstancedMesh[] = []
  const drawBarrels = () => {
    let n = 0
    const m = new THREE.Matrix4()
    for (const b of BARREL_SPOTS) {
      if (!alive.get(b.id)) continue
      m.makeRotationY((b.x * 0.37) % Math.PI).setPosition(positions.get(b.id)!)
      for (const mesh of barrelMeshes) mesh.setMatrixAt(n, m)
      n++
    }
    for (const mesh of barrelMeshes) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true }
  }
  void loadProp('barrel').then((prop) => {
    barrelMeshes = propInstances(prop, BARREL_SPOTS.length, true, group)
    drawBarrels()
  }).catch((error) => console.error('[outposts] barrel model failed to load:', error))

  return {
    group,
    blockers,
    circles,
    barrelCircles: () => BARREL_SPOTS.filter((b) => alive.get(b.id)).map((b) => ({ x: b.x, z: b.z, r: BARREL_RADIUS })),
    barrelPosition: (id) => positions.get(id)?.clone() ?? null,
    setBarrel(id, standing) {
      if (!alive.has(id) || alive.get(id) === standing) return
      alive.set(id, standing)
      // A blown barrel no longer stops rounds
      proxies.get(id)?.layers.set(standing ? 0 : 1)
      drawBarrels()
    },
    alive: (id) => alive.get(id) ?? false,
    proxy: (id) => proxies.get(id) ?? null,
    near: (x, z, margin = 0) => OUTPOSTS.some(([ox, oz]) => Math.hypot(ox - x, oz - z) < OUTPOST_CLEARANCE + margin),
  }
}
