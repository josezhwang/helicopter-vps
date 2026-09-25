import * as THREE from 'three'
import { heightAt } from './terrain'

export type Team = 'blue' | 'red'

export const BASE_HALF = 42 // base walls span ±BASE_HALF around the center

export function flagPoleHeight(): number {
  return 22
}

export interface BaseObjects {
  group: THREE.Group
  flagCloth: THREE.Mesh
  flagState: { waving: boolean; carried: boolean; base: Team }
  colliders: THREE.Box3[]
  flagTip: THREE.Object3D
}

const BLUE = {
  wall: 0x5d6d80,
  accent: 0x2e6fbd,
  cloth: 0x2e6fbd,
}

const RED = {
  wall: 0x7d5a52,
  accent: 0xb03a2e,
  cloth: 0xb03a2e,
}

function makeFlagCloth(team: Team): THREE.Mesh {
  const colors = team === 'blue' ? BLUE : RED
  const geometry = new THREE.PlaneGeometry(10, 6, 12, 6)
  geometry.translate(5, 0, 0) // pivot at pole edge
  const material = new THREE.MeshStandardMaterial({
    color: colors.cloth,
    side: THREE.DoubleSide,
    roughness: 0.8,
    emissive: colors.cloth,
    emissiveIntensity: 0.08,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  return mesh
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

  // --- Flagpole in front of bunker ---
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.8, roughness: 0.3 })
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, flagPoleHeight(), 10), poleMat)
  pole.position.set(-12, flagPoleHeight() / 2, 0)
  pole.castShadow = true
  group.add(pole)

  const flagCloth = makeFlagCloth(team)
  flagCloth.position.set(-12, flagPoleHeight() - 5, 0)
  group.add(flagCloth)

  const flagTip = new THREE.Object3D()
  flagTip.position.set(-12, flagPoleHeight() - 5, 0)
  group.add(flagTip)

  const flagState = { waving: true, carried: false, base: team }

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

  return { group, flagCloth, flagState, colliders, flagTip }
}

/** Rebuild flag cloth vertices for a gentle waving animation. */
export function animateFlag(flag: BaseObjects, time: number, worldPos: THREE.Vector3) {
  const cloth = flag.flagCloth
  if (flag.flagState.carried) return
  const geometry = cloth.geometry as THREE.PlaneGeometry
  const pos = geometry.attributes.position as THREE.BufferAttribute
  const width = 10
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const amp = (x / width) * 0.9
    pos.setZ(i, Math.sin(time * 4 + x * 0.8 + worldPos.x * 0.1) * amp + Math.sin(time * 2.3 + x * 0.5) * amp * 0.4)
  }
  pos.needsUpdate = true
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
