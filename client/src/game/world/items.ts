import * as THREE from 'three'
import { heightAt } from './terrain'
import { loadProp, propInstances, type Prop, type PropName } from './props'
import { baseToWorld, baseYaw, LAYOUT, type Team } from './layout'
import type { WeaponKind } from './weapons'

/**
 * Things lying around that anyone (either team) can take with [G]: anti-aircraft launchers on each base's
 * rack, missile crates (4 missiles each), ammo boxes, and weapons players dropped or left where they died.
 * The server owns the list and the counts; this draws it and finds what is in reach.
 */
export type ItemKind = WeaponKind | 'missiles' | 'ammo-primary' | 'ammo-handgun'

export interface NetItem {
  id: string
  kind: ItemKind
  x: number
  z: number
  /** Heading on the ground (radians, world). */
  yaw: number
  /** Rounds / missiles inside (a weapon's spare rounds, a crate's missiles, a box's rounds). */
  count: number
  /** A weapon's loaded magazine. */
  mag: number
  /** Part of a base's stock (on the rack / crate / box spot) rather than dropped by a player. */
  fixed: boolean
  /** Taken from the rack and not back yet. */
  gone?: boolean
}

export const ITEM_LABEL: Record<ItemKind, string> = {
  handgun: 'handgun',
  primary: 'primary gun',
  launcher: 'AA launcher',
  missiles: 'AA missiles',
  'ammo-primary': 'primary gun ammo',
  'ammo-handgun': 'handgun ammo',
}

/** Which weapon's spare rounds an item holds. */
export const AMMO_OF: Record<ItemKind, WeaponKind> = {
  handgun: 'handgun', primary: 'primary', launcher: 'launcher', missiles: 'launcher', 'ammo-primary': 'primary', 'ammo-handgun': 'handgun',
}

const RACK_TOP = 0.9
/** Reach for [G]: horizontal distance from the player. */
export const ITEM_REACH = 2.4

type Visual = 'launcher' | 'handgun' | 'primary' | 'missile' | 'missile_crate' | 'ammo_556' | 'ammo_9mm'
const PROP_OF: Record<Visual, PropName> = {
  launcher: 'launcher', handgun: 'handgun', primary: 'primary', missile: 'missile', missile_crate: 'missile_crate', ammo_556: 'ammo_556', ammo_9mm: 'ammo_9mm',
}
const CAPACITY: Record<Visual, number> = { launcher: 90, handgun: 70, primary: 70, missile: 120, missile_crate: 20, ammo_556: 16, ammo_9mm: 16 }
/** Items further than this aren't drawn (small things, lost in the distance). */
const DRAW_DISTANCE = 220

export interface ItemField {
  group: THREE.Group
  items: Map<string, NetItem>
  /** Replace everything (joining / reconnecting). */
  reset: (items: NetItem[]) => void
  upsert: (item: NetItem) => void
  remove: (id: string) => void
  /** The closest item within reach of a player standing at `feet`. */
  nearest: (feet: THREE.Vector3) => NetItem | null
  /** Where an item sits (for effects and prompts). */
  positionOf: (item: NetItem) => THREE.Vector3
  update: (camera: THREE.Vector3) => void
}

export function createItems(): ItemField {
  const group = new THREE.Group()
  group.name = 'items'
  const items = new Map<string, NetItem>()
  const meshes = new Map<Visual, { prop: Prop; meshes: THREE.InstancedMesh[] }>()
  let dirty = true
  let lastCamera = new THREE.Vector3(Infinity, 0, Infinity)

  // The launcher racks: a long table in front of each warehouse
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.9 })
  const rack = LAYOUT.launcherRack
  const rackLength = (rack.count - 1) * rack.dx + 1.6
  const rackParts: THREE.BufferGeometry[] = []
  const top = new THREE.BoxGeometry(rackLength, 0.08, 1.9)
  top.translate(0, RACK_TOP - 0.04, 0)
  rackParts.push(top)
  for (const x of [-rackLength / 2 + 0.2, 0, rackLength / 2 - 0.2]) for (const z of [-0.8, 0.8]) {
    const leg = new THREE.BoxGeometry(0.1, RACK_TOP, 0.1)
    leg.translate(x, RACK_TOP / 2, z)
    rackParts.push(leg)
  }
  for (const team of ['blue', 'red'] as Team[]) {
    const mid = rack.x0 + ((rack.count - 1) * rack.dx) / 2
    const at = baseToWorld(team, mid, rack.z)
    for (const part of rackParts) {
      const mesh = new THREE.Mesh(part, wood)
      mesh.position.set(at.x, heightAt(at.x, at.z), at.z)
      mesh.rotation.y = baseYaw(team, 0)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.raycast = () => {}
      group.add(mesh)
    }
  }

  for (const visual of Object.keys(PROP_OF) as Visual[]) {
    void loadProp(PROP_OF[visual]).then((prop) => {
      meshes.set(visual, { prop, meshes: propInstances(prop, CAPACITY[visual], false, group) })
      dirty = true
    }).catch((error) => console.error(`[items] ${visual} model failed to load:`, error))
  }

  const onRack = (item: NetItem) => item.fixed && item.kind === 'launcher'
  const positionOf = (item: NetItem) => new THREE.Vector3(item.x, heightAt(item.x, item.z) + (onRack(item) ? RACK_TOP : 0), item.z)

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3()
  const rebuild = (camera: THREE.Vector3) => {
    const used = new Map<Visual, number>()
    const place = (visual: Visual, position: THREE.Vector3, euler: THREE.Euler) => {
      const set = meshes.get(visual)
      if (!set) return
      const slot = used.get(visual) ?? 0
      if (slot >= CAPACITY[visual]) return
      used.set(visual, slot + 1)
      m.compose(position, q.setFromEuler(euler), s)
      for (const mesh of set.meshes) mesh.setMatrixAt(slot, m)
    }
    /** A gun lying on its side on the ground (or across the rack). */
    const lying = (visual: Visual, item: NetItem) => {
      const set = meshes.get(visual)
      if (!set) return
      const at = positionOf(item)
      // On its side: half its width above the surface
      at.y += (set.prop.box.max.x - set.prop.box.min.x) / 2
      place(visual, at, e.set(0, item.yaw, Math.PI / 2, 'YXZ'))
    }
    for (const item of items.values()) {
      if (item.gone) continue
      if (Math.hypot(item.x - camera.x, item.z - camera.z) > DRAW_DISTANCE) continue
      switch (item.kind) {
        case 'launcher':
        case 'handgun':
        case 'primary':
          lying(item.kind, item)
          break
        case 'missiles': {
          if (!item.fixed) {
            if (item.count > 0) lying('missile', item)
            break
          }
          const crate = meshes.get('missile_crate')
          const base = positionOf(item)
          place('missile_crate', base, e.set(0, item.yaw, 0, 'YXZ'))
          if (!crate) break
          // Missiles still in the crate: two layers of two, lying lengthways
          const box = crate.prop.box
          const depth = box.max.z - box.min.z
          for (let i = 0; i < Math.min(4, item.count); i++) {
            const local = p.set(0, 0.32 + Math.floor(i / 2) * 0.24, box.min.z + depth * (i % 2 === 0 ? 0.25 : 0.52))
            local.applyAxisAngle(new THREE.Vector3(0, 1, 0), item.yaw).add(base)
            place('missile', local.clone(), e.set(0, item.yaw + Math.PI / 2, 0, 'YXZ'))
          }
          break
        }
        case 'ammo-primary':
        case 'ammo-handgun':
          place(item.kind === 'ammo-primary' ? 'ammo_556' : 'ammo_9mm', positionOf(item), e.set(0, item.yaw, 0, 'YXZ'))
          break
      }
    }
    for (const [visual, set] of meshes) {
      for (const mesh of set.meshes) {
        mesh.count = used.get(visual) ?? 0
        mesh.instanceMatrix.needsUpdate = true
      }
    }
  }

  const nearest = (feet: THREE.Vector3) => {
    let best: NetItem | null = null
    let bestDistance = ITEM_REACH
    for (const item of items.values()) {
      if (item.gone) continue
      const d = Math.hypot(item.x - feet.x, item.z - feet.z)
      if (d >= bestDistance || Math.abs(positionOf(item).y - feet.y) > 2.5) continue
      best = item
      bestDistance = d
    }
    return best
  }

  return {
    group,
    items,
    reset(list) {
      items.clear()
      for (const item of list) items.set(item.id, item)
      dirty = true
    },
    upsert(item) {
      items.set(item.id, item)
      dirty = true
    },
    remove(id) {
      if (items.delete(id)) dirty = true
    },
    nearest,
    positionOf,
    update(camera) {
      // Re-sorting by distance only matters when the camera has moved a fair way
      if (!dirty && lastCamera.distanceToSquared(camera) < 30 * 30) return
      dirty = false
      lastCamera = camera.clone()
      rebuild(camera)
    },
  }
}
