import * as THREE from 'three'
import { heightAt } from './terrain'
import { loadProp, propInstances, type Prop, type PropName } from './props'
import { baseToWorld, baseYaw, LAYOUT, type Team } from './layout'
import { AMMO, WEAPONS, WEAPON_KINDS, type AmmoType, type WeaponKind } from './weapons'

/**
 * Things lying around that anyone (either team) can take with [G]: long guns on each base's gun table,
 * anti-aircraft launchers on its rack, missile crates (4 missiles each), ammo boxes, and weapons players
 * dropped or left where they died. The server owns the list and the counts; this draws it and finds what is
 * in reach.
 */
export type ItemKind = WeaponKind | `ammo-${AmmoType}`

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
  /** Part of a base's stock (on the rack / table / crate / box spot) rather than dropped by a player. */
  fixed: boolean
  /** Taken from the rack / table and not back yet. */
  gone?: boolean
}

export const isWeaponItem = (kind: ItemKind): kind is WeaponKind => (WEAPON_KINDS as string[]).includes(kind)
/** Which spare rounds an item holds. */
export const ammoOf = (kind: ItemKind): AmmoType => (isWeaponItem(kind) ? WEAPONS[kind].ammo : (kind.slice(5) as AmmoType))

export function itemLabel(kind: ItemKind): string {
  if (isWeaponItem(kind)) return WEAPONS[kind].name
  return AMMO[ammoOf(kind)].name
}

const RACK_TOP = 0.9
/** Reach for [G]: horizontal distance from the player. */
export const ITEM_REACH = 2.4

type Visual = PropName
const CAPACITY: Partial<Record<Visual, number>> = { launcher: 90, handgun: 70, primary: 70, missile: 120, missile_crate: 20, ammo_556: 60, ammo_9mm: 24, grenade: 60 }
/** Supplies further than this aren't drawn (small things, lost in the distance); guns closer still. */
const DRAW_DISTANCE = 220
const GUN_DRAW_DISTANCE = 90
/** Ammo boxes per type: 9mm has its own box, the rest share the 5.56 box in different sizes. */
const BOX: Record<AmmoType, { visual: Visual; scale: number }> = {
  '9mm': { visual: 'ammo_9mm', scale: 1 }, '556': { visual: 'ammo_556', scale: 1 }, '762': { visual: 'ammo_556', scale: 1.4 },
  sniper: { visual: 'ammo_556', scale: 0.8 }, plasma: { visual: 'ammo_556', scale: 1.1 }, missile: { visual: 'missile_crate', scale: 1 },
  grenade: { visual: 'ammo_556', scale: 1.25 },
}

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

/** A plain table: a top and six legs, `length` along its local X. */
function tableParts(length: number, depth: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = []
  const top = new THREE.BoxGeometry(length, 0.08, depth)
  top.translate(0, RACK_TOP - 0.04, 0)
  parts.push(top)
  for (const x of [-length / 2 + 0.2, 0, length / 2 - 0.2]) for (const z of [-depth / 2 + 0.1, depth / 2 - 0.1]) {
    const leg = new THREE.BoxGeometry(0.1, RACK_TOP, 0.1)
    leg.translate(x, RACK_TOP / 2, z)
    parts.push(leg)
  }
  return parts
}

export function createItems(): ItemField {
  const group = new THREE.Group()
  group.name = 'items'
  const items = new Map<string, NetItem>()
  const meshes = new Map<Visual, { prop: Prop; meshes: THREE.InstancedMesh[] }>()
  let dirty = true
  let lastCamera = new THREE.Vector3(Infinity, 0, Infinity)

  // Each base's launcher rack (in front of the warehouse) and gun table (beside the helicopters)
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.9 })
  const rack = LAYOUT.launcherRack, table = LAYOUT.gunTable
  const tables = [
    { parts: tableParts((rack.count - 1) * rack.dx + 1.6, 1.9), center: [rack.x0 + ((rack.count - 1) * rack.dx) / 2, rack.z] as const, turn: 0 },
    { parts: tableParts((table.count - 1) * table.dz + 1.6, 1.6), center: [table.x, table.z0 + ((table.count - 1) * table.dz) / 2] as const, turn: Math.PI / 2 },
  ]
  for (const team of ['blue', 'red'] as Team[]) {
    for (const t of tables) {
      const at = baseToWorld(team, t.center[0], t.center[1])
      for (const part of t.parts) {
        const mesh = new THREE.Mesh(part, wood)
        mesh.position.set(at.x, heightAt(at.x, at.z), at.z)
        mesh.rotation.y = baseYaw(team, t.turn)
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.raycast = () => {}
        group.add(mesh)
      }
    }
  }

  const visuals: Visual[] = [...new Set<Visual>([...WEAPON_KINDS.map((k) => WEAPONS[k].model), 'missile', 'missile_crate', 'ammo_556', 'ammo_9mm', 'grenade'])]
  for (const visual of visuals) {
    void loadProp(visual).then((prop) => {
      meshes.set(visual, { prop, meshes: propInstances(prop, CAPACITY[visual] ?? 40, false, group) })
      dirty = true
    }).catch((error) => console.error(`[items] ${visual} model failed to load:`, error))
  }

  const onTable = (item: NetItem) => item.fixed && isWeaponItem(item.kind)
  const positionOf = (item: NetItem) => new THREE.Vector3(item.x, heightAt(item.x, item.z) + (onTable(item) ? RACK_TOP : 0), item.z)

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3()
  const rebuild = (camera: THREE.Vector3) => {
    const used = new Map<Visual, number>()
    const place = (visual: Visual, position: THREE.Vector3, euler: THREE.Euler, scale = 1) => {
      const set = meshes.get(visual)
      if (!set) return
      const slot = used.get(visual) ?? 0
      if (slot >= (CAPACITY[visual] ?? 40)) return
      used.set(visual, slot + 1)
      m.compose(position, q.setFromEuler(euler), s.setScalar(scale))
      for (const mesh of set.meshes) mesh.setMatrixAt(slot, m)
    }
    /** A gun lying on its side on the ground (or across the rack / table). */
    const lying = (visual: Visual, item: NetItem) => {
      const set = meshes.get(visual)
      if (!set) return
      const at = positionOf(item)
      at.y += (set.prop.box.max.x - set.prop.box.min.x) / 2
      place(visual, at, e.set(0, item.yaw, Math.PI / 2, 'YXZ'))
    }
    for (const item of items.values()) {
      if (item.gone) continue
      const distance = Math.hypot(item.x - camera.x, item.z - camera.z)
      if (distance > DRAW_DISTANCE) continue
      if (isWeaponItem(item.kind)) {
        if (distance < GUN_DRAW_DISTANCE || item.kind === 'launcher') lying(WEAPONS[item.kind].model, item)
        continue
      }
      const ammo = ammoOf(item.kind)
      if (ammo === 'missile') {
        if (!item.fixed) {
          if (item.count > 0) lying('missile', item)
          continue
        }
        const crate = meshes.get('missile_crate')
        const base = positionOf(item)
        place('missile_crate', base, e.set(0, item.yaw, 0, 'YXZ'))
        if (!crate) continue
        // Missiles still in the crate: two layers of two, lying lengthways
        const box = crate.prop.box
        const depth = box.max.z - box.min.z
        for (let i = 0; i < Math.min(4, item.count); i++) {
          const local = p.set(0, 0.32 + Math.floor(i / 2) * 0.24, box.min.z + depth * (i % 2 === 0 ? 0.25 : 0.52))
          local.applyAxisAngle(new THREE.Vector3(0, 1, 0), item.yaw).add(base)
          place('missile', local.clone(), e.set(0, item.yaw + Math.PI / 2, 0, 'YXZ'))
        }
        continue
      }
      if (ammo === 'grenade') {
        // A box with grenades on top (dropped grenades: just the grenades on the ground)
        const at = positionOf(item)
        if (item.fixed) place('ammo_556', at, e.set(0, item.yaw, 0, 'YXZ'), BOX.grenade.scale)
        const top = item.fixed ? 0.42 : 0.08
        for (let i = 0; i < Math.min(3, Math.ceil(item.count / 2)); i++) {
          const local = p.set((i - 1) * 0.2, top, (i % 2) * 0.12 - 0.06).applyAxisAngle(new THREE.Vector3(0, 1, 0), item.yaw).add(at)
          place('grenade', local.clone(), e.set(0, item.yaw + i, Math.PI / 2, 'YXZ'))
        }
        continue
      }
      place(BOX[ammo].visual, positionOf(item), e.set(0, item.yaw, 0, 'YXZ'), BOX[ammo].scale)
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
      if (!dirty && lastCamera.distanceToSquared(camera) < 15 * 15) return
      dirty = false
      lastCamera = camera.clone()
      rebuild(camera)
    },
  }
}
