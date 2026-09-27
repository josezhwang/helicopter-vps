import * as THREE from 'three'
import { createTerrain, createWater, createSkyAndLights, heightAt, SHADOW_RANGE, SUN_OFFSET, FOG_FAR } from './world/terrain'
import { createBase, GEM_LOCAL, BASE_HALF, type BaseObjects, type Team } from './world/bases'
import { createRocks, createBushes, createClouds, createGrass, type GrassField, type RockField } from './world/nature'
import { createForest, type ForestField } from './world/forest'
import { createTurrets, type Turret, type TurretField } from './world/turrets'
import { createFleet, driverOf, DOOR_HOLD_MS, MAX_ROTOR_RPM, CAR_WHEELBASE, CAR_TRACK, CAR_CIRCLE_RADIUS, CAR_CIRCLE_OFFSET, type Fleet, type Vehicle } from './world/vehicles'
import { BASE_CENTER, BASE_ROTATION, LAYOUT, PLATEAU_HALF, baseToWorld, baseYaw } from './world/layout'
import { Player, EYE_HEIGHT } from './world/player'
import { Viewmodel } from './world/viewmodel'
import { Arsenal } from './world/weapon'
import { WEAPONS, WEAPON_KINDS, MACHINE_GUN, LOCK_TIME, LOCK_CONE, type WeaponKind } from './world/weapons'
import { createItems, ITEM_LABEL, AMMO_OF, type ItemField, type NetItem } from './world/items'
import { createProjectiles, type Projectiles } from './world/projectiles'
import { createAvatar, type Avatar } from './world/avatar'
import { gameState, setGameState, type RosterEntry } from './state'
import type { Multiplayer, NetPlayer, NetState, Took, Vec3, WorldSnapshot } from './net'

export interface MatchSetup {
  you: string
  players: NetPlayer[]
  net: Multiplayer
  /** Vehicles, supplies and wrecks as the server has them. */
  world?: WorldSnapshot
}

interface RemotePlayer {
  info: NetPlayer
  avatar: Avatar | null
  target: NetState | null
  snapped: boolean
  /** Died inside a vehicle: the body is inside it, so no death animation on the ground. */
  diedInVehicle: boolean
  /** Smoothed ground speed of the rendered avatar, drives idle/run blending. */
  speed: number
}

/** Climbing into / out of a helicopter: the view moves from where we stand, past the door, to the seat (or back). */
interface Transition {
  kind: 'board' | 'exit'
  vehicle: Vehicle
  seat: number
  t: number
  duration: number
  /** World-space start and end of the move (the door point is taken from the helicopter each frame). */
  from: THREE.Vector3
  to: THREE.Vector3
}

const NET_SEND_INTERVAL = 1 / 15
const ROSTER_INTERVAL = 0.3
/** Other players' solid radius; with the player's own 0.6 radius, bodies keep ~1m apart. */
const PLAYER_BLOCK_RADIUS = 0.45
const PLAYER_BLOCK_HEIGHT = 1.8
/** Jumps further than this (respawn, leaving a vehicle) snap instead of gliding across the map. */
const SNAP_DISTANCE = 25
const TEAM_NAME: Record<Team, string> = { blue: 'BLUE', red: 'RED' }
/** How close you have to be to get in (metres from the vehicle's centre) or onto a machine gun. */
const BOARD_RANGE = { heli: 7.5, car: 6 }
const GUN_RANGE = 3.8
/** Battle car handling: top speed / reverse speed (m/s), acceleration, braking, coasting (m/s²), steering lock. */
const CAR_MAX_SPEED = 24
const CAR_REVERSE_SPEED = 8
const CAR_ACCEL = 9
const CAR_BRAKE = 22
const CAR_ROLL = 2.5
const CAR_MAX_STEER = 0.55
/** Cars can't drive into water deeper than this (terrain height; the water surface is at -6). */
const CAR_WATER_LIMIT = -4.5
/** Eye position of the car's roof gunner, in car space. */
const CAR_GUNNER_SEAT = new THREE.Vector3(0, 4.4, -0.3)
const WORLD_LIMIT = 480
/** Seconds to climb into / out of a helicopter. */
const BOARD_TIME = 1.5
const EXIT_TIME = 1.1
/** Machine gun aim limits: how far up (and down) the barrel can point. */
const GUN_PITCH_UP = 0.9
const GUN_PITCH_DOWN = 0.3
const label = (v: Vehicle) => (v.kind === 'heli' ? 'helicopter' : 'battle car')
const other = (team: Team): Team => (team === 'blue' ? 'red' : 'blue')
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function lerpAngle(from: number, to: number, t: number) {
  return from + wrap(to - from) * t
}

/** Inside a base's walls (square, both bases are turned in quarter turns), with a margin. */
function inBase(x: number, z: number, margin: number) {
  return Object.values(BASE_CENTER).some((c) => Math.max(Math.abs(x - c.x), Math.abs(z - c.z)) < BASE_HALF + margin)
}

export class BattlefieldGame {
  readonly team: Team
  private remotes = new Map<string, RemotePlayer>()
  private lastNetSend = 0
  private lastRosterAt = 0
  private lastFrameAt = 0
  private lastRosterJson = ''
  private captureSent = false
  /** Both bases' helicopters and battle cars (anyone may use any); `vehicle` / `seat` is where we sit. */
  private fleet: Fleet
  private vehicle: Vehicle | null = null
  private seat = 0
  private transition: Transition | null = null
  /** The machine gun we are manning. */
  private turret: Turret | null = null
  private gunCooldown = 0
  /** Cockpit / roof-gunner view or the chase camera behind the vehicle (pilots and drivers only). */
  private cameraMode: 'inside' | 'chase' = 'inside'
  private lastVehicleYaw = 0
  private heliYaw = 0
  private heliThrottle = 0
  private heliRoll = 0
  private heliPitch = 0
  private heliAltitude = 0
  private carSpeed = 0
  /** Launcher lock-on: the helicopter in the sights and for how long. */
  private lock: { target: Vehicle | null; time: number } = { target: null, time: 0 }
  /** An item we asked the server for (don't ask twice while waiting). */
  private pendingTake: string | null = null
  private lastWeaponsKey = ''
  /** Solid things cars bump into (rocks, trees, machine guns — bushes are driven through), and base walls. */
  private solidCircles: Array<{ x: number; z: number; r: number }> = []
  private colliders: THREE.Box3[] = []
  private dead = false
  private sun!: THREE.DirectionalLight
  private deathCamRoll = 0
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private player: Player
  private arsenal: Arsenal
  private viewmodel: Viewmodel
  private items: ItemField
  private projectiles: Projectiles
  private ourBase: BaseObjects
  private enemyBase: BaseObjects
  private bases: { blue: BaseObjects; red: BaseObjects }
  private turrets: TurretField
  private grass: GrassField
  private rocks: RockField
  private forest: ForestField
  private terrain: THREE.Mesh
  private input = {
    forward: false,
    back: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    arrowUp: false,
    arrowDown: false,
    arrowLeft: false,
    arrowRight: false,
  }
  private mouse = { shooting: false }
  private carryTarget: Team | null = null
  private clock = new THREE.Clock()
  private disposed = false
  private targetList: THREE.Object3D[] = []
  /** What blocks the launcher's line of sight (terrain, bases, trees, rocks). */
  private sightBlockers: THREE.Object3D[] = []
  private boundHandlers: Array<[EventTarget, string, EventListener]> = []
  private lastShotCount = 0
  private score = 0

  constructor(private container: HTMLElement, private match: MatchSetup) {
    this.team = match.players.find((p) => p.id === match.you)?.team ?? 'blue'

    // Renderer: ask Chrome for the discrete GPU on laptops/desktops that have one
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    // 1.5x keeps high-DPI monitors sharp without rendering 4x the pixels
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    // Past the fog end everything is sky coloured anyway
    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, FOG_FAR)
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.camera)

    // World
    this.sun = createSkyAndLights(this.scene)
    this.terrain = createTerrain()
    const worldCircles = this.solidCircles
    this.scene.add(this.terrain)
    this.scene.add(createWater())
    // Vehicle parking first: nothing grows on it
    this.fleet = createFleet()
    this.scene.add(this.fleet.group)
    this.scene.add(this.fleet.hitGroup)
    // Rocks next, so trees can keep clear of them; nothing grows inside the bases
    this.rocks = createRocks(worldCircles, (x, z) => inBase(x, z, 5) || this.fleet.clearance(x, z, 3))
    this.forest = createForest(this.renderer, worldCircles, (x, z) => inBase(x, z, PLATEAU_HALF - BASE_HALF + 10) || this.fleet.clearance(x, z, 5))
    this.scene.add(this.forest.group)
    this.scene.add(this.rocks.group)
    const bushCircles: Array<{ x: number; z: number; r: number }> = []
    this.scene.add(createBushes(bushCircles, (x, z) => inBase(x, z, 4) || this.fleet.clearance(x, z, 2)))
    this.scene.add(createClouds())

    // Bases: blue in the south-west corner, red in the north-east; "ours" depends on the team
    this.bases = { blue: createBase('blue', this.colliders), red: createBase('red', this.colliders) }
    this.ourBase = this.bases[this.team]
    this.enemyBase = this.bases[other(this.team)]
    this.scene.add(this.bases.blue.group)
    this.scene.add(this.bases.red.group)

    // Machine-gun emplacements outside both bases (solid: they block players and bullets); anyone can man them
    this.turrets = createTurrets((['blue', 'red'] as const).map((team) => ({
      center: this.bases[team].group.position,
      placements: LAYOUT.machineGuns.map(([x, z], i) => {
        const at = baseToWorld(team, x, z)
        return { id: `${team}-mg-${i}`, x: at.x, z: at.z, facing: baseYaw(team, Math.atan2(x, z)) }
      }),
    })))
    this.scene.add(this.turrets.group)
    worldCircles.push(...this.turrets.circles)

    // Grass everywhere except inside the bases, under the guns and on the parking spots
    this.grass = createGrass((x, z) =>
      inBase(x, z, 3) ||
      this.turrets.turrets.some((t) => Math.hypot(x - t.x, z - t.z) < 4) ||
      this.fleet.clearance(x, z))
    this.scene.add(this.grass.group)

    // Supplies (launchers, missile crates, ammo boxes, dropped weapons) and everything that flies
    this.items = createItems()
    this.scene.add(this.items.group)
    this.projectiles = createProjectiles()
    this.scene.add(this.projectiles.group)
    if (match.world) this.applyWorld(match.world)

    this.player = new Player(this.camera)
    this.respawnPlayer()

    // Colliders from both bases for player/wall collision (the shared array fills in as the base models load)
    this.player.setColliders(this.colliders)
    this.player.setCircles([...worldCircles, ...bushCircles])

    this.arsenal = new Arsenal(this.scene, this.camera, () => {
      // small recoil kick
      this.player.pitch += this.arsenal.current === 'launcher' ? 0.03 : 0.004
    })
    this.viewmodel = new Viewmodel(this.camera)

    // Everything that stops a bullet: terrain, bases, trees, rocks, vehicles, machine guns (player avatars are
    // added per shot). Bushes and grass are left out on purpose: they hide you but don't stop bullets.
    this.targetList = [this.terrain, this.ourBase.group, this.enemyBase.group, this.forest.trunks, this.rocks.group, this.fleet.hitGroup, this.turrets.group]
    this.sightBlockers = [this.terrain, this.ourBase.group, this.enemyBase.group, this.forest.trunks, this.rocks.group]

    // Debug handle for console/preview smoke tests
    ;(window as unknown as { __game?: BattlefieldGame }).__game = this

    for (const player of match.players) this.upsertPlayer(player)
    this.applyOwnVitals(match.players)
    const enemy = TEAM_NAME[other(this.team)]
    setGameState({
      team: this.team,
      message: `You are on the ${TEAM_NAME[this.team]} team. Steal the ${enemy} gem and bring it to your ${TEAM_NAME[this.team]} gem. [F] switch weapon, [G] pick up / drop, [E] vehicles and machine guns.`,
    })
    this.publishRoster()
    this.bindEvents()
  }

  // ---------------------------------------------------------------- players

  upsertPlayer(player: NetPlayer) {
    if (player.id === this.match.you) return
    let remote = this.remotes.get(player.id)
    if (!remote) {
      remote = { info: player, avatar: null, target: null, snapped: false, speed: 0, diedInVehicle: false }
      this.remotes.set(player.id, remote)
    }
    if (remote.avatar && remote.info.team !== player.team) {
      this.scene.remove(remote.avatar.group)
      remote.avatar.dispose()
      remote.avatar = null
    }
    remote.info = { ...player }
    if (!remote.avatar && player.team) {
      remote.avatar = createAvatar(player.displayName, player.team)
      remote.avatar.group.userData.playerId = player.id
      remote.avatar.group.visible = false
      this.scene.add(remote.avatar.group)
    }
    if (player.state) this.applyRemoteState(player.id, player.state)
    if (!player.online) this.removePlayer(player.id)
  }

  /** After a reconnect the server's roster and world are authoritative: anyone missing is offline. */
  syncRoster(players: NetPlayer[], world?: WorldSnapshot) {
    if (world) this.applyWorld(world)
    for (const player of players) this.upsertPlayer(player)
    this.applyOwnVitals(players)
    const known = new Set(players.map((p) => p.id))
    for (const id of this.remotes.keys()) if (!known.has(id)) this.removePlayer(id)
  }

  removePlayer(id: string) {
    const remote = this.remotes.get(id)
    if (!remote) return
    remote.info = { ...remote.info, online: false }
    remote.target = null
    remote.snapped = false
    if (remote.avatar) remote.avatar.group.visible = false
    this.releaseVehiclesOf(id)
    this.releaseGunsOf(id)
  }

  applyRemoteState(id: string, state: NetState) {
    const remote = this.remotes.get(id)
    if (!remote) return
    remote.info.online = true
    remote.info.hp = state.hp
    remote.target = state
  }

  applyHp(id: string, hp: number, by: string) {
    if (id === this.match.you) {
      const took = hp < gameState.health
      setGameState({ health: hp, damageTaken: gameState.damageTaken + (took ? 1 : 0) })
      this.publishRoster()
      return
    }
    const remote = this.remotes.get(id)
    if (remote) remote.info.hp = hp
    if (by === this.match.you && hp < 100) setGameState({ hitsLanded: gameState.hitsLanded + 1 })
    this.publishRoster()
  }

  playerKilled(id: string, by: string) {
    const killer = this.nameOf(by)
    if (id === this.match.you) {
      this.die(killer)
      return
    }
    const remote = this.remotes.get(id)
    if (!remote) return
    remote.info.dead = true
    remote.info.hp = 0
    remote.diedInVehicle = !!remote.target?.vehicle
    remote.avatar?.die()
    this.releaseVehiclesOf(id)
    this.releaseGunsOf(id)
    if (by === this.match.you) setGameState({ message: `You eliminated ${remote.info.displayName}.` })
    this.publishRoster()
  }

  playerRespawned(id: string) {
    if (id === this.match.you) {
      this.dead = false
      this.arsenal.reset()
      this.respawnPlayer()
      setGameState({ dead: false, health: 100, message: 'Back in the fight! Fresh handgun and primary gun.' })
      this.publishRoster()
      return
    }
    const remote = this.remotes.get(id)
    if (!remote) return
    remote.info.dead = false
    remote.info.hp = 100
    remote.snapped = false
    remote.diedInVehicle = false
    remote.avatar?.revive()
    this.publishRoster()
  }

  /** Another player fired: muzzle flash on their gun (or at their seat / machine gun) and the round flying to where it landed. */
  remoteShot(id: string, to: Vec3, weapon: string) {
    const remote = this.remotes.get(id)
    if (!remote?.avatar || !remote.info.online || remote.info.dead || !remote.target) return
    const end = new THREE.Vector3(...to)
    const s = remote.target
    let start: THREE.Vector3
    if (s.gun) {
      const t = this.turrets.turrets.find((g) => g.id === s.gun!.id)
      if (!t) return
      const eye = new THREE.Vector3()
      start = new THREE.Vector3()
      this.turrets.gunnerView(t, eye, start)
    } else if (remote.avatar.group.visible) {
      start = remote.avatar.fire()
    } else if (s.vehicle && this.fleet.byId.has(s.vehicle.id)) {
      const vehicle = this.fleet.byId.get(s.vehicle.id)!
      start = vehicle.object.localToWorld(this.seatEye(vehicle, s.vehicle.seat))
    } else {
      return
    }
    if (weapon === 'machine-gun') this.projectiles.round('bullet_556', start, end, MACHINE_GUN.color)
    else this.projectiles.round(weapon === 'handgun' ? 'bullet_9mm' : 'bullet_556', start, end, weapon === 'handgun' ? WEAPONS.handgun.color : WEAPONS.primary.color)
  }

  /** Another player's anti-aircraft missile, homing on a helicopter (the server decides the hit). */
  remoteMissile(_id: string, target: string, from: Vec3) {
    const vehicle = this.fleet.byId.get(target)
    if (!vehicle) return
    this.projectiles.missile(new THREE.Vector3(from[0], from[1] + 0.2, from[2]), () => (vehicle.destroyed ? null : this.aimPoint(vehicle)))
  }

  vehicleWrecked(id: string, by: string, at: { p: Vec3; r: Vec3 } | null) {
    const vehicle = this.fleet.byId.get(id)
    if (!vehicle) return
    if (at && !vehicle.occupants.includes(this.match.you)) {
      vehicle.object.position.set(...at.p)
      vehicle.object.rotation.set(at.r[0], at.r[1], at.r[2])
    }
    this.projectiles.explosion(this.aimPoint(vehicle), 2)
    vehicle.destroyed = true
    if (this.vehicle === vehicle) {
      this.transition = null
      this.leaveVehicle()
    }
    vehicle.occupants.fill(null)
    this.projectiles.burn(() => (vehicle.destroyed ? vehicle.object.position.clone().add(new THREE.Vector3(0, 1.5, 0)) : null), 30)
    if (this.lock.target === vehicle) this.lock = { target: null, time: 0 }
    const byName = by === this.match.you ? 'You' : this.nameOf(by)
    setGameState({ message: `${byName} shot down a helicopter!` })
  }

  vehicleRepaired(id: string) {
    const vehicle = this.fleet.byId.get(id)
    if (!vehicle) return
    vehicle.occupants.fill(null)
    this.fleet.sendHome(vehicle)
  }

  /** Vehicles, supplies and wrecks from the server (joining or reconnecting). */
  private applyWorld(world: WorldSnapshot) {
    for (const [id, pose] of Object.entries(world.vehicles)) {
      const vehicle = this.fleet.byId.get(id)
      if (!vehicle || driverOf(vehicle) || vehicle === this.vehicle) continue
      vehicle.object.position.set(...pose.p)
      vehicle.object.rotation.set(pose.r[0], pose.r[1], pose.r[2])
    }
    for (const id of world.wrecks) {
      const vehicle = this.fleet.byId.get(id)
      if (vehicle) vehicle.destroyed = true
    }
    this.items?.reset(world.items)
  }

  itemChanged(item: NetItem) {
    this.items.upsert(item)
  }

  itemGone(id: string) {
    this.items.remove(id)
  }

  /** The server handed us (part of) an item we asked for. */
  took(took: Took) {
    this.pendingTake = null
    if (!took.kind) return
    const name = ITEM_LABEL[took.kind]
    if (took.weapon && (took.kind === 'handgun' || took.kind === 'primary' || took.kind === 'launcher')) {
      this.arsenal.give(took.kind, took.mag)
      this.arsenal.addReserve(took.kind, took.count)
      setGameState({ message: took.kind === 'launcher' ? 'AA launcher picked up. Load it with missiles from the crates, lock on to an enemy aircraft for 2 s, fire!' : `Picked up a ${name}.` })
      return
    }
    if (took.count <= 0) {
      setGameState({ message: `Nothing left to take (${name}).` })
      return
    }
    const kind = AMMO_OF[took.kind]
    this.arsenal.addReserve(kind, took.count)
    // A launcher waiting for its first missile loads it straight away
    if (this.arsenal.current === kind && this.arsenal.mag === 0) this.arsenal.reload()
    setGameState({ message: kind === 'launcher' ? `Took ${took.count} AA missile${took.count > 1 ? 's' : ''}.` : `Took ${took.count} rounds of ${name}.` })
  }

  /** Back at our spawn, looking out of the gate. */
  private respawnPlayer() {
    this.player.spawn(this.spawnPoint())
    // The camera looks along -Z; the gate is the base's +Z side
    this.player.yaw = BASE_ROTATION[this.team] + Math.PI
  }

  /** Our respawn spot just inside our gate. */
  private spawnPoint() {
    const mates = this.match.players.filter((p) => p.team === this.team)
    const slot = Math.max(0, mates.findIndex((p) => p.id === this.match.you)) % LAYOUT.spawn.length
    const at = baseToWorld(this.team, ...LAYOUT.spawn[slot])
    return new THREE.Vector3(at.x, 0, at.z)
  }

  private applyOwnVitals(players: NetPlayer[]) {
    const me = players.find((p) => p.id === this.match.you)
    if (!me) return
    setGameState({ health: me.hp ?? 100 })
    if (me.dead && !this.dead) this.die(null)
  }

  private nameOf(id: string) {
    return this.remotes.get(id)?.info.displayName ?? (id === this.match.you ? 'yourself' : 'an enemy')
  }

  private teamOf(id: string): Team | null {
    return id === this.match.you ? this.team : this.remotes.get(id)?.info.team ?? null
  }

  private die(killer: string | null) {
    this.dead = true
    this.deathCamRoll = 0
    this.transition = null
    this.leaveTurret()
    this.leaveVehicle()
    // What we carried is on the ground where we fell (the server dropped it); we respawn with fresh guns
    this.arsenal.slots = {}
    this.arsenal.reserve = { handgun: 0, primary: 0, launcher: 0 }
    this.arsenal.current = null
    // Put the body on the ground (it may have been in a vehicle) so others see it fall there
    this.player.position.y = heightAt(this.player.position.x, this.player.position.z) + EYE_HEIGHT
    this.carryTarget = null
    this.captureSent = false
    this.mouse.shooting = false
    for (const key of Object.keys(this.input) as Array<keyof typeof this.input>) this.input[key] = false
    setGameState({
      dead: true,
      health: 0,
      carryingGem: false,
      message: `${killer ? `You were eliminated by ${killer}` : 'You were eliminated'}. Respawning in 5 seconds…`,
    })
    this.publishRoster()
  }

  /** First-person death: the view sinks to the ground and tips over. */
  private updateDeathCamera(dt: number) {
    const k = 1 - Math.exp(-dt * 5)
    const ground = heightAt(this.camera.position.x, this.camera.position.z) + 0.35
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, ground, k)
    this.deathCamRoll = THREE.MathUtils.lerp(this.deathCamRoll, 0.9, k)
    this.camera.rotation.set(THREE.MathUtils.lerp(this.camera.rotation.x, 0.25, k), this.player.yaw, this.deathCamRoll)
  }

  /** The sun's shadow box follows the camera (snapped to whole shadow texels so edges don't shimmer). */
  private updateShadowArea() {
    const texel = (SHADOW_RANGE * 2) / this.sun.shadow.mapSize.x
    const x = Math.round(this.camera.position.x / texel) * texel
    const z = Math.round(this.camera.position.z / texel) * texel
    this.sun.target.position.set(x, 0, z)
    this.sun.position.set(x + SUN_OFFSET.x, SUN_OFFSET.y, z + SUN_OFFSET.z)
    this.sun.target.updateMatrixWorld()
  }

  /** A remote player got out, left or died: their seat is free, the vehicle stays where it is. */
  private releaseVehiclesOf(playerId: string) {
    for (const vehicle of this.fleet.vehicles) {
      const seat = vehicle.occupants.indexOf(playerId)
      if (seat < 0 || vehicle === this.vehicle && seat === this.seat) continue
      vehicle.occupants[seat] = null
      vehicle.doorHold[seat] = performance.now() + DOOR_HOLD_MS * 0.6
      if (seat === 0) vehicle.targetSpin = 0
    }
  }

  private releaseGunsOf(playerId: string) {
    for (const t of this.turrets.turrets) {
      if (t.occupant !== playerId) continue
      t.occupant = null
      t.idle = true
    }
  }

  /** Map a raycast hit back to an enemy player and report it; the server applies the damage. */
  private reportHit(object: THREE.Object3D, weapon: string) {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const playerId = node.userData.playerId as string | undefined
      if (playerId) {
        const remote = this.remotes.get(playerId)
        if (remote && remote.info.team !== this.team && !remote.info.dead) this.match.net.sendHit(playerId, weapon)
        return
      }
      const vehicleId = node.userData.vehicleId as string | undefined
      if (vehicleId) {
        // Shooting a vehicle hurts the enemies inside it (the pilot / driver first)
        const vehicle = this.fleet.byId.get(vehicleId)
        const victim = vehicle?.occupants.find((id) => id && id !== this.match.you && this.teamOf(id) !== this.team && !this.remotes.get(id)?.info.dead)
        if (victim) this.match.net.sendHit(victim, weapon)
        return
      }
    }
  }

  /** Other players on foot and vehicles on the ground are solid: you can't walk through them. */
  private movingObstacles() {
    const obstacles: Array<{ x: number; z: number; r: number }> = []
    const feetY = this.player.position.y - EYE_HEIGHT
    for (const remote of this.remotes.values()) {
      const avatar = remote.avatar?.group
      if (!avatar?.visible || remote.info.dead) continue
      // Only when roughly level with us, so someone on a ledge above or below doesn't block
      if (Math.abs(avatar.position.y - feetY) > PLAYER_BLOCK_HEIGHT) continue
      obstacles.push({ x: avatar.position.x, z: avatar.position.z, r: PLAYER_BLOCK_RADIUS })
    }
    obstacles.push(...this.fleet.circles(this.vehicle))
    return obstacles
  }

  private shootTargets() {
    const avatars: THREE.Object3D[] = []
    for (const remote of this.remotes.values()) if (remote.avatar?.group.visible && !remote.info.dead) avatars.push(remote.avatar.group)
    // Our own vehicle's hitbox is on another layer while we're in it, so our shots leave it
    return [...this.targetList, ...avatars]
  }

  endMatch(winner: Team) {
    this.carryTarget = null
    this.mouse.shooting = false
    for (const key of Object.keys(this.input) as Array<keyof typeof this.input>) this.input[key] = false
    const won = winner === this.team
    if (won) this.score += 1
    setGameState({
      finished: true,
      winner,
      carryingGem: false,
      score: this.score,
      message: won ? `VICTORY! The ${TEAM_NAME[winner]} team stole the enemy gem.` : `DEFEAT. The ${TEAM_NAME[winner]} team stole your gem.`,
    })
    document.exitPointerLock?.()
  }

  private sendNetState() {
    const p = this.player.position
    const vehicle = this.vehicle
    const pose = vehicle?.object
    const t = this.turret
    this.match.net.sendState({
      p: [p.x, p.y, p.z],
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      vehicle: vehicle && pose
        ? { id: vehicle.id, seat: this.seat, p: [pose.position.x, pose.position.y, pose.position.z], r: [pose.rotation.x, pose.rotation.y, pose.rotation.z], spin: vehicle.kind === 'heli' ? vehicle.spin : this.carSpeed }
        : null,
      gun: t ? { id: t.id, yaw: t.yaw, pitch: t.pitch } : null,
      w: this.arsenal.current ? WEAPON_KINDS.indexOf(this.arsenal.current) : -1,
      inv: this.arsenal.snapshot(),
      flag: this.carryTarget !== null,
      hp: gameState.health,
    })
  }

  private updateRemotes(dt: number) {
    const k = 1 - Math.exp(-dt * 12)
    const gunners = new Set<string>()
    for (const remote of this.remotes.values()) {
      const s = remote.target
      if (!remote.info.online || !s || !remote.avatar) continue
      const avatar = remote.avatar.group
      const distance = avatar.position.distanceTo(this.camera.position)
      if (remote.info.dead) {
        // The body stays where it fell while the death animation plays
        avatar.visible = !remote.diedInVehicle && remote.avatar.deathVisible()
        remote.avatar.carriedGem.visible = false
        if (avatar.visible) remote.avatar.update(dt, 0, 0, distance)
        this.releaseVehiclesOf(remote.info.id)
        continue
      }
      const feet = new THREE.Vector3(s.p[0], s.p[1] - EYE_HEIGHT, s.p[2])
      let groundSpeed = 0
      if (!remote.snapped || avatar.position.distanceToSquared(feet) > SNAP_DISTANCE ** 2) {
        avatar.position.copy(feet)
        avatar.rotation.y = s.yaw
        remote.snapped = true
      } else {
        const beforeX = avatar.position.x
        const beforeZ = avatar.position.z
        avatar.position.lerp(feet, k)
        avatar.rotation.y = lerpAngle(avatar.rotation.y, s.yaw, k)
        groundSpeed = Math.hypot(avatar.position.x - beforeX, avatar.position.z - beforeZ) / Math.max(dt, 1e-3)
      }
      remote.speed = THREE.MathUtils.lerp(remote.speed, groundSpeed, 1 - Math.exp(-dt * 6))
      avatar.visible = !s.vehicle
      remote.avatar.carriedGem.visible = s.flag
      remote.avatar.setWeapon(s.gun ? null : WEAPON_KINDS[s.w ?? -1] ?? null)
      if (avatar.visible) remote.avatar.update(dt, remote.speed, s.pitch, distance)
      this.syncRemoteVehicle(remote.info.id, s, k)
      // On a machine gun: the gun follows their aim on our screen too
      if (s.gun) {
        const t = this.turrets.turrets.find((g) => g.id === s.gun!.id)
        if (t && t !== this.turret) {
          gunners.add(t.id)
          t.occupant = remote.info.id
          t.idle = false
          t.yaw = lerpAngle(t.yaw, s.gun.yaw, k)
          t.pitch = THREE.MathUtils.lerp(t.pitch, s.gun.pitch, k)
        }
      }
    }
    for (const t of this.turrets.turrets) {
      if (t.occupant && t !== this.turret && !gunners.has(t.id)) {
        t.occupant = null
        t.idle = true
      }
    }
  }

  /** A remote player in a vehicle: their seat is taken, and from the pilot / driver seat they move it on our screen. */
  private syncRemoteVehicle(playerId: string, s: NetState, k: number) {
    const claimed = s.vehicle ? this.fleet.byId.get(s.vehicle.id) : undefined
    const seat = s.vehicle?.seat ?? 0
    for (const vehicle of this.fleet.vehicles) {
      const was = vehicle.occupants.indexOf(playerId)
      if (was >= 0 && (vehicle !== claimed || was !== seat)) {
        vehicle.occupants[was] = null
        vehicle.doorHold[was] = performance.now() + DOOR_HOLD_MS * 0.6
        if (was === 0) vehicle.targetSpin = 0
      }
    }
    if (!claimed || !s.vehicle || claimed.destroyed) return
    // Two players in one seat: the server keeps whoever got in first and ejects the other
    if (claimed === this.vehicle && seat === this.seat) return
    if (claimed.occupants[seat] !== playerId) {
      claimed.occupants[seat] = playerId
      claimed.doorHold[seat] = performance.now() + DOOR_HOLD_MS
    }
    if (seat !== 0 || claimed === this.vehicle) return
    const pose = claimed.object
    const target = new THREE.Vector3(...s.vehicle.p)
    claimed.targetSpin = s.vehicle.spin
    if (pose.position.distanceToSquared(target) > SNAP_DISTANCE ** 2) {
      pose.position.copy(target)
      pose.rotation.set(s.vehicle.r[0], s.vehicle.r[1], s.vehicle.r[2])
      return
    }
    pose.position.lerp(target, k)
    pose.rotation.set(
      THREE.MathUtils.lerp(pose.rotation.x, s.vehicle.r[0], k),
      lerpAngle(pose.rotation.y, s.vehicle.r[1], k),
      THREE.MathUtils.lerp(pose.rotation.z, s.vehicle.r[2], k),
    )
  }

  /** A gem is "taken" while anyone — us or a remote player — carries it (`flag` on the wire = carrying the enemy gem). */
  private gemCarried(gemTeam: Team) {
    if (this.carryTarget === gemTeam) return true
    for (const remote of this.remotes.values()) {
      if (remote.info.online && !remote.info.dead && remote.target?.flag && remote.info.team === other(gemTeam)) return true
    }
    return false
  }

  private updateGemVisibility() {
    for (const team of ['blue', 'red'] as const) this.bases[team].gem.setTaken(this.gemCarried(team))
  }

  private publishRoster() {
    const me = this.match.players.find((p) => p.id === this.match.you)
    const status = (vehicle: { id: string } | null | undefined) => (vehicle ? (vehicle.id.includes('-heli-') ? 'flying' : 'driving') : 'on foot') as RosterEntry['status']
    const entries: RosterEntry[] = [{
      id: this.match.you,
      name: me?.displayName ?? 'You',
      team: this.team,
      status: this.dead ? 'dead' : this.carryTarget ? 'carrying gem' : status(this.vehicle),
      hp: gameState.health,
      you: true,
    }]
    for (const remote of this.remotes.values()) {
      const s = remote.target
      entries.push({
        id: remote.info.id,
        name: remote.info.displayName,
        team: remote.info.team,
        status: !remote.info.online ? 'offline' : remote.info.dead ? 'dead' : s?.flag ? 'carrying gem' : status(s?.vehicle),
        hp: remote.info.hp ?? 100,
        you: false,
      })
    }
    const json = JSON.stringify(entries)
    if (json === this.lastRosterJson) return
    this.lastRosterJson = json
    setGameState({ players: entries })
  }

  // ---------------------------------------------------------------- input

  private bindEvents() {
    const add = (t: EventTarget, k: string, fn: EventListener) => {
      t.addEventListener(k, fn)
      this.boundHandlers.push([t, k, fn])
    }

    add(this.renderer.domElement, 'click', () => {
      this.renderer.domElement.requestPointerLock()
    })

    add(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.renderer.domElement
      if (!locked) {
        for (const key of Object.keys(this.input) as Array<keyof typeof this.input>) this.input[key] = false
        this.mouse.shooting = false
      }
    })

    add(document, 'mousemove', ((e: MouseEvent) => {
      if (document.pointerLockElement !== this.renderer.domElement) return
      // Subtle freelook while piloting
      const scale = this.vehicle?.kind === 'heli' && this.seat === 0 ? 0.5 : 1
      this.player.look(e.movementX * scale, e.movementY * scale)
    }) as EventListener)

    add(document, 'mousedown', ((e: MouseEvent) => {
      if (e.button === 0) this.mouse.shooting = true
    }) as EventListener)
    add(document, 'mouseup', ((e: MouseEvent) => {
      if (e.button === 0) this.mouse.shooting = false
    }) as EventListener)

    add(document, 'keydown', ((e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': this.input.forward = true; break
        case 'KeyS': this.input.back = true; break
        case 'KeyA': this.input.left = true; break
        case 'KeyD': this.input.right = true; break
        case 'ShiftLeft': this.input.sprint = true; break
        case 'Space':
          this.input.jump = true
          e.preventDefault()
          break
        case 'ArrowUp': this.input.arrowUp = true; e.preventDefault(); break
        case 'ArrowDown': this.input.arrowDown = true; e.preventDefault(); break
        case 'ArrowLeft': this.input.arrowLeft = true; e.preventDefault(); break
        case 'ArrowRight': this.input.arrowRight = true; e.preventDefault(); break
        case 'KeyR':
          if (!e.repeat) this.arsenal.reload()
          break
        case 'KeyF':
          if (!e.repeat && !this.dead && !this.turret) this.arsenal.switchNext()
          break
        case 'KeyG':
          if (!e.repeat) this.pickUpOrDrop()
          break
        case 'KeyE':
          if (!e.repeat) this.interact()
          break
        case 'KeyV':
          if (!e.repeat) this.cycleVehicleCamera()
          break
      }
    }) as EventListener)

    add(document, 'keyup', ((e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': this.input.forward = false; break
        case 'KeyS': this.input.back = false; break
        case 'KeyA': this.input.left = false; break
        case 'KeyD': this.input.right = false; break
        case 'ShiftLeft': this.input.sprint = false; break
        case 'Space': this.input.jump = false; break
        case 'ArrowUp': this.input.arrowUp = false; break
        case 'ArrowDown': this.input.arrowDown = false; break
        case 'ArrowLeft': this.input.arrowLeft = false; break
        case 'ArrowRight': this.input.arrowRight = false; break
      }
    }) as EventListener)

    add(window, 'resize', (() => {
      const w = this.container.clientWidth
      const h = this.container.clientHeight
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(w, h)
    }) as EventListener)
  }

  private feet() {
    return this.player.position.clone().setY(this.player.position.y - EYE_HEIGHT)
  }

  /** On foot and free to use things with [E] / [G]. */
  private get onFoot() {
    return !this.dead && !this.vehicle && !this.turret && !this.transition && !gameState.finished
  }

  // ---------------------------------------------------------------- supplies: [G]

  /** [G]: take what is in reach (a weapon, missiles, ammo), or put down the weapon in hand. */
  private pickUpOrDrop() {
    if (!this.onFoot || this.pendingTake) return
    const item = this.items.nearest(this.feet())
    if (item) {
      const weaponItem = item.kind === 'handgun' || item.kind === 'primary' || item.kind === 'launcher'
      const ammoKind = AMMO_OF[item.kind]
      const want = this.arsenal.space(ammoKind)
      if (weaponItem && !this.arsenal.has(item.kind as WeaponKind)) {
        this.pendingTake = item.id
        this.match.net.sendTake(item.id, 'weapon', want)
        return
      }
      if (want <= 0) {
        setGameState({ message: `You can't carry any more ${ammoKind === 'launcher' ? 'missiles' : `${WEAPONS[ammoKind].name.toLowerCase()} rounds`}.` })
        return
      }
      if (item.count + (weaponItem ? item.mag : 0) <= 0) {
        setGameState({ message: `The ${ITEM_LABEL[item.kind]} is empty.` })
        return
      }
      this.pendingTake = item.id
      this.match.net.sendTake(item.id, 'ammo', want)
      window.setTimeout(() => { if (this.pendingTake === item.id) this.pendingTake = null }, 2000)
      return
    }
    const kind = this.arsenal.current
    if (!kind) return
    const dropped = this.arsenal.remove(kind)
    if (!dropped) return
    this.match.net.sendDrop(kind, dropped.mag, dropped.spare)
    setGameState({ message: `Dropped your ${WEAPONS[kind].name.toLowerCase()}.` })
  }

  private pickupPrompt(): string {
    if (!this.onFoot) return ''
    const item = this.items.nearest(this.feet())
    if (!item) return ''
    const name = ITEM_LABEL[item.kind]
    switch (item.kind) {
      case 'handgun':
      case 'primary':
      case 'launcher':
        return this.arsenal.has(item.kind) ? `Take ${item.kind === 'launcher' ? 'its missiles' : 'its rounds'} (${item.count + item.mag})` : `Pick up ${name}`
      case 'missiles':
        return item.count > 0 ? `Take AA missiles (${item.count} left)` : 'Missile crate (empty)'
      default:
        return item.count > 0 ? `Take ${name} (${item.count} rounds)` : `${name} box (empty)`
    }
  }

  // ---------------------------------------------------------------- vehicles and machine guns: [E]

  private interact() {
    if (this.dead || gameState.finished || this.transition) return
    if (this.turret) { this.leaveTurret(); return }
    if (this.vehicle) { this.exitVehicle(); return }
    const choice = this.nearestInteraction()
    if (!choice) return
    if (choice.turret) { this.mountTurret(choice.turret); return }
    const vehicle = choice.vehicle!
    if (vehicle.destroyed) {
      setGameState({ message: `That ${label(vehicle)} is a burnt-out wreck.` })
      return
    }
    const seat = vehicle.occupants.findIndex((o) => o === null)
    if (seat < 0) {
      setGameState({ message: vehicle.kind === 'heli' ? 'That helicopter is full.' : `That battle car is being driven by ${this.nameOf(driverOf(vehicle)!)}.` })
      return
    }
    this.enterVehicle(vehicle, seat)
  }

  /** The nearest vehicle (any team's) or machine gun we could use. */
  private nearestInteraction(): { vehicle?: Vehicle; turret?: Turret; distance: number } | null {
    let best: { vehicle?: Vehicle; turret?: Turret; distance: number } | null = null
    const p = this.player.position
    for (const vehicle of this.fleet.vehicles) {
      const v = vehicle.object.position
      if (Math.abs(p.y - EYE_HEIGHT - v.y) > 4) continue
      const distance = Math.hypot(p.x - v.x, p.z - v.z)
      if (distance < BOARD_RANGE[vehicle.kind] && (!best || distance < best.distance)) best = { vehicle, distance }
    }
    for (const turret of this.turrets.turrets) {
      const distance = Math.hypot(p.x - turret.x, p.z - turret.z)
      if (distance < GUN_RANGE && (!best || distance < best.distance)) best = { turret, distance }
    }
    return best
  }

  private interactPrompt(): string {
    if (!this.onFoot) return ''
    const choice = this.nearestInteraction()
    if (!choice) return ''
    if (choice.turret) return choice.turret.occupant ? `Machine gun (manned by ${this.nameOf(choice.turret.occupant)})` : 'Man the machine gun'
    const vehicle = choice.vehicle!
    if (vehicle.destroyed) return `Wrecked ${label(vehicle)}`
    const seat = vehicle.occupants.findIndex((o) => o === null)
    if (seat < 0) return vehicle.kind === 'heli' ? 'Helicopter (full)' : 'Battle car (taken)'
    if (vehicle.kind === 'car') return 'Drive battle car'
    return seat === 0 ? 'Fly helicopter (pilot seat)' : 'Board helicopter (passenger — you can shoot)'
  }

  /** Eye position of a seat, in the vehicle's local space. */
  private seatEye(vehicle: Vehicle, seat: number) {
    return vehicle.kind === 'heli' ? this.fleet.heliSeats[seat].eye.clone() : CAR_GUNNER_SEAT.clone()
  }

  private enterVehicle(vehicle: Vehicle, seat: number) {
    this.vehicle = vehicle
    this.seat = seat
    vehicle.occupants[seat] = this.match.you
    // Our own shots pass through the vehicle we're in
    vehicle.hitbox.traverse((node) => node.layers.set(1))
    const yaw = vehicle.object.rotation.y
    this.lastVehicleYaw = yaw
    this.player.velocity.set(0, 0, 0)
    this.mouse.shooting = false
    // Look where the nose points (the camera looks along -Z, the vehicles' noses point along +Z)
    this.player.yaw = yaw + Math.PI
    this.player.pitch = vehicle.kind === 'heli' ? 0 : -0.2
    if (vehicle.kind === 'heli') {
      if (seat === 0) {
        this.heliYaw = yaw
        this.heliAltitude = vehicle.object.position.y
        this.heliThrottle = 0
        this.heliRoll = vehicle.object.rotation.z
        this.heliPitch = vehicle.object.rotation.x
        vehicle.targetSpin = vehicle.spin
      }
      this.cameraMode = 'inside'
      // Open the door, climb in past it, sit down
      vehicle.doorHold[seat] = performance.now() + DOOR_HOLD_MS
      this.transition = { kind: 'board', vehicle, seat, t: 0, duration: BOARD_TIME, from: this.camera.position.clone(), to: new THREE.Vector3() }
      setGameState({
        vehicle: 'heli',
        seat,
        message: seat === 0
          ? 'You are the pilot (pilots can\'t shoot). SPACE spins up the rotor, W/S fly, A/D turn, ↑/↓ altitude, ←/→ roll, V camera, E to get out.'
          : 'Passenger seat: the door stays open — aim with the mouse and shoot. E to get out.',
      })
    } else {
      this.carSpeed = 0
      vehicle.targetSpin = 0
      this.cameraMode = 'chase'
      setGameState({ vehicle: 'car', seat: 0, message: 'W/S drive, A/D steer, SPACE brake. V for the roof gun, E to get out.' })
    }
    this.publishRoster()
  }

  /** Get out: through the door to the ground beside a landed helicopter (jumping if it is flying), or step out of a car. */
  private exitVehicle() {
    const vehicle = this.vehicle
    if (!vehicle) return
    if (vehicle.kind === 'heli') {
      const outside = this.fleet.heliSeats[this.seat].outside
      const spot = vehicle.object.localToWorld(new THREE.Vector3(outside.x * 1.2, 0, outside.z))
      const flying = vehicle.object.position.y - this.fleet.restHeight(vehicle, vehicle.object.position.x, vehicle.object.position.z) > 1.5
      vehicle.doorHold[this.seat] = performance.now() + DOOR_HOLD_MS
      if (flying) {
        // Jump: out of the door and down
        this.leaveVehicle()
        this.player.position.set(spot.x, vehicle.object.position.y + EYE_HEIGHT, spot.z)
        this.player.velocity.set(0, 0, 0)
        return
      }
      this.transition = {
        kind: 'exit', vehicle, seat: this.seat, t: 0, duration: EXIT_TIME,
        from: this.camera.position.clone(),
        to: new THREE.Vector3(spot.x, heightAt(spot.x, spot.z) + EYE_HEIGHT, spot.z),
      }
      return
    }
    this.leaveVehicle()
    const side = 3.6
    const circles = [...this.solidCircles, ...this.fleet.circles(null)]
    const clear = (spot: THREE.Vector3) => circles.every((c) => Math.hypot(c.x - spot.x, c.z - spot.z) > c.r + 0.7)
    const candidates = [new THREE.Vector3(side, 0, 0), new THREE.Vector3(-side, 0, 0), new THREE.Vector3(0, 0, -side * 2), new THREE.Vector3(0, 0, side * 2)]
      .map((local) => vehicle.object.localToWorld(local))
    const spot = candidates.find(clear) ?? candidates[0]
    spot.x = THREE.MathUtils.clamp(spot.x, -WORLD_LIMIT, WORLD_LIMIT)
    spot.z = THREE.MathUtils.clamp(spot.z, -WORLD_LIMIT, WORLD_LIMIT)
    this.player.position.set(spot.x, Math.max(vehicle.object.position.y, heightAt(spot.x, spot.z)) + EYE_HEIGHT, spot.z)
    this.player.velocity.set(0, 0, 0)
    this.player.pitch = 0
  }

  /** We are no longer in our vehicle (got out, died, or someone else had the seat first). */
  private leaveVehicle() {
    const vehicle = this.vehicle
    if (!vehicle) return
    this.vehicle = null
    if (vehicle.occupants[this.seat] === this.match.you) vehicle.occupants[this.seat] = null
    if (this.seat === 0) {
      vehicle.targetSpin = 0
      if (vehicle.kind === 'car') vehicle.spin = this.carSpeed
    }
    this.carSpeed = 0
    this.seat = 0
    vehicle.hitbox.traverse((node) => node.layers.set(0))
    this.camera.rotation.order = 'YXZ'
    setGameState({ vehicle: null, seat: 0, rotorRpm: 0, speedKmh: 0 })
    this.publishRoster()
  }

  /** The server says another player got into this seat first (or it was shot down). */
  ejectFrom(vehicleId: string) {
    if (this.vehicle?.id !== vehicleId) return
    this.transition = null
    const vehicle = this.vehicle
    this.leaveVehicle()
    const spot = vehicle.object.localToWorld(new THREE.Vector3(3.5, 0, 0))
    this.player.position.set(spot.x, Math.max(vehicle.object.position.y, heightAt(spot.x, spot.z)) + EYE_HEIGHT, spot.z)
    setGameState({ message: 'Someone else got into that seat first.' })
  }

  private cycleVehicleCamera() {
    if (!this.vehicle || this.seat !== 0 || this.transition) return
    this.cameraMode = this.cameraMode === 'inside' ? 'chase' : 'inside'
    const inside = this.vehicle.kind === 'heli' ? 'COCKPIT VIEW' : 'ROOF GUN'
    setGameState({ message: `${this.cameraMode === 'inside' ? inside : 'CHASE VIEW'} — press V to change camera.` })
  }

  /** Climbing in or out: move the view from start, past the seat's door, to the end. */
  private updateTransition(dt: number) {
    const tr = this.transition
    if (!tr) return
    tr.t += dt
    const vehicle = tr.vehicle
    const door = vehicle.object.localToWorld(this.fleet.heliSeats[tr.seat].outside.clone())
    const seat = vehicle.object.localToWorld(this.seatEye(vehicle, tr.seat))
    const from = tr.kind === 'board' ? tr.from : seat
    const to = tr.kind === 'board' ? seat : tr.to
    // Wait for the door, then a curve through the doorway
    const u = THREE.MathUtils.smoothstep(tr.t / tr.duration, 0.25, 0.9)
    const a = from.clone().lerp(door, u), b = door.clone().lerp(to, u)
    this.camera.position.copy(a.lerp(b, u))
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.set(this.player.pitch, this.player.yaw, 0)
    this.player.position.copy(this.camera.position)
    if (tr.t < tr.duration) return
    this.transition = null
    if (tr.kind === 'exit') {
      this.leaveVehicle()
      this.player.position.copy(tr.to)
      this.player.velocity.set(0, 0, 0)
      this.player.pitch = 0
    }
  }

  private updateVehicle(dt: number) {
    const vehicle = this.vehicle
    if (!vehicle || this.transition) return
    if (this.seat === 0) {
      if (vehicle.kind === 'heli') this.updateHelicopter(vehicle, dt)
      else this.updateCar(vehicle, dt)
    }
    // The camera turns with the vehicle; the mouse looks around on top of that
    const yaw = vehicle.object.rotation.y
    this.player.yaw += wrap(yaw - this.lastVehicleYaw)
    this.lastVehicleYaw = yaw
    // We ride along: our position is the seat (what others use for range checks, where we get out)
    const seat = vehicle.object.localToWorld(this.seatEye(vehicle, this.seat))
    this.player.position.copy(seat)
    this.camera.rotation.order = 'YXZ'
    if (this.cameraMode === 'inside' || this.seat !== 0) {
      this.camera.position.copy(seat)
      this.camera.rotation.set(this.player.pitch, this.player.yaw, 0)
    } else if (vehicle.kind === 'heli') {
      const back = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(18)
      const p = vehicle.object.position
      this.camera.position.lerp(new THREE.Vector3(p.x + back.x, p.y + 8, p.z + back.z), Math.min(1, dt * 4))
      this.camera.lookAt(p.x, p.y + 3, p.z)
    } else {
      // Chase camera orbits the car with the mouse
      const pitch = THREE.MathUtils.clamp(this.player.pitch, -0.9, 0.3)
      this.player.pitch = pitch
      const target = vehicle.object.position.clone().add(new THREE.Vector3(0, 2.6, 0))
      const forward = new THREE.Vector3(-Math.sin(this.player.yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(this.player.yaw) * Math.cos(pitch))
      const eye = target.addScaledVector(forward, -11)
      eye.y = Math.max(eye.y, heightAt(eye.x, eye.z) + 0.8)
      this.camera.position.copy(eye)
      this.camera.rotation.set(pitch, this.player.yaw, 0)
    }
  }

  /**
   * Helicopter flight: SPACE spools the rotor up (Shift down); once it is fast enough W/S fly, A/D turn,
   * arrows climb/descend and roll. A slowing rotor lets it sink back to the ground.
   */
  private updateHelicopter(heli: Vehicle, dt: number) {
    const turnInput = (this.input.left ? 1 : 0) - (this.input.right ? 1 : 0)
    const fwdInput = (this.input.forward ? 1 : 0) - (this.input.back ? 1 : 0)
    if (this.input.jump) heli.targetSpin += 25 * dt
    if (this.input.sprint) heli.targetSpin -= 35 * dt
    heli.targetSpin = THREE.MathUtils.clamp(heli.targetSpin, 0, MAX_ROTOR_RPM)
    const liftReady = THREE.MathUtils.clamp((heli.spin - 40) / 30, 0, 1)

    this.heliYaw += turnInput * dt * 1.1 * liftReady
    const yaw = this.heliYaw
    const dirX = Math.sin(yaw)
    const dirZ = Math.cos(yaw)
    this.heliThrottle = THREE.MathUtils.lerp(this.heliThrottle, fwdInput * liftReady, Math.min(1, dt * 1.2))
    const speed = this.heliThrottle * 60
    const p = heli.object.position
    const x = THREE.MathUtils.clamp(p.x + dirX * speed * dt, -WORLD_LIMIT, WORLD_LIMIT)
    const z = THREE.MathUtils.clamp(p.z + dirZ * speed * dt, -WORLD_LIMIT, WORLD_LIMIT)

    const ground = this.fleet.restHeight(heli, x, z)
    const climbRate = this.input.arrowUp ? 22 : this.input.arrowDown ? -18 : 0
    // Flying forward lifts off a little on its own; without enough rotor it sinks
    const hover = fwdInput !== 0 || Math.abs(this.heliThrottle) > 0.05 ? 2.5 * liftReady : 0
    this.heliAltitude += climbRate * dt * liftReady - (1 - liftReady) * 10 * dt
    this.heliAltitude = THREE.MathUtils.clamp(this.heliAltitude, ground + hover, 220)

    let targetRoll = -turnInput * 0.18 * Math.abs(this.heliThrottle)
    if (this.input.arrowLeft) targetRoll = 0.3
    else if (this.input.arrowRight) targetRoll = -0.3
    // Nose down when flying forward (+pitch lowers the +Z nose)
    const airborne = this.heliAltitude - ground > 0.3
    this.heliRoll = THREE.MathUtils.lerp(this.heliRoll, airborne ? targetRoll : 0, Math.min(1, dt * 5))
    this.heliPitch = THREE.MathUtils.lerp(this.heliPitch, airborne ? this.heliThrottle * 0.22 : 0, Math.min(1, dt * 2.5))

    p.set(x, this.heliAltitude, z)
    heli.object.rotation.set(this.heliPitch, yaw, this.heliRoll)
    setGameState({ rotorRpm: Math.round(heli.spin * 10) })
  }

  /** Arcade battle car: W/S throttle and reverse, A/D steer, SPACE brakes; it follows the ground and bumps off obstacles. */
  private updateCar(car: Vehicle, dt: number) {
    const throttle = (this.input.forward ? 1 : 0) - (this.input.back ? 1 : 0)
    const steerInput = (this.input.left ? 1 : 0) - (this.input.right ? 1 : 0)
    const toward = (value: number, target: number, step: number) => (value > target ? Math.max(target, value - step) : Math.min(target, value + step))
    let speed = this.carSpeed
    if (this.input.jump) speed = toward(speed, 0, CAR_BRAKE * dt)
    else if (throttle > 0) speed = speed < -0.2 ? toward(speed, 0, CAR_BRAKE * dt) : speed + CAR_ACCEL * (1 - 0.5 * Math.max(0, speed) / CAR_MAX_SPEED) * dt
    else if (throttle < 0) speed = speed > 0.2 ? toward(speed, 0, CAR_BRAKE * dt) : speed - CAR_ACCEL * 0.6 * dt
    else speed = toward(speed, 0, CAR_ROLL * dt)
    // Downhill speeds up, uphill slows down (+pitch = nose down)
    speed += 9.8 * Math.sin(car.object.rotation.x) * 0.6 * dt
    speed = THREE.MathUtils.clamp(speed, -CAR_REVERSE_SPEED, CAR_MAX_SPEED)

    // Steering gets gentler at speed
    const steerTarget = steerInput * CAR_MAX_STEER * (1 - 0.5 * Math.min(1, Math.abs(speed) / CAR_MAX_SPEED))
    car.steer = THREE.MathUtils.lerp(car.steer, steerTarget, Math.min(1, dt * 6))
    const yaw = car.object.rotation.y + (speed / CAR_WHEELBASE) * Math.tan(car.steer) * dt
    const x = car.object.position.x + Math.sin(yaw) * speed * dt
    const z = car.object.position.z + Math.cos(yaw) * speed * dt

    if (this.carBlocked(car, x, z, yaw)) {
      // Bump: stop and bounce back a little
      speed = -speed * 0.25
      if (this.carBlocked(car, car.object.position.x, car.object.position.z, car.object.rotation.y) && !this.carBlocked(car, x, z, yaw, false)) {
        // Already overlapping another vehicle or a player (they moved into us): let it drive out
        car.object.position.set(x, car.object.position.y, z)
        car.object.rotation.y = yaw
      }
    } else {
      car.object.position.set(x, car.object.position.y, z)
      car.object.rotation.y = yaw
    }
    this.carSpeed = speed
    car.spin = speed
    this.carGroundPose(car)
    setGameState({ speedKmh: Math.round(Math.abs(speed) * 3.6) })
  }

  /** Would the car's footprint (two circles along its length) at (x, z, yaw) hit something? */
  private carBlocked(car: Vehicle, x: number, z: number, yaw: number, moving = true) {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return true
    const fx = Math.sin(yaw) * CAR_CIRCLE_OFFSET
    const fz = Math.cos(yaw) * CAR_CIRCLE_OFFSET
    const feet = [{ x: x + fx, z: z + fz }, { x: x - fx, z: z - fz }]
    // Deep water ahead
    if (heightAt(x + Math.sin(yaw) * 3.2, z + Math.cos(yaw) * 3.2) < CAR_WATER_LIMIT) return true
    const others: Array<{ x: number; z: number; r: number }> = moving ? this.fleet.circles(car) : []
    if (moving) for (const remote of this.remotes.values()) {
      const avatar = remote.avatar?.group
      if (avatar?.visible && !remote.info.dead) others.push({ x: avatar.position.x, z: avatar.position.z, r: 0.45 })
    }
    const r = CAR_CIRCLE_RADIUS
    for (const f of feet) {
      for (const c of this.solidCircles) {
        const dx = f.x - c.x, dz = f.z - c.z, min = c.r + r
        if (Math.abs(dx) < min && Math.abs(dz) < min && dx * dx + dz * dz < min * min) return true
      }
      for (const c of others) if (Math.hypot(f.x - c.x, f.z - c.z) < c.r + r) return true
      const y = car.object.position.y
      for (const box of this.colliders) {
        if (box.max.y < y + 0.4 || box.min.y > y + 3) continue
        const cx = THREE.MathUtils.clamp(f.x, box.min.x, box.max.x)
        const cz = THREE.MathUtils.clamp(f.z, box.min.z, box.max.z)
        if (Math.hypot(f.x - cx, f.z - cz) < r) return true
      }
    }
    return false
  }

  /** Sit the car on the ground: height from its wheels, pitch and roll from the slope under them. */
  private carGroundPose(car: Vehicle) {
    const { x, z } = car.object.position
    const yaw = car.object.rotation.y
    const cos = Math.cos(yaw), sin = Math.sin(yaw)
    const f = CAR_WHEELBASE / 2, t = CAR_TRACK / 2
    const at = (lx: number, lz: number) => heightAt(x + lx * cos + lz * sin, z - lx * sin + lz * cos)
    const fl = at(t, f), fr = at(-t, f), rl = at(t, -f), rr = at(-t, -f)
    car.object.position.y = Math.max((fl + fr + rl + rr) / 4, heightAt(x, z) - 0.15)
    car.object.rotation.x = Math.atan2((rl + rr - fl - fr) / 2, CAR_WHEELBASE)
    car.object.rotation.z = Math.atan2((fl + rl - fr - rr) / 2, CAR_TRACK)
  }

  /** Vehicles nobody drives: helicopters sink to the ground (a wreck falls hard) and level out, cars sit on the ground. */
  private settleParkedVehicles(dt: number) {
    for (const vehicle of this.fleet.vehicles) {
      if (driverOf(vehicle) || (vehicle === this.vehicle && this.seat === 0)) continue
      const pose = vehicle.object
      if (vehicle.kind === 'car') {
        // A car rolls to a stop where it was left
        if (Math.abs(vehicle.spin) > 0.05) {
          const step = vehicle.spin * dt
          const x = pose.position.x + Math.sin(pose.rotation.y) * step
          const z = pose.position.z + Math.cos(pose.rotation.y) * step
          if (!this.carBlocked(vehicle, x, z, pose.rotation.y)) pose.position.set(x, pose.position.y, z)
          else vehicle.spin = 0
        }
        this.carGroundPose(vehicle)
        continue
      }
      const rest = this.fleet.restHeight(vehicle, pose.position.x, pose.position.z)
      const k = Math.min(1, dt * 2.5)
      const fall = vehicle.destroyed ? 25 : Math.max(0.5, (pose.position.y - rest) * 1.6)
      pose.position.y = Math.max(rest, pose.position.y - fall * dt)
      pose.rotation.x = THREE.MathUtils.lerp(pose.rotation.x, vehicle.destroyed ? 0.12 : 0, k)
      pose.rotation.z = THREE.MathUtils.lerp(pose.rotation.z, vehicle.destroyed ? 0.35 : 0, k)
    }
  }

  // ---------------------------------------------------------------- machine guns

  private mountTurret(turret: Turret) {
    if (turret.occupant && turret.occupant !== this.match.you) {
      setGameState({ message: `${this.nameOf(turret.occupant)} is on that machine gun.` })
      return
    }
    this.turret = turret
    turret.occupant = this.match.you
    turret.idle = false
    this.player.yaw = turret.facing + turret.yaw + Math.PI
    this.player.pitch = -turret.pitch
    this.mouse.shooting = false
    setGameState({ onGun: true, message: 'Machine gun: aim with the mouse, LMB fires slow, heavy rounds. E to leave it.' })
  }

  private leaveTurret() {
    const turret = this.turret
    if (!turret) return
    this.turret = null
    if (turret.occupant === this.match.you) turret.occupant = null
    turret.idle = true
    setGameState({ onGun: false })
  }

  /** The server says someone else is already on this gun. */
  ungun(gunId: string) {
    if (this.turret?.id !== gunId) return
    this.leaveTurret()
    setGameState({ message: 'Someone else is already on that machine gun.' })
  }

  /** Manning a gun: it follows our aim, we look along the barrel from behind it, and it fires slow heavy rounds. */
  private updateTurret(dt: number) {
    const turret = this.turret
    if (!turret) return
    this.player.pitch = THREE.MathUtils.clamp(this.player.pitch, -GUN_PITCH_DOWN, GUN_PITCH_UP)
    turret.yaw = wrap(this.player.yaw + Math.PI - turret.facing)
    turret.pitch = -this.player.pitch
    const eye = new THREE.Vector3(), muzzle = new THREE.Vector3()
    this.turrets.gunnerView(turret, eye, muzzle)
    this.camera.position.copy(eye)
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.set(this.player.pitch, this.player.yaw, 0)
    // Others see us standing behind the gun
    this.player.position.set(eye.x, heightAt(eye.x, eye.z) + EYE_HEIGHT, eye.z)
    this.player.velocity.set(0, 0, 0)

    this.gunCooldown = Math.max(0, this.gunCooldown - dt)
    if (!this.mouse.shooting || this.gunCooldown > 0) return
    this.gunCooldown = MACHINE_GUN.fireRate
    const view = this.camera.getWorldDirection(new THREE.Vector3())
    view.add(new THREE.Vector3((Math.random() - 0.5) * MACHINE_GUN.spread, (Math.random() - 0.5) * MACHINE_GUN.spread, 0)).normalize()
    // The eye sits above and behind the barrel: find what the crosshair is on, then fire from the muzzle at it
    const targets = this.shootTargets().filter((t) => t !== this.turrets.group)
    const sight = new THREE.Raycaster(eye, view, 0, MACHINE_GUN.range).intersectObjects(targets, true)[0]
    const aim = sight?.point ?? eye.clone().addScaledVector(view, MACHINE_GUN.range)
    const dir = aim.clone().sub(muzzle).normalize()
    const origin = muzzle.clone().addScaledVector(dir, 0.4)
    const hits = new THREE.Raycaster(origin, dir, 0, MACHINE_GUN.range).intersectObjects(targets, true)
    const end = hits[0]?.point.clone() ?? origin.clone().addScaledVector(dir, MACHINE_GUN.range)
    this.projectiles.round('bullet_556', muzzle, end, MACHINE_GUN.color)
    this.match.net.sendShot([end.x, end.y, end.z], MACHINE_GUN.id)
    if (hits[0]) this.reportHit(hits[0].object, MACHINE_GUN.id)
    this.player.pitch += 0.012
  }

  // ---------------------------------------------------------------- launcher

  /** Where a missile aims on a helicopter (its cabin). */
  private aimPoint(vehicle: Vehicle) {
    return vehicle.object.localToWorld(new THREE.Vector3(0, 1.6, 0.5))
  }

  /** A helicopter with an enemy aboard (anyone may fly anyone's helicopter, so it's about who is inside). */
  private hostileAircraft(vehicle: Vehicle) {
    return vehicle.kind === 'heli' && !vehicle.destroyed && vehicle.occupants.some((id) => id && id !== this.match.you && this.teamOf(id) !== this.team && !this.remotes.get(id)?.info.dead)
  }

  /**
   * Holding the launcher on foot: keep an enemy aircraft in the sights for LOCK_TIME to lock on, then fire.
   * Returns true when the launcher is in hand (so the normal guns don't fire).
   */
  private updateLauncher(dt: number, canShoot: boolean): boolean {
    const holding = canShoot && this.arsenal.current === 'launcher' && !this.vehicle
    if (!holding) {
      if (gameState.lock !== -1) setGameState({ lock: -1, lockX: -1, lockY: -1 })
      this.lock = { target: null, time: 0 }
      return this.arsenal.current === 'launcher'
    }
    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const forward = this.camera.getWorldDirection(new THREE.Vector3())
    let best: Vehicle | null = null
    let bestAngle = LOCK_CONE
    for (const vehicle of this.fleet.vehicles) {
      if (!this.hostileAircraft(vehicle)) continue
      const to = this.aimPoint(vehicle).sub(origin)
      const distance = to.length()
      if (distance > WEAPONS.launcher.range || distance < 5) continue
      const angle = forward.angleTo(to)
      if (angle < bestAngle) { best = vehicle; bestAngle = angle }
    }
    if (best) {
      // Something solid in the way breaks the lock
      const to = this.aimPoint(best).sub(origin)
      const hit = new THREE.Raycaster(origin, to.clone().normalize(), 0.5, to.length() - 3).intersectObjects(this.sightBlockers, true)[0]
      if (hit) best = null
    }
    if (best && best === this.lock.target) this.lock.time += dt
    else this.lock = { target: best, time: 0 }
    const progress = best ? Math.min(1, this.lock.time / LOCK_TIME) : 0
    let x = -1, y = -1
    if (best) {
      const screen = this.aimPoint(best).project(this.camera)
      x = (screen.x + 1) / 2
      y = (1 - screen.y) / 2
    }
    setGameState({ lock: progress, lockX: Math.round(x * 400) / 400, lockY: Math.round(y * 400) / 400 })

    const locked = best && progress >= 1
    if (!locked) {
      if (this.mouse.shooting && this.arsenal.mag > 0 && !gameState.message.startsWith('Hold the launcher')) {
        setGameState({ message: `Hold the launcher on an enemy aircraft for ${LOCK_TIME} s to lock on.` })
      }
      this.arsenal.holdTrigger(this.mouse.shooting)
      return true
    }
    if (this.arsenal.mag <= 0 && this.mouse.shooting) {
      if (this.arsenal.reserve.launcher <= 0) setGameState({ message: 'No missiles: take some from the missile crates in a base.' })
      else this.arsenal.reload()
    }
    if (!this.arsenal.fireMissile(this.mouse.shooting)) return true
    const target = best!
    this.match.net.sendMissile(target.id)
    this.projectiles.missile(origin.clone().addScaledVector(forward, 1.5), () => (target.destroyed ? null : this.aimPoint(target)))
    setGameState({ message: 'Missile away!' })
    this.lock = { target: null, time: 0 }
    return true
  }

  // ---------------------------------------------------------------- gem

  private updateGemsAndCapture() {
    // Carry logic — only on foot
    if (this.vehicle || this.carryTarget || this.turret) return
    // Pickup: close to the enemy gem's pedestal (reachable on foot), unless a teammate already has it
    const enemyTeam = other(this.team)
    const enemyGemWorld = this.enemyBase.group.localToWorld(GEM_LOCAL.clone())
    const d = this.player.position.distanceTo(enemyGemWorld)
    if (d < 7 && !this.dead && !this.gemCarried(enemyTeam)) {
      this.carryTarget = enemyTeam
      setGameState({ carryingGem: true, message: `${TEAM_NAME[enemyTeam]} gem taken! Bring it to the ${TEAM_NAME[this.team]} gem.` })
    }
  }

  private tryCapture() {
    if (!this.carryTarget) return
    const ourGemWorld = this.ourBase.group.localToWorld(GEM_LOCAL.clone())
    const d = this.player.position.distanceTo(ourGemWorld)
    if (d >= 9) {
      this.captureSent = false
      return
    }
    if (this.captureSent) return
    // The server confirms the capture and ends the match for every player
    this.captureSent = true
    this.sendNetState()
    this.match.net.sendCapture()
    setGameState({ message: 'Gem delivered — confirming capture…' })
  }

  private updatePlayer(dt: number) {
    this.player.setDynamicCircles(this.movingObstacles())
    if (this.vehicle || this.dead || this.turret || this.transition) return
    const locked = document.pointerLockElement === this.renderer.domElement
    this.player.update(dt, this.input, locked)
    this.tryCapture()
  }

  private syncHudState() {
    const def = this.arsenal.def
    const weapons = WEAPON_KINDS.filter((k) => this.arsenal.has(k))
    const key = weapons.join(',')
    if (key !== this.lastWeaponsKey) {
      this.lastWeaponsKey = key
      setGameState({ weapons })
    }
    setGameState({
      current: this.arsenal.current,
      weaponName: def?.name ?? '',
      ammo: this.arsenal.mag,
      maxAmmo: def?.magSize ?? 0,
      reserve: def ? this.arsenal.reserve[def.kind] : 0,
      reloading: this.arsenal.reloading,
      carryingGem: this.carryTarget !== null,
      interactPrompt: this.interactPrompt(),
      pickupPrompt: this.pickupPrompt(),
    })
  }

  start() {
    const loop = () => {
      if (this.disposed) return
      requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), 0.05)
      // Remote players follow real elapsed time so they stay in sync on slow machines
      const frameAt = performance.now()
      const realDt = this.lastFrameAt ? Math.min((frameAt - this.lastFrameAt) / 1000, 0.5) : dt
      this.lastFrameAt = frameAt
      const time = this.clock.elapsedTime

      this.updateRemotes(realDt)
      this.updateShadowArea()
      this.bases.blue.gem.update(time)
      this.bases.red.gem.update(time)
      this.grass.update(this.camera.position)
      this.rocks.update(this.camera.position)
      this.forest.update(this.camera.position)
      this.items.update(this.camera.position)
      this.updateGemVisibility()
      // Real time, not the capped frame dt, so slow machines don't fall behind
      const now = performance.now()
      if (now - this.lastRosterAt >= ROSTER_INTERVAL * 1000) {
        this.lastRosterAt = now
        this.publishRoster()
      }

      if (gameState.finished) {
        this.mouse.shooting = false
        this.settleParkedVehicles(realDt)
        this.fleet.update(realDt, this.camera.position, this.vehicle)
        this.turrets.update(time, this.camera.position)
        this.projectiles.update(realDt)
        this.renderer.render(this.scene, this.camera)
        return
      }

      this.updatePlayer(dt)
      if (this.dead) this.updateDeathCamera(realDt)
      this.updateTransition(dt)
      this.updateVehicle(dt)
      this.updateTurret(dt)
      this.settleParkedVehicles(realDt)
      // After our own vehicle / gun moved, so they are drawn exactly where the camera is this frame
      this.fleet.update(realDt, this.camera.position, this.seat === 0 ? this.vehicle : null)
      this.turrets.update(time, this.camera.position)
      this.updateGemsAndCapture()

      if (now - this.lastNetSend >= NET_SEND_INTERVAL * 1000) {
        this.lastNetSend = now
        this.sendNetState()
      }

      this.arsenal.tick(dt)
      // Pilots fly, they can't shoot; passengers, drivers in the roof-gun view and anyone on foot can
      const canShoot = !this.dead && !this.transition && !this.turret && (
        !this.vehicle || (this.vehicle.kind === 'heli' ? this.seat !== 0 : this.cameraMode === 'inside'))
      const launcherInHand = this.updateLauncher(realDt, canShoot)
      if (canShoot && !launcherInHand) {
        const shot = this.arsenal.tryFire(this.mouse, this.shootTargets())
        if (shot) {
          const def = WEAPONS[shot.kind]
          if (def.bullet) this.projectiles.round(def.bullet, shot.start, shot.end, def.color)
          this.match.net.sendShot([shot.end.x, shot.end.y, shot.end.z], shot.kind)
          if (shot.object) this.reportHit(shot.object, shot.kind)
        }
      } else if (!canShoot) {
        this.arsenal.holdTrigger(this.mouse.shooting)
      }
      this.projectiles.update(realDt)
      this.viewmodel.show(this.arsenal.current)
      this.viewmodel.update(dt, {
        recoilKick: this.arsenal.shotCount !== this.lastShotCount,
        reloading: this.arsenal.reloading,
        hidden: !canShoot || gameState.finished || this.dead,
        moving: this.input.forward || this.input.back || this.input.left || this.input.right,
        time,
      })
      this.lastShotCount = this.arsenal.shotCount
      this.syncHudState()

      this.renderer.render(this.scene, this.camera)
    }
    requestAnimationFrame(loop)
  }

  dispose() {
    this.disposed = true
    for (const [t, k, fn] of this.boundHandlers) t.removeEventListener(k, fn)
    this.boundHandlers = []
    for (const remote of this.remotes.values()) remote.avatar?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
