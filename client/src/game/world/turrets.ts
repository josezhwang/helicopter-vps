import * as THREE from 'three'
import { loadModel } from './assets'
import { heightAt } from './terrain'

const MODEL_URL = '/models/machinegun.glb'
/** Simplified copy for distance; its bolts and other tiny pieces are dropped entirely (invisible that far). */
const FAR_MODEL_URL = '/models/machinegun_far.glb'
/** Guns closer than this use the detailed model and cast shadows. */
const DETAIL_DISTANCE = 70
/** Pieces smaller than this (model units, ~17cm in game) are left out of the far model. */
const TINY_PIECE = 0.3
/** Height of a turret from the ground to the top of the gun, in metres. */
const TURRET_HEIGHT = 3.2
/**
 * The model ships as ~55 loose parts with no pivots, so it is split by height (model units, y up):
 * pieces entirely below BASE_TOP stay fixed, pieces entirely above GUN_BOTTOM tilt with the gun,
 * everything in between (turntable, yoke arms, cables) turns with the turret.
 */
const BASE_TOP = 2.0
const GUN_BOTTOM = 2.7
/** Named parts in the model: the round turntable (turn axis) and the cross axle the gun tilts on. */
const TURNTABLE_PART = 'pCylinder3'
const AXLE_PART = 'pCylinder4'
/** A base's turrets are not drawn from further than this (they are a few pixels in the fog by then). */
const VISIBLE_DISTANCE = 450
export const TURRET_BLOCK_RADIUS = 2.4

type Part = 'base' | 'yaw' | 'pitch'
const PARTS: Part[] = ['base', 'yaw', 'pitch']

export interface TurretPlacement {
  x: number
  z: number
  /** Direction the barrel points when centred (radians, 0 = +Z). */
  facing: number
}

export interface Turret extends TurretPlacement {
  /** Current turn and tilt relative to `facing`; negative pitch raises the barrel. */
  yaw: number
  pitch: number
  /** While true the gun slowly scans on its own; set false to aim it by setting yaw/pitch. */
  idle: boolean
}

interface Frame {
  scale: number
  lift: number
  yawPivot: THREE.Vector3
  pitchPivot: THREE.Vector3
}

interface SplitModel extends Frame {
  pieces: Record<Part, Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>>
}

type Lod = 'near' | 'far'
const LODS: Lod[] = ['near', 'far']

let turretModels: Promise<{ near: SplitModel; far: SplitModel | null } | null> | null = null

/** Detailed model, plus the distant one aligned to the same pivots and sharing its materials. */
function loadTurretModels() {
  turretModels ??= (async () => {
    const near = await buildSplit(MODEL_URL, false)
    const far = await buildSplit(FAR_MODEL_URL, true, near).catch((error) => {
      console.warn('[turrets] far model unavailable, using full detail at every distance:', error)
      return null
    })
    if (far) {
      const byName = new Map<string, THREE.Material>()
      for (const part of PARTS) for (const piece of near.pieces[part]) byName.set(piece.material.name, piece.material)
      for (const part of PARTS) for (const piece of far.pieces[part]) piece.material = byName.get(piece.material.name) ?? piece.material
    }
    // Double-sided transparent glass would otherwise be drawn twice (back faces, then front)
    for (const part of PARTS) for (const piece of near.pieces[part]) if (piece.material.transparent) piece.material.forceSinglePass = true
    return { near, far }
  })().catch((error) => {
    console.error('[turrets] machine gun model failed to load:', error)
    return null
  })
  return turretModels
}

/**
 * Split the loose parts into base / turning / tilting pieces. Classification is per connected
 * piece, not per part: some parts are sets of small bolts spread over both the base and the gun,
 * and each bolt has to move with whatever it is screwed into.
 */
async function buildSplit(url: string, dropTiny: boolean, frame?: Frame): Promise<SplitModel> {
  {
    const gltf = await loadModel(url)
    const root = gltf.scene
    root.updateMatrixWorld(true)
    const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
    const meshes: THREE.Mesh[] = []
    root.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh) })

    const partBox = (name: string) => {
      const mesh = meshes.find((m) => m.parent?.name === name || m.name === name)
      return mesh ? new THREE.Box3().setFromObject(mesh).applyMatrix4(toRoot) : null
    }
    const all = new THREE.Box3()
    for (const mesh of meshes) all.union(new THREE.Box3().setFromObject(mesh).applyMatrix4(toRoot))
    const turntable = partBox(TURNTABLE_PART)?.getCenter(new THREE.Vector3()) ?? all.getCenter(new THREE.Vector3())
    const axle = partBox(AXLE_PART)?.getCenter(new THREE.Vector3()) ?? turntable.clone().setY((BASE_TOP + GUN_BOTTOM) / 2)
    const yawPivot = frame?.yawPivot ?? new THREE.Vector3(turntable.x, 0, turntable.z)
    const pitchPivot = frame?.pitchPivot ?? axle.clone()
    const pivotOf: Record<Part, THREE.Vector3> = { base: new THREE.Vector3(), yaw: yawPivot, pitch: pitchPivot }

    const builders = new Map<string, { part: Part; material: THREE.Material; position: number[]; normal: number[]; uv: number[] }>()
    const p = new THREE.Vector3()
    const n = new THREE.Vector3()
    for (const mesh of meshes) {
      const geometry = mesh.geometry
      const position = geometry.attributes.position
      const normal = geometry.attributes.normal
      const uv = geometry.attributes.uv
      const toModel = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld)
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(toModel)
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      const count = position.count
      const world = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) p.fromBufferAttribute(position, i).applyMatrix4(toModel).toArray(world, i * 3)

      // Union-find: vertices at the same position (UV seams) and vertices of one triangle are one piece
      const parent = new Int32Array(count).map((_, i) => i)
      const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
      const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
      const seen = new Map<string, number>()
      for (let i = 0; i < count; i++) {
        const key = `${Math.round(world[i * 3] * 1e4)},${Math.round(world[i * 3 + 1] * 1e4)},${Math.round(world[i * 3 + 2] * 1e4)}`
        const first = seen.get(key)
        if (first === undefined) seen.set(key, i)
        else union(i, first)
      }
      const index = geometry.index ? geometry.index.array : Array.from({ length: count }, (_, i) => i)
      for (let t = 0; t < index.length; t += 3) { union(index[t], index[t + 1]); union(index[t + 1], index[t + 2]) }
      const minY = new Map<number, number>()
      const maxY = new Map<number, number>()
      const pieceBox = new Map<number, THREE.Box3>()
      for (let i = 0; i < count; i++) {
        const r = find(i), y = world[i * 3 + 1]
        minY.set(r, Math.min(minY.get(r) ?? Infinity, y))
        maxY.set(r, Math.max(maxY.get(r) ?? -Infinity, y))
        if (dropTiny) {
          let box = pieceBox.get(r)
          if (!box) pieceBox.set(r, (box = new THREE.Box3()))
          box.expandByPoint(p.set(world[i * 3], y, world[i * 3 + 2]))
        }
      }
      const tiny = (vertex: number) => {
        if (!dropTiny) return false
        const size = pieceBox.get(find(vertex))!.getSize(n)
        return Math.max(size.x, size.y, size.z) < TINY_PIECE
      }
      const partOf = (vertex: number): Part => {
        const r = find(vertex)
        return maxY.get(r)! <= BASE_TOP ? 'base' : minY.get(r)! >= GUN_BOTTOM ? 'pitch' : 'yaw'
      }

      for (let t = 0; t < index.length; t += 3) {
        if (tiny(index[t])) continue
        const part = partOf(index[t])
        const key = `${part}|${material.uuid}`
        let builder = builders.get(key)
        if (!builder) builders.set(key, (builder = { part, material, position: [], normal: [], uv: [] }))
        const pivot = pivotOf[part]
        for (let k = 0; k < 3; k++) {
          const v = index[t + k]
          builder.position.push(world[v * 3] - pivot.x, world[v * 3 + 1] - pivot.y, world[v * 3 + 2] - pivot.z)
          if (normal) { n.fromBufferAttribute(normal, v).applyMatrix3(normalMatrix).normalize(); builder.normal.push(n.x, n.y, n.z) }
          if (uv) builder.uv.push(uv.getX(v), uv.getY(v))
        }
      }
    }

    const pieces: SplitModel['pieces'] = { base: [], yaw: [], pitch: [] }
    for (const builder of builders.values()) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.position, 3))
      if (builder.normal.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(builder.normal, 3))
      else geometry.computeVertexNormals()
      if (builder.uv.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(builder.uv, 2))
      pieces[builder.part].push({ geometry, material: builder.material })
    }
    const scale = frame?.scale ?? TURRET_HEIGHT / (all.max.y - all.min.y)
    return { pieces, scale, lift: frame?.lift ?? -all.min.y * scale, yawPivot, pitchPivot }
  }
}

export interface TurretField {
  group: THREE.Group
  /** Solid circles for player movement (available immediately, before the model loads). */
  circles: Array<{ x: number; z: number; r: number }>
  turrets: Turret[]
  /** Idle scan + distance culling; call once per frame. */
  update: (time: number, camera: THREE.Vector3) => void
}

/** Machine-gun emplacements, one instanced set per base (a few draw calls per base, not per gun). */
export function createTurrets(bases: Array<{ center: THREE.Vector3; placements: TurretPlacement[] }>): TurretField {
  const group = new THREE.Group()
  group.name = 'turrets'
  const circles: TurretField['circles'] = []
  const sets = bases.map((base) => {
    const turrets: Turret[] = base.placements.map((pl) => ({ ...pl, yaw: 0, pitch: 0, idle: true }))
    for (const t of turrets) circles.push({ x: t.x, z: t.z, r: TURRET_BLOCK_RADIUS })
    const setGroup = new THREE.Group()
    group.add(setGroup)
    const meshes = { near: { base: [], yaw: [], pitch: [] }, far: { base: [], yaw: [], pitch: [] } } as Record<Lod, Record<Part, THREE.InstancedMesh[]>>
    return { center: base.center, turrets, group: setGroup, meshes }
  })
  let models: { near: SplitModel; far: SplitModel | null } | null = null

  const m = new THREE.Matrix4()
  const world = new THREE.Matrix4()
  const turn = new THREE.Matrix4()
  const tilt = new THREE.Matrix4()
  const scale = new THREE.Matrix4()
  const toYaw = new THREE.Matrix4()
  const yawToPitch = new THREE.Matrix4()
  /** Write every gun of a set into the near or far instanced meshes, depending on its distance. */
  function writeMatrices(set: (typeof sets)[number], camera: THREE.Vector3 | null) {
    if (!models) return
    const frame = models.near
    scale.makeScale(frame.scale, frame.scale, frame.scale)
    toYaw.makeTranslation(frame.yawPivot.x, frame.yawPivot.y, frame.yawPivot.z)
    yawToPitch.makeTranslation(frame.pitchPivot.x - frame.yawPivot.x, frame.pitchPivot.y - frame.yawPivot.y, frame.pitchPivot.z - frame.yawPivot.z)
    const used: Record<Lod, number> = { near: 0, far: 0 }
    for (const t of set.turrets) {
      const lod: Lod = !models.far || !camera || Math.hypot(camera.x - t.x, camera.z - t.z) < DETAIL_DISTANCE ? 'near' : 'far'
      const slot = used[lod]++
      // Sunk slightly so the base never floats on a slope
      const y = heightAt(t.x, t.z) + frame.lift - 0.2
      world.makeRotationY(t.facing).setPosition(t.x, y, t.z).multiply(scale)
      turn.makeRotationY(t.yaw)
      tilt.makeRotationX(t.pitch)
      for (const part of PARTS) {
        if (part === 'base') m.copy(world)
        else if (part === 'yaw') m.copy(world).multiply(toYaw).multiply(turn)
        else m.copy(world).multiply(toYaw).multiply(turn).multiply(yawToPitch).multiply(tilt)
        for (const mesh of set.meshes[lod][part]) mesh.setMatrixAt(slot, m)
      }
    }
    for (const lod of LODS) {
      for (const part of PARTS) {
        for (const mesh of set.meshes[lod][part]) {
          mesh.count = used[lod]
          mesh.instanceMatrix.needsUpdate = true
        }
      }
    }
  }

  void loadTurretModels().then((loaded) => {
    if (!loaded) return
    models = loaded
    for (const set of sets) {
      for (const lod of LODS) {
        const model = loaded[lod]
        if (!model) continue
        for (const part of PARTS) {
          for (const piece of model.pieces[part]) {
            const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, set.turrets.length)
            // Only nearby guns cast shadows (the shadow area is around the player anyway)
            mesh.castShadow = lod === 'near'
            mesh.receiveShadow = true
            mesh.name = `turret-${lod}-${part}`
            // One sphere around the whole emplacement ring: cheap culling that survives the guns turning
            mesh.boundingSphere = new THREE.Sphere(set.center.clone().setY(heightAt(set.center.x, set.center.z)), 75)
            set.meshes[lod][part].push(mesh)
            set.group.add(mesh)
          }
        }
      }
      writeMatrices(set, null)
    }
  })

  return {
    group,
    circles,
    turrets: sets.flatMap((s) => s.turrets),
    update(time, camera) {
      for (const set of sets) {
        const near = Math.hypot(camera.x - set.center.x, camera.z - set.center.z) < VISIBLE_DISTANCE
        set.group.visible = near
        if (!near || !models) continue
        // Idle scan: each gun sweeps slowly around its facing (phases differ per gun)
        set.turrets.forEach((t, i) => {
          if (!t.idle) return
          const phase = i * 1.7 + t.x * 0.01
          t.yaw = Math.sin(time * 0.3 + phase) * 0.55
          t.pitch = -0.04 + Math.sin(time * 0.45 + phase * 1.3) * 0.06
        })
        writeMatrices(set, camera)
      }
    },
  }
}
