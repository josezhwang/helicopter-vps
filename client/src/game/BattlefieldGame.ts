import * as THREE from 'three'
import { createTerrain, createWater, createSkyAndLights, heightAt, SHADOW_RANGE, SUN_OFFSET, FOG_FAR } from './world/terrain'
import { createBase, GEM_LOCAL, turretPlacements, BASE_HALF, type BaseObjects, type Team } from './world/bases'
import { createRocks, createBushes, createClouds, createGrass, type GrassField, type RockField } from './world/nature'
import { createForest, type ForestField } from './world/forest'
import { createTurrets, type TurretField } from './world/turrets'
import { createFleet, MAX_ROTOR_RPM, CAR_WHEELBASE, CAR_TRACK, CAR_CIRCLE_RADIUS, CAR_CIRCLE_OFFSET, type Fleet, type Vehicle } from './world/vehicles'
import { Player, EYE_HEIGHT } from './world/player'
import { Viewmodel } from './world/viewmodel'
import { Weapon } from './world/weapon'
import { createAvatar, type Avatar } from './world/avatar'
import { gameState, setGameState, type RosterEntry } from './state'
import type { Multiplayer, NetPlayer, NetState, VehiclePoses } from './net'

export interface MatchSetup {
  you: string
  players: NetPlayer[]
  net: Multiplayer
  /** Where vehicles were last left in this match (from the server). */
  vehicles?: VehiclePoses
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

const NET_SEND_INTERVAL = 1 / 15
const ROSTER_INTERVAL = 0.3
/** Other players' solid radius; with the player's own 0.6 radius, bodies keep ~1m apart. */
const PLAYER_BLOCK_RADIUS = 0.45
const PLAYER_BLOCK_HEIGHT = 1.8
/** Jumps further than this (respawn, leaving a vehicle) snap instead of gliding across the map. */
const SNAP_DISTANCE = 25
const TEAM_NAME: Record<Team, string> = { blue: 'BLUE', red: 'RED' }
/** How close you have to be to get in (metres from the vehicle's centre). */
const BOARD_RANGE = { heli: 7.5, car: 6 }
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
const label = (v: Vehicle) => (v.kind === 'heli' ? 'helicopter' : 'battle car')
const other = (team: Team): Team => (team === 'blue' ? 'red' : 'blue')

function lerpAngle(from: number, to: number, t: number) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from))
  return from + delta * t
}

export class BattlefieldGame {
  readonly team: Team
  private remotes = new Map<string, RemotePlayer>()
  private lastNetSend = 0
  private lastRosterAt = 0
  private lastFrameAt = 0
  private lastRosterJson = ''
  private captureSent = false
  /** Both teams' helicopters and battle cars; `vehicle` is the one we're in. */
  private fleet: Fleet
  private vehicle: Vehicle | null = null
  /** Cockpit / roof-gunner view (can shoot) or the chase camera behind the vehicle. */
  private cameraMode: 'inside' | 'chase' = 'inside'
  private lastVehicleYaw = 0
  private heliYaw = 0
  private heliThrottle = 0
  private heliRoll = 0
  private heliPitch = 0
  private heliAltitude = 0
  private carSpeed = 0
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
  private weapon: Weapon
  private viewmodel: Viewmodel
  private ourBase: BaseObjects
  private enemyBase: BaseObjects
  private bases: { blue: BaseObjects; red: BaseObjects }
  private turrets: TurretField
  private grass: GrassField
  private rocks: RockField
  private forest: ForestField
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
  private boundHandlers: Array<[EventTarget, string, EventListener]> = []
  private lastShotCount = 0

  constructor(private container: HTMLElement, private match: MatchSetup) {
    this.team = match.players.find((p) => p.id === match.you)?.team ?? 'blue'

    // Renderer
    // Ask Chrome for the discrete GPU on laptops/desktops that have one
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    // 1.5x keeps high-DPI monitors sharp without rendering 4x the pixels
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    // Scene + camera
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      FOG_FAR, // past the fog end everything is sky coloured anyway
    )
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.camera)

    // World
    this.sun = createSkyAndLights(this.scene)
    const terrain = createTerrain()
    const worldCircles = this.solidCircles
    this.scene.add(terrain)
    this.scene.add(createWater())
    // Vehicle pads and parking first: nothing grows on them
    const baseSpots = { blue: new THREE.Vector3(-380, 0, -380), red: new THREE.Vector3(380, 0, 380) }
    this.fleet = createFleet(baseSpots)
    this.scene.add(this.fleet.group)
    this.scene.add(this.fleet.hitGroup)
    // Rocks next, so trees can keep clear of them
    this.rocks = createRocks(worldCircles, (x, z) => this.fleet.clearance(x, z, 3))
    this.forest = createForest(this.renderer, worldCircles, (x, z) =>
      Object.values(baseSpots).some((b) => Math.hypot(x - b.x, z - b.z) < 70) || this.fleet.clearance(x, z, 5))
    this.scene.add(this.forest.group)
    this.scene.add(this.rocks.group)
    const bushCircles: Array<{ x: number; z: number; r: number }> = []
    this.scene.add(createBushes(bushCircles, (x, z) => this.fleet.clearance(x, z, 2)))
    this.scene.add(createClouds())

    // Bases: blue in the south-west corner, red in the north-east; "ours" depends on the team
    const blueBase = createBase('blue', new THREE.Vector3(-380, 0, -380))
    const redBase = createBase('red', new THREE.Vector3(380, 0, 380))
    this.bases = { blue: blueBase, red: redBase }
    this.ourBase = this.bases[this.team]
    this.enemyBase = this.bases[other(this.team)]
    this.scene.add(blueBase.group)
    this.scene.add(redBase.group)

    // Machine-gun emplacements around both bases (solid: they block players and bullets)
    this.turrets = createTurrets((['blue', 'red'] as const).map((team) => ({
      center: this.bases[team].group.position,
      placements: turretPlacements(team, this.bases[team].group.position),
    })))
    this.scene.add(this.turrets.group)
    worldCircles.push(...this.turrets.circles)

    // Grass everywhere except inside the bases and under the guns
    const baseCenters = [blueBase.group.position, redBase.group.position]
    this.grass = createGrass((x, z) =>
      baseCenters.some((c) => Math.abs(x - c.x) < BASE_HALF + 6 && Math.abs(z - c.z) < BASE_HALF + 6) ||
      this.turrets.turrets.some((t) => Math.hypot(x - t.x, z - t.z) < 4) ||
      this.fleet.clearance(x, z))
    this.scene.add(this.grass.group)

    if (match.vehicles) this.applyVehiclePoses(match.vehicles)

    this.player = new Player(this.camera)
    this.player.spawn(this.spawnPoint())

    // Colliders from both bases for player/wall collision
    this.colliders = [...this.ourBase.colliders, ...this.enemyBase.colliders]
    this.player.setColliders(this.colliders)
    this.player.setCircles([...worldCircles, ...bushCircles])

    // Weapon
    this.weapon = new Weapon(this.scene, this.camera, () => {
      // small recoil kick
      this.player.pitch += 0.004
    })
    this.viewmodel = new Viewmodel(this.camera)
    this.viewmodel.loadHandgun()
    this.viewmodel.show('primary-handgun')

    // Everything that stops a bullet: terrain, bases, trees, rocks, vehicles, machine guns (player avatars are
    // added per shot). Bushes and grass are left out on purpose: they hide you but don't stop bullets.
    this.targetList = [terrain, this.ourBase.group, this.enemyBase.group, this.forest.trunks, this.rocks.group, this.fleet.hitGroup, this.turrets.group]

    // Debug handle for console/preview smoke tests
    ;(window as unknown as { __game?: BattlefieldGame }).__game = this

    for (const player of match.players) this.upsertPlayer(player)
    this.applyOwnVitals(match.players)
    const enemy = TEAM_NAME[other(this.team)]
    setGameState({
      team: this.team,
      message: `You are on the ${TEAM_NAME[this.team]} team. Steal the ${enemy} gem and bring it to your ${TEAM_NAME[this.team]} gem. Your 5 helicopters wait behind the base, 5 battle cars beside it: [E] to get in.`,
    })
    this.publishRoster()

    this.bindEvents()
  }

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

  /** After a reconnect the server's roster is authoritative: anyone missing is offline. */
  syncRoster(players: NetPlayer[], vehicles?: VehiclePoses) {
    if (vehicles) this.applyVehiclePoses(vehicles)
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
    if (by === this.match.you) setGameState({ hitsLanded: gameState.hitsLanded + 1 })
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
    if (by === this.match.you) setGameState({ message: `You eliminated ${remote.info.displayName}.` })
    this.publishRoster()
  }

  playerRespawned(id: string) {
    if (id === this.match.you) {
      this.dead = false
      this.player.spawn(this.spawnPoint())
      setGameState({ dead: false, health: 100, message: 'Back in the fight!' })
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

  /** Another player fired: muzzle flash on their gun (or their vehicle) and a tracer to where it landed. */
  remoteShot(id: string, to: [number, number, number]) {
    const remote = this.remotes.get(id)
    if (!remote?.avatar || !remote.info.online || remote.info.dead || !remote.target) return
    const end = new THREE.Vector3(...to)
    let start: THREE.Vector3
    if (remote.avatar.group.visible) {
      start = remote.avatar.fire()
    } else if (remote.target.vehicle && this.fleet.byId.has(remote.target.vehicle.id)) {
      const vehicle = this.fleet.byId.get(remote.target.vehicle.id)!
      start = vehicle.object.localToWorld(vehicle.kind === 'heli' ? new THREE.Vector3(0, 1.2, 4.5) : CAR_GUNNER_SEAT.clone())
    } else {
      return
    }
    this.weapon.spawnTracer(start, end, 0xffd27a)
  }

  /** Just outside our gate (blue gate faces +X, red gate faces -X), teammates side by side. */
  private spawnPoint() {
    const base = this.ourBase.group.position
    const mates = this.match.players.filter((p) => p.team === this.team)
    const slot = Math.max(0, mates.findIndex((p) => p.id === this.match.you))
    const gateDir = this.team === 'blue' ? 1 : -1
    const spread = (slot - (mates.length - 1) / 2) * 4
    return new THREE.Vector3(base.x + gateDir * 56, 0, base.z + gateDir * 8 + spread)
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

  private die(killer: string | null) {
    this.dead = true
    this.deathCamRoll = 0
    this.leaveVehicle()
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

  /** A remote driver got out, left or died: the vehicle stays where it is (a helicopter sinks to the ground). */
  private releaseVehiclesOf(pilotId: string) {
    for (const vehicle of this.fleet.vehicles) {
      if (vehicle.pilot !== pilotId || vehicle === this.vehicle) continue
      vehicle.pilot = null
      vehicle.targetSpin = 0
    }
  }

  /** Parked vehicles as the server last saw them (for vehicles nobody is in right now). */
  private applyVehiclePoses(poses: VehiclePoses) {
    for (const [id, pose] of Object.entries(poses)) {
      const vehicle = this.fleet.byId.get(id)
      if (!vehicle || vehicle.pilot || vehicle === this.vehicle) continue
      vehicle.object.position.set(...pose.p)
      vehicle.object.rotation.set(pose.r[0], pose.r[1], pose.r[2])
    }
  }

  /** Map a raycast hit back to an enemy player and report it; the server applies the damage. */
  private reportHit(object: THREE.Object3D) {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const playerId = node.userData.playerId as string | undefined
      if (playerId) {
        const remote = this.remotes.get(playerId)
        if (remote && remote.info.team !== this.team && !remote.info.dead) this.match.net.sendHit(playerId, this.weapon.weaponId)
        return
      }
      const vehicleId = node.userData.vehicleId as string | undefined
      if (vehicleId) {
        // Shooting an enemy vehicle hurts whoever is inside it
        const vehicle = this.fleet.byId.get(vehicleId)
        if (vehicle && vehicle.team !== this.team && vehicle.pilot && vehicle.pilot !== this.match.you) this.match.net.sendHit(vehicle.pilot, this.weapon.weaponId)
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
      message: won
        ? `VICTORY! The ${TEAM_NAME[winner]} team stole the enemy gem.`
        : `DEFEAT. The ${TEAM_NAME[winner]} team stole your gem.`,
    })
    document.exitPointerLock?.()
  }

  private sendNetState() {
    const p = this.player.position
    const vehicle = this.vehicle
    const pose = vehicle?.object
    this.match.net.sendState({
      p: [p.x, p.y, p.z],
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      vehicle: vehicle && pose
        ? { id: vehicle.id, p: [pose.position.x, pose.position.y, pose.position.z], r: [pose.rotation.x, pose.rotation.y, pose.rotation.z], spin: vehicle.kind === 'heli' ? vehicle.spin : this.carSpeed }
        : null,
      flag: this.carryTarget !== null,
      hp: gameState.health,
    })
  }

  private updateRemotes(dt: number) {
    const k = 1 - Math.exp(-dt * 12)
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
      if (avatar.visible) remote.avatar.update(dt, remote.speed, s.pitch, distance)
      this.syncRemoteVehicle(remote.info.id, s, k)
    }
  }

  /** A remote player in a vehicle drives it on our screen; getting out leaves it where it stopped. */
  private syncRemoteVehicle(playerId: string, s: NetState, k: number) {
    const claimed = s.vehicle ? this.fleet.byId.get(s.vehicle.id) : undefined
    for (const vehicle of this.fleet.vehicles) {
      if (vehicle.pilot === playerId && vehicle !== claimed && vehicle !== this.vehicle) {
        vehicle.pilot = null
        vehicle.targetSpin = 0
      }
    }
    // Two players in one vehicle: the server keeps whoever got in first and ejects the other
    if (!claimed || !s.vehicle || claimed === this.vehicle) return
    const pose = claimed.object
    const target = new THREE.Vector3(...s.vehicle.p)
    const snap = claimed.pilot !== playerId || pose.position.distanceToSquared(target) > SNAP_DISTANCE ** 2
    claimed.pilot = playerId
    claimed.targetSpin = s.vehicle.spin
    if (snap) {
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
    const entries: RosterEntry[] = [{
      id: this.match.you,
      name: me?.displayName ?? 'You',
      team: this.team,
      status: this.dead ? 'dead' : this.carryTarget ? 'carrying gem' : this.vehicle ? (this.vehicle.kind === 'heli' ? 'flying' : 'driving') : 'on foot',
      hp: gameState.health,
      you: true,
    }]
    for (const remote of this.remotes.values()) {
      const s = remote.target
      entries.push({
        id: remote.info.id,
        name: remote.info.displayName,
        team: remote.info.team,
        status: !remote.info.online ? 'offline' : remote.info.dead ? 'dead' : s?.flag ? 'carrying gem' : s?.vehicle ? (s.vehicle.id.includes('-heli-') ? 'flying' : 'driving') : 'on foot',
        hp: remote.info.hp ?? 100,
        you: false,
      })
    }
    const json = JSON.stringify(entries)
    if (json === this.lastRosterJson) return
    this.lastRosterJson = json
    setGameState({ players: entries })
  }

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
        this.input.forward = false
        this.input.back = false
        this.input.left = false
        this.input.right = false
        this.input.sprint = false
        this.input.jump = false
        this.input.arrowUp = false
        this.input.arrowDown = false
        this.input.arrowLeft = false
        this.input.arrowRight = false
        this.mouse.shooting = false
      }
    })

    add(document, 'mousemove', ((e: MouseEvent) => {
      if (document.pointerLockElement !== this.renderer.domElement) return
      if (this.vehicle?.kind === 'heli') {
        // subtle freelook while piloting
        this.player.look(e.movementX * 0.5, e.movementY * 0.5)
      } else {
        this.player.look(e.movementX, e.movementY)
      }
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
          this.weapon.reload()
          break
        case 'KeyE':
          this.toggleVehicle()
          break
        case 'KeyV':
          this.cycleVehicleCamera()
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

  /** [E]: get out, or into the nearest of our team's vehicles. */
  private toggleVehicle() {
    if (this.dead || gameState.finished) return
    if (this.vehicle) {
      this.exitVehicle()
      return
    }
    const vehicle = this.nearestVehicle()
    if (!vehicle) return
    if (vehicle.pilot) {
      setGameState({ message: `That ${label(vehicle)} is being used by ${this.nameOf(vehicle.pilot)}.` })
      return
    }
    this.enterVehicle(vehicle)
  }

  /** The closest of our team's vehicles within reach, if any. */
  private nearestVehicle(): Vehicle | null {
    let best: Vehicle | null = null
    let bestDistance = Infinity
    const p = this.player.position
    for (const vehicle of this.fleet.vehicles) {
      if (vehicle.team !== this.team) continue
      const v = vehicle.object.position
      if (Math.abs(p.y - EYE_HEIGHT - v.y) > 4) continue
      const distance = Math.hypot(p.x - v.x, p.z - v.z)
      if (distance < BOARD_RANGE[vehicle.kind] && distance < bestDistance) {
        best = vehicle
        bestDistance = distance
      }
    }
    return best
  }

  private enterVehicle(vehicle: Vehicle) {
    this.vehicle = vehicle
    vehicle.pilot = this.match.you
    // Our own shots pass through the vehicle we're in
    vehicle.hitbox.traverse((node) => node.layers.set(1))
    const yaw = vehicle.object.rotation.y
    this.lastVehicleYaw = yaw
    this.player.velocity.set(0, 0, 0)
    // Look where the nose points (the camera looks along -Z, the vehicles' noses point along +Z)
    this.player.yaw = yaw + Math.PI
    this.player.pitch = vehicle.kind === 'heli' ? 0 : -0.2
    if (vehicle.kind === 'heli') {
      this.heliYaw = yaw
      this.heliAltitude = vehicle.object.position.y
      this.heliThrottle = 0
      this.heliRoll = vehicle.object.rotation.z
      this.heliPitch = vehicle.object.rotation.x
      vehicle.targetSpin = vehicle.spin
      this.cameraMode = 'inside'
      setGameState({ vehicle: 'heli', nearVehicle: null, message: 'Press SPACE to spin up the rotor. W/S fly, A/D turn, ↑/↓ altitude, ←/→ roll, V camera, E to exit.' })
    } else {
      this.carSpeed = 0
      vehicle.targetSpin = 0
      this.cameraMode = 'chase'
      setGameState({ vehicle: 'car', nearVehicle: null, message: 'W/S drive, A/D steer, SPACE brake. V for the roof gun, E to get out.' })
    }
    this.publishRoster()
  }

  /** Step out beside the vehicle (falling to the ground if it is in the air). */
  private exitVehicle() {
    const vehicle = this.vehicle
    if (!vehicle) return
    this.leaveVehicle()
    const side = vehicle.kind === 'heli' ? 3.2 : 3.6
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

  /** We are no longer in our vehicle (got out, died, or someone else had it first). */
  private leaveVehicle() {
    const vehicle = this.vehicle
    if (!vehicle) return
    this.vehicle = null
    vehicle.pilot = null
    vehicle.targetSpin = 0
    if (vehicle.kind === 'car') vehicle.spin = this.carSpeed
    this.carSpeed = 0
    vehicle.hitbox.traverse((node) => node.layers.set(0))
    this.camera.rotation.order = 'YXZ'
    setGameState({ vehicle: null, rotorRpm: 0, speedKmh: 0 })
    this.publishRoster()
  }

  /** The server says another player got into this vehicle first. */
  ejectFrom(vehicleId: string) {
    if (this.vehicle?.id !== vehicleId) return
    this.exitVehicle()
    setGameState({ message: 'Someone else got into that vehicle first.' })
  }

  private cycleVehicleCamera() {
    if (!this.vehicle) return
    this.cameraMode = this.cameraMode === 'inside' ? 'chase' : 'inside'
    const inside = this.vehicle.kind === 'heli' ? 'COCKPIT VIEW' : 'ROOF GUN'
    setGameState({ message: `${this.cameraMode === 'inside' ? inside : 'CHASE VIEW'} — press V to change camera.` })
  }

  private updateVehicle(dt: number) {
    const vehicle = this.vehicle
    if (!vehicle) return
    if (vehicle.kind === 'heli') this.updateHelicopter(vehicle, dt)
    else this.updateCar(vehicle, dt)
    // The camera turns with the vehicle; the mouse looks around on top of that
    const yaw = vehicle.object.rotation.y
    this.player.yaw += Math.atan2(Math.sin(yaw - this.lastVehicleYaw), Math.cos(yaw - this.lastVehicleYaw))
    this.lastVehicleYaw = yaw
    // We ride along: our position is the seat (what others use for range checks, where we get out)
    const seat = vehicle.object.localToWorld(vehicle.kind === 'heli' ? this.fleet.heliSeat.clone() : CAR_GUNNER_SEAT.clone())
    this.player.position.copy(seat)
    this.camera.rotation.order = 'YXZ'
    if (this.cameraMode === 'inside') {
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

  /** Vehicles nobody is in: helicopters sink to the ground (or their pad) and level out, cars sit on the ground. */
  private settleParkedVehicles(dt: number) {
    for (const vehicle of this.fleet.vehicles) {
      if (vehicle.pilot || vehicle === this.vehicle) continue
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
      pose.position.y = Math.max(rest, pose.position.y - Math.max(0.5, (pose.position.y - rest) * 1.6) * dt)
      pose.rotation.x = THREE.MathUtils.lerp(pose.rotation.x, 0, k)
      pose.rotation.z = THREE.MathUtils.lerp(pose.rotation.z, 0, k)
    }
  }

  private updateGemsAndCapture() {
    // Carry logic — only when on foot
    if (this.vehicle || this.carryTarget) {
      this.updateNearVehicleState()
      return
    }

    // Pickup: close to the enemy gem's pedestal (reachable on foot), unless a teammate already has it
    const enemyTeam = other(this.team)
    const enemyGemWorld = this.enemyBase.group.localToWorld(GEM_LOCAL.clone())
    const d = this.player.position.distanceTo(enemyGemWorld)
    if (d < 7 && !this.dead && !this.gemCarried(enemyTeam)) {
      this.carryTarget = enemyTeam
      setGameState({
        carryingGem: true,
        message: `${TEAM_NAME[enemyTeam]} gem taken! Bring it to the ${TEAM_NAME[this.team]} gem.`,
      })
    }

    this.updateNearVehicleState()
  }

  private updateNearVehicleState() {
    const near = this.vehicle || this.dead ? null : this.nearestVehicle()
    setGameState({ nearVehicle: near?.kind ?? null })
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

  private score = 0

  private updatePlayer(dt: number) {
    this.player.setDynamicCircles(this.movingObstacles())
    if (this.vehicle || this.dead) return
    const locked = document.pointerLockElement === this.renderer.domElement
    this.player.update(dt, this.input, locked)
    this.tryCapture()
  }

  private syncHudState() {
    setGameState({
      ammo: this.weapon.ammo,
      maxAmmo: this.weapon.def.magSize,
      reloading: this.weapon.reloading,
      carryingGem: this.carryTarget !== null,
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
      this.turrets.update(time, this.camera.position)
      this.grass.update(this.camera.position)
      this.rocks.update(this.camera.position)
      this.forest.update(this.camera.position)
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
        this.renderer.render(this.scene, this.camera)
        return
      }

      this.updatePlayer(dt)
      if (this.dead) this.updateDeathCamera(realDt)
      this.updateVehicle(dt)
      this.settleParkedVehicles(realDt)
      // After our own vehicle moved, so it is drawn exactly where the camera is this frame
      this.fleet.update(realDt, this.camera.position, this.vehicle)
      this.updateGemsAndCapture()

      if (now - this.lastNetSend >= NET_SEND_INTERVAL * 1000) {
        this.lastNetSend = now
        this.sendNetState()
      }

      this.weapon.tick(dt)
      // In a vehicle you can shoot from the cockpit / roof gun view, not the chase camera
      const canShoot = !this.vehicle || this.cameraMode === 'inside'
      if (!this.dead && canShoot) {
        const shot = this.weapon.tryFire(this.mouse, dt, this.shootTargets())
        if (shot) {
          this.match.net.sendShot([shot.end.x, shot.end.y, shot.end.z])
          if (shot.object) this.reportHit(shot.object)
        }
      }
      this.viewmodel.show(this.weapon.weaponId)
      this.viewmodel.update(dt, {
        recoilKick: this.weapon.shotCount !== this.lastShotCount,
        reloading: this.weapon.reloading,
        hidden: !canShoot || gameState.finished || this.dead,
        moving: this.input.forward || this.input.back || this.input.left || this.input.right,
        time,
      })
      this.lastShotCount = this.weapon.shotCount
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
