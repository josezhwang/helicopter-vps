import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { loadModel, toStandardMaterial } from './assets'
import type { GunModel } from './weapons'

/**
 * Weapons, ammo and supply models, each normalised once: scaled to a real size, turned so guns, missiles and
 * rounds point along -Z (muzzle / nose at the far end), centred, and merged into one piece per material.
 * The viewmodel, the soldiers, the pickups and the flying rounds all build on these.
 */
export type PropName = GunModel | 'missile' | 'bullet_9mm' | 'bullet_556' | 'bullet_heavy' | 'missile_crate' | 'ammo_9mm' | 'ammo_556'

interface Spec {
  url: string
  /** Longest side after scaling, metres. */
  size: number
  /** Turn applied before measuring (to point the model along -Z). */
  rotate: [number, number, number]
  /** Sit on y = 0 (supplies) instead of being centred (held and flying things). */
  grounded?: boolean
}

const SPECS: Record<PropName, Spec> = {
  handgun: { url: '/models/handgun.glb', size: 0.34, rotate: [0, 0, 0] },
  primary: { url: '/primary-handgun.glb', size: 0.95, rotate: [0, -Math.PI / 2, 0] },
  launcher: { url: '/models/launcher.glb', size: 1.6, rotate: [0, Math.PI / 2, 0] },
  gun_m4a1: { url: '/models/gun_m4a1.glb', size: 0.95, rotate: [0, Math.PI / 2, 0] },
  gun_m254: { url: '/models/gun_m254.glb', size: 1, rotate: [0, -Math.PI / 2, 0] },
  gun_pulse: { url: '/models/gun_pulse.glb', size: 1.3, rotate: [0, Math.PI, 0] },
  gun_m240b: { url: '/models/gun_m240b.glb', size: 1.25, rotate: [0, -Math.PI / 2, 0] },
  gun_plasma: { url: '/models/gun_plasma.glb', size: 1, rotate: [0, Math.PI, 0] },
  gun_m170: { url: '/models/gun_m170.glb', size: 1.35, rotate: [0, 0, 0] },
  gun_svd: { url: '/models/gun_svd.glb', size: 1.2, rotate: [0, 0, 0] },
  missile: { url: '/models/missile.glb', size: 1.1, rotate: [-Math.PI / 2, 0, 0] },
  bullet_9mm: { url: '/models/bullet_9mm.glb', size: 0.16, rotate: [-Math.PI / 2, 0, 0] },
  bullet_556: { url: '/models/bullet_556.glb', size: 0.22, rotate: [0, Math.PI / 2, 0] },
  bullet_heavy: { url: '/models/bullet_heavy.glb', size: 0.55, rotate: [0, -Math.PI / 2, 0] },
  missile_crate: { url: '/models/missile_crate.glb', size: 1.55, rotate: [0, 0, 0], grounded: true },
  ammo_9mm: { url: '/models/ammo_9mm.glb', size: 0.7, rotate: [0, 0, 0], grounded: true },
  ammo_556: { url: '/models/ammo_556.glb', size: 0.7, rotate: [0, 0, 0], grounded: true },
}

export interface Prop {
  pieces: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>
  /** Bounds after normalising. */
  box: THREE.Box3
  /** Front tip (muzzle / nose) — the point with the lowest z. */
  tip: THREE.Vector3
}

const cache = new Map<PropName, Promise<Prop>>()

export function loadProp(name: PropName): Promise<Prop> {
  let prop = cache.get(name)
  if (!prop) cache.set(name, (prop = buildProp(SPECS[name])))
  return prop
}

async function buildProp(spec: Spec): Promise<Prop> {
  const gltf = await loadModel(spec.url)
  const root = gltf.scene
  root.updateMatrixWorld(true)
  const turn = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...spec.rotate))
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>()
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || Array.isArray(mesh.material)) return
    const geometry = mesh.geometry.clone().applyMatrix4(turn.clone().multiply(toRoot).multiply(mesh.matrixWorld))
    for (const attribute of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(attribute)) geometry.deleteAttribute(attribute)
    if (!geometry.index) geometry.setIndex([...Array(geometry.attributes.position.count).keys()])
    if (!geometry.attributes.normal) geometry.computeVertexNormals()
    const material = toStandardMaterial(mesh.material)
    if (!byMaterial.has(material)) byMaterial.set(material, [])
    byMaterial.get(material)!.push(geometry)
  })
  const box = new THREE.Box3()
  const pieces = [...byMaterial].map(([material, list]) => {
    const geometry = list.length === 1 ? list[0] : mergeGeometries(list)!
    geometry.computeBoundingBox()
    box.union(geometry.boundingBox!)
    return { geometry, material }
  })
  const size = box.getSize(new THREE.Vector3())
  const scale = spec.size / Math.max(size.x, size.y, size.z)
  const center = box.getCenter(new THREE.Vector3())
  const shift = new THREE.Vector3(-center.x, spec.grounded ? -box.min.y : -center.y, -center.z)
  const place = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z))
  const final = new THREE.Box3()
  let tip = new THREE.Vector3(0, 0, Infinity)
  // The muzzle: the point furthest forward (on the barrel's rim, close enough to its axis for a flash)
  for (const piece of pieces) {
    piece.geometry.applyMatrix4(place)
    piece.geometry.computeBoundingBox()
    piece.geometry.computeBoundingSphere()
    final.union(piece.geometry.boundingBox!)
    const position = piece.geometry.attributes.position
    for (let i = 0; i < position.count; i++) if (position.getZ(i) < tip.z) tip = new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i))
  }
  return { pieces, box: final, tip }
}

/** A plain mesh group of a prop (for single copies: the viewmodel, a soldier's gun). */
export function propGroup(prop: Prop, shadows = true): THREE.Group {
  const group = new THREE.Group()
  for (const piece of prop.pieces) {
    const mesh = new THREE.Mesh(piece.geometry, piece.material)
    mesh.castShadow = shadows
    mesh.raycast = () => {}
    group.add(mesh)
  }
  return group
}

/** Instanced copies of a prop, one InstancedMesh per material; `count` starts at 0. */
export function propInstances(prop: Prop, capacity: number, shadows: boolean, parent: THREE.Object3D): THREE.InstancedMesh[] {
  return prop.pieces.map((piece) => {
    const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, capacity)
    mesh.count = 0
    mesh.castShadow = shadows
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    parent.add(mesh)
    return mesh
  })
}
