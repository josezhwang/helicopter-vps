import * as THREE from 'three'
import { heightAt } from './terrain'
import { loadProp, propInstances } from './props'

/**
 * Hand grenades: thrown with [Q], they arc through the air, bounce off the ground, walls, trees and vehicles,
 * roll to a stop and go off when the fuse burns down. The thrower's game flies its own grenade and says where
 * it went off (the server checks it and does the damage); everyone else's game flies the same throw and lets
 * the server's blast finish it.
 */
export const GRENADE_FUSE = 2.8
/** How hard a grenade is thrown (m/s), and how much of the thrower's own speed it keeps. */
export const THROW_SPEED = 17
const RADIUS = 0.09
const GRAVITY = 9.8
const BOUNCE = 0.3
const FRICTION = 0.62
const CAPACITY = 16
/** Someone else's grenade that never went off (they left): gone after this long. */
const REMOTE_LIFE = 9
const STEP = 1 / 90

interface Grenade {
  owner: string
  position: THREE.Vector3
  velocity: THREE.Vector3
  rotation: THREE.Quaternion
  axis: THREE.Vector3
  age: number
  /** Seconds until it goes off (null: someone else's — the server's blast ends it). */
  fuse: number | null
  resting: boolean
  onFuse?: (at: THREE.Vector3) => void
}

export interface GrenadeWorld {
  /** Walls and buildings. */
  colliders: THREE.Box3[]
  /** Trees, rocks, sandbags, vehicles: upright cylinders. */
  circles: () => Array<{ x: number; z: number; r: number }>
}

export interface Grenades {
  group: THREE.Group
  throw: (owner: string, from: THREE.Vector3, velocity: THREE.Vector3, fuse: number | null, onFuse?: (at: THREE.Vector3) => void) => void
  /** The server's blast for one of `owner`'s grenades: take their oldest one away. */
  detonate: (owner: string) => void
  /** How many of `owner`'s grenades are live. */
  live: (owner: string) => number
  /** Hook for a clink when one strikes something hard enough. */
  onBounce: ((at: THREE.Vector3, speed: number) => void) | null
  update: (dt: number) => void
}

export function createGrenades(world: GrenadeWorld): Grenades {
  const group = new THREE.Group()
  group.name = 'grenades'
  const grenades: Grenade[] = []
  let meshes: THREE.InstancedMesh[] = []
  void loadProp('grenade').then((prop) => { meshes = propInstances(prop, CAPACITY, true, group) })
    .catch((error) => console.error('[grenades] grenade model failed to load:', error))

  const normal = new THREE.Vector3(), turn = new THREE.Quaternion(), m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1)
  const api: Grenades = {
    group,
    onBounce: null,
    throw(owner, from, velocity, fuse, onFuse) {
      if (grenades.length >= CAPACITY) grenades.shift()
      const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      grenades.push({ owner, position: from.clone(), velocity: velocity.clone(), rotation: new THREE.Quaternion(), axis, age: 0, fuse, resting: false, onFuse })
    },
    detonate(owner) {
      const i = grenades.findIndex((g) => g.owner === owner && g.fuse === null)
      if (i >= 0) grenades.splice(i, 1)
    },
    live: (owner) => grenades.filter((g) => g.owner === owner).length,
    update(dt) {
      let circles: Array<{ x: number; z: number; r: number }> | null = null
      for (let i = grenades.length - 1; i >= 0; i--) {
        const g = grenades[i]
        g.age += dt
        if (g.fuse !== null) {
          g.fuse -= dt
          if (g.fuse <= 0) {
            grenades.splice(i, 1)
            g.onFuse?.(g.position.clone())
            continue
          }
        } else if (g.age > REMOTE_LIFE) {
          grenades.splice(i, 1)
          continue
        }
        if (g.resting) continue
        // Only what is near enough to hit this frame
        circles ??= world.circles()
        const p = g.position, reach = 6 + g.velocity.length() * dt
        const near = circles.filter((c) => Math.abs(c.x - p.x) < reach + c.r && Math.abs(c.z - p.z) < reach + c.r)
        const boxes = world.colliders.filter((b) => p.x > b.min.x - reach && p.x < b.max.x + reach && p.z > b.min.z - reach && p.z < b.max.z + reach)
        for (let t = 0; t < dt && !g.resting; t += STEP) move(g, Math.min(STEP, dt - t), near, boxes)
        g.rotation.premultiply(turn.setFromAxisAngle(g.axis, Math.min(18, g.velocity.length() * 2.2) * dt))
      }
      grenades.forEach((g, slot) => {
        m.compose(g.position, g.rotation, one)
        for (const mesh of meshes) mesh.setMatrixAt(slot, m)
      })
      for (const mesh of meshes) { mesh.count = grenades.length; mesh.instanceMatrix.needsUpdate = true }
    },
  }

  const bounce = (g: Grenade, n: THREE.Vector3) => {
    const into = g.velocity.dot(n)
    if (into >= 0) return
    // Reflect what goes into the surface (losing most of it); a real knock also rubs off some of what slides along it
    const along = g.velocity.clone().addScaledVector(n, -into)
    if (-into > 1) along.multiplyScalar(FRICTION)
    g.velocity.copy(along).addScaledVector(n, -into * BOUNCE)
    if (-into > 2.5) api.onBounce?.(g.position, -into)
  }

  function move(g: Grenade, h: number, circles: Array<{ x: number; z: number; r: number }>, boxes: THREE.Box3[]) {
    const p = g.position
    g.velocity.y -= GRAVITY * h
    p.addScaledVector(g.velocity, h)
    const ground = heightAt(p.x, p.z)
    // Walls and buildings (axis-aligned boxes): out through the nearest side, bouncing off it
    for (const box of boxes) {
      if (p.x < box.min.x - RADIUS || p.x > box.max.x + RADIUS || p.y < box.min.y - RADIUS || p.y > box.max.y + RADIUS || p.z < box.min.z - RADIUS || p.z > box.max.z + RADIUS) continue
      const sides = [p.x - box.min.x + RADIUS, box.max.x + RADIUS - p.x, p.y - box.min.y + RADIUS, box.max.y + RADIUS - p.y, p.z - box.min.z + RADIUS, box.max.z + RADIUS - p.z]
      const side = sides.indexOf(Math.min(...sides))
      const axis = side >> 1, sign = side % 2 === 0 ? -1 : 1
      normal.set(0, 0, 0).setComponent(axis, sign)
      p.setComponent(axis, (sign < 0 ? box.min : box.max).getComponent(axis) + sign * RADIUS)
      bounce(g, normal)
    }
    // Trunks, rocks, sandbags, vehicles
    for (const c of circles) {
      const dx = p.x - c.x, dz = p.z - c.z, min = c.r + RADIUS
      if (Math.abs(dx) > min || Math.abs(dz) > min) continue
      const d = Math.hypot(dx, dz)
      if (d >= min || d < 1e-6 || p.y > ground + 3.5) continue
      normal.set(dx / d, 0, dz / d)
      p.x = c.x + normal.x * min
      p.z = c.z + normal.z * min
      bounce(g, normal)
    }
    // The ground: bounce off its slope, then roll to a stop
    if (p.y < ground + RADIUS) {
      p.y = ground + RADIUS
      const e = 0.4
      normal.set(heightAt(p.x - e, p.z) - heightAt(p.x + e, p.z), 2 * e, heightAt(p.x, p.z - e) - heightAt(p.x, p.z + e)).normalize()
      bounce(g, normal)
      // Rolling resistance (grass)
      g.velocity.multiplyScalar(Math.max(0, 1 - h * 3.5))
      if (g.velocity.lengthSq() < 0.35 * 0.35) {
        g.velocity.set(0, 0, 0)
        g.resting = true
      }
    }
  }

  return api
}