import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { loadModel, toStandardMaterial } from './assets'
import { heightAt, HALF_WORLD } from './terrain'

type Species = 'pine' | 'leafy'
const SPECIES: Species[] = ['pine', 'leafy']

interface SpeciesDef {
  model: string
  /** The model casts shadows up to `shadowDistance`, is drawn without them up to `modelDistance`, then a flat cut-out. */
  shadowDistance: number
  modelDistance: number
  height: [number, number]
  /** Trunk radius (m) for bullets and walking. */
  trunk: number
}

const DEFS: Record<Species, SpeciesDef> = {
  pine: { model: '/models/tree_pine.glb', shadowDistance: 60, modelDistance: 110, height: [9, 15], trunk: 0.4 },
  leafy: { model: '/models/tree_leafy.glb', shadowDistance: 40, modelDistance: 60, height: [7.5, 11], trunk: 0.5 },
}

const TREE_COUNT = 520
const MIN_SPACING = 3.5
/** Re-sort trees into detail levels after the camera moves this far. */
const REBUILD_STEP = 5
const IMPOSTOR_SIZE = 256

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

interface Part { geometry: THREE.BufferGeometry; material: THREE.Material }

/** Tree parts merged per material, normalised to 1 unit tall, standing on y = 0. */
async function loadTreeParts(url: string): Promise<{ parts: Part[]; width: number }> {
  const root = (await loadModel(url)).scene
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>()
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld))
    for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name)
    if (!byMaterial.has(material)) byMaterial.set(material, [])
    byMaterial.get(material)!.push(geometry)
  })
  const merged: Part[] = []
  const box = new THREE.Box3()
  for (const [material, geometries] of byMaterial) {
    const geometry = geometries.length > 1 ? mergeGeometries(geometries.map((g) => (g.index ? g.toNonIndexed() : g))) : geometries[0]
    if (!geometry) continue
    geometry.computeBoundingBox()
    box.union(geometry.boundingBox!)
    merged.push({ geometry, material: treeMaterial(material) })
  }
  const f = { center: box.getCenter(new THREE.Vector3()), minY: box.min.y, height: box.max.y - box.min.y }
  for (const part of merged) {
    part.geometry.translate(-f.center.x, -f.minY, -f.center.z)
    part.geometry.scale(1 / f.height, 1 / f.height, 1 / f.height)
    part.geometry.computeBoundingSphere()
  }
  const size = box.getSize(new THREE.Vector3())
  return { parts: merged, width: Math.max(size.x, size.z) / f.height }
}

/**
 * Leaves: alpha-tested instead of alpha-blended, so they write depth, need no sorting and cast
 * cut-out shadows. Physical materials become standard ones (cheaper, same textures).
 */
function treeMaterial(source: THREE.Material): THREE.Material {
  const material = toStandardMaterial(source).clone()
  if (source.transparent || material.map) {
    const leafy = source.transparent
    material.transparent = false
    material.depthWrite = true
    if (leafy) {
      material.alphaTest = 0.5
      material.side = THREE.DoubleSide
    }
  }
  return material
}

/** A flat cut-out of the tree, rendered once from the side: 4 triangles for trees far away. */
function bakeImpostor(renderer: THREE.WebGLRenderer, parts: Part[], width: number): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x4a5a33, 1.1))
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.4)
  sun.position.set(-0.6, 1.2, 1)
  scene.add(sun)
  for (const part of parts) scene.add(new THREE.Mesh(part.geometry, part.material))
  const half = width / 2
  const camera = new THREE.OrthographicCamera(-half, half, 1, 0, -10, 10)
  camera.position.set(0, 0, 5)
  camera.lookAt(0, 0, 0)
  const target = new THREE.WebGLRenderTarget(IMPOSTOR_SIZE, Math.round(IMPOSTOR_SIZE / Math.max(width, 0.25)), { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter })
  target.texture.colorSpace = THREE.SRGBColorSpace
  const previousTarget = renderer.getRenderTarget()
  const previousColor = renderer.getClearColor(new THREE.Color())
  const previousAlpha = renderer.getClearAlpha()
  const shadows = renderer.shadowMap.enabled
  renderer.shadowMap.enabled = false
  renderer.setRenderTarget(target)
  renderer.setClearColor(0x000000, 0)
  renderer.clear()
  renderer.render(scene, camera)
  renderer.setRenderTarget(previousTarget)
  renderer.setClearColor(previousColor, previousAlpha)
  renderer.shadowMap.enabled = shadows

  // Two crossed quads, so the cut-out has some volume from any angle
  const a = new THREE.PlaneGeometry(width, 1)
  a.translate(0, 0.5, 0)
  const b = a.clone().rotateY(Math.PI / 2)
  const geometry = mergeGeometries([a, b])!
  geometry.computeBoundingSphere()
  const material = new THREE.MeshBasicMaterial({ map: target.texture, alphaTest: 0.5, side: THREE.DoubleSide })
  return { geometry, material }
}

interface Tree { x: number; y: number; z: number; height: number; yaw: number; species: Species; matrix: THREE.Matrix4 }

export interface ForestField {
  /** What is drawn (never hit by bullets: leaves and cut-outs let shots through). */
  group: THREE.Group
  /** Invisible trunks: bullets stop here. */
  trunks: THREE.Group
  trees: Array<{ x: number; z: number; height: number; species: Species }>
  update: (camera: THREE.Vector3) => void
}

/**
 * Trees in natural groves with clearings between them (same layout on every client). Near trees use
 * the full models, then lighter ones, and far away a baked cut-out, so hundreds of trees stay cheap.
 */
export function createForest(renderer: THREE.WebGLRenderer, circles: Array<{ x: number; z: number; r: number }>, avoid: (x: number, z: number) => boolean): ForestField {
  const group = new THREE.Group()
  group.name = 'forest'
  const trunks = new THREE.Group()
  trunks.name = 'tree-trunks'
  const rng = mulberry32(20260926)
  const grove = (x: number, z: number) =>
    THREE.MathUtils.clamp(0.42 + 0.45 * Math.sin(x * 0.0095 + 0.4) * Math.cos(z * 0.011 - 1.1) + 0.3 * Math.sin((x - z) * 0.023 + 2) + 0.15 * Math.cos((x + z) * 0.05), 0, 1)
  const cell = new Map<string, Array<{ x: number; z: number }>>()
  const key = (x: number, z: number) => `${Math.floor(x / MIN_SPACING)},${Math.floor(z / MIN_SPACING)}`
  const crowded = (x: number, z: number) => {
    const cx = Math.floor(x / MIN_SPACING), cz = Math.floor(z / MIN_SPACING)
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const t of cell.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(t.x - x, t.z - z) < MIN_SPACING) return true
    }
    return false
  }
  const rockCircles = [...circles]

  const trees: Tree[] = []
  for (let attempt = 0; attempt < TREE_COUNT * 12 && trees.length < TREE_COUNT; attempt++) {
    const x = (rng() * 2 - 1) * HALF_WORLD * 0.96
    const z = (rng() * 2 - 1) * HALF_WORLD * 0.96
    const keep = rng(), kind = rng(), size = rng(), yaw = rng() * Math.PI * 2
    if (keep > grove(x, z) ** 1.6) continue
    const h = heightAt(x, z)
    if (h < 1.2 || avoid(x, z) || crowded(x, z)) continue
    if (rockCircles.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + 1.5)) continue
    // Pines on higher ground, leafy trees in the lowlands
    const species: Species = kind < (h > 5 ? 0.75 : 0.3) ? 'pine' : 'leafy'
    const [lo, hi] = DEFS[species].height
    const height = lo + size * (hi - lo)
    const y = h - 0.15
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(height, height, height))
    trees.push({ x, y, z, height, yaw, species, matrix })
    const k = key(x, z)
    if (!cell.has(k)) cell.set(k, [])
    cell.get(k)!.push({ x, z })
    circles.push({ x, z, r: DEFS[species].trunk + 0.2 })
  }

  // Bullet blockers: an invisible trunk per tree (present before any model loads)
  const trunkGeometry = new THREE.CylinderGeometry(1, 1, 1, 8)
  trunkGeometry.translate(0, 0.5, 0)
  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshBasicMaterial({ visible: false }), trees.length)
  trees.forEach((t, i) => {
    const r = DEFS[t.species].trunk
    trunkMesh.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(), new THREE.Vector3(r, t.height * 0.55, r)))
  })
  trunkMesh.computeBoundingSphere()
  trunks.add(trunkMesh)

  type Level = { meshes: THREE.InstancedMesh[]; count: number }
  const levels = new Map<Species, { shadowed: Level; plain: Level; far: Level; trees: Tree[] }>()
  const last = new THREE.Vector3(Infinity, 0, Infinity)
  const noRaycast = () => {}
  const makeLevel = (parts: Part[], capacity: number, shadows: boolean): Level => {
    const meshes = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity)
      mesh.count = 0
      mesh.castShadow = shadows
      mesh.receiveShadow = true
      mesh.raycast = noRaycast
      group.add(mesh)
      return mesh
    })
    return { meshes, count: 0 }
  }
  const rebuild = (camera: THREE.Vector3) => {
    last.copy(camera)
    for (const [species, set] of levels) {
      const def = DEFS[species]
      const counts = { shadowed: 0, plain: 0, far: 0 }
      for (const t of set.trees) {
        const d = Math.hypot(t.x - camera.x, t.z - camera.z)
        const level = d < def.shadowDistance ? 'shadowed' : d < def.modelDistance ? 'plain' : 'far'
        for (const mesh of set[level].meshes) mesh.setMatrixAt(counts[level], t.matrix)
        counts[level]++
      }
      for (const level of ['shadowed', 'plain', 'far'] as const) {
        for (const mesh of set[level].meshes) {
          mesh.count = counts[level]
          mesh.instanceMatrix.needsUpdate = true
          mesh.computeBoundingSphere()
        }
      }
    }
  }

  for (const species of SPECIES) {
    const def = DEFS[species]
    const mine = trees.filter((t) => t.species === species)
    if (!mine.length) continue
    void (async () => {
      const model = await loadTreeParts(def.model)
      const impostor = bakeImpostor(renderer, model.parts, model.width)
      levels.set(species, {
        shadowed: makeLevel(model.parts, mine.length, true),
        plain: makeLevel(model.parts, mine.length, false),
        far: makeLevel([impostor], mine.length, false),
        trees: mine,
      })
      if (Number.isFinite(last.x)) rebuild(last)
    })().catch((error) => console.error(`[forest] ${species} trees failed to load:`, error))
  }

  return {
    group,
    trunks,
    trees: trees.map(({ x, z, height, species }) => ({ x, z, height, species })),
    update(camera) {
      if (!levels.size) { last.copy(camera); return }
      if (Math.hypot(camera.x - last.x, camera.z - last.z) > REBUILD_STEP) rebuild(camera)
    },
  }
}
