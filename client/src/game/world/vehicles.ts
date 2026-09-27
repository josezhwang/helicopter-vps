import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { loadModel, toStandardMaterial } from './assets'
import { heightAt } from './terrain'
import { baseToWorld, baseYaw, LAYOUT, type Team } from './layout'

/**
 * Each team's motor pool: FLEET_SIZE helicopters on the base's landing area and FLEET_SIZE battle cars parked
 * outside the gate. Anyone may use any of them. Every vehicle is drawn with shared instanced meshes (a
 * handful of draw calls for all 20); the per-vehicle `object` only carries the pose and invisible hitboxes.
 */

export type VehicleKind = 'heli' | 'car'
export const FLEET_SIZE = 5
/** Rotor speed ceiling (the HUD shows it x10). */
export const MAX_ROTOR_RPM = 100
/** Seats per vehicle: a helicopter has pilot, co-pilot and two rear seats; a car just its driver. */
export const SEATS: Record<VehicleKind, number> = { heli: 4, car: 1 }

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

/**
 * Helicopter seats (eye positions, in the model's own units before scaling): pilot front on the +X side,
 * co-pilot front on the -X side, two rear seats. Seat i gets in through door i.
 */
const HELI_SEATS_MODEL: THREE.Vector3Tuple[] = [[0.31, 1.78, 0.62], [-0.31, 1.78, 0.62], [0.33, 1.8, -0.42], [-0.33, 1.8, -0.42]]
/** How far doors swing open (radians). */
const DOOR_OPEN = 1.25
/** How long a door stays open while someone climbs in or out (ms). */
export const DOOR_HOLD_MS = 1600

/** Cars closer than this use the detailed model and cast shadows. */
const CAR_DETAIL_DISTANCE = 75
/** Vehicles further away than this are not drawn (a few pixels in the haze). */
const VISIBLE_DISTANCE = 750

const TEAM_TINT: Record<Team, THREE.Color> = {
  blue: new THREE.Color(0.78, 0.9, 1.2),
  red: new THREE.Color(1.2, 0.82, 0.78),
}
const WRECK_TINT = new THREE.Color(0.16, 0.14, 0.13)

export interface Vehicle {
  id: string
  /** The base it belongs to (paint and parking spot); anyone may drive it. */
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
  /** Player in each seat (seat 0 flies / drives), null when empty. */
  occupants: Array<string | null>
  /** Shot down: a burnt-out wreck until it respawns at home. */
  destroyed: boolean
  /** Door opening 0..1 per seat (helicopters), and until when each is held open for someone climbing in/out. */
  doors: number[]
  doorHold: number[]
  /** Where it was parked at the start of the match. */
  home: { x: number; y: number; z: number; yaw: number }
  rotorAngle: number
  tailAngle: number
  wheelAngle: number
  lastYaw: number
}

export const driverOf = (v: Vehicle) => v.occupants[0]

export interface HeliSeat {
  /** Eye position in the helicopter's local space (metres). */
  eye: THREE.Vector3
  /** Just outside the seat's door, at standing eye height (local space). */
  outside: THREE.Vector3
}

export interface Fleet {
  group: THREE.Group
  /** Invisible hitboxes for bullets (one or two boxes per vehicle). */
  hitGroup: THREE.Group
  vehicles: Vehicle[]
  byId: Map<string, Vehicle>
  heliSeats: HeliSeat[]
  /** Where a vehicle comes to rest at (x, z). */
  restHeight: (v: Vehicle, x: number, z: number) => number
  /** True where nature should not grow: parking spots. */
  clearance: (x: number, z: number, margin?: number) => boolean
  /** Solid circles for things walking or driving around (vehicles on the ground). */
  circles: (skip?: Vehicle | null) => Array<{ x: number; z: number; r: number }>
  /** Put a vehicle back on its home spot, parked and whole. */
  sendHome: (v: Vehicle) => void
  update: (dt: number, camera: THREE.Vector3, localDriver: Vehicle | null) => void
}

interface Spot { kind: VehicleKind; team: Team; index: number; x: number; z: number; yaw: number }

function fleetSpots(team: Team): Spot[] {
  const spots: Spot[] = []
  for (let i = 0; i < FLEET_SIZE; i++) {
    const heli = baseToWorld(team, ...LAYOUT.helis[i])
    spots.push({ kind: 'heli', team, index: i, ...heli, yaw: baseYaw(team, LAYOUT.heliYaw) })
    const car = baseToWorld(team, ...LAYOUT.cars[i])
    spots.push({ kind: 'car', team, index: i, ...car, yaw: baseYaw(team, LAYOUT.carYaw) })
  }
  return spots
}

export const vehicleId = (team: Team, kind: VehicleKind, index: number) => `${team}-${kind}-${index}`

type Piece = { geometry: THREE.BufferGeometry; material: THREE.Material }

/**
 * Merge a loaded model into as few pieces as possible (model space, scaled): untextured materials become
 * vertex colours on one shared material, each textured material keeps its own piece.
 */
function bakePieces(root: THREE.Object3D, scale: number, shared: THREE.MeshStandardMaterial): Piece[] {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const place = new THREE.Matrix4().makeScale(scale, scale, scale)
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

/**
 * Split a geometry into its connected pieces (vertices at the same spot count as joined), each returned
 * as its own geometry with the same attributes.
 */
function splitPieces(geometry: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const position = geometry.attributes.position
  const count = position.count
  const parent = Int32Array.from({ length: count }, (_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  const seen = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(position.getX(i) * 1e4)},${Math.round(position.getY(i) * 1e4)},${Math.round(position.getZ(i) * 1e4)}`
    const first = seen.get(key)
    if (first === undefined) seen.set(key, i)
    else union(i, first)
  }
  const index = geometry.index ? Array.from(geometry.index.array) : [...Array(count).keys()]
  for (let t = 0; t < index.length; t += 3) { union(index[t], index[t + 1]); union(index[t + 1], index[t + 2]) }
  const groups = new Map<number, number[]>()
  for (let t = 0; t < index.length; t += 3) {
    const root = find(index[t])
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(index[t], index[t + 1], index[t + 2])
  }
  return [...groups.values()].map((triangles) => {
    const piece = new THREE.BufferGeometry()
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const size = attribute.itemSize
      const data = new Float32Array(triangles.length * size)
      triangles.forEach((v, i) => { for (let k = 0; k < size; k++) data[i * size + k] = attribute.getComponent(v, k) })
      piece.setAttribute(name, new THREE.BufferAttribute(data, size))
    }
    return piece
  })
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

export function createFleet(): Fleet {
  const group = new THREE.Group()
  group.name = 'vehicles'
  const hitGroup = new THREE.Group()
  hitGroup.name = 'vehicle-hitboxes'
  const spots = [...fleetSpots('blue'), ...fleetSpots('red')]
  const hitMaterial = new THREE.MeshBasicMaterial({ visible: false })
  const vehicles: Vehicle[] = []
  const byId = new Map<string, Vehicle>()

  for (const spot of spots) {
    const object = new THREE.Object3D()
    object.rotation.order = 'YXZ'
    const y = heightAt(spot.x, spot.z)
    object.position.set(spot.x, y, spot.z)
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
    const seats = SEATS[spot.kind]
    const vehicle: Vehicle = {
      id, team: spot.team, kind: spot.kind, index: spot.index, object, hitbox,
      spin: 0, targetSpin: 0, steer: 0, occupants: Array(seats).fill(null), destroyed: false,
      doors: Array(seats).fill(0), doorHold: Array(seats).fill(0),
      home: { x: spot.x, y, z: spot.z, yaw: spot.yaw },
      rotorAngle: spot.index * 0.7, tailAngle: 0, wheelAngle: 0, lastYaw: spot.yaw,
    }
    vehicles.push(vehicle)
    byId.set(id, vehicle)
  }

  // Helicopters stand on the base's level concrete; cars on the ground outside
  const restHeight = (_v: Vehicle, x: number, z: number) => heightAt(x, z) + 0.02

  const clearance = (x: number, z: number, margin = 0) => spots.some((s) => Math.hypot(s.x - x, s.z - z) < (s.kind === 'heli' ? 8 : 5) + margin)

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

  const sendHome = (v: Vehicle) => {
    v.object.position.set(v.home.x, v.home.y, v.home.z)
    v.object.rotation.set(0, v.home.yaw, 0)
    v.spin = v.targetSpin = 0
    v.steer = 0
    v.destroyed = false
    v.lastYaw = v.home.yaw
  }

  // ---- Rendering (filled in once the models load) ----
  interface Door { meshes: THREE.InstancedMesh[]; hinge: THREE.Vector3; swing: number }
  interface HeliModel {
    statics: THREE.InstancedMesh[]; rotor: THREE.InstancedMesh[]; tail: THREE.InstancedMesh[]; doors: Door[]
    rotorHub: THREE.Vector3; rotorAxis: THREE.Vector3; tailHub: THREE.Vector3; tailAxis: THREE.Vector3
  }
  interface CarLevel { body: THREE.InstancedMesh[]; wheels: THREE.InstancedMesh[] }
  let heliModel: HeliModel | null = null
  let carNear: CarLevel | null = null
  let carFar: CarLevel | null = null
  const helis = vehicles.filter((v) => v.kind === 'heli')
  const cars = vehicles.filter((v) => v.kind === 'car')
  // Rough seats until the model loads (then placed from the model's own proportions)
  const heliSeats: HeliSeat[] = HELI_SEATS_MODEL.map(([x, , z]) => ({
    eye: new THREE.Vector3(x * HELI_SCALE, 2.2, z * HELI_SCALE),
    outside: new THREE.Vector3(Math.sign(x) * 2.2, 1.7, z * HELI_SCALE),
  }))

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
    const groups: Record<'static' | 'rotor' | 'tail', Piece[]> = { static: [], rotor: [], tail: [] }
    const place = new THREE.Matrix4().makeScale(HELI_SCALE, HELI_SCALE, HELI_SCALE).multiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z))
    // The side windows are the doors: cut them out of the glass so they can swing open on their front edge
    const doorPieces: Array<Piece[]> = [[], [], [], []]
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || Array.isArray(mesh.material)) return
      const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, toRoot.clone().multiply(mesh.matrixWorld)))
      const material = toStandardMaterial(mesh.material)
      if (!material.transparent) {
        groups[partOf(mesh)].push({ geometry, material })
        return
      }
      // Single pass for the see-through canopy (double-sided transparency draws twice)
      material.forceSinglePass = true
      material.depthWrite = false
      const fixed: THREE.BufferGeometry[] = []
      for (const piece of splitPieces(geometry)) {
        piece.computeBoundingBox()
        const c = piece.boundingBox!.getCenter(new THREE.Vector3())
        if (Math.abs(c.x) < 0.6) { fixed.push(piece); continue }
        doorPieces[(c.z > 0.4 ? 0 : 2) + (c.x > 0 ? 0 : 1)].push({ geometry: piece, material })
      }
      const rest = fixed.length > 1 ? mergeGeometries(fixed) : fixed[0]
      if (rest) groups.static.push({ geometry: rest, material })
    })
    // Pivots (metres, vehicle space) and spin axes: each rotor turns about its thinnest direction
    const pivot = (node: THREE.Object3D | undefined, pieces: Piece[]) => {
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
    const doors: Door[] = doorPieces.map((pieces, i) => {
      const bounds = new THREE.Box3()
      for (const p of pieces) { p.geometry.computeBoundingBox(); bounds.union(p.geometry.boundingBox!) }
      const hinge = new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, 0, bounds.max.z)
      // The back edge swings outwards: +X doors turn negative, -X doors positive
      return { meshes: pieces.map((p) => makeInstanced(p, capacity, false, group)), hinge, swing: i % 2 === 0 ? -DOOR_OPEN : DOOR_OPEN }
    })
    heliModel = {
      statics: groups.static.map((p) => makeInstanced(p, capacity, true, group)),
      rotor: groups.rotor.map((p) => makeInstanced(p, capacity, true, group)),
      tail: groups.tail.map((p) => makeInstanced(p, capacity, false, group)),
      doors,
      rotorHub: main.hub, rotorAxis: main.axis, tailHub: tail.hub, tailAxis: tail.axis,
    }
    // Seats from the model's own proportions
    HELI_SEATS_MODEL.forEach((seat, i) => {
      const eye = new THREE.Vector3(...seat).applyMatrix4(place)
      heliSeats[i].eye.copy(eye)
      heliSeats[i].outside.set(Math.sign(seat[0]) * 2.3, 1.7, eye.z - 0.3)
    })
    // Fit the hitboxes: cabin (everything ahead of the tail boom) and the boom back to the tail rotor
    const staticBounds = new THREE.Box3()
    for (const p of groups.static) { p.geometry.computeBoundingBox(); staticBounds.union(p.geometry.boundingBox!) }
    const cabinBack = main.hub.z - 1.6
    const cabinMin = new THREE.Vector3(-1.1, 0.35, cabinBack), cabinMax = new THREE.Vector3(1.1, main.hub.y - 0.45, staticBounds.max.z)
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
    const bodyPieces = bakePieces(body.scene, CAR_SCALE, sharedMaterial())
    const wheelPieces = bakePieces(wheel.scene, CAR_SCALE, sharedMaterial())
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
    const now = performance.now()
    for (const v of vehicles) {
      if (v.kind === 'heli') {
        // Rotor winds up and down smoothly (also after the pilot leaves); a wreck's rotor is still
        if (v.destroyed) v.targetSpin = v.spin = 0
        v.spin = THREE.MathUtils.clamp(THREE.MathUtils.lerp(v.spin, v.targetSpin, Math.min(1, 4 * dt)), 0, MAX_ROTOR_RPM)
        v.rotorAngle = (v.rotorAngle + v.spin * dt) % (Math.PI * 2)
        v.tailAngle = (v.tailAngle + v.spin * 1.5 * dt) % (Math.PI * 2)
        // Passenger doors stay open (they shoot out of them); any door opens while someone climbs through
        for (let seat = 0; seat < v.doors.length; seat++) {
          const open = !v.destroyed && ((seat > 0 && v.occupants[seat] !== null) || now < v.doorHold[seat])
          v.doors[seat] = THREE.MathUtils.clamp(v.doors[seat] + (open ? dt : -dt) * 2.5, 0, 1)
        }
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
        const tint = v.destroyed ? WRECK_TINT : TEAM_TINT[v.team]
        setInstances(heliModel.statics, n, m, tint)
        setInstances(heliModel.rotor, n, spinAbout(heliModel.rotorHub, heliModel.rotorAxis, v.rotorAngle).premultiply(m), tint)
        setInstances(heliModel.tail, n, spinAbout(heliModel.tailHub, heliModel.tailAxis, v.tailAngle).premultiply(m), tint)
        heliModel.doors.forEach((door, i) => {
          const angle = door.swing * (1 - (1 - v.doors[i]) ** 2)
          setInstances(door.meshes, n, spinAbout(door.hinge, yAxis, angle).premultiply(m), tint)
        })
        n++
      }
      finish([...heliModel.statics, ...heliModel.rotor, ...heliModel.tail, ...heliModel.doors.flatMap((d) => d.meshes)], n)
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
        const tint = v.destroyed ? WRECK_TINT : TEAM_TINT[v.team]
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

  return { group, hitGroup, vehicles, byId, heliSeats, restHeight, clearance, circles, sendHome, update }
}
