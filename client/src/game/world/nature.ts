import * as THREE from 'three'
import { heightAt, HALF_WORLD } from './terrain'

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

/** Reusable trunk + canopy materials shared by all trees (perf). */
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 })
const canopyMats = [
  new THREE.MeshStandardMaterial({ color: 0x3f6b2f, roughness: 1 }),
  new THREE.MeshStandardMaterial({ color: 0x4c7a35, roughness: 1 }),
  new THREE.MeshStandardMaterial({ color: 0x33592a, roughness: 1 }),
]

export function createForest(circles?: Array<{ x: number; z: number; r: number }>): THREE.Group {
  const group = new THREE.Group()
  const rng = mulberry32(20260924)

  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 6, 6)
  const coneGeo = new THREE.ConeGeometry(2.6, 7, 7)
  const blobGeo = new THREE.IcosahedronGeometry(2.8, 1)

  for (let i = 0; i < 260; i++) {
    const x = (rng() * 2 - 1) * HALF_WORLD * 0.95
    const z = (rng() * 2 - 1) * HALF_WORLD * 0.95

    // Keep bases, spawn lanes and water clear
    if (Math.hypot(x + 380, z + 380) < 60) continue
    if (Math.hypot(x - 380, z - 380) < 60) continue
    const h = heightAt(x, z)
    if (h < 1.0) continue // no trees in low ground/water

    const scale = 0.7 + rng() * 0.9
    const tree = new THREE.Group()

    const trunk = new THREE.Mesh(trunkGeo, trunkMat)
    trunk.position.y = 3
    trunk.castShadow = true
    tree.add(trunk)

    if (rng() > 0.35) {
      const canopy = new THREE.Mesh(coneGeo, canopyMats[Math.floor(rng() * canopyMats.length)])
      canopy.position.y = 8
      canopy.castShadow = true
      tree.add(canopy)
    } else {
      const blob = new THREE.Mesh(blobGeo, canopyMats[Math.floor(rng() * canopyMats.length)])
      blob.position.y = 7.5
      blob.scale.set(1 + rng() * 0.4, 0.8 + rng() * 0.3, 1 + rng() * 0.4)
      blob.castShadow = true
      tree.add(blob)
    }

    tree.position.set(x, h - 0.2, z)
    tree.scale.setScalar(scale)
    tree.rotation.y = rng() * Math.PI * 2
    group.add(tree)

    // Solid trunk the player must walk around
    circles?.push({ x, z, r: 0.6 * scale + 0.25 })
  }

  return group
}

export function createRocks(circles?: Array<{ x: number; z: number; r: number }>): THREE.Group {
  const group = new THREE.Group()
  const rng = mulberry32(777)
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x83868c, roughness: 1 })
  const geo = new THREE.DodecahedronGeometry(1, 0)

  for (let i = 0; i < 140; i++) {
    const x = (rng() * 2 - 1) * HALF_WORLD * 0.98
    const z = (rng() * 2 - 1) * HALF_WORLD * 0.98
    if (Math.hypot(x + 380, z + 380) < 55) continue
    if (Math.hypot(x - 380, z - 380) < 55) continue
    const h = heightAt(x, z)
    if (h < -2) continue

    const scale = 0.8 + rng() * 2.6
    const rock = new THREE.Mesh(geo, rockMat)
    rock.position.set(x, h + scale * 0.35, z)
    rock.scale.set(scale, scale * (0.6 + rng() * 0.5), scale * (0.8 + rng() * 0.4))
    rock.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI)
    rock.castShadow = true
    rock.receiveShadow = true
    group.add(rock)

    // Big rocks are solid; pebbles stay walkable
    if (scale > 1.4) circles?.push({ x, z, r: scale * 0.8 })
  }

  return group
}

export function createBushes(): THREE.Group {
  const group = new THREE.Group()
  const rng = mulberry32(4242)
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x5d7a3d, roughness: 1 })
  const geo = new THREE.IcosahedronGeometry(1, 0)

  for (let i = 0; i < 400; i++) {
    const x = (rng() * 2 - 1) * HALF_WORLD * 0.97
    const z = (rng() * 2 - 1) * HALF_WORLD * 0.97
    if (Math.hypot(x + 380, z + 380) < 52) continue
    if (Math.hypot(x - 380, z - 380) < 52) continue
    const h = heightAt(x, z)
    if (h < 0.5) continue

    const scale = 0.5 + rng() * 1.3
    const bush = new THREE.Mesh(geo, bushMat)
    bush.position.set(x, h + scale * 0.5, z)
    bush.scale.set(scale * 1.4, scale * 0.8, scale * 1.4)
    bush.rotation.y = rng() * Math.PI
    bush.castShadow = true
    group.add(bush)
  }

  return group
}

export function createClouds(): THREE.Group {
  const group = new THREE.Group()
  const rng = mulberry32(31337)
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    transparent: true,
    opacity: 0.92,
    flatShading: true,
  })
  const geo = new THREE.IcosahedronGeometry(1, 1)

  for (let i = 0; i < 26; i++) {
    const cloud = new THREE.Group()
    const puffs = 3 + Math.floor(rng() * 4)
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(geo, cloudMat)
      puff.position.set((rng() * 2 - 1) * 14, (rng() * 2 - 1) * 3, (rng() * 2 - 1) * 8)
      puff.scale.set(8 + rng() * 14, 4 + rng() * 6, 7 + rng() * 12)
      cloud.add(puff)
    }
    cloud.position.set((rng() * 2 - 1) * 700, 130 + rng() * 70, (rng() * 2 - 1) * 700)
    group.add(cloud)
  }

  return group
}
