import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { loadModel, toStandardMaterial } from './assets'
import { heightAt } from './terrain'
import { baseToWorld, baseYaw, LAYOUT, type Team } from './layout'
import { createMechRig, type MechRig } from './mechs'
import { trackLoad } from './loading'

/**
 * Each team's motor pool: FLEET_SIZE helicopters on the base's landing area and FLEET_SIZE battle cars parked
 * outside the gate. Anyone may use any of them. Every vehicle is drawn with shared instanced meshes (a
 * handful of draw calls for all 20); the per-vehicle `object` only carries the pose and invisible hitboxes.
 */

export type VehicleKind = 'heli' | 'car' | 'tank' | 'mech'
export const FLEET_SIZE = 5
/** Rotor speed ceiling (the HUD shows it x10). */
export const MAX_ROTOR_RPM = 100
/** Seats per vehicle: a helicopter has pilot, co-pilot and two rear seats; a car just its driver. */
export const SEATS: Record<VehicleKind, number> = { heli: 4, car: 1, tank: 1, mech: 1 }
/** Hull strength per kind (the server's copy decides; this is for the HUD before the first report). */
export const VEHICLE_MAX_HP: Record<VehicleKind, number> = { heli: 450, car: 700, tank: 2000, mech: 1600 }
export const TANKS_PER_BASE = 2

const HELI_URL = '/models/heli_hind.glb'
const CAR_URL = '/models/battle_car.glb'
const CAR_FAR_URL = '/models/battle_car_far.glb'
const WHEEL_URL = '/models/battle_car_wheel.glb'
const WHEEL_FAR_URL = '/models/battle_car_wheel_far.glb'
const TURRET_URL = '/models/battle_car_turret.glb'
const GATLING_URL = '/models/battle_car_gatling.glb'
const TANK_HULL_URL = '/models/tank_hull.glb'
const TANK_TURRET_URL = '/models/tank_turret.glb'
const TANK_GUN_URL = '/models/tank_gun.glb'
/** The tank's tracks (one link model, laid round each loop) and road wheels, and where they sit. */
const TANK_RUNNING_URL = '/models/tank_running.glb'
const TANK_RUNNING_JSON = '/models/tank_running.json'

/**
 * The attack helicopter ("Hind Attack Helicopter" by Ashley Aslett, CC-BY 4.0, markings removed). Measured at
 * full size (metres, nose +Z, origin on the ground under the rotor hub); the game flies it at HELI_SCALE so five
 * of them fit on a base's landing row: 13.7 m long, 13.7 m rotor.
 */
const HELI_SCALE = 0.78
const HIND = {
  rotorHub: [0, 4.148, 0], rotorAxis: [0, 0.999836, 0.018083],
  tailHub: [0.498, 3.673, -10.338], tailAxis: [1, 0, 0],
  gunPivot: [0.003, 0.838, 5.647], gunMuzzle: [0.004, 0.832, 6.642],
  cabin: { min: [-0.951, 0.539, -3.185], max: [0.951, 3.646, 5.945] },
  boom: { min: [-0.608, 0.98, -11.4], max: [0.608, 2.989, -3.185] },
} as const
const hind = (v: readonly number[]) => new THREE.Vector3(v[0], v[1], v[2]).multiplyScalar(HELI_SCALE)
/** The nose gun (the gunner's): turns about HELI_GUN_PIVOT, this far to either side and up / down (radians). */
export const HELI_GUN_PIVOT = hind(HIND.gunPivot)
const HELI_GUN_MUZZLE = hind(HIND.gunMuzzle)
export const HELI_GUN_LIMITS = { yaw: 1.9, up: 0.2, down: 0.95 }
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
 * The car's roof gun (metres, car space): the dome turns about a vertical axis through YAW_PIVOT, the gatling
 * tilts about GATLING_PIVOT (on its own axis, which it also spins around), muzzle at GATLING_MUZZLE.
 */
export const TURRET_PIVOT = new THREE.Vector3(0, 0, -1.5925 * CAR_SCALE)
export const GATLING_PIVOT = new THREE.Vector3(0, 3.892 * CAR_SCALE, -0.473 * CAR_SCALE)
const GATLING_MUZZLE = new THREE.Vector3(0, 3.892 * CAR_SCALE, 1.239 * CAR_SCALE)
/** How high / low the gatling can point (radians). */
export const CAR_GUN_PITCH = { up: 0.55, down: 0.18 }
/**
 * The tank (metres, tank space, nose +Z, origin under the middle of the hull): the turret turns about the
 * vertical axis through TANK_TURRET_PIVOT, the gun tilts about TANK_GUN_PIVOT (on its trunnions), the muzzle is
 * at TANK_MUZZLE. The hull's footprint is two circles along it.
 */
export const TANK_TURRET_PIVOT = new THREE.Vector3(0, 0, 0.63)
export const TANK_GUN_PIVOT = new THREE.Vector3(0.054, 2.184, 2.53)
const TANK_MUZZLE = new THREE.Vector3(0.054, 2.184, 8.46)
export const TANK_GUN_PITCH = { up: 0.3, down: 0.12 }
export const TANK_CIRCLE_RADIUS = 2.15
export const TANK_CIRCLE_OFFSET = 2.35
export const TANK_LENGTH = 9.1
export const TANK_WIDTH = 4.2
/** The mech stands on a circle this big; it counts as airborne this far above the ground. */
export const MECH_RADIUS = 2.4
export const MECH_AIRBORNE = 0.6

/**
 * Helicopter seats (eye positions on the full-size model): the pilot in the raised rear cockpit, the gunner in
 * the nose (he works the nose gun), and two troopers at the cabin doors, leaning out to shoot. Seat i gets in
 * from the side its `outside` spot is on (x, z; standing eye height).
 */
const HELI_SEATS_MODEL: Array<{ eye: THREE.Vector3Tuple; outside: [number, number] }> = [
  { eye: [0, 2.4, 3.62], outside: [2.2, 3.4] },
  { eye: [0, 1.88, 4.85], outside: [-2.2, 4.6] },
  { eye: [1.12, 1.95, 1.32], outside: [2.2, 1.32] },
  { eye: [-1.12, 1.95, 1.32], outside: [-2.2, 1.32] },
]
/** How long a door stays open while someone climbs in or out (ms). */
export const DOOR_HOLD_MS = 1600

/** Cars closer than this use the detailed model and cast shadows. */
const CAR_DETAIL_DISTANCE = 75
/** Mechs further than this skip shadows. */
const FAR_MECH_DISTANCE = 90
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
  /** Hull strength left (0 = wreck). */
  hp: number
  /** Car roof gun / tank turret: turn and tilt relative to the vehicle, recoil (1 → 0 after a shot), gatling barrel spin. */
  aimYaw: number
  aimPitch: number
  gunRecoil: number
  gatlingSpin: number
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
  /** Where a car's gatling muzzle / a tank's gun muzzle is right now (world space). */
  carMuzzle: (v: Vehicle, out: THREE.Vector3) => THREE.Vector3
  /** A car's gatling / a tank's gun: its muzzle and the way its barrel points right now (world space). */
  gunRay: (v: Vehicle, muzzle: THREE.Vector3, dir: THREE.Vector3) => void
  /** Where a ray really meets a vehicle's body (for bullet holes), world space; null if it misses the model. */
  surfaceHit: (v: Vehicle, origin: THREE.Vector3, dir: THREE.Vector3, far: number) => { point: THREE.Vector3; normal: THREE.Vector3 } | null
  update: (dt: number, camera: THREE.Vector3, localDriver: Vehicle | null) => void
  /** A mech's animated rig (muzzles, rocket pods, cockpit), null for other vehicles. */
  mech: (v: Vehicle) => MechRig | null
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
  LAYOUT.tanks.forEach(([x, z], i) => spots.push({ kind: 'tank', team, index: i, ...baseToWorld(team, x, z), yaw: baseYaw(team, LAYOUT.tankYaw) }))
  LAYOUT.mechs.forEach(([x, z], i) => spots.push({ kind: 'mech', team, index: i, ...baseToWorld(team, x, z), yaw: baseYaw(team, LAYOUT.mechYaw) }))
  return spots
}

export const vehicleId = (team: Team, kind: VehicleKind, index: number) => `${team}-${kind}-${index}`

type Piece = { geometry: THREE.BufferGeometry; material: THREE.Material }

/**
 * Merge a loaded model into one piece per material (model space, scaled), keeping its smooth normals, UVs and its
 * full PBR materials (colour, normal, roughness / metal, emissive maps): vehicles are drawn at full quality.
 */
function bakePieces(root: THREE.Object3D, scale: number): Piece[] {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const place = new THREE.Matrix4().makeScale(scale, scale, scale)
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>()
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || Array.isArray(mesh.material)) return
    const material = mesh.material as THREE.MeshStandardMaterial
    const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, toRoot.clone().multiply(mesh.matrixWorld)))
    const keep = ['position', 'normal', 'uv', ...(material.vertexColors ? ['color'] : [])]
    for (const name of Object.keys(geometry.attributes)) if (!keep.includes(name)) geometry.deleteAttribute(name)
    geometry.morphAttributes = {}
    if (!geometry.index) geometry.setIndex([...Array(geometry.attributes.position.count).keys()])
    if (!geometry.attributes.normal) geometry.computeVertexNormals()
    if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2))
    if (!byMaterial.has(material)) byMaterial.set(material, [])
    byMaterial.get(material)!.push(geometry)
  })
  const pieces: Piece[] = []
  for (const [material, list] of byMaterial) {
    const geometry = list.length === 1 ? list[0] : mergeGeometries(list)
    if (!geometry) continue
    if (geometry !== list[0]) for (const g of list) g.dispose()
    pieces.push({ geometry, material: toStandardMaterial(material) })
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
    if (spot.kind === 'heli') { box.scale.set(2.4, 2.8, 5.5); box.position.set(0, 1.9, 1) } else if (spot.kind === 'car') { box.scale.set(3.6, 2.8, 6.1); box.position.set(0, 1.9, 0) } else if (spot.kind === 'mech') { box.scale.set(4.4, 3.0, 3.2); box.position.set(0, 5.7, 0.1) } else { box.scale.set(4.2, 2.0, 9.1); box.position.set(0, 1.1, 0) }
    hitbox.add(box)
    if (spot.kind === 'mech') {
      // The legs under the torso
      const legs = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hitMaterial)
      legs.scale.set(3.2, 4.3, 2.4)
      legs.position.set(0, 2.15, 0)
      hitbox.add(legs)
    }
    if (spot.kind === 'tank') {
      // The turret on top (round enough that one box covers it whichever way it faces)
      const turret = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hitMaterial)
      turret.scale.set(3.3, 1.35, 3.3)
      turret.position.set(0.1, 2.55, 0.63)
      hitbox.add(turret)
    }
    object.add(hitbox)
    hitGroup.add(object)
    const seats = SEATS[spot.kind]
    const vehicle: Vehicle = {
      id, team: spot.team, kind: spot.kind, index: spot.index, object, hitbox,
      spin: 0, targetSpin: 0, steer: 0, occupants: Array(seats).fill(null), destroyed: false,
      doors: Array(seats).fill(0), doorHold: Array(seats).fill(0),
      home: { x: spot.x, y, z: spot.z, yaw: spot.yaw },
      hp: VEHICLE_MAX_HP[spot.kind],
      aimYaw: 0, aimPitch: 0, gunRecoil: 0, gatlingSpin: 0,
      rotorAngle: spot.index * 0.7, tailAngle: 0, wheelAngle: 0, lastYaw: spot.yaw,
    }
    vehicles.push(vehicle)
    byId.set(id, vehicle)
  }

  // Helicopters stand on the base's level concrete; cars on the ground outside
  const restHeight = (_v: Vehicle, x: number, z: number) => heightAt(x, z) + 0.02

  const clearance = (x: number, z: number, margin = 0) => spots.some((s) => Math.hypot(s.x - x, s.z - z) < (s.kind === 'heli' ? 8 : s.kind === 'tank' || s.kind === 'mech' ? 6 : 5) + margin)

  const circles = (skip?: Vehicle | null) => {
    const out: Array<{ x: number; z: number; r: number }> = []
    for (const v of vehicles) {
      if (v === skip) continue
      const p = v.object.position
      if (v.kind === 'heli') {
        // A flying helicopter doesn't block anything below it
        if (p.y - restHeight(v, p.x, p.z) > 3) continue
        out.push({ x: p.x, z: p.z, r: HELI_BODY_RADIUS })
      } else if (v.kind === 'mech') {
        // A mech up on its jets doesn't block the ground
        if (p.y - heightAt(p.x, p.z) > 3) continue
        out.push({ x: p.x, z: p.z, r: MECH_RADIUS })
      } else {
        const tank = v.kind === 'tank'
        const offset = tank ? TANK_CIRCLE_OFFSET : CAR_CIRCLE_OFFSET, r = tank ? TANK_CIRCLE_RADIUS : CAR_CIRCLE_RADIUS
        const fx = Math.sin(v.object.rotation.y) * offset, fz = Math.cos(v.object.rotation.y) * offset
        out.push({ x: p.x + fx, z: p.z + fz, r }, { x: p.x - fx, z: p.z - fz, r })
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
    v.aimYaw = v.aimPitch = v.gunRecoil = 0
    v.hp = VEHICLE_MAX_HP[v.kind]
  }

  // ---- Rendering (filled in once the models load) ----
  interface HeliModel {
    statics: THREE.InstancedMesh[]; glass: THREE.InstancedMesh[]; rotor: THREE.InstancedMesh[]; tail: THREE.InstancedMesh[]; gun: THREE.InstancedMesh[]
    rotorHub: THREE.Vector3; rotorAxis: THREE.Vector3; tailHub: THREE.Vector3; tailAxis: THREE.Vector3
  }
  interface CarLevel { body: THREE.InstancedMesh[]; wheels: THREE.InstancedMesh[] }
  let carGun: { turret: THREE.InstancedMesh[]; gatling: THREE.InstancedMesh[] } | null = null
  let tankModel: { hull: THREE.InstancedMesh[]; turret: THREE.InstancedMesh[]; gun: THREE.InstancedMesh[] } | null = null
  /** Plain (not drawn) meshes of each vehicle kind's body, to find where rounds meet it. */
  const surfaces: Record<VehicleKind, THREE.Mesh[]> = { heli: [], car: [], tank: [], mech: [] }
  const surfaceMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  let heliModel: HeliModel | null = null
  let carNear: CarLevel | null = null
  let carFar: CarLevel | null = null
  const helis = vehicles.filter((v) => v.kind === 'heli')
  const cars = vehicles.filter((v) => v.kind === 'car')
  const tanks = vehicles.filter((v) => v.kind === 'tank')
  // Mechs are animated models of their own (only a few of them)
  const mechRigs = new Map<Vehicle, MechRig>()
  const mechTrack = new Map<Vehicle, { y: number; rising: boolean; yaw: number; turn: number }>()
  for (const v of vehicles) {
    if (v.kind !== 'mech') continue
    const rig = createMechRig(v.team)
    mechRigs.set(v, rig)
    mechTrack.set(v, { y: v.object.position.y, rising: false, yaw: v.object.rotation.y, turn: 0 })
    group.add(rig.object)
  }
  const heliSeats: HeliSeat[] = HELI_SEATS_MODEL.map(({ eye, outside }) => ({
    eye: hind(eye),
    outside: new THREE.Vector3(outside[0] * HELI_SCALE, 1.7, outside[1] * HELI_SCALE),
  }))
  // Hitboxes: the cabin and the tail boom
  for (const v of vehicles) {
    if (v.kind !== 'heli') continue
    v.hitbox.clear()
    for (const box of [HIND.cabin, HIND.boom]) {
      const min = hind(box.min), max = hind(box.max)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hitMaterial)
      mesh.scale.subVectors(max, min)
      mesh.position.addVectors(min, max).multiplyScalar(0.5)
      v.hitbox.add(mesh)
    }
  }

  void (async () => {
    const gltf = await loadModel(HELI_URL)
    const root = gltf.scene
    root.updateMatrixWorld(true)
    const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
    const place = new THREE.Matrix4().makeScale(HELI_SCALE, HELI_SCALE, HELI_SCALE)
    type Part = 'static' | 'glass' | 'rotor' | 'tail' | 'gun'
    const partOf = (node: THREE.Object3D): Part => {
      for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n.name === 'rotor' || n.name === 'tail' || n.name === 'gun' || n.name === 'glass') return n.name
      return 'static'
    }
    const byPart: Record<Part, Map<THREE.Material, THREE.BufferGeometry[]>> = { static: new Map(), glass: new Map(), rotor: new Map(), tail: new Map(), gun: new Map() }
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || Array.isArray(mesh.material)) return
      const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, toRoot.clone().multiply(mesh.matrixWorld)))
      for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name)
      if (!geometry.index) geometry.setIndex([...Array(geometry.attributes.position.count).keys()])
      if (!geometry.attributes.normal) geometry.computeVertexNormals()
      if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2))
      const map = byPart[partOf(mesh)]
      if (!map.has(mesh.material)) map.set(mesh.material, [])
      map.get(mesh.material)!.push(geometry)
    })
    const pieces = (part: Part): Piece[] => [...byPart[part]].flatMap(([source, list]) => {
      const geometry = list.length === 1 ? list[0] : mergeGeometries(list)
      if (!geometry) return []
      const material = toStandardMaterial(source)
      if (material.transparent) {
        // Canopy glass: one pass, no depth writes (it's drawn after the cockpit it shows)
        material.depthWrite = false
        material.forceSinglePass = true
      }
      return [{ geometry, material }]
    })
    const capacity = helis.length
    const inst = (list: Piece[], shadows: boolean) => list.map((p) => makeInstanced(p, capacity, shadows, group))
    const statics = pieces('static')
    surfaces.heli = statics.filter((p) => !(p.material as THREE.MeshStandardMaterial).transparent).map((p) => new THREE.Mesh(p.geometry, surfaceMaterial))
    heliModel = {
      statics: inst(statics, true),
      glass: inst(pieces('glass'), false),
      rotor: inst(pieces('rotor'), true),
      tail: inst(pieces('tail'), false),
      gun: inst(pieces('gun'), true),
      rotorHub: hind(HIND.rotorHub),
      rotorAxis: new THREE.Vector3(...HIND.rotorAxis).normalize(),
      tailHub: hind(HIND.tailHub),
      tailAxis: new THREE.Vector3(...HIND.tailAxis),
    }
  })().catch((error) => console.error('[vehicles] helicopter model failed to load:', error))

  const loadCar = async (bodyUrl: string, wheelUrl: string, shadows: boolean): Promise<CarLevel> => {
    const [body, wheel] = await Promise.all([loadModel(bodyUrl), loadModel(wheelUrl)])
    const bodyPieces = bakePieces(body.scene, CAR_SCALE)
    const wheelPieces = bakePieces(wheel.scene, CAR_SCALE)
    return {
      body: bodyPieces.map((p) => makeInstanced(p, cars.length, shadows, group)),
      // Wheel shadows are mostly hidden under the body's: 40 wheels aren't worth drawing twice
      wheels: wheelPieces.map((p) => makeInstanced(p, cars.length * WHEELS.length, false, group)),
    }
  }
  void loadCar(CAR_URL, WHEEL_URL, true).then((level) => {
    carNear = level
    surfaces.car = level.body.map((mesh) => new THREE.Mesh(mesh.geometry, surfaceMaterial))
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
  void Promise.all([loadModel(TURRET_URL), loadModel(GATLING_URL)]).then(([turret, gatling]) => {
    carGun = {
      turret: bakePieces(turret.scene, CAR_SCALE).map((p) => makeInstanced(p, cars.length, true, group)),
      gatling: bakePieces(gatling.scene, CAR_SCALE).map((p) => makeInstanced(p, cars.length, true, group)),
    }
  }).catch((error) => console.error('[vehicles] battle car gun failed to load:', error))
  // The tank (Challenger 2 by Tom Zimmermann, CC-BY 4.0): hull with tracks and road wheels, turret, gun — already in tank space
  void Promise.all([loadModel(TANK_HULL_URL), loadModel(TANK_TURRET_URL), loadModel(TANK_GUN_URL)]).then(([hull, turret, gun]) => {
    const hullPieces = bakePieces(hull.scene, 1)
    tankModel = {
      hull: hullPieces.map((p) => makeInstanced(p, tanks.length, true, group)),
      turret: bakePieces(turret.scene, 1).map((p) => makeInstanced(p, tanks.length, true, group)),
      gun: bakePieces(gun.scene, 1).map((p) => makeInstanced(p, tanks.length, true, group)),
    }
    surfaces.tank = hullPieces.map((p) => new THREE.Mesh(p.geometry, surfaceMaterial))
  }).catch((error) => console.error('[vehicles] tank model failed to load:', error))

  // The tracks and road wheels move: each link slides round its loop towards the next link's place, each wheel
  // turns on its axle, the two sides separately (a tank turning on the spot runs them in opposite directions)
  interface Pose { p: THREE.Vector3; q: THREE.Quaternion }
  interface Running {
    links: THREE.InstancedMesh[]; loops: Record<'left' | 'right', Pose[]>; pitch: number; step: number
    wheels: Array<{ meshes: THREE.InstancedMesh[]; spots: Array<{ matrix: THREE.Matrix4; center: THREE.Vector3; radius: number; side: 'left' | 'right' }> }>
  }
  let running: Running | null = null
  const tracks = new Map<Vehicle, { left: number; right: number; yaw: number }>()
  for (const v of tanks) tracks.set(v, { left: 0, right: 0, yaw: v.object.rotation.y })
  void Promise.all([loadModel(TANK_RUNNING_URL), trackLoad(TANK_RUNNING_JSON, fetch(TANK_RUNNING_JSON).then((r) => r.json()))]).then(([gltf, layout]) => {
    const root = gltf.scene
    root.updateMatrixWorld(true)
    const piecesOf = (name: string) => {
      const node = root.getObjectByName(name)
      return node ? bakePieces(node, 1) : []
    }
    const toPose = (m: number[]): Pose => {
      const matrix = new THREE.Matrix4().fromArray(m)
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
      matrix.decompose(p, q, sc)
      return { p, q }
    }
    const perTank = layout.links.left.length + layout.links.right.length
    const wheelGroups = new Map<number, Running['wheels'][number]['spots']>()
    for (const w of layout.wheels as Array<{ mesh: number; matrix: number[]; center: number[]; radius: number; side: 'left' | 'right' }>) {
      if (!wheelGroups.has(w.mesh)) wheelGroups.set(w.mesh, [])
      wheelGroups.get(w.mesh)!.push({ matrix: new THREE.Matrix4().fromArray(w.matrix), center: new THREE.Vector3(...w.center), radius: w.radius, side: w.side })
    }
    running = {
      links: piecesOf('link').map((p) => makeInstanced(p, tanks.length * perTank, false, group)),
      loops: { left: layout.links.left.map(toPose), right: layout.links.right.map(toPose) },
      pitch: layout.pitch,
      step: layout.forward === 1 ? 1 : -1,
      wheels: [...wheelGroups].map(([mesh, spots]) => ({ meshes: piecesOf(`wheel_${mesh}`).map((p) => makeInstanced(p, tanks.length * spots.length, false, group)), spots })),
    }
  }).catch((error) => console.error('[vehicles] tank tracks failed to load:', error))

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
  const zAxis = new THREE.Vector3(0, 0, 1)
  /** Car-space matrices of the roof dome and the gatling for the gun's current aim. */
  const gunMatrices = (v: Vehicle, turret: THREE.Matrix4, gatling: THREE.Matrix4) => {
    turret.makeTranslation(TURRET_PIVOT.x, TURRET_PIVOT.y, TURRET_PIVOT.z).multiply(spinM.makeRotationY(v.aimYaw)).multiply(fromHub.makeTranslation(-TURRET_PIVOT.x, -TURRET_PIVOT.y, -TURRET_PIVOT.z))
    const kick = v.gunRecoil * v.gunRecoil * 0.14
    gatling.copy(turret).multiply(toHub.makeTranslation(GATLING_PIVOT.x, GATLING_PIVOT.y, GATLING_PIVOT.z))
      .multiply(spinM.makeRotationX(-v.aimPitch)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -kick))
      .multiply(new THREE.Matrix4().makeRotationAxis(zAxis, v.gatlingSpin)).multiply(fromHub.makeTranslation(-GATLING_PIVOT.x, -GATLING_PIVOT.y, -GATLING_PIVOT.z))
  }
  /** Tank-space matrices of the turret (turning about the origin) and the gun (tilting, sliding back on recoil). */
  const tankMatrices = (v: Vehicle, turret: THREE.Matrix4, gun: THREE.Matrix4) => {
    const tp = TANK_TURRET_PIVOT
    turret.makeTranslation(tp.x, tp.y, tp.z).multiply(spinM.makeRotationY(v.aimYaw)).multiply(fromHub.makeTranslation(-tp.x, -tp.y, -tp.z))
    const kick = v.gunRecoil * v.gunRecoil * 0.45
    gun.copy(turret).multiply(toHub.makeTranslation(TANK_GUN_PIVOT.x, TANK_GUN_PIVOT.y, TANK_GUN_PIVOT.z))
      .multiply(spinM.makeRotationX(-v.aimPitch)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -kick))
      .multiply(fromHub.makeTranslation(-TANK_GUN_PIVOT.x, -TANK_GUN_PIVOT.y, -TANK_GUN_PIVOT.z))
  }
  /** Helicopter-space matrix of the nose gun for its current aim. */
  const heliGunMatrix = (v: Vehicle, out: THREE.Matrix4) => {
    const p = HELI_GUN_PIVOT
    return out.makeTranslation(p.x, p.y, p.z).multiply(spinM.makeRotationY(v.aimYaw)).multiply(new THREE.Matrix4().makeRotationX(-v.aimPitch)).multiply(fromHub.makeTranslation(-p.x, -p.y, -p.z))
  }
  const turretM = new THREE.Matrix4(), gatlingM = new THREE.Matrix4()
  const carMuzzle = (v: Vehicle, out: THREE.Vector3) => {
    if (v.kind === 'heli') {
      v.object.updateMatrix()
      return out.copy(HELI_GUN_MUZZLE).applyMatrix4(heliGunMatrix(v, gatlingM)).applyMatrix4(v.object.matrix)
    }
    const rig = mechRigs.get(v)
    if (rig) { rig.gun(out, new THREE.Vector3()); return out }
    v.object.updateMatrix()
    if (v.kind === 'tank') {
      tankMatrices(v, turretM, gatlingM)
      return out.copy(TANK_MUZZLE).applyMatrix4(gatlingM).applyMatrix4(v.object.matrix)
    }
    gunMatrices(v, turretM, gatlingM)
    return out.copy(GATLING_MUZZLE).applyMatrix4(gatlingM).applyMatrix4(v.object.matrix)
  }
  const gunRay = (v: Vehicle, muzzle: THREE.Vector3, dir: THREE.Vector3) => {
    const rig = mechRigs.get(v)
    if (rig) { rig.gun(muzzle, dir); return }
    if (v.kind === 'heli') {
      carMuzzle(v, muzzle)
      dir.copy(HELI_GUN_PIVOT).applyMatrix4(gatlingM).applyMatrix4(v.object.matrix)
      dir.subVectors(muzzle, dir).normalize()
      return
    }
    const tank = v.kind === 'tank'
    carMuzzle(v, muzzle)
    // The breech sits on the barrel's axis too: muzzle minus breech is the way it points
    dir.copy(tank ? TANK_GUN_PIVOT : GATLING_PIVOT).applyMatrix4(gatlingM).applyMatrix4(v.object.matrix)
    dir.subVectors(muzzle, dir).normalize()
  }
  const surfaceRay = new THREE.Raycaster()
  const surfaceHit = (v: Vehicle, origin: THREE.Vector3, dir: THREE.Vector3, far: number) => {
    v.object.updateMatrixWorld()
    surfaceRay.set(origin, dir)
    surfaceRay.far = far
    let best: THREE.Intersection | null = null
    for (const mesh of surfaces[v.kind]) {
      mesh.matrixWorld.copy(v.object.matrixWorld)
      const hit = surfaceRay.intersectObject(mesh, false)[0]
      if (hit && (!best || hit.distance < best.distance)) best = hit
    }
    if (!best?.face) return null
    return { point: best.point.clone(), normal: best.face.normal.clone().transformDirection(v.object.matrixWorld) }
  }

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
      } else if (v.kind === 'tank') {
        if (v !== localDriver) v.spin = THREE.MathUtils.lerp(v.spin, v.targetSpin, Math.min(1, 6 * dt))
        v.gunRecoil = Math.max(0, v.gunRecoil - dt * 1.4)
        // How far each track has run: forward speed, plus / minus the turn (the left track is at +x)
        const track = tracks.get(v)!
        const yawRate = Math.atan2(Math.sin(v.object.rotation.y - track.yaw), Math.cos(v.object.rotation.y - track.yaw)) / Math.max(dt, 1e-3)
        track.yaw = v.object.rotation.y
        const half = TANK_WIDTH * 0.37
        track.left += (v.spin - yawRate * half) * dt
        track.right += (v.spin + yawRate * half) * dt
      } else if (v.kind === 'mech') {
        if (v !== localDriver) v.spin = THREE.MathUtils.lerp(v.spin, v.targetSpin, Math.min(1, 6 * dt))
        v.gunRecoil = Math.max(0, v.gunRecoil - dt * 6)
      } else {
        if (v !== localDriver) {
          v.spin = THREE.MathUtils.lerp(v.spin, v.targetSpin, Math.min(1, 6 * dt))
          // Remote cars: steer the front wheels from how fast the car is turning
          const yawRate = Math.atan2(Math.sin(v.object.rotation.y - v.lastYaw), Math.cos(v.object.rotation.y - v.lastYaw)) / Math.max(dt, 1e-3)
          const steer = Math.abs(v.spin) > 0.5 ? Math.atan((yawRate * CAR_WHEELBASE) / v.spin) : 0
          v.steer = THREE.MathUtils.lerp(v.steer, THREE.MathUtils.clamp(steer, -0.6, 0.6), Math.min(1, 8 * dt))
        }
        v.wheelAngle = (v.wheelAngle + (v.spin * dt) / CAR_WHEEL_RADIUS) % (Math.PI * 2)
        // The gatling keeps spinning for a moment after the last shot
        v.gatlingSpin = (v.gatlingSpin + v.gunRecoil * 30 * dt) % (Math.PI * 2)
        v.gunRecoil = Math.max(0, v.gunRecoil - dt * 6)
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
        setInstances(heliModel.glass, n, m, tint)
        // The main rotor turns clockwise seen from above
        setInstances(heliModel.rotor, n, spinAbout(heliModel.rotorHub, heliModel.rotorAxis, -v.rotorAngle).premultiply(m), tint)
        setInstances(heliModel.tail, n, spinAbout(heliModel.tailHub, heliModel.tailAxis, v.tailAngle).premultiply(m), tint)
        setInstances(heliModel.gun, n, part.multiplyMatrices(m, heliGunMatrix(v, turretM)), tint)
        n++
      }
      finish([...heliModel.statics, ...heliModel.glass, ...heliModel.rotor, ...heliModel.tail, ...heliModel.gun], n)
    }

    for (const [v, rig] of mechRigs) {
      const d2 = v.object.position.distanceToSquared(camera)
      rig.object.visible = d2 < VISIBLE_DISTANCE ** 2
      if (!rig.object.visible) continue
      const track = mechTrack.get(v)!
      const p = v.object.position
      const vy = (p.y - track.y) / Math.max(dt, 1e-3)
      track.rising = vy > 0.5 ? true : vy < -0.5 ? false : track.rising
      track.y = p.y
      const yawRate = Math.atan2(Math.sin(v.object.rotation.y - track.yaw), Math.cos(v.object.rotation.y - track.yaw)) / Math.max(dt, 1e-3)
      track.turn = THREE.MathUtils.lerp(track.turn, yawRate, Math.min(1, dt * 8))
      track.yaw = v.object.rotation.y
      rig.object.position.copy(p)
      rig.object.rotation.set(0, v.object.rotation.y, 0)
      const airborne = p.y - heightAt(p.x, p.z) > MECH_AIRBORNE
      rig.update(d2 > FAR_MECH_DISTANCE ** 2 ? dt : dt, {
        speed: v.spin, turn: track.turn, airborne, rising: airborne && track.rising,
        aimYaw: v.aimYaw, aimPitch: v.aimPitch, occupied: v.occupants[0] !== null, destroyed: v.destroyed,
      }, d2 < 90 * 90)
    }

    if (tankModel) {
      let n = 0
      for (const v of tanks) {
        if (v.object.position.distanceToSquared(camera) > VISIBLE_DISTANCE ** 2) continue
        v.object.updateMatrix()
        tankMatrices(v, turretM, gatlingM)
        const tint = v.destroyed ? WRECK_TINT : TEAM_TINT[v.team]
        setInstances(tankModel.hull, n, v.object.matrix, tint)
        setInstances(tankModel.turret, n, part.multiplyMatrices(v.object.matrix, turretM), tint)
        setInstances(tankModel.gun, n, part.multiplyMatrices(v.object.matrix, gatlingM), tint)
        n++
      }
      finish([...tankModel.hull, ...tankModel.turret, ...tankModel.gun], n)
    }
    if (running) {
      const gear = running
      let n = 0
      const lp = new THREE.Vector3(), lq = new THREE.Quaternion(), local = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1)
      let slot = 0
      const wheelSlots = gear.wheels.map(() => 0)
      for (const v of tanks) {
        if (v.object.position.distanceToSquared(camera) > VISIBLE_DISTANCE ** 2) continue
        const tint = v.destroyed ? WRECK_TINT : TEAM_TINT[v.team]
        const track = tracks.get(v)!
        for (const side of ['left', 'right'] as const) {
          const loop = gear.loops[side]
          const count = loop.length
          const u = (side === 'left' ? track.left : track.right) / gear.pitch
          const k = Math.floor(u), f = u - k
          for (let i = 0; i < count; i++) {
            const a = loop[(((i + gear.step * k) % count) + count) % count]
            const b = loop[(((i + gear.step * (k + 1)) % count) + count) % count]
            lp.lerpVectors(a.p, b.p, f)
            lq.slerpQuaternions(a.q, b.q, f)
            local.compose(lp, lq, one)
            setInstances(gear.links, slot++, part.multiplyMatrices(v.object.matrix, local), tint)
          }
        }
        gear.wheels.forEach((group, gi) => {
          for (const spot of group.spots) {
            const angle = (spot.side === 'left' ? track.left : track.right) / spot.radius
            local.makeTranslation(spot.center.x, spot.center.y, spot.center.z).multiply(spinM.makeRotationX(angle)).multiply(fromHub.makeTranslation(-spot.center.x, -spot.center.y, -spot.center.z)).multiply(spot.matrix)
            setInstances(group.meshes, wheelSlots[gi]++, part.multiplyMatrices(v.object.matrix, local), tint)
          }
        })
        n++
      }
      finish(gear.links, slot)
      gear.wheels.forEach((group, gi) => finish(group.meshes, wheelSlots[gi]))
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
      if (carGun) {
        let n = 0
        for (const v of cars) {
          if (v.object.position.distanceToSquared(camera) > VISIBLE_DISTANCE ** 2) continue
          gunMatrices(v, turretM, gatlingM)
          const tint = v.destroyed ? WRECK_TINT : TEAM_TINT[v.team]
          setInstances(carGun.turret, n, part.multiplyMatrices(v.object.matrix, turretM), tint)
          setInstances(carGun.gatling, n, part.multiplyMatrices(v.object.matrix, gatlingM), tint)
          n++
        }
        finish([...carGun.turret, ...carGun.gatling], n)
      }
      finish([...near.body], nearCount)
      finish([...near.wheels], nearCount * WHEELS.length)
      if (far !== near) {
        finish([...far.body], farCount)
        finish([...far.wheels], farCount * WHEELS.length)
      }
    }
  }

  return { group, hitGroup, vehicles, byId, heliSeats, restHeight, clearance, circles, sendHome, carMuzzle, gunRay, surfaceHit, update, mech: (v) => mechRigs.get(v) ?? null }
}
