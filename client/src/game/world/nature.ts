import * as THREE from 'three'
import { heightAt, HALF_WORLD } from './terrain'
import { firstMeshGeometry, loadModel, toStandardMaterial } from './assets'

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

/**
 * Hundreds of identical props are drawn as one InstancedMesh per geometry/material pair
 * (one draw call each instead of one per object). The random layout is unchanged: every
 * generator consumes the RNG in exactly the same order as the per-object version did.
 */
function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], cast: boolean, receive = false) {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length)
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = cast
  mesh.receiveShadow = receive
  mesh.computeBoundingSphere()
  return mesh
}

const compose = (x: number, y: number, z: number, euler: THREE.Euler, sx: number, sy: number, sz: number) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(sx, sy, sz))

type RockVariant = 'rock1' | 'rock2' | 'rock3' | 'rock4'
const ROCK_VARIANTS: RockVariant[] = ['rock1', 'rock2', 'rock3', 'rock4']
/** The rune stone is tall and thin; keep it a landmark rather than a tower. */
const ROCK_HEIGHT_FACTOR: Record<RockVariant, number> = { rock1: 1, rock2: 1, rock3: 1, rock4: 0.45 }

/** Deterministic (same on every client): big rocks are mossy piles, boulders, or the odd rune stone. */
function rockVariant(index: number, scale: number): RockVariant {
  const h = Math.imul(index + 1, 2654435761) >>> 0
  if (scale > 2.6 && h % 9 === 0) return 'rock4'
  if (scale > 2.0) return h % 2 ? 'rock3' : 'rock2'
  if (scale > 1.4) return (['rock3', 'rock2', 'rock1'] as const)[h % 3]
  return h % 2 ? 'rock1' : 'rock2'
}

/** A rock model scaled so its footprint radius is 1 (like the placeholder), sitting on y = 0. */
async function loadRockVariant(variant: RockVariant) {
  const part = firstMeshGeometry((await loadModel(`/models/${variant}.glb`)).scene)
  if (!part) throw new Error(`${variant} has no mesh`)
  const { geometry } = part
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2
  geometry.translate(-center.x, -box.min.y, -center.z)
  geometry.scale(1 / radius, ROCK_HEIGHT_FACTOR[variant] / radius, 1 / radius)
  geometry.computeBoundingSphere()
  return { geometry, material: toStandardMaterial(part.material) }
}

/** Rocks further than this are lost in the fog: not drawn. Only rocks inside the shadow area cast shadows. */
const ROCK_DRAW_DISTANCE = 600
const ROCK_SHADOW_DISTANCE = 190
const ROCK_REBUILD_STEP = 8
const EXTRA_STONE_ATTEMPTS = 900

export interface RockField {
  group: THREE.Group
  placements: Array<{ x: number; h: number; z: number; scale: number }>
  /** Re-sort rocks into near (shadow-casting) / far / hidden sets when the camera has moved. */
  update: (camera: THREE.Vector3) => void
}

export function createRocks(circles?: Array<{ x: number; z: number; r: number }>): RockField {
  const group = new THREE.Group()
  const rng = mulberry32(777)
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x83868c, roughness: 1 })
  const geo = new THREE.DodecahedronGeometry(1, 0)
  const rocks: THREE.Matrix4[] = []
  const placed: Array<{ x: number; h: number; z: number; scale: number; sy: number; sz: number; ry: number }> = []

  for (let i = 0; i < 140; i++) {
    const x = (rng() * 2 - 1) * HALF_WORLD * 0.98
    const z = (rng() * 2 - 1) * HALF_WORLD * 0.98
    if (Math.hypot(x + 380, z + 380) < 55) continue
    if (Math.hypot(x - 380, z - 380) < 55) continue
    const h = heightAt(x, z)
    if (h < -2) continue

    const scale = 0.8 + rng() * 2.6
    const sy = scale * (0.6 + rng() * 0.5)
    const sz = scale * (0.8 + rng() * 0.4)
    const rx = rng() * Math.PI
    const ry = rng() * Math.PI
    const rz = rng() * Math.PI
    rocks.push(compose(x, h + scale * 0.35, z, new THREE.Euler(rx, ry, rz), scale, sy, sz))
    placed.push({ x, h, z, scale, sy, sz, ry })

    // Big rocks are solid; pebbles stay walkable
    if (scale > 1.4) circles?.push({ x, z, r: scale * 0.8 })
  }

  // Extra stones, mostly small, gathered in loose clusters (own seed: the rocks above keep their places)
  const extra = mulberry32(4444)
  const clusters = (x: number, z: number) => 0.35 + 0.35 * Math.sin(x * 0.013 + 0.8) * Math.cos(z * 0.015 - 0.3) + 0.3 * Math.sin((x + z) * 0.031)
  for (let i = 0; i < EXTRA_STONE_ATTEMPTS; i++) {
    const x = (extra() * 2 - 1) * HALF_WORLD * 0.97
    const z = (extra() * 2 - 1) * HALF_WORLD * 0.97
    const keep = extra(), big = extra(), size = extra(), sy = extra(), sz = extra(), ry = extra() * Math.PI
    if (keep > clusters(x, z)) continue
    if (Math.hypot(x + 380, z + 380) < 58 || Math.hypot(x - 380, z - 380) < 58) continue
    const h = heightAt(x, z)
    if (h < -1) continue
    const scale = big < 0.1 ? 1.6 + size * 1.0 : 0.35 + size * 1.0
    const ys = scale * (0.6 + sy * 0.5), zs = scale * (0.8 + sz * 0.4)
    rocks.push(compose(x, h + scale * 0.35, z, new THREE.Euler(0, ry, 0), scale, ys, zs))
    placed.push({ x, h, z, scale, sy: ys, sz: zs, ry })
    if (scale > 1.4) circles?.push({ x, z, r: scale * 0.8 })
  }

  // Simple stand-in rocks until the real models load, so bullets are blocked from the first frame
  const standIn = instanced(geo, rockMat, rocks, true, true)
  group.add(standIn)

  const sets: Array<{ near: THREE.InstancedMesh; far: THREE.InstancedMesh; rocks: Array<{ x: number; z: number; scale: number; matrix: THREE.Matrix4 }> }> = []
  const last = new THREE.Vector3(Infinity, 0, Infinity)
  const rebuild = (camera: THREE.Vector3) => {
    last.copy(camera)
    for (const set of sets) {
      let near = 0, far = 0
      for (const rock of set.rocks) {
        const d = Math.hypot(rock.x - camera.x, rock.z - camera.z)
        // Small stones are dots long before big rocks are: draw distance grows with size
        if (d > Math.min(ROCK_DRAW_DISTANCE, 90 + rock.scale * 190)) continue
        if (d < ROCK_SHADOW_DISTANCE) set.near.setMatrixAt(near++, rock.matrix)
        else set.far.setMatrixAt(far++, rock.matrix)
      }
      set.near.count = near
      set.far.count = far
      for (const mesh of [set.near, set.far]) {
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
      }
    }
  }

  void Promise.all(ROCK_VARIANTS.map(loadRockVariant)).then((loaded) => {
    const byVariant = new Map(ROCK_VARIANTS.map((v, i) => [v, { ...loaded[i], rocks: [] as Array<{ x: number; z: number; scale: number; matrix: THREE.Matrix4 }> }]))
    placed.forEach((r, i) => {
      // Real rocks stay upright (a random tilt would put moss underneath), sunk a little into the slope
      byVariant.get(rockVariant(i, r.scale))!.rocks.push({
        x: r.x,
        z: r.z,
        scale: r.scale,
        matrix: compose(r.x, r.h - 0.12 * r.scale, r.z, new THREE.Euler(0, r.ry * 2, 0), r.scale, r.sy, r.sz),
      })
    })
    for (const v of byVariant.values()) {
      if (!v.rocks.length) continue
      const near = instanced(v.geometry, v.material, v.rocks.map((r) => r.matrix), true, true)
      const far = instanced(v.geometry, v.material, v.rocks.map((r) => r.matrix), false, true)
      group.add(near, far)
      sets.push({ near, far, rocks: v.rocks })
    }
    group.remove(standIn)
    geo.dispose()
    rockMat.dispose()
    if (Number.isFinite(last.x)) rebuild(last)
  }).catch((error) => console.error('[nature] rock models failed to load, keeping simple rocks:', error))

  return {
    group,
    placements: placed.map(({ x, h, z, scale }) => ({ x, h, z, scale })),
    update(camera) {
      if (!sets.length) { last.copy(camera); return }
      if (Math.hypot(camera.x - last.x, camera.z - last.z) > ROCK_REBUILD_STEP) rebuild(camera)
    },
  }
}

export function createBushes(circles?: Array<{ x: number; z: number; r: number }>): THREE.Group {
  const group = new THREE.Group()
  const rng = mulberry32(4242)
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x5d7a3d, roughness: 1 })
  const geo = new THREE.IcosahedronGeometry(1, 0)
  const bushes: THREE.Matrix4[] = []

  for (let i = 0; i < 400; i++) {
    const x = (rng() * 2 - 1) * HALF_WORLD * 0.97
    const z = (rng() * 2 - 1) * HALF_WORLD * 0.97
    if (Math.hypot(x + 380, z + 380) < 52) continue
    if (Math.hypot(x - 380, z - 380) < 52) continue
    const h = heightAt(x, z)
    if (h < 0.5) continue

    const scale = 0.5 + rng() * 1.3
    bushes.push(compose(x, h + scale * 0.5, z, new THREE.Euler(0, rng() * Math.PI, 0), scale * 1.4, scale * 0.8, scale * 1.4))
    circles?.push({ x, z, r: scale * 0.95 })
  }

  group.add(instanced(geo, bushMat, bushes, true))
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
  const puffs: THREE.Matrix4[] = []

  for (let i = 0; i < 26; i++) {
    const count = 3 + Math.floor(rng() * 4)
    const local: THREE.Matrix4[] = []
    for (let p = 0; p < count; p++) {
      const px = (rng() * 2 - 1) * 14
      const py = (rng() * 2 - 1) * 3
      const pz = (rng() * 2 - 1) * 8
      const sx = 8 + rng() * 14
      const sy = 4 + rng() * 6
      const sz = 7 + rng() * 12
      local.push(compose(px, py, pz, new THREE.Euler(), sx, sy, sz))
    }
    const cloud = new THREE.Matrix4().makeTranslation((rng() * 2 - 1) * 700, 130 + rng() * 70, (rng() * 2 - 1) * 700)
    for (const m of local) puffs.push(cloud.clone().multiply(m))
  }

  group.add(instanced(geo, cloudMat, puffs, false))
  return group
}

const GRASS_URL = '/models/grass.glb'
/** Grass is purely visual: drawn only near the camera, in square chunks so off-screen/far ones are skipped. */
const GRASS_CHUNK = 64
const GRASS_DRAW_DISTANCE = 120
/** Within this distance every clump is drawn; further out only every other one. */
const GRASS_FULL_DENSITY_DISTANCE = 55
const GRASS_CLUMPS = 34000
const GRASS_HEIGHT = 0.9

export interface GrassField {
  group: THREE.Group
  update: (camera: THREE.Vector3) => void
}

/** Clumps of grass in natural-looking patches (denser meadows, bare stretches), never inside `exclude`. */
export function createGrass(exclude: (x: number, z: number) => boolean): GrassField {
  const group = new THREE.Group()
  group.name = 'grass'
  const rng = mulberry32(9090)
  // Large, soft patches: 0 = bare, 1 = meadow
  const meadow = (x: number, z: number) =>
    THREE.MathUtils.clamp(0.8 + 0.25 * Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.017 - 0.7) + 0.2 * Math.sin((x + z) * 0.043) + 0.1 * Math.cos((x - z) * 0.09), 0, 1)
  const chunks = new Map<string, { cx: number; cz: number; matrices: THREE.Matrix4[] }>()
  let placed = 0
  for (let attempt = 0; attempt < GRASS_CLUMPS * 6 && placed < GRASS_CLUMPS; attempt++) {
    const x = (rng() * 2 - 1) * HALF_WORLD * 0.97
    const z = (rng() * 2 - 1) * HALF_WORLD * 0.97
    const keep = rng()
    const yaw = rng() * Math.PI * 2
    const size = 0.7 + rng() * 0.65
    if (keep > meadow(x, z)) continue
    const h = heightAt(x, z)
    if (h < -1.8 || exclude(x, z)) continue
    const cx = Math.floor(x / GRASS_CHUNK)
    const cz = Math.floor(z / GRASS_CHUNK)
    const key = `${cx},${cz}`
    let chunk = chunks.get(key)
    if (!chunk) chunks.set(key, (chunk = { cx: (cx + 0.5) * GRASS_CHUNK, cz: (cz + 0.5) * GRASS_CHUNK, matrices: [] }))
    chunk.matrices.push(compose(x, h - 0.05, z, new THREE.Euler(0, yaw, 0), size, size * (0.85 + (size - 0.7) * 0.4), size))
    placed++
  }

  const meshes: Array<{ mesh: THREE.InstancedMesh; cx: number; cz: number; fullOnly: boolean }> = []
  void loadModel(GRASS_URL).then((gltf) => {
    const part = firstMeshGeometry(gltf.scene)
    if (!part) return
    const { geometry } = part
    geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const center = box.getCenter(new THREE.Vector3())
    geometry.translate(-center.x, -box.min.y, -center.z)
    geometry.scale(GRASS_HEIGHT / (box.max.y - box.min.y), GRASS_HEIGHT / (box.max.y - box.min.y), GRASS_HEIGHT / (box.max.y - box.min.y))
    const source = part.material as THREE.MeshStandardMaterial
    // Lambert + alpha test: the cheapest shading that still lets the blades catch the sun
    // Lifted a little so clumps blend with the terrain instead of reading as dark specks from afar
    const material = new THREE.MeshLambertMaterial({ map: source.map ?? null, color: 0xf2ffd8, emissive: 0x1c2a12, alphaTest: 0.45, side: THREE.DoubleSide })
    for (const chunk of chunks.values()) {
      // Two halves per chunk: the second half is only drawn close to the camera
      for (const [half, fullOnly] of [[0, false], [1, true]] as const) {
        const matrices = chunk.matrices.filter((_, i) => i % 2 === half)
        if (!matrices.length) continue
        const mesh = instanced(geometry, material, matrices, false)
        // Walk-through decoration: never blocks bullets or the player
        mesh.raycast = () => {}
        mesh.visible = false
        group.add(mesh)
        meshes.push({ mesh, cx: chunk.cx, cz: chunk.cz, fullOnly })
      }
    }
  }).catch((error) => console.error('[nature] grass model failed to load:', error))

  const reach = GRASS_DRAW_DISTANCE + GRASS_CHUNK * 0.71
  const fullReach = GRASS_FULL_DENSITY_DISTANCE + GRASS_CHUNK * 0.71
  return {
    group,
    update(camera) {
      for (const { mesh, cx, cz, fullOnly } of meshes) mesh.visible = Math.hypot(camera.x - cx, camera.z - cz) < (fullOnly ? fullReach : reach)
    },
  }
}
