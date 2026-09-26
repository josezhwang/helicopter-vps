import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { loadModel, toStandardMaterial } from './assets'
import { heightAt } from './terrain'
import type { Team } from './bases'

/**
 * Each team's motor pool: FLEET_SIZE helicopters on pads behind the base and FLEET_SIZE battle cars parked
 * beside it. Every vehicle is drawn with shared instanced meshes (a handful of draw calls for all 20);
 * the per-vehicle `object` only carries the pose and an invisible hitbox for bullets.
 */

export type VehicleKind = 'heli' | 'car'
export const FLEET_SIZE = 5
/** Rotor speed ceiling (the HUD shows it x10). */
export const MAX_ROTOR_RPM = 100

const HELI_URL = '/models/helicopter.glb'
const CAR_URL = '/models/battle_car.glb'
const CAR_FAR_URL = '/models/battle_car_far.glb'
const WHEEL_URL = '/models/battle_car_wheel.glb'
const WHEEL_FAR_URL = '/models/battle_car_wheel_far.glb'

/** MD-500 model units → metres: about 10.4m nose to tail, 9.2m rotor. */
const HELI_SCALE = 1.25
/** Battle car model units → metres: about 6.1m long, 3.6m wide. */
const CAR_SCALE = 0.85
/**
 * Wheel hubs in car model units (the car was exported centred on its footprint, ground at y = 0), with the
 * rear wheels' slightly larger size and the side they're on. The wheel model is the left front one.
 */
const WHEELS: Array<{ x: number; y: number; z: number; size: number; right: boolean; front: boolean }> = [
  { x: -1.3669, y: 0.7978, z: 1.8339, size: 1, right: false, front: true },
  { x: 1.367, y: 0.7978, z: 1.8339, size: 1, right: true, front: true },
  { x: -1.3258, y: 0.8138, z: -2.2941, size: 1.02, right: false, front: false },
  { x: 1.3258, y: 0.8138, z: -2.2941, size: 1.02, right: true, front: false },
]
export const CAR_WHEEL_RADIUS = 0.79 * CAR_SCALE
/** Distance between front and rear axles, and between left and right wheels, in metres. */
export const CAR_WHEELBASE = (1.8339 + 2.2941) * CAR_SCALE
export const CAR_TRACK = 2.7 * CAR_SCALE
/** Along the car's length, two circles of this radius stand in for its footprint in collisions. */
export const CAR_CIRCLE_RADIUS = 1.85
export const CAR_CIRCLE_OFFSET = 1.45
export const HELI_BODY_RADIUS = 3

/** Cars closer than this use the detailed model and cast shadows. */
const CAR_DETAIL_DISTANCE = 75
/** Vehicles further away than this are not drawn (a few pixels in the haze). */
const VISIBLE_DISTANCE = 750
const PAD_RADIUS = 5.5

const TEAM_TINT: Record<Team, THREE.Color> = {
  blue: new THREE.Color(0.78, 0.9, 1.2),
  red: new THREE.Color(1.2, 0.82, 0.78),
}
const PAD_RING_COLOR: Record<Team, number> = { blue: 0x2e6fbd, red: 0xb03a2e }

export interface Vehicle {
  id: string
  team: Team
  kind: VehicleKind
  index: number
  /** Pose holder: position is the ground point under the vehicle's centre; rotation order YXZ (yaw, pitch, roll). */
  object: THREE.Object3D
  hitbox: THREE.Object3D
  /** Helicopter: rotor RPM (0..MAX_ROTOR_RPM). Car: speed along its nose in m/s. */
  spin: number
  targetSpin: number
  /** Front-wheel angle (cars), radians, positive = turning left. */
  steer: number
  /** Who is driving: a player id, or null when parked. */
  pilot: string | null
  /** Where it was parked at the start of the match. */
  home: { x: number; z: number; yaw: number }
  rotorAngle: number
  tailAngle: number
  wheelAngle: number
  lastYaw: number
}

export interface Fleet {
  group: THREE.Group
  /** Invisible hitboxes for bullets (one or two boxes per vehicle). */
  hitGroup: THREE.Group
  vehicles: Vehicle[]
  byId: Map<string, Vehicle>
  /** Eye position inside a helicopter, in its local space. */
  heliSeat: THREE.Vector3
  /** Where a heli comes to rest at (x, z): its pad top, or the ground. */
  restHeight: (v: Vehicle, x: number, z: number) => number
  /** True where nature should not grow: pads and parking spots. */
  clearance: (x: number, z: number, margin?: number) => boolean
  /** Solid circles for things walking or driving around (vehicles on the ground). */
  circles: (skip?: Vehicle | null) => Array<{ x: number; z: number; r: number }>
  update: (dt: number, camera: THREE.Vector3, localDriver: Vehicle | null) => void
}

interface Spot { kind: VehicleKind; team: Team; index: number; x: number; z: number; yaw: number }

/**
 * Helicopter pads side by side behind each base (behind the back machine gun), noses toward the gate side;
 * battle cars side by side on the flank that faces the enemy, noses pointing away from the base.
 * Blue's gate faces +X, red's faces -X (the base is mirrored).
 */
function fleetSpots(team: Team, center: THREE.Vector3): Spot[] {
  const g = team === 'blue' ? 1 : -1
  const spots: Spot[] = []
  for (let i = 0; i < FLEET_SIZE; i++) {
    const lateral = (i - (FLEET_SIZE - 1) / 2)
    spots.push({ kind: 'heli', team, index: i, x: center.x - 68 * g, z: center.z + lateral * 20 * g, yaw: (Math.PI / 2) * g })
    spots.push({ kind: 'car', team, index: i, x: center.x + lateral * 12 * g, z: center.z + 64 * g, yaw: g > 0 ? 0 : Math.PI })
  }
  return spots
}

export const vehicleId = (team: Team, kind: VehicleKind, index: number) => `${team}-${kind}-${index}`

type Piece = { geometry: THREE.BufferGeometry; material: THREE.Material }

/**
 * Merge a loaded model into as few pieces as possible (model space, scaled): untextured materials become
 * vertex colours on one shared material, each textured material keeps its own piece.
 */
function bakePieces(root: THREE.Object3D, scale: number, offset: THREE.Vector3, shared: THREE.MeshStandardMaterial): Piece[] {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const place = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z))
  const colored: THREE.BufferGeometry[] = []
  const textured = new Map<THREE.Material, THREE.BufferGeometry[]>()
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || Array.isArray(mesh.material)) return
    const material = mesh.material as THREE.MeshStandardMaterial
    const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, toRoot.clone().multiply(mesh.matrixWorld)))
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'uv') geometry.deleteAttribute(name)
    geometry.morphAttributes = {}
    if (material.map) {
      if (!textured.has(material)) textured.set(material, [])
      textured.get(material)!.push(geometry)
      return
    }
    geometry.deleteAttribute('uv')
    const count = geometry.attributes.position.count
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) colors.set([material.color.r, material.color.g, material.color.b], i * 3)
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    colored.push(geometry)
  })
  const pieces: Piece[] = []
  const merge = (list: THREE.BufferGeometry[]) => {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list)
    if (merged !== list[0]) for (const g of list) g.dispose()
    return merged
  }
  if (colored.length) {
    const geometry = merge(colored)
    if (geometry) pieces.push({ geometry, material: shared })
  }
  for (const [material, list] of textured) {
    const geometry = merge(list)
    if (!geometry) continue
    const standard = toStandardMaterial(material)
    standard.flatShading = true
    standard.needsUpdate = true
    pieces.push({ geometry, material: standard })
  }
  return pieces
}

/** Instanced copies of one piece; `count` is set every frame to the vehicles drawn with it. */
function makeInstanced(piece: Piece, capacity: number, shadows: boolean, parent: THREE.Group) {
  const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, capacity)
  mesh.count = 0
  mesh.castShadow = shadows
  mesh.receiveShadow = true
  // Instances sit at both ends of the map: per-instance culling isn't available, drawing all ~10 is cheap
  mesh.frustumCulled = false
  mesh.raycast = () => {}
  mesh.setColorAt(0, new THREE.Color(1, 1, 1))
  parent.add(mesh)
  return mesh
}

export function createFleet(bases: Record<Team, THREE.Vector3>): Fleet {
  const group = new THREE.Group()
  group.name = 'vehicles'
  const hitGroup = new THREE.Group()
  hitGroup.name = 'vehicle-hitboxes'
  const spots = [...fleetSpots('blue', bases.blue), ...fleetSpots('red', bases.red)]
  const hitMaterial = new THREE.MeshBasicMaterial({ visible: false })
  const vehicles: Vehicle[] = []
  const byId = new Map<string, Vehicle>()

  for (const spot of spots) {
    const object = new THREE.Object3D()
    object.rotation.order = 'YXZ'
    object.position.set(spot.x, heightAt(spot.x, spot.z), spot.z)
    object.rotation.y = spot.yaw
    const hitbox = new THREE.Group()
    const id = vehicleId(spot.team, spot.kind, spot.index)
    hitbox.userData.vehicleId = id
    // Placeholder shapes until the model loads and the boxes are fitted to it
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hitMaterial)
    if (spot.kind === 'heli') { box.scale.set(2.4, 2.8, 5.5); box.position.set(0, 1.9, 1) } else { box.scale.set(3.6, 2.8, 6.1); box.position.set(0, 1.9, 0) }
    hitbox.add(box)
    object.add(hitbox)
    hitGroup.add(object)
    const vehicle: Vehicle = {
      id, team: spot.team, kind: spot.kind, index: spot.index, object, hitbox,
      spin: 0, targetSpin: 0, steer: 0, pilot: null,
      home: { x: spot.x, z: spot.z, yaw: spot.yaw },
      rotorAngle: spot.index * 0.7, tailAngle: 0, wheelAngle: 0, lastYaw: spot.yaw,
    }
    vehicles.push(vehicle)
    byId.set(id, vehicle)
  }

  // Helipads: a level slab set into the slope (level with the ground under the skids, the uphill rim runs into
  // the hillside), deep enough to reach the ground on the downhill side
  const pads = vehicles.filter((v) => v.kind === 'heli').map((v) => {
    let top = -Infinity, bottom = Infinity
    for (let a = 0; a < 16; a++) {
      for (const r of [0, PAD_RADIUS * 0.5, PAD_RADIUS]) {
        const h = heightAt(v.home.x + Math.cos((a / 16) * Math.PI * 2) * r, v.home.z + Math.sin((a / 16) * Math.PI * 2) * r)
        if (r <= PAD_RADIUS * 0.5) top = Math.max(top, h)
        bottom = Math.min(bottom, h)
      }
    }
    return { vehicle: v, top: top + 0.12, bottom: bottom - 0.3 }
  })
  const slab = new THREE.InstancedMesh(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS, 1, 28), new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.95 }), pads.length)
  const ringGeometry = new THREE.TorusGeometry(PAD_RADIUS - 1.2, 0.22, 6, 40).rotateX(Math.PI / 2)
  const ring = new THREE.InstancedMesh(ringGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), pads.length)
  pads.forEach((pad, i) => {
    const height = pad.top - pad.bottom
    slab.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(pad.vehicle.home.x, pad.bottom + height / 2, pad.vehicle.home.z), new THREE.Quaternion(), new THREE.Vector3(1, height, 1)))
    ring.setMatrixAt(i, new THREE.Matrix4().makeTranslation(pad.vehicle.home.x, pad.top + 0.02, pad.vehicle.home.z))
    ring.setColorAt(i, new THREE.Color(PAD_RING_COLOR[pad.vehicle.team]))
    pad.vehicle.object.position.y = pad.top
  })
  slab.receiveShadow = true
  for (const mesh of [slab, ring]) { mesh.computeBoundingSphere(); mesh.frustumCulled = false; group.add(mesh) }

  const restHeight = (v: Vehicle, x: number, z: number) => {
    const ground = heightAt(x, z)
    if (v.kind !== 'heli') return ground
    const pad = pads.find((p) => Math.hypot(p.vehicle.home.x - x, p.vehicle.home.z - z) < PAD_RADIUS)
    return pad ? Math.max(ground, pad.top) : ground
  }

  const clearance = (x: number, z: number, margin = 0) => spots.some((s) => Math.hypot(s.x - x, s.z - z) < (s.kind === 'heli' ? PAD_RADIUS + 2 : 5) + margin)

  const circles = (skip?: Vehicle | null) => {
    const out: Array<{ x: number; z: number; r: number }> = []
    for (const v of vehicles) {
      if (v === skip) continue
      const p = v.object.position
      if (v.kind === 'heli') {
        // A flying helicopter doesn't block anything below it
        if (p.y - restHeight(v, p.x, p.z) > 3) continue
        out.push({ x: p.x, z: p.z, r: HELI_BODY_RADIUS })
      } else {
        const fx = Math.sin(v.object.rotation.y) * CAR_CIRCLE_OFFSET, fz = Math.cos(v.object.rotation.y) * CAR_CIRCLE_OFFSET
        out.push({ x: p.x + fx, z: p.z + fz, r: CAR_CIRCLE_RADIUS }, { x: p.x - fx, z: p.z - fz, r: CAR_CIRCLE_RADIUS })
      }
    }
    return out
  }

  // ---- Rendering (filled in once the models load) ----
  interface HeliModel { statics: THREE.InstancedMesh[]; rotor: THREE.InstancedMesh[]; tail: THREE.InstancedMesh[]; rotorHub: THREE.Vector3; rotorAxis: THREE.Vector3; tailHub: THREE.Vector3; tailAxis: THREE.Vector3 }
  interface CarLevel { body: THREE.InstancedMesh[]; wheels: THREE.InstancedMesh[] }
  let heliModel: HeliModel | null = null
  let carNear: CarLevel | null = null
  let carFar: CarLevel | null = null
  const heliSeat = new THREE.Vector3(0, 2.3, 1.9)
  const helis = vehicles.filter((v) => v.kind === 'heli')
  const cars = vehicles.filter((v) => v.kind === 'car')

  const sharedMaterial = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35, flatShading: true })

  void (async () => {
    const gltf = await loadModel(HELI_URL)
    const root = gltf.scene
    root.updateMatrixWorld(true)
    const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
    const box = new THREE.Box3().setFromObject(root)
    const rotorNode = root.getObjectByName('Top_rotor')
    const tailNode = root.getObjectByName('Tail_Rotor')
    // Origin: the ground under the main rotor hub, so the helicopter turns about its mast
    const hubModel = rotorNode ? rotorNode.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot) : box.getCenter(new THREE.Vector3())
    const offset = new THREE.Vector3(-hubModel.x, -box.min.y, -hubModel.z)
    const partOf = (node: THREE.Object3D) => {
      for (let n: THREE.Object3D | null = node; n; n = n.parent) {
        if (n === rotorNode) return 'rotor'
        if (n === tailNode) return 'tail'
      }
      return 'static'
    }
    const groups: Record<'static' | 'rotor' | 'tail', Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>> = { static: [], rotor: [], tail: [] }
    const place = new THREE.Matrix4().makeScale(HELI_SCALE, HELI_SCALE, HELI_SCALE).multiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z))
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || Array.isArray(mesh.material)) return
      const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, toRoot.clone().multiply(mesh.matrixWorld)))
      const material = toStandardMaterial(mesh.material)
      // Single pass for the see-through canopy (double-sided transparency draws twice)
      if (material.transparent) { material.forceSinglePass = true; material.depthWrite = false }
      groups[partOf(mesh)].push({ geometry, material })
    })
    // Pivots (metres, vehicle space) and spin axes: each rotor turns about its thinnest direction
    const pivot = (node: THREE.Object3D | undefined, pieces: Array<{ geometry: THREE.BufferGeometry }>) => {
      const bounds = new THREE.Box3()
      for (const p of pieces) { p.geometry.computeBoundingBox(); bounds.union(p.geometry.boundingBox!) }
      const size = bounds.getSize(new THREE.Vector3())
      const axis = size.x <= size.y && size.x <= size.z ? new THREE.Vector3(1, 0, 0) : size.y <= size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
      const hub = node ? node.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoot).applyMatrix4(place) : bounds.getCenter(new THREE.Vector3())
      return { hub, axis }
    }
    const main = pivot(rotorNode, groups.rotor)
    const tail = pivot(tailNode, groups.tail)
    const capacity = helis.length
    heliModel = {
      statics: groups.static.map((p) => makeInstanced(p, capacity, true, group)),
      rotor: groups.rotor.map((p) => makeInstanced(p, capacity, true, group)),
      tail: groups.tail.map((p) => makeInstanced(p, capacity, false, group)),
      rotorHub: main.hub, rotorAxis: main.axis, tailHub: tail.hub, tailAxis: tail.axis,
    }
    // Fit the hitboxes: cabin (everything ahead of the tail boom) and the boom back to the tail rotor
    const staticBounds = new THREE.Box3()
    for (const p of groups.static) { p.geometry.computeBoundingBox(); staticBounds.union(p.geometry.boundingBox!) }
    const cabinBack = main.hub.z - 1.6
    const cabinMin = new THREE.Vector3(-1.1, 0.35, cabinBack), cabinMax = new THREE.Vector3(1.1, main.hub.y - 0.45, staticBounds.max.z)
    const glass = groups.static.find((p) => p.material.transparent)
    if (glass) {
      glass.geometry.computeBoundingBox()
      const g = glass.geometry.boundingBox!
      heliSeat.set(0, g.min.y + (g.max.y - g.min.y) * 0.72, g.min.z + (g.max.z - g.min.z) * 0.68)
    }
    for (const v of helis) {
      v.hitbox.clear()
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hitMaterial)
      cabin.scale.subVectors(cabinMax, cabinMin)
      cabin.position.addVectors(cabinMin, cabinMax).multiplyScalar(0.5)
      const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hitMaterial)
      boom.scale.set(0.7, 1.2, cabinBack - staticBounds.min.z)
      boom.position.set(0, tail.hub.y, (cabinBack + staticBounds.min.z) / 2)
      v.hitbox.add(cabin, boom)
    }
  })().catch((error) => console.error('[vehicles] helicopter model failed to load:', error))

  const loadCar = async (bodyUrl: string, wheelUrl: string, shadows: boolean): Promise<CarLevel> => {
    const [body, wheel] = await Promise.all([loadModel(bodyUrl), loadModel(wheelUrl)])
    const bodyPieces = bakePieces(body.scene, CAR_SCALE, new THREE.Vector3(), sharedMaterial())
    const wheelPieces = bakePieces(wheel.scene, CAR_SCALE, new THREE.Vector3(), sharedMaterial())
    return {
      body: bodyPieces.map((p) => makeInstanced(p, cars.length, shadows, group)),
      // Wheel shadows are mostly hidden under the body's: 40 wheels aren't worth drawing twice
      wheels: wheelPieces.map((p) => makeInstanced(p, cars.length * WHEELS.length, false, group)),
    }
  }
  void loadCar(CAR_URL, WHEEL_URL, true).then((level) => {
    carNear = level
    // Fit the hitbox to the body
    const bounds = new THREE.Box3()
    for (const mesh of level.body) { mesh.geometry.computeBoundingBox(); bounds.union(mesh.geometry.boundingBox!) }
    bounds.min.y = 0.2
    for (const v of cars) {
      const box = v.hitbox.children[0] as THREE.Mesh
      box.scale.subVectors(bounds.max, bounds.min)
      box.position.addVectors(bounds.min, bounds.max).multiplyScalar(0.5)
    }
  }).catch((error) => console.error('[vehicles] battle car model failed to load:', error))
  void loadCar(CAR_FAR_URL, WHEEL_FAR_URL, false).then((level) => { carFar = level })
    .catch((error) => console.warn('[vehicles] distant battle car unavailable, using full detail:', error))

  // ---- Per-frame ----
  const m = new THREE.Matrix4(), part = new THREE.Matrix4(), spinM = new THREE.Matrix4(), toHub = new THREE.Matrix4(), fromHub = new THREE.Matrix4()
  const wheelLocal = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), ws = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0), xAxis = new THREE.Vector3(1, 0, 0)
  const setInstances = (meshes: THREE.InstancedMesh[], slot: number, matrix: THREE.Matrix4, tint: THREE.Color) => {
    for (const mesh of meshes) { mesh.setMatrixAt(slot, matrix); mesh.setColorAt(slot, tint) }
  }
  const finish = (meshes: THREE.InstancedMesh[], count: number) => {
    for (const mesh of meshes) {
      mesh.count = count
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }
  const spinAbout = (hub: THREE.Vector3, axis: THREE.Vector3, angle: number) =>
    part.copy(toHub.makeTranslation(hub.x, hub.y, hub.z)).multiply(spinM.makeRotationAxis(axis, angle)).multiply(fromHub.makeTranslation(-hub.x, -hub.y, -hub.z))

  const update = (dt: number, camera: THREE.Vector3, localDriver: Vehicle | null) => {
    for (const v of vehicles) {
      if (v.kind === 'heli') {
        // Rotor winds up and down smoothly (also after the pilot leaves)
        v.spin = THREE.MathUtils.clamp(THREE.MathUtils.lerp(v.spin, v.targetSpin, Math.min(1, 4 * dt)), 0, MAX_ROTOR_RPM)
        v.rotorAngle = (v.rotorAngle + v.spin * dt) % (Math.PI * 2)
        v.tailAngle = (v.tailAngle + v.spin * 1.5 * dt) % (Math.PI * 2)
      } else {
        if (v !== localDriver) {
          v.spin = THREE.MathUtils.lerp(v.spin, v.targetSpin, Math.min(1, 6 * dt))
          // Remote cars: steer the front wheels from how fast the car is turning
          const yawRate = Math.atan2(Math.sin(v.object.rotation.y - v.lastYaw), Math.cos(v.object.rotation.y - v.lastYaw)) / Math.max(dt, 1e-3)
          const steer = Math.abs(v.spin) > 0.5 ? Math.atan((yawRate * CAR_WHEELBASE) / v.spin) : 0
          v.steer = THREE.MathUtils.lerp(v.steer, THREE.MathUtils.clamp(steer, -0.6, 0.6), Math.min(1, 8 * dt))
        }
        v.wheelAngle = (v.wheelAngle + (v.spin * dt) / CAR_WHEEL_RADIUS) % (Math.PI * 2)
      }
      v.lastYaw = v.object.rotation.y
    }

    if (heliModel) {
      let n = 0
      for (const v of helis) {
        if (v.object.position.distanceToSquared(camera) > VISIBLE_DISTANCE ** 2) continue
        v.object.updateMatrix()
        m.copy(v.object.matrix)
        const tint = TEAM_TINT[v.team]
        setInstances(heliModel.statics, n, m, tint)
        setInstances(heliModel.rotor, n, spinAbout(heliModel.rotorHub, heliModel.rotorAxis, v.rotorAngle).premultiply(m), tint)
        setInstances(heliModel.tail, n, spinAbout(heliModel.tailHub, heliModel.tailAxis, v.tailAngle).premultiply(m), tint)
        n++
      }
      finish([...heliModel.statics, ...heliModel.rotor, ...heliModel.tail], n)
    }

    const near = carNear
    if (near) {
      const far = carFar ?? near
      let nearCount = 0, farCount = 0
      for (const v of cars) {
        const d2 = v.object.position.distanceToSquared(camera)
        if (d2 > VISIBLE_DISTANCE ** 2) continue
        const level: CarLevel = d2 < CAR_DETAIL_DISTANCE ** 2 || far === near ? near : far
        const slot = level === near ? nearCount++ : farCount++
        v.object.updateMatrix()
        m.copy(v.object.matrix)
        const tint = TEAM_TINT[v.team]
        setInstances(level.body, slot, m, tint)
        WHEELS.forEach((w, i) => {
          const steer = w.front ? v.steer : 0
          // Right wheels are the left model turned around, so they roll the other way about their own axis
          q.setFromAxisAngle(yAxis, steer + (w.right ? Math.PI : 0))
          wheelLocal.compose(s.set(w.x * CAR_SCALE, w.y * CAR_SCALE, w.z * CAR_SCALE), q, ws.setScalar(w.size))
          wheelLocal.multiply(spinM.makeRotationAxis(xAxis, w.right ? -v.wheelAngle : v.wheelAngle))
          setInstances(level.wheels, slot * WHEELS.length + i, part.multiplyMatrices(m, wheelLocal), tint)
        })
      }
      finish([...near.body], nearCount)
      finish([...near.wheels], nearCount * WHEELS.length)
      if (far !== near) {
        finish([...far.body], farCount)
        finish([...far.wheels], farCount * WHEELS.length)
      }
    }
  }

  return { group, hitGroup, vehicles, byId, heliSeat, restHeight, clearance, circles, update }
}
