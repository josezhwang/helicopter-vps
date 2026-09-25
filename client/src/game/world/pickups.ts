import * as THREE from 'three'
import { heightAt } from './terrain'
import type { WeaponId } from './weapons'
import { WEAPONS } from './weapons'

export interface Pickup {
  id: WeaponId
  group: THREE.Group
  position: THREE.Vector3
  taken: boolean
}

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

/** Build a little floating weapon crate model for one pickup. */
function makePickupModel(color: number): THREE.Group {
  const g = new THREE.Group()

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(1.1, 1.5, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  )
  halo.rotation.x = -Math.PI / 2
  halo.position.y = -0.9
  g.add(halo)

  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.28, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x26292e, roughness: 0.45, metalness: 0.5 }),
  )
  gun.castShadow = true
  g.add(gun)

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 }),
  )
  barrel.rotation.x = Math.PI / 2
  barrel.position.z = -0.5
  barrel.castShadow = true
  g.add(barrel)

  const tag = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7 }),
  )
  tag.position.y = 0.5
  g.add(tag)

  return g
}

/**
 * Scatter `count` weapon pickups across open land. Spawn weights favor the
 * SMG; rifle and magnum are rarer and stronger. Never inside bases or water.
 */
export function createPickups(count = 10): { group: THREE.Group; pickups: Pickup[] } {
  const group = new THREE.Group()
  const pickups: Pickup[] = []
  const rng = mulberry32(99117)

  const pool: WeaponId[] = [
    'smg', 'smg', 'smg',
    'battle-rifle', 'battle-rifle',
    'magnum',
  ]

  let placed = 0
  let attempts = 0
  while (placed < count && attempts < 600) {
    attempts++
    const x = (rng() * 2 - 1) * 400
    const z = (rng() * 2 - 1) * 400

    // Keep clear of the two bases
    if (Math.hypot(x + 380, z + 380) < 65) continue
    if (Math.hypot(x - 380, z - 380) < 65) continue
    const h = heightAt(x, z)
    if (h < 0.5) continue // no water pickups

    const def = WEAPONS[pool[Math.floor(rng() * pool.length)]]

    const g = makePickupModel(def.color)
    g.position.set(x, h + 1.1, z)
    group.add(g)

    pickups.push({
      id: def.id,
      group: g,
      position: g.position.clone(),
      taken: false,
    })
    placed++
  }

  return { group, pickups }
}

/** Spin + bob every live pickup. */
export function updatePickups(pickups: Pickup[], time: number) {
  for (const p of pickups) {
    if (p.taken) continue
    p.group.rotation.y = time * 1.4
    p.group.position.y = p.position.y + Math.sin(time * 2 + p.position.x) * 0.18
  }
}
