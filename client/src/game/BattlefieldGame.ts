import * as THREE from 'three'
import { createTerrain, heightAt } from './world/terrain'
import { createWater } from './world/water'
import { createSky, FOG_FAR, SUN_DIRECTION, type SkyRig } from './world/sky'
import { Graphics, loadQuality, saveQuality, PROFILES, type Quality, type QualityProfile } from './world/graphics'
import { createBase, GEM_LOCAL, BASE_HALF, type BaseObjects, type Team } from './world/bases'
import { createRocks, createBushes, createGrass, type GrassField, type RockField } from './world/nature'
import { createForest, type ForestField } from './world/forest'
import { createGrassBlades, type GrassBlades } from './world/grassField'
import { bakeGroundMap, type GroundMap } from './world/groundMap'
import { createTurrets, type Turret, type TurretField } from './world/turrets'
import {
  createFleet, driverOf, DOOR_HOLD_MS, MAX_ROTOR_RPM, CAR_WHEELBASE, CAR_TRACK, CAR_CIRCLE_RADIUS, CAR_CIRCLE_OFFSET, CAR_GUN_PITCH, TURRET_PIVOT, GATLING_PIVOT,
  TANK_GUN_PIVOT, TANK_GUN_PITCH, TANK_TURRET_PIVOT, MECH_RADIUS, MECH_AIRBORNE, HELI_GUN_PIVOT, HELI_GUN_LIMITS, TANK_CIRCLE_RADIUS, TANK_CIRCLE_OFFSET, TANK_LENGTH, TANK_WIDTH, VEHICLE_MAX_HP, type Fleet, type Vehicle,
} from './world/vehicles'
import { BARREL_SPOTS, BASE_CENTER, BASE_ROTATION, LAYOUT, PLATEAU_HALF, baseToWorld, baseYaw } from './world/layout'
import { createOutposts, type Outposts } from './world/outposts'
import { createGrenades, GRENADE_FUSE, THROW_SPEED, type Grenades } from './world/grenades'
import { GameAudio, type LoopSource, type ShotSound } from './world/audio'
import { Player, EYE_HEIGHT } from './world/player'
import { Viewmodel } from './world/viewmodel'
import { Arsenal, type Shot } from './world/weapon'
import { AMMO, WEAPONS, MACHINE_GUN, CAR_GUN, LOCK_TIME, LOCK_CONE, type RoundKind, type WeaponKind } from './world/weapons'
import { createItems, itemLabel, ammoOf, isWeaponItem, type ItemField, type NetItem } from './world/items'
import { createProjectiles, type Projectiles, type Surface } from './world/projectiles'
import { createDecals, type Decals } from './world/decals'
import { createAvatar, muzzleFlashTexture, type Avatar } from './world/avatar'
import { gameState, radar, setGameState, type KillEntry, type RadarBlip, type RosterEntry } from './state'
import type { BlastKind, Multiplayer, NetPlayer, NetState, ProjectileKind, Took, Vec3, WorldSnapshot } from './net'

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
  /** When they last fired or threw something (it shows them on the radar). */
  lastFiredAt: number
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
const BOARD_RANGE = { heli: 7.5, car: 6, tank: 6.5, mech: 5.5 }
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
/** Tank handling: top speed / reverse (m/s), acceleration, braking (m/s²), hull and turret turn rates (rad/s). */
const TANK_MAX_SPEED = 11
const TANK_REVERSE_SPEED = 5
const TANK_ACCEL = 4.5
const TANK_BRAKE = 12
const TANK_TURN = 0.8
const TANK_TURRET_SPEED = 0.9
const TANK_PITCH_SPEED = 0.6
/** Seconds to load the next shell (the server allows no faster). */
const TANK_RELOAD = 3
/** Gunner's sight: eye position in turret space, and its magnification. */
/** The gunner's sight on the turret roof (relative to the turret's turning axis). */
const TANK_SIGHT = new THREE.Vector3(0.35, 3.75, 0.4)
const TANK_SIGHT_ZOOM = 2.4
/** How far a tank shell and an unguided rocket fly before they go off by themselves. */
const SHELL_RANGE = 640
const ROCKET_RANGE = 440
/**
 * The combat mech: walks at MECH_WALK m/s (runs with Shift), turns on the spot, and hops on its jump-jets
 * (SPACE, MECH_JET_TIME seconds of fuel, refilling on the ground). Its torso turns towards the crosshair; the
 * arm autocannon fires heavy rounds, the shoulder pods a salvo of rockets.
 */
const MECH_WALK = 4.2
const MECH_RUN = 8.5
const MECH_BACK = 2.6
const MECH_ACCEL = 6
const MECH_TURN = 1.05
const MECH_GRAVITY = 13
const MECH_JET_THRUST = 21
const MECH_JET_TIME = 2.2
const MECH_JET_REFILL = 0.3
const MECH_TWIST_LIMIT = 1.9
const MECH_TWIST_SPEED = 2.4
const MECH_PITCH = { up: 0.5, down: 0.35 }
/** Height the torso aims from (the gun arm's shoulder). */
const MECH_AIM_HEIGHT = 5.4
const MECH_CANNON = { id: 'mech-cannon', power: 22, fireRate: 0.11, range: 420, spread: 0.012, color: 0xffc46a }
const MECH_SALVO = 6
/** The helicopter's nose gun (the gunner's seat). */
const HELI_GUN = { id: 'heli-gun', power: 16, fireRate: 0.09, range: 400, spread: 0.012, color: 0xffd08a }
const MECH_ROCKET_GAP = 0.16
const MECH_SALVO_RELOAD = 7
/** Metres per footstep (for the thud). */
const MECH_STRIDE = 3.2

/** Seconds between grenades, and how long the throw keeps the gun out of view. */
const GRENADE_COOLDOWN = 0.9
const THROW_TIME = 0.45
const MAX_LIVE_GRENADES = 3
const KILL_FEED_MS = 7000
const KILL_FEED_SIZE = 5
/** How big each kind of explosion looks and sounds. */
const BLAST_SIZE: Record<BlastKind, number> = { shell: 1.5, rocket: 1.4, grenade: 1, barrel: 1.8 }
/** What the kill feed calls each way to die (weapons use their own names). */
const HOW_LABEL: Record<string, string> = {
  'machine-gun': 'Machine gun', 'car-gun': 'Roof gatling', 'mech-cannon': 'Mech autocannon', 'heli-gun': 'Helicopter nose gun', missile: 'AA missile', shell: 'Tank shell', rocket: 'Rocket',
  grenade: 'Grenade', barrel: 'Barrel', wreck: 'Wreck',
}
const howLabel = (how: string) => HOW_LABEL[how] ?? WEAPONS[how as WeaponKind]?.name ?? how
/** What each weapon sounds like. */
const SHOT_SOUND: Record<string, ShotSound> = {
  handgun: 'pistol', primary: 'rifle', m4a1: 'rifle', m254: 'rifle', pulse: 'heavy', m240b: 'heavy', plasma: 'plasma',
  m170: 'sniper', svd: 'sniper', 'machine-gun': 'mg', 'car-gun': 'gatling', 'mech-cannon': 'heavy', 'heli-gun': 'gatling',
}
const LABEL: Record<Vehicle['kind'], string> = { heli: 'helicopter', car: 'battle car', tank: 'tank', mech: 'combat mech' }
const label = (v: Vehicle) => LABEL[v.kind]
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
  /** Speed of the car or tank we drive (m/s along its nose). */
  private carSpeed = 0
  private cannonCooldown = 0
  /** The tank's last sight and barrel rays (distances along them), refreshed a dozen times a second. */
  private tankAim = { distance: SHELL_RANGE, at: 0, gunDistance: SHELL_RANGE, gunAt: 0 }
  /** [E] on a vehicle with enemies aboard: waiting for the server to pull them out. */
  private pendingHijack: { vehicle: Vehicle; until: number } | null = null
  private grenadeCooldown = 0
  /** Counts down while the arm is busy throwing. */
  private throwTimer = 0
  /** Camera shake from blasts and our own cannon, dies away by itself. */
  private shake = 0
  /** The last explosion that went off close to us (damage from it points there). */
  private nearBlast: { at: THREE.Vector3; time: number } | null = null
  private killFeed: Array<KillEntry & { at: number }> = []
  private killCount = 0
  private lastRadarAt = 0
  private lastShadeAt = 0
  /** Our mech: vertical speed, jet fuel (0..1), gun cooldown, the rocket salvo, footstep distance. */
  private mechVy = 0
  private mechJet = 1
  private mechGunCooldown = 0
  private mechSalvo = { left: MECH_SALVO, next: 0, reloadUntil: 0 }
  private mechStep = 0
  private mechAim = { distance: 300, at: 0 }
  private shadeRay = new THREE.Raycaster()
  /** Two lights that flash where things blow up and where we fire (always present, dark when idle). */
  private flashes: Array<{ light: THREE.PointLight; from: number; until: number; peak: number }> = []
  private lastLoopsAt = 0
  private smokeTimer = 0
  /** For reload / switch / empty-click sounds. */
  private soundState = { reloading: false, mag: 0, kind: null as WeaponKind | null, trigger: false }
  /** Launcher lock-on: the helicopter in the sights and for how long. */
  private lock: { target: Vehicle | null; time: number } = { target: null, time: 0 }
  /** An item we asked the server for (don't ask twice while waiting). */
  private pendingTake: string | null = null
  private lastWeaponsKey = ''
  /** Solid things cars bump into (rocks, trees, machine guns — bushes are driven through), and base walls. */
  private solidCircles: Array<{ x: number; z: number; r: number }> = []
  private colliders: THREE.Box3[] = []
  private dead = false
  private sky: SkyRig
  private water: ReturnType<typeof createWater>
  private graphics: Graphics
  private deathCamRoll = 0
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private player: Player
  private arsenal: Arsenal
  private viewmodel: Viewmodel
  private items: ItemField
  private projectiles: Projectiles
  private decals: Decals
  private outposts: Outposts
  private grenades: Grenades
  private audio = new GameAudio()
  /** Right-mouse aiming: current zoom (field of view divisor). */
  private zoom = 1
  private carGunCooldown = 0
  private ourBase: BaseObjects
  private enemyBase: BaseObjects
  private bases: { blue: BaseObjects; red: BaseObjects }
  private turrets: TurretField
  private grass: GrassField | null = null
  private blades: GrassBlades | null = null
  private groundMap: GroundMap
  private noGrass: (x: number, z: number) => boolean
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
  private mouse = { shooting: false, aiming: false }
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
    // (post-processing does the anti-aliasing and tone mapping, see Graphics)
    const quality = loadQuality()
    this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', powerPreference: 'high-performance', stencil: false })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    // Past the fog end everything is sky coloured anyway
    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, FOG_FAR)
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.camera)

    // Sky, sun and the frame pipeline (post effects), at the remembered quality
    this.sky = createSky(this.scene, this.renderer, PROFILES[quality])
    this.graphics = new Graphics(this.renderer, this.scene, this.camera, SUN_DIRECTION, quality)
    this.graphics.setSize(container.clientWidth, container.clientHeight)
    setGameState({ quality })

    // World
    this.terrain = createTerrain({ textureSize: PROFILES[quality].terrainTextures, anisotropy: Math.min(PROFILES[quality].anisotropy, this.renderer.capabilities.getMaxAnisotropy()) })
    const worldCircles = this.solidCircles
    this.scene.add(this.terrain)
    this.water = createWater()
    this.scene.add(this.water.mesh)
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(0xffa860, 0, 45, 2)
      this.scene.add(light)
      this.flashes.push({ light, from: 0, until: 0, peak: 0 })
    }
    // Vehicle parking and the sandbag outposts first: nothing grows on them
    this.fleet = createFleet()
    this.scene.add(this.fleet.group)
    this.scene.add(this.fleet.hitGroup)
    this.outposts = createOutposts()
    this.scene.add(this.outposts.group)
    this.scene.add(this.outposts.blockers)
    worldCircles.push(...this.outposts.circles)
    const outpost = (x: number, z: number, margin: number) => this.outposts.near(x, z, margin)
    // Rocks next, so trees can keep clear of them; nothing grows inside the bases
    this.rocks = createRocks(worldCircles, (x, z) => inBase(x, z, 5) || this.fleet.clearance(x, z, 3) || outpost(x, z, 2))
    this.forest = createForest(this.renderer, worldCircles, (x, z) => inBase(x, z, PLATEAU_HALF - BASE_HALF + 10) || this.fleet.clearance(x, z, 5) || outpost(x, z, 6))
    this.scene.add(this.forest.group)
    this.scene.add(this.rocks.group)
    const bushCircles: Array<{ x: number; z: number; r: number }> = []
    this.scene.add(createBushes(bushCircles, (x, z) => inBase(x, z, 4) || this.fleet.clearance(x, z, 2) || outpost(x, z, 0)))

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

    // The ground map (bare dirt, meadow, grass) the terrain and the grass share: no grass inside the bases,
    // under the guns, on the parking spots or inside the outposts; trampled earth round outposts and vehicles
    const noGrass = (x: number, z: number) =>
      inBase(x, z, 3) ||
      this.turrets.turrets.some((t) => Math.hypot(x - t.x, z - t.z) < 4) ||
      this.fleet.clearance(x, z) ||
      this.outposts.near(x, z, -4)
    const worn = (x: number, z: number) => (this.outposts.near(x, z, 3) ? 0.6 : this.outposts.near(x, z, 7) ? 0.3 : 0) + (this.fleet.clearance(x, z, 1) ? 0.45 : 0)
    this.groundMap = bakeGroundMap(noGrass, worn)
    ;(this.terrain.userData.layers as { uGround: { value: THREE.Texture } }).uGround.value = this.groundMap.texture
    this.noGrass = noGrass
    this.plantGrass(PROFILES[quality])

    // Supplies (launchers, missile crates, ammo boxes, dropped weapons) and everything that flies
    this.items = createItems()
    this.scene.add(this.items.group)
    this.projectiles = createProjectiles()
    this.scene.add(this.projectiles.group)
    this.decals = createDecals()
    this.scene.add(this.decals.group)
    // Grenades bounce off walls, trunks, rocks, sandbags, barrels and vehicles on the ground
    this.grenades = createGrenades({
      colliders: this.colliders,
      circles: () => [...worldCircles, ...this.fleet.circles(null), ...this.outposts.barrelCircles()],
    })
    this.grenades.onBounce = (at, speed) => this.audio.clink(at, speed)
    this.scene.add(this.grenades.group)
    if (match.world) this.applyWorld(match.world)

    this.player = new Player(this.camera)
    this.respawnPlayer()

    // Colliders from both bases for player/wall collision (the shared array fills in as the base models load)
    this.player.setColliders(this.colliders)
    this.player.setCircles([...worldCircles, ...bushCircles])

    this.arsenal = new Arsenal(this.scene, this.camera, (def) => {
      // Recoil: the view kicks up (less when aiming steadily) and a little sideways
      const steady = this.mouse.aiming ? 0.6 : 1
      this.player.pitch += def.kick * steady
      this.player.yaw += (Math.random() - 0.5) * def.kick * 0.4 * steady
    })
    this.viewmodel = new Viewmodel(this.camera, this.graphics.viewmodelRig, muzzleFlashTexture())

    // Everything that stops a bullet: terrain, bases, trees, rocks, vehicles, machine guns (player avatars are
    // added per shot). Bushes and grass are left out on purpose: they hide you but don't stop bullets.
    this.targetList = [this.terrain, this.ourBase.group, this.enemyBase.group, this.forest.trunks, this.rocks.group, this.fleet.hitGroup, this.turrets.group, this.outposts.blockers]
    this.sightBlockers = [this.terrain, this.ourBase.group, this.enemyBase.group, this.forest.trunks, this.rocks.group, this.outposts.blockers]

    // Debug handle for console/preview smoke tests
    ;(window as unknown as { __game?: BattlefieldGame }).__game = this

    for (const player of match.players) this.upsertPlayer(player)
    this.applyOwnVitals(match.players)
    const enemy = TEAM_NAME[other(this.team)]
    setGameState({
      team: this.team,
      message: `You are on the ${TEAM_NAME[this.team]} team. Steal the ${enemy} gem and bring it to your ${TEAM_NAME[this.team]} gem. [F] switch weapon, [Q] grenade, [G] pick up / drop, [E] vehicles and machine guns.`,
    })
    this.publishRoster()
    this.bindEvents()
  }

  // ---------------------------------------------------------------- players

  upsertPlayer(player: NetPlayer) {
    if (player.id === this.match.you) return
    let remote = this.remotes.get(player.id)
    if (!remote) {
      remote = { info: player, avatar: null, target: null, snapped: false, speed: 0, diedInVehicle: false, lastFiredAt: 0 }
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
      if (took) this.audio.ui('hurt')
      setGameState({ health: hp, damageTaken: gameState.damageTaken + (took ? 1 : 0), ...(took ? { damageDir: this.damageDirection(by) } : {}) })
      this.publishRoster()
      return
    }
    const remote = this.remotes.get(id)
    if (remote) {
      if (hp < remote.info.hp && hp > 0) remote.avatar?.flinch()
      remote.info.hp = hp
    }
    if (by === this.match.you && hp < 100) {
      setGameState({ hitsLanded: gameState.hitsLanded + 1 })
      if (hp > 0) this.audio.ui('hit')
    }
    this.publishRoster()
  }

  /** Where damage came from, as an angle from where we look (0 = ahead, + = right): a blast next to us, or the shooter. */
  private damageDirection(by: string): number | null {
    const source = this.nearBlast && performance.now() - this.nearBlast.time < 400 ? this.nearBlast.at : this.whereIs(by)
    if (!source) return null
    const forward = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize()
    const to = source.clone().sub(this.camera.position).setY(0)
    if (to.lengthSq() < 0.25) return null
    return Math.atan2(to.x * -forward.z + to.z * forward.x, to.dot(forward))
  }

  /** Where a player is right now (their vehicle, their machine gun, their body). */
  private whereIs(id: string): THREE.Vector3 | null {
    const remote = this.remotes.get(id)
    const s = remote?.target
    if (!s) return null
    if (s.vehicle) return new THREE.Vector3(...s.vehicle.p)
    if (s.gun) {
      const t = this.turrets.turrets.find((g) => g.id === s.gun!.id)
      if (t) return new THREE.Vector3(t.x, heightAt(t.x, t.z) + 1.5, t.z)
    }
    return remote.avatar?.group.visible ? remote.avatar.group.position.clone() : new THREE.Vector3(...s.p)
  }

  /** A name for the kill feed. */
  private feedName(id: string) {
    if (id === this.match.you) return this.match.players.find((p) => p.id === id)?.displayName ?? 'You'
    return this.remotes.get(id)?.info.displayName ?? '?'
  }

  private addKill(killer: string, victim: string, how: string) {
    const entry = {
      id: ++this.killCount,
      killer: killer && killer !== victim ? this.feedName(killer) : '',
      killerTeam: this.teamOf(killer),
      victim: this.feedName(victim),
      victimTeam: this.teamOf(victim),
      how: howLabel(how),
      mine: killer === this.match.you || victim === this.match.you,
      at: performance.now(),
    }
    this.killFeed = [...this.killFeed, entry].slice(-KILL_FEED_SIZE)
    setGameState({ killFeed: this.killFeed })
  }

  /** Old kill feed lines fade out. */
  private pruneKillFeed() {
    const now = performance.now()
    if (!this.killFeed.length || now - this.killFeed[0].at < KILL_FEED_MS) return
    this.killFeed = this.killFeed.filter((e) => now - e.at < KILL_FEED_MS)
    setGameState({ killFeed: this.killFeed })
  }

  playerKilled(id: string, by: string, how = '') {
    const killer = this.nameOf(by)
    this.addKill(by, id, how)
    if (by === this.match.you && id !== this.match.you) this.audio.ui('kill')
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

  /**
   * Another player fired: muzzle flash on their gun (or machine gun / car gatling / at their seat), the round
   * flying to where it landed, and what it did there (hole, dust, sparks).
   */
  remoteShot(id: string, to: Vec3, weapon: string) {
    const remote = this.remotes.get(id)
    if (!remote?.avatar || !remote.info.online || remote.info.dead || !remote.target) return
    remote.lastFiredAt = performance.now()
    const end = new THREE.Vector3(...to)
    const s = remote.target
    let start: THREE.Vector3
    let heavy = false
    if (s.gun) {
      const t = this.turrets.turrets.find((g) => g.id === s.gun!.id)
      if (!t) return
      start = new THREE.Vector3()
      this.turrets.gunnerView(t, new THREE.Vector3(), start)
      t.recoil = 1
      heavy = true
    } else if ((weapon === CAR_GUN.id || weapon === MECH_CANNON.id || weapon === HELI_GUN.id) && s.vehicle && this.fleet.byId.has(s.vehicle.id)) {
      const vehicle = this.fleet.byId.get(s.vehicle.id)!
      start = this.fleet.carMuzzle(vehicle, new THREE.Vector3())
      vehicle.gunRecoil = 1
      heavy = true
    } else if (remote.avatar.group.visible) {
      start = remote.avatar.fire()
    } else if (s.vehicle && this.fleet.byId.has(s.vehicle.id)) {
      const vehicle = this.fleet.byId.get(s.vehicle.id)!
      start = vehicle.object.localToWorld(this.seatEye(vehicle, s.vehicle.seat))
    } else {
      return
    }
    const def = WEAPONS[weapon as WeaponKind] as (typeof WEAPONS)[WeaponKind] | undefined
    const round: RoundKind = heavy ? 'bullet_heavy' : def?.round ?? 'bullet_556'
    const color = heavy ? (weapon === CAR_GUN.id ? CAR_GUN.color : weapon === MECH_CANNON.id ? MECH_CANNON.color : weapon === HELI_GUN.id ? HELI_GUN.color : MACHINE_GUN.color) : def?.color ?? 0xffd27a
    const dir = end.clone().sub(start)
    const distance = dir.length()
    dir.normalize()
    this.projectiles.round(round, start, end, color)
    this.projectiles.muzzleFlash(start, dir, heavy ? 1.6 : 0.7)
    this.audio.shot(SHOT_SOUND[weapon] ?? 'rifle', start)
    // Re-trace the last stretch here to find the surface it struck
    const hit = new THREE.Raycaster(start, dir, 0.3, distance + 1).intersectObjects(this.targetList, true)[0]
    if (hit && hit.distance > distance - 1.5) this.applyImpact(hit, dir, heavy || (def?.power ?? 0) >= 40)
  }

  /** A face normal from a hit, in world space and facing the shooter. */
  private hitNormal(hit: THREE.Intersection, dir: THREE.Vector3) {
    if (!hit.face) return dir.clone().negate()
    const matrix = hit.object.matrixWorld.clone()
    const instanced = hit.object as THREE.InstancedMesh
    if (instanced.isInstancedMesh && hit.instanceId !== undefined) {
      const m = new THREE.Matrix4()
      instanced.getMatrixAt(hit.instanceId, m)
      matrix.multiply(m)
    }
    const normal = hit.face.normal.clone().transformDirection(matrix)
    return normal.dot(dir) > 0 ? normal.negate() : normal
  }

  /** Where a round really meets a base's buildings (its bullets hit simplified boxes; holes belong on the walls). */
  private baseSurface(base: THREE.Object3D, origin: THREE.Vector3, dir: THREE.Vector3, far: number) {
    const ray = new THREE.Raycaster(origin, dir, 0, far)
    const hits: THREE.Intersection[] = []
    for (const child of base.children) {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) continue
      THREE.Mesh.prototype.raycast.call(mesh, ray, hits)
    }
    hits.sort((a, b) => a.distance - b.distance)
    return hits[0] ?? null
  }

  /**
   * What a round did where it struck: dirt kicked up from the ground, chips off rock, concrete dust off walls,
   * splinters off trees, sparks off vehicles, guns and robots — and a hole in solid surfaces (on vehicles the
   * hole rides along with them).
   */
  private applyImpact(hit: THREE.Intersection, dir: THREE.Vector3, heavy: boolean) {
    let surface: Surface = 'dirt'
    let point = hit.point.clone()
    let normal: THREE.Vector3 | null = null
    let hole = true
    let attach: THREE.Object3D | null = null
    for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
      if (node.userData.playerId) { surface = 'robot'; hole = false; break }
      // Explosive barrels: holes ride on the barrel (and go with it when it blows); sandbags just spit sand
      if (node.userData.barrelId) { surface = 'metal'; attach = node; break }
      if (node === this.outposts.blockers) { surface = 'dirt'; hole = false; break }
      const vehicleId = node.userData.vehicleId as string | undefined
      if (vehicleId) {
        surface = 'metal'
        const vehicle = this.fleet.byId.get(vehicleId)
        const real = vehicle && this.fleet.surfaceHit(vehicle, hit.point.clone().addScaledVector(dir, -3), dir, 7)
        if (real) { point = real.point; normal = real.normal.dot(dir) > 0 ? real.normal.negate() : real.normal; attach = vehicle.object } else hole = false
        break
      }
      if (node === this.turrets.group) { surface = 'metal'; hole = false; break }
      if (node === this.forest.trunks) { surface = 'wood'; hole = false; break }
      if (node === this.rocks.group) { surface = 'rock'; break }
      if (node === this.bases.blue.group || node === this.bases.red.group) {
        surface = 'concrete'
        const real = this.baseSurface(node, hit.point.clone().addScaledVector(dir, -2), dir, 5)
        if (real) { point = real.point; normal = this.hitNormal(real, dir) } else hole = false
        break
      }
      if (node === this.terrain) break
    }
    normal ??= this.hitNormal(hit, dir)
    this.projectiles.impact(point, normal, surface, heavy)
    this.audio.impact(point, surface)
    // Ground holes sit a little higher: inside a base the concrete floor lies a few centimetres over the ground
    if (hole) this.decals.add('hole', point, normal, heavy ? 0.5 : 0.24 + Math.random() * 0.06, attach, hit.object === this.terrain ? 0.07 : 0.02)
  }

  /** Another player's anti-aircraft missile, homing on a helicopter (the server decides the hit). */
  remoteMissile(id: string, target: string, from: Vec3) {
    const vehicle = this.fleet.byId.get(target)
    if (!vehicle) return
    const start = new THREE.Vector3(from[0], from[1] + 0.2, from[2])
    const remote = this.remotes.get(id)
    if (remote) remote.lastFiredAt = performance.now()
    this.audio.shot('launch', start)
    this.projectiles.missile(start, () => (vehicle.destroyed ? null : this.aimPoint(vehicle)))
  }

  /** Another player fired a tank shell or an unguided rocket: it flies there, and the server's blast follows. */
  remoteFire(id: string, kind: ProjectileKind, from: Vec3, to: Vec3) {
    const start = new THREE.Vector3(...from)
    const end = new THREE.Vector3(...to)
    const remote = this.remotes.get(id)
    if (remote) remote.lastFiredAt = performance.now()
    const dir = end.clone().sub(start).normalize()
    if (kind === 'shell') {
      const tank = remote?.target?.vehicle ? this.fleet.byId.get(remote.target.vehicle.id) : undefined
      if (tank) tank.gunRecoil = 1
      this.projectiles.shell(start, end)
      this.projectiles.muzzleFlash(start, dir, 3.5)
      this.projectiles.blastDust(new THREE.Vector3(start.x, heightAt(start.x, start.z), start.z), 3)
      this.audio.shot('cannon', start)
      return
    }
    this.projectiles.missile(start, () => end, undefined, false)
    this.audio.shot('launch', start)
  }

  /** Another player threw a grenade: fly the same throw here (the server's blast ends it). */
  remoteThrow(id: string, from: Vec3, velocity: Vec3) {
    const remote = this.remotes.get(id)
    if (remote) {
      remote.lastFiredAt = performance.now()
      remote.avatar?.throwGrenade()
    }
    this.grenades.throw(id, new THREE.Vector3(...from), new THREE.Vector3(...velocity), null)
  }

  /** The server says something blew up (it has already worked out who got hurt). */
  blast(at: [number, number | null, number], kind: BlastKind, by: string) {
    const point = new THREE.Vector3(at[0], at[1] ?? heightAt(at[0], at[2]) + 0.5, at[2])
    if (kind === 'grenade' && by !== this.match.you) this.grenades.detonate(by)
    // Our own shells, rockets and grenades already went off on our screen
    if (by === this.match.you && kind !== 'barrel') return
    this.explodeAt(point, kind)
  }

  /** An explosion here: fire and smoke, a scorch mark on the ground, a bang, and a shake if it is close. */
  /** Light up the surroundings for a moment (a blast, a muzzle flash). */
  private flashLight(at: THREE.Vector3, color: number, peak: number, seconds: number) {
    const now = performance.now()
    const slot = this.flashes.reduce((a, b) => (b.until < a.until ? b : a))
    if (slot.until > now && slot.peak > peak) return
    slot.light.position.copy(at)
    slot.light.color.setHex(color)
    slot.from = now
    slot.until = now + seconds * 1000
    slot.peak = peak
  }

  private updateFlashes() {
    const now = performance.now()
    for (const f of this.flashes) {
      const left = f.until > now ? (f.until - now) / (f.until - f.from) : 0
      f.light.intensity = f.peak * left * left
    }
  }

  private explodeAt(at: THREE.Vector3, kind: BlastKind) {
    const size = BLAST_SIZE[kind]
    this.flashLight(at.clone().setY(Math.max(at.y, heightAt(at.x, at.z) + 1.5)), 0xff9a4a, 2200 * size, 0.45 + 0.15 * size)
    const ground = heightAt(at.x, at.z)
    const low = at.y - ground < 2.5
    this.projectiles.explosion(at.clone().setY(Math.max(at.y, ground + 0.6)), size, low)
    if (low) this.decals.add('scorch', new THREE.Vector3(at.x, ground, at.z), this.groundNormal(at.x, at.z), 2.4 + size * 2.2, null, 0.08)
    if (kind === 'barrel') this.projectiles.burn(() => at, 7)
    const d = at.distanceTo(this.camera.position)
    this.shake = Math.min(1.4, this.shake + Math.max(0, 1 - d / (40 * size)) * size * 0.8)
    if (d < 12) this.nearBlast = { at: at.clone(), time: performance.now() }
    this.audio.explosion(at, size)
  }

  private groundNormal(x: number, z: number) {
    const e = 0.6
    return new THREE.Vector3(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize()
  }

  vehicleHpChanged(id: string, hp: number, max: number) {
    const vehicle = this.fleet.byId.get(id)
    if (!vehicle) return
    if (hp < vehicle.hp) this.fleet.mech(vehicle)?.flinch()
    vehicle.hp = Math.max(0, Math.min(max, hp))
    if (vehicle === this.vehicle && hp < max * 0.25 && hp > 0 && !gameState.message.startsWith('Hull critical')) {
      setGameState({ message: `Hull critical — get out of the ${label(vehicle)} before it blows!` })
    }
  }

  /** An explosive barrel went up (its bullet holes go with it) or is back. */
  barrelChanged(id: string, alive: boolean) {
    if (!alive) {
      const proxy = this.outposts.proxy(id)
      if (proxy) this.decals.clear(proxy)
    }
    this.outposts.setBarrel(id, alive)
  }

  vehicleWrecked(id: string, by: string, at: { p: Vec3; r: Vec3 } | null) {
    const vehicle = this.fleet.byId.get(id)
    if (!vehicle) return
    if (at && !vehicle.occupants.includes(this.match.you)) {
      vehicle.object.position.set(...at.p)
      vehicle.object.rotation.set(at.r[0], at.r[1], at.r[2])
    }
    const center = vehicle.kind === 'heli' ? this.aimPoint(vehicle) : vehicle.object.localToWorld(new THREE.Vector3(0, 1.4, 0))
    this.projectiles.explosion(center, 2, vehicle.kind !== 'heli')
    this.flashLight(center, 0xff8a3a, 5000, 0.8)
    this.audio.explosion(center, 2)
    const d = center.distanceTo(this.camera.position)
    this.shake = Math.min(1.4, this.shake + Math.max(0, 1 - d / 90) * 1.2)
    const p = vehicle.object.position
    this.decals.add('scorch', new THREE.Vector3(p.x, heightAt(p.x, p.z), p.z), this.groundNormal(p.x, p.z), 9, null, 0.08)
    vehicle.destroyed = true
    vehicle.hp = 0
    if (this.vehicle === vehicle) {
      this.transition = null
      this.leaveVehicle()
    }
    vehicle.occupants.fill(null)
    this.projectiles.burn(() => (vehicle.destroyed ? vehicle.object.position.clone().add(new THREE.Vector3(0, 1.5, 0)) : null), 30)
    if (this.lock.target === vehicle) this.lock = { target: null, time: 0 }
    const byName = by === this.match.you ? 'You' : this.nameOf(by)
    setGameState({ message: vehicle.kind === 'heli' ? `${byName} shot down a helicopter!` : `${byName} destroyed a ${label(vehicle)}!` })
  }

  vehicleRepaired(id: string) {
    const vehicle = this.fleet.byId.get(id)
    if (!vehicle) return
    vehicle.occupants.fill(null)
    this.decals.clear(vehicle.object)
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
    for (const vehicle of this.fleet.vehicles) vehicle.hp = world.vehicleHp[vehicle.id] ?? VEHICLE_MAX_HP[vehicle.kind]
    for (const id of world.wrecks) {
      const vehicle = this.fleet.byId.get(id)
      if (vehicle) vehicle.destroyed = true
    }
    for (const barrel of world.barrels) this.outposts?.setBarrel(barrel.id, barrel.alive)
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
    if (took.weapon || took.count > 0) this.audio.ui('pickup')
    const name = itemLabel(took.kind)
    if (took.weapon && isWeaponItem(took.kind)) {
      if (this.arsenal.inSlotOf(took.kind)) return
      this.arsenal.give(took.kind, took.mag)
      this.arsenal.addReserve(WEAPONS[took.kind].ammo, took.count)
      const def = WEAPONS[took.kind]
      setGameState({ message: took.kind === 'launcher' ? 'AA launcher picked up. Load it with missiles from the crates, lock on to an enemy aircraft for 2 s, fire!' : `Picked up the ${name}${def.scope ? ' — right mouse for the scope' : ''}.` })
      return
    }
    if (took.count <= 0) {
      setGameState({ message: `Nothing left to take (${name}).` })
      return
    }
    const ammo = ammoOf(took.kind)
    this.arsenal.addReserve(ammo, took.count)
    // A weapon waiting for rounds (a launcher for its first missile) loads straight away
    if (this.arsenal.def?.ammo === ammo && this.arsenal.mag === 0) this.arsenal.reload()
    setGameState({ message: ammo === 'missile' ? `Took ${took.count} AA missile${took.count > 1 ? 's' : ''}.` : `Took ${took.count} ${AMMO[ammo].name}.` })
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
    this.throwTimer = 0
    this.pendingHijack = null
    this.leaveTurret()
    this.leaveVehicle()
    // What we carried is on the ground where we fell (the server dropped it); we respawn with fresh guns
    this.arsenal.clear()
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

  /** Lower settings: the sun's shadow box follows the camera. The sky dome stays centred on it. */
  private updateShadowArea() {
    this.sky.follow(this.camera.position)
    this.sky.update(this.camera)
  }

  /** Is the camera in sunlight? (Hills, buildings and rocks between it and the sun put it in shade.) */
  private inSunlight() {
    const eye = this.camera.position
    for (let d = 4; d < 320; d += 4) {
      const x = eye.x + SUN_DIRECTION.x * d, y = eye.y + SUN_DIRECTION.y * d, z = eye.z + SUN_DIRECTION.z * d
      if (heightAt(x, z) > y) return false
      if (y > 60) break
    }
    this.shadeRay.set(eye, SUN_DIRECTION)
    this.shadeRay.far = 80
    return this.shadeRay.intersectObjects([this.ourBase.group, this.enemyBase.group, this.rocks.group], true).length === 0
  }

  /** Graphics settings (Ultra / High / Medium / Low), applied straight away and remembered. */
  setQuality(quality: Quality) {
    if (quality === this.graphics.quality) return
    saveQuality(quality)
    this.graphics.setQuality(quality)
    this.sky.setProfile(PROFILES[quality])
    this.plantGrass(PROFILES[quality])
    setGameState({ quality })
  }

  /** Blade-by-blade grass round the camera (or, on Low, the lighter grass clumps). */
  private plantGrass(profile: QualityProfile) {
    if (this.blades) {
      this.scene.remove(this.blades.mesh)
      this.blades.dispose()
      this.blades = null
    }
    if (profile.grassBlades > 0) {
      this.blades = createGrassBlades(profile.grassBlades, profile.grassRadius, this.groundMap.texture)
      this.scene.add(this.blades.mesh)
      if (this.grass) this.grass.group.visible = false
    } else {
      this.grass ??= createGrass(this.noGrass)
      if (!this.grass.group.parent) this.scene.add(this.grass.group)
      this.grass.group.visible = true
    }
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

  /**
   * Map a raycast hit back to what it struck and report it; the server applies the damage. Enemy players; a
   * vehicle's hull and the enemies inside (the pilot / driver first — a tank shrugs bullets off, and a
   * teammate's ride is left alone); explosive barrels.
   */
  private reportHit(object: THREE.Object3D, weapon: string) {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const playerId = node.userData.playerId as string | undefined
      if (playerId) {
        const remote = this.remotes.get(playerId)
        if (remote && remote.info.team !== this.team && !remote.info.dead) this.match.net.sendHit(weapon, { target: playerId })
        return
      }
      const barrelId = node.userData.barrelId as string | undefined
      if (barrelId) {
        if (this.outposts.alive(barrelId)) this.match.net.sendHit(weapon, { barrel: barrelId })
        return
      }
      const vehicleId = node.userData.vehicleId as string | undefined
      if (vehicleId) {
        const vehicle = this.fleet.byId.get(vehicleId)
        if (!vehicle || vehicle.destroyed || vehicle.kind === 'tank') return
        const aboard = vehicle.occupants.filter((id): id is string => !!id && id !== this.match.you)
        const friends = aboard.some((id) => this.teamOf(id) === this.team)
        const victim = aboard.find((id) => this.teamOf(id) !== this.team && !this.remotes.get(id)?.info.dead)
        if (friends && !victim) return
        this.match.net.sendHit(weapon, { ...(friends ? {} : { vehicle: vehicleId }), ...(victim ? { target: victim } : {}) })
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
    obstacles.push(...this.fleet.circles(this.vehicle), ...this.outposts.barrelCircles())
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
        ? {
          id: vehicle.id, seat: this.seat, p: [pose.position.x, pose.position.y, pose.position.z], r: [pose.rotation.x, pose.rotation.y, pose.rotation.z],
          spin: vehicle.kind === 'heli' ? vehicle.spin : this.carSpeed,
          ...((vehicle.kind === 'heli' ? this.seat === 1 : this.seat === 0) ? { aim: [vehicle.aimYaw, vehicle.aimPitch] as [number, number] } : {}),
        }
        : null,
      gun: t ? { id: t.id, yaw: t.yaw, pitch: t.pitch } : null,
      w: this.arsenal.kind ?? '',
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
      remote.avatar.setWeapon(s.gun || s.vehicle ? null : (s.w || null))
      if (avatar.visible) remote.avatar.update(dt, remote.speed, s.pitch, distance, feet.y - heightAt(feet.x, feet.z) > 0.45)
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
    // The gunner of a helicopter works its nose gun
    if (claimed.kind === 'heli' && seat === 1 && s.vehicle.aim && !(claimed === this.vehicle && this.seat === 1)) {
      claimed.aimYaw = lerpAngle(claimed.aimYaw, s.vehicle.aim[0], k)
      claimed.aimPitch = THREE.MathUtils.lerp(claimed.aimPitch, s.vehicle.aim[1], k)
    }
    if (seat !== 0 || claimed === this.vehicle) return
    const pose = claimed.object
    const target = new THREE.Vector3(...s.vehicle.p)
    claimed.targetSpin = s.vehicle.spin
    if (s.vehicle.aim) {
      claimed.aimYaw = lerpAngle(claimed.aimYaw, s.vehicle.aim[0], k)
      claimed.aimPitch = THREE.MathUtils.lerp(claimed.aimPitch, s.vehicle.aim[1], k)
    }
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
      // Browsers only let a page make sound once the player has done something
      this.audio.unlock()
    })

    add(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.renderer.domElement
      if (!locked) {
        for (const key of Object.keys(this.input) as Array<keyof typeof this.input>) this.input[key] = false
        this.mouse.shooting = false
        this.mouse.aiming = false
      }
    })

    add(document, 'mousemove', ((e: MouseEvent) => {
      if (document.pointerLockElement !== this.renderer.domElement) return
      // Subtle freelook while piloting; finer aim when zoomed in
      const scale = (this.vehicle?.kind === 'heli' && this.seat === 0 ? 0.5 : 1) / this.zoom
      this.player.look(e.movementX * scale, e.movementY * scale)
    }) as EventListener)

    add(document, 'mousedown', ((e: MouseEvent) => {
      if (e.button === 0) this.mouse.shooting = true
      if (e.button === 2) this.mouse.aiming = true
    }) as EventListener)
    add(document, 'mouseup', ((e: MouseEvent) => {
      if (e.button === 0) this.mouse.shooting = false
      if (e.button === 2) this.mouse.aiming = false
    }) as EventListener)
    add(this.renderer.domElement, 'contextmenu', ((e: MouseEvent) => e.preventDefault()) as EventListener)

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
        case 'KeyQ':
          if (!e.repeat) this.throwGrenade()
          break
      }
      this.audio.unlock()
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
      this.graphics.setSize(w, h)
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
      const weaponItem = isWeaponItem(item.kind)
      const ammo = ammoOf(item.kind)
      if (isWeaponItem(item.kind) && !this.arsenal.has(item.kind)) {
        // One weapon per slot: the one we hold there goes down first (with its rounds)
        const held = this.arsenal.inSlotOf(item.kind)
        if (held) {
          const dropped = this.arsenal.remove(WEAPONS[item.kind].slot)!
          this.match.net.sendDrop(dropped.kind, dropped.mag, dropped.spare)
        }
        this.pendingTake = item.id
        this.match.net.sendTake(item.id, 'weapon', this.arsenal.space(ammo))
        window.setTimeout(() => { if (this.pendingTake === item.id) this.pendingTake = null }, 2000)
        return
      }
      const want = this.arsenal.space(ammo)
      if (want <= 0) {
        setGameState({ message: `You can't carry any more ${AMMO[ammo].name}.` })
        return
      }
      if (item.count + (weaponItem ? item.mag : 0) <= 0) {
        setGameState({ message: `The ${itemLabel(item.kind)} is empty.` })
        return
      }
      this.pendingTake = item.id
      this.match.net.sendTake(item.id, 'ammo', want)
      window.setTimeout(() => { if (this.pendingTake === item.id) this.pendingTake = null }, 2000)
      return
    }
    const slot = this.arsenal.current
    if (!slot) return
    const dropped = this.arsenal.remove(slot)
    if (!dropped) return
    this.match.net.sendDrop(dropped.kind, dropped.mag, dropped.spare)
    setGameState({ message: `Dropped your ${WEAPONS[dropped.kind].name}.` })
  }

  private pickupPrompt(): string {
    if (!this.onFoot) return ''
    const item = this.items.nearest(this.feet())
    if (!item) return ''
    const name = itemLabel(item.kind)
    if (isWeaponItem(item.kind)) {
      if (this.arsenal.has(item.kind)) return `Take ${item.kind === 'launcher' ? 'its missiles' : 'its rounds'} (${item.count + item.mag})`
      const held = this.arsenal.inSlotOf(item.kind)
      return held ? `Swap your ${WEAPONS[held.kind].name} for the ${name}` : `Pick up the ${name}`
    }
    if (ammoOf(item.kind) === 'missile') return item.count > 0 ? `Take AA missiles (${item.count} left)` : 'Missile crate (empty)'
    return item.count > 0 ? `Take ${name} (${item.count})` : `${name} box (empty)`
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
    if (this.enemiesAboard(vehicle).length) {
      // Enemies inside: pull them out if it's standing still on the ground, and take it
      if (!this.grounded(vehicle)) {
        setGameState({ message: vehicle.kind === 'heli' ? 'The enemy is flying it — shoot it down or wait for it to land.' : `The enemy is driving that ${label(vehicle)} — stop it first.` })
        return
      }
      if (this.pendingHijack && this.pendingHijack.until > performance.now()) return
      this.pendingHijack = { vehicle, until: performance.now() + 2000 }
      this.match.net.sendHijack(vehicle.id)
      setGameState({ message: `Pulling the enemy out of the ${label(vehicle)}…` })
      return
    }
    const seat = vehicle.occupants.findIndex((o) => o === null)
    if (seat < 0) {
      setGameState({ message: vehicle.kind === 'heli' ? 'That helicopter is full.' : `That ${label(vehicle)} is being driven by ${this.nameOf(driverOf(vehicle)!)}.` })
      return
    }
    this.enterVehicle(vehicle, seat)
  }

  /** Enemy players sitting in a vehicle. */
  private enemiesAboard(vehicle: Vehicle) {
    return vehicle.occupants.filter((id): id is string => !!id && id !== this.match.you && this.teamOf(id) !== this.team && !this.remotes.get(id)?.info.dead)
  }

  /** Standing still on the ground (a helicopter landed, a car or tank not driving off). */
  private grounded(vehicle: Vehicle) {
    const p = vehicle.object.position
    if (vehicle.kind === 'heli') return p.y - this.fleet.restHeight(vehicle, p.x, p.z) < 1.5
    if (vehicle.kind === 'mech') return p.y - heightAt(p.x, p.z) < MECH_AIRBORNE && Math.abs(vehicle.spin) < 4
    return Math.abs(vehicle.spin) < 4
  }

  /** The server pulled the enemies out (or not): climb in. */
  hijackAnswer(vehicleId: string, ok: boolean, reason: string) {
    const pending = this.pendingHijack
    if (!pending || pending.vehicle.id !== vehicleId) return
    this.pendingHijack = null
    const vehicle = pending.vehicle
    if (!ok) {
      const why: Record<string, string> = {
        moving: `The ${label(vehicle)} is moving — stop it first.`,
        far: `Get closer to the ${label(vehicle)}.`,
        locked: 'You were just pulled out of it — give it a moment.',
        wreck: `That ${label(vehicle)} is a burnt-out wreck.`,
      }
      setGameState({ message: why[reason] ?? `You can't take that ${label(vehicle)} right now.` })
      return
    }
    if (!this.onFoot || vehicle.destroyed) return
    // The pilot's / driver's seat if it is free now, else the first free one
    const seat = vehicle.occupants[0] === null ? 0 : vehicle.occupants.findIndex((o) => o === null)
    if (seat < 0) return
    this.enterVehicle(vehicle, seat)
  }

  /** Someone pulled the enemies out of a vehicle: their seats are empty now. */
  vehicleHijacked(vehicleId: string, by: string, victims: string[]) {
    const vehicle = this.fleet.byId.get(vehicleId)
    if (!vehicle) return
    for (const id of victims) {
      const seat = vehicle.occupants.indexOf(id)
      if (seat >= 0) vehicle.occupants[seat] = null
      const remote = this.remotes.get(id)
      if (remote?.target) remote.target = { ...remote.target, vehicle: null }
    }
    if (by === this.match.you) {
      setGameState({ message: `You pulled ${victims.map((id) => this.nameOf(id)).join(' and ')} out — the ${label(vehicle)} is yours!` })
    } else if (this.teamOf(by) === this.team && !victims.includes(this.match.you)) {
      setGameState({ message: `${this.nameOf(by)} took an enemy ${label(vehicle)}!` })
    }
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
    const enemies = this.enemiesAboard(vehicle)
    if (enemies.length) {
      if (!this.grounded(vehicle)) return vehicle.kind === 'heli' ? 'Enemy helicopter in the air — shoot it down' : `Enemy ${label(vehicle)} on the move`
      return `Pull ${this.nameOf(enemies[0])}${enemies.length > 1 ? ` and ${enemies.length - 1} more` : ''} out and take the ${label(vehicle)}`
    }
    const seat = vehicle.occupants.findIndex((o) => o === null)
    if (seat < 0) return vehicle.kind === 'heli' ? 'Helicopter (full)' : `${label(vehicle)[0].toUpperCase()}${label(vehicle).slice(1)} (taken)`
    if (vehicle.kind === 'car') return 'Drive battle car'
    if (vehicle.kind === 'tank') return 'Drive tank'
    if (vehicle.kind === 'mech') return 'Pilot the combat mech'
    return seat === 0 ? 'Fly helicopter (pilot seat)' : seat === 1 ? 'Board helicopter (gunner — nose gun)' : 'Board helicopter (door gunner — your own weapons)'
  }

  /** Eye position of a seat, in the vehicle's local space (a tank's gunner sight turns with the turret). */
  private seatEye(vehicle: Vehicle, seat: number) {
    if (vehicle.kind === 'heli') return this.fleet.heliSeats[seat].eye.clone()
    if (vehicle.kind === 'tank') return TANK_SIGHT.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.aimYaw).add(TANK_TURRET_PIVOT)
    if (vehicle.kind === 'mech') {
      // The cockpit rides on the torso (it twists and bobs as the mech walks)
      const rig = this.fleet.mech(vehicle)
      if (!rig) return new THREE.Vector3(0, 6.5, 1.7)
      vehicle.object.updateMatrixWorld()
      return vehicle.object.worldToLocal(rig.cockpit(new THREE.Vector3()))
    }
    return CAR_GUNNER_SEAT.clone()
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
          : seat === 1 ? 'Gunner seat: the nose gun follows your aim — LMB fires. E to get out.' : 'Door gunner: lean out of the cabin door — aim with the mouse and shoot. E to get out.',
      })
    } else if (vehicle.kind === 'mech') {
      this.carSpeed = 0
      vehicle.targetSpin = 0
      this.mechVy = 0
      this.mechJet = 1
      this.cameraMode = 'chase'
      this.player.yaw = yaw + vehicle.aimYaw + Math.PI
      this.mechSalvo = { left: MECH_SALVO, next: 0, reloadUntil: performance.now() + 1200 }
      setGameState({ vehicle: 'mech', seat: 0, message: 'COMBAT MECH: W/S walk (Shift runs), A/D turn, SPACE jump-jets — the torso follows your aim. LMB autocannon, RMB rocket salvo, V cockpit view, E to get out.' })
    } else if (vehicle.kind === 'tank') {
      this.carSpeed = 0
      vehicle.targetSpin = 0
      this.cameraMode = 'chase'
      // Look where the turret points
      this.player.yaw = yaw + vehicle.aimYaw + Math.PI
      this.cannonCooldown = Math.max(this.cannonCooldown, 1)
      setGameState({ vehicle: 'tank', seat: 0, message: 'TANK: W/S drive, A/D turn the hull, the turret follows your aim. LMB fires the cannon (3 s reload), V gunner sight, E to get out.' })
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
    const side = vehicle.kind === 'tank' ? 4 : vehicle.kind === 'mech' ? 4.2 : 3.6
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
      // A car rolls on; a tank's tracks stop it where it is
      if (vehicle.kind === 'car') vehicle.spin = this.carSpeed
      if (vehicle.kind === 'tank' || vehicle.kind === 'mech') vehicle.spin = 0
    }
    this.carSpeed = 0
    this.seat = 0
    vehicle.hitbox.traverse((node) => node.layers.set(0))
    this.camera.rotation.order = 'YXZ'
    setGameState({ vehicle: null, seat: 0, rotorRpm: 0, speedKmh: 0, cannon: -1, gunX: -1, gunY: -1, tankSight: false })
    this.publishRoster()
  }

  /** The server says we have to leave: someone got into this seat first, it was shot down, or `by` pulled us out. */
  ejectFrom(vehicleId: string, by: string | null = null, reason = 'taken') {
    if (this.vehicle?.id !== vehicleId) return
    this.transition = null
    const vehicle = this.vehicle
    const seat = this.seat
    this.leaveVehicle()
    // Out through our own door (a helicopter) or beside it
    const local = vehicle.kind === 'heli' ? this.fleet.heliSeats[seat].outside.clone().setY(0).multiplyScalar(1.2) : new THREE.Vector3(vehicle.kind === 'tank' ? 4 : vehicle.kind === 'mech' ? 4.2 : 3.5, 0, 0)
    const spot = vehicle.object.localToWorld(local)
    this.player.position.set(spot.x, Math.max(vehicle.object.position.y, heightAt(spot.x, spot.z)) + EYE_HEIGHT, spot.z)
    this.player.velocity.set(0, 0, 0)
    this.player.pitch = 0
    const why = reason === 'locked' ? `You were just pulled out of that ${label(vehicle)} — give it a moment.` : reason === 'wreck' ? `That ${label(vehicle)} is a wreck.` : 'Someone else got into that seat first.'
    setGameState({ message: by ? `${this.nameOf(by)} pulled you out of the ${label(vehicle)}!` : why })
  }

  private cycleVehicleCamera() {
    if (!this.vehicle || this.seat !== 0 || this.transition) return
    this.cameraMode = this.cameraMode === 'inside' ? 'chase' : 'inside'
    const inside = this.vehicle.kind === 'heli' || this.vehicle.kind === 'mech' ? 'COCKPIT VIEW' : this.vehicle.kind === 'tank' ? 'GUNNER SIGHT' : 'ROOF GUN'
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
      else if (vehicle.kind === 'tank') this.updateTank(vehicle, dt)
      else if (vehicle.kind === 'mech') this.updateMech(vehicle, dt)
      else this.updateCar(vehicle, dt)
    }
    // The camera turns with the vehicle and the mouse looks around on top of that (a tank's turret doesn't
    // turn with its hull: the view stays where you aim)
    const yaw = vehicle.object.rotation.y
    if (vehicle.kind !== 'tank' && vehicle.kind !== 'mech') this.player.yaw += wrap(yaw - this.lastVehicleYaw)
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
      // Chase camera orbits the car / tank / mech with the mouse
      const tank = vehicle.kind === 'tank', mech = vehicle.kind === 'mech'
      const pitch = THREE.MathUtils.clamp(this.player.pitch, -0.9, 0.3)
      this.player.pitch = pitch
      const target = vehicle.object.position.clone().add(new THREE.Vector3(0, mech ? 7.5 : tank ? 4 : 2.6, 0))
      const forward = new THREE.Vector3(-Math.sin(this.player.yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(this.player.yaw) * Math.cos(pitch))
      const eye = target.addScaledVector(forward, mech ? -17 : tank ? -15.5 : -11)
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

  /**
   * Tank: W/S drive (slow to get going, quick to stop), A/D turn the hull on its tracks — on the spot too.
   * It follows the ground and stops against trees, rocks, walls and other vehicles.
   */
  private updateTank(tank: Vehicle, dt: number) {
    const throttle = (this.input.forward ? 1 : 0) - (this.input.back ? 1 : 0)
    const turnInput = (this.input.left ? 1 : 0) - (this.input.right ? 1 : 0)
    const toward = (value: number, target: number, step: number) => (value > target ? Math.max(target, value - step) : Math.min(target, value + step))
    let speed = this.carSpeed
    if (this.input.jump) speed = toward(speed, 0, TANK_BRAKE * dt)
    else if (throttle > 0) speed = speed < -0.2 ? toward(speed, 0, TANK_BRAKE * dt) : speed + TANK_ACCEL * (1 - 0.4 * Math.max(0, speed) / TANK_MAX_SPEED) * dt
    else if (throttle < 0) speed = speed > 0.2 ? toward(speed, 0, TANK_BRAKE * dt) : speed - TANK_ACCEL * 0.7 * dt
    else speed = toward(speed, 0, TANK_BRAKE * 0.45 * dt)
    // Uphill slows it, downhill helps a little
    speed += 9.8 * Math.sin(tank.object.rotation.x) * 0.35 * dt
    speed = THREE.MathUtils.clamp(speed, -TANK_REVERSE_SPEED, TANK_MAX_SPEED)
    const turn = turnInput * TANK_TURN * (1 - 0.3 * Math.min(1, Math.abs(speed) / TANK_MAX_SPEED)) * dt
    const yaw = tank.object.rotation.y + turn
    const x = tank.object.position.x + Math.sin(yaw) * speed * dt
    const z = tank.object.position.z + Math.cos(yaw) * speed * dt
    if (this.carBlocked(tank, x, z, yaw)) {
      speed = -speed * 0.15
      const here = tank.object.position
      if (!this.carBlocked(tank, here.x, here.z, yaw)) {
        // Can't go on, but it can still turn where it stands
        tank.object.rotation.y = yaw
      } else if (this.carBlocked(tank, here.x, here.z, tank.object.rotation.y) && !this.carBlocked(tank, x, z, yaw, false)) {
        // Something moved into us: let it drive out
        here.set(x, here.y, z)
        tank.object.rotation.y = yaw
      }
    } else {
      tank.object.position.set(x, tank.object.position.y, z)
      tank.object.rotation.y = yaw
    }
    this.carSpeed = speed
    tank.spin = speed
    this.carGroundPose(tank)
    setGameState({ speedKmh: Math.round(Math.abs(speed) * 3.6) })
  }

  /**
   * Combat mech: W/S walk (Shift runs, S backs up), A/D turn on the spot or on the move, SPACE fires the
   * jump-jets (a few seconds of fuel that refills on the ground). Stops against trees, rocks, walls and vehicles;
   * a hard landing shakes the view.
   */
  private updateMech(mech: Vehicle, dt: number) {
    const throttle = (this.input.forward ? 1 : 0) - (this.input.back ? 1 : 0)
    const turnInput = (this.input.left ? 1 : 0) - (this.input.right ? 1 : 0)
    const p = mech.object.position
    const ground = heightAt(p.x, p.z)
    const airborne = p.y - ground > 0.05 || this.mechVy > 0
    const target = throttle > 0 ? (this.input.sprint ? MECH_RUN : MECH_WALK) : throttle < 0 ? -MECH_BACK : 0
    // Legs can't change pace in the air: it keeps its momentum
    let speed = this.carSpeed
    if (!airborne) speed += THREE.MathUtils.clamp(target - speed, -MECH_ACCEL * 1.6 * dt, MECH_ACCEL * dt)
    const yaw = mech.object.rotation.y + turnInput * MECH_TURN * (airborne ? 0.5 : 1) * dt
    // Jump-jets
    if (this.input.jump && this.mechJet > 0.02) {
      this.mechVy += MECH_JET_THRUST * dt
      this.mechJet = Math.max(0, this.mechJet - dt / MECH_JET_TIME)
    } else if (!airborne) {
      this.mechJet = Math.min(1, this.mechJet + MECH_JET_REFILL * dt)
    }
    if (airborne || this.mechVy > 0) this.mechVy -= MECH_GRAVITY * dt
    this.mechVy = THREE.MathUtils.clamp(this.mechVy, -35, 10)
    let x = p.x + Math.sin(yaw) * speed * dt
    let z = p.z + Math.cos(yaw) * speed * dt
    if (this.carBlocked(mech, x, z, yaw)) {
      speed = -speed * 0.1
      x = p.x
      z = p.z
    }
    let y = p.y + this.mechVy * dt
    const groundThere = heightAt(x, z)
    if (y <= groundThere) {
      if (this.mechVy < -9) {
        // Hard landing
        this.shake = Math.min(1.2, this.shake + Math.min(1, -this.mechVy / 25))
        this.audio.explosion(new THREE.Vector3(x, groundThere, z), 0.35)
        this.projectiles.blastDust(new THREE.Vector3(x, groundThere, z), 4)
      }
      y = groundThere
      this.mechVy = 0
    }
    p.set(x, y, z)
    mech.object.rotation.set(0, yaw, 0)
    this.carSpeed = speed
    mech.spin = speed
    // Footfalls: a thud and a little shake at every step
    if (!airborne && Math.abs(speed) > 0.4) {
      this.mechStep += Math.abs(speed) * dt
      if (this.mechStep > MECH_STRIDE) {
        this.mechStep = 0
        this.audio.impact(new THREE.Vector3(x, groundThere, z), 'dirt')
        this.shake = Math.min(0.5, this.shake + 0.12)
      }
    }
    setGameState({ speedKmh: Math.round(Math.abs(speed) * 3.6), jet: Math.round(this.mechJet * 50) / 50 })
  }

  /**
   * The mech's weapons: the torso turns towards whatever the crosshair is on (the gun arm follows it up and down),
   * LMB fires the arm autocannon (heavy rounds, fast), RMB lets go a salvo of rockets from the shoulder pods.
   */
  private updateMechGun(mech: Vehicle, dt: number) {
    const rig = this.fleet.mech(mech)
    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const view = this.camera.getWorldDirection(new THREE.Vector3())
    const targets = this.shootTargets()
    const now = performance.now()
    if (now - this.mechAim.at > 70 || this.mouse.shooting) {
      const sight = new THREE.Raycaster(origin, view, 4, MECH_CANNON.range).intersectObjects(targets, true)[0]
      this.mechAim.distance = sight?.distance ?? MECH_CANNON.range
      this.mechAim.at = now
    }
    const aim = origin.clone().addScaledVector(view, this.mechAim.distance)
    mech.object.updateMatrixWorld()
    const local = mech.object.worldToLocal(aim.clone())
    const wantYaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -MECH_TWIST_LIMIT, MECH_TWIST_LIMIT)
    const wantPitch = THREE.MathUtils.clamp(Math.atan2(local.y - MECH_AIM_HEIGHT, Math.max(2, Math.hypot(local.x, local.z))), -MECH_PITCH.down, MECH_PITCH.up)
    const step = MECH_TWIST_SPEED * dt
    mech.aimYaw += THREE.MathUtils.clamp(wantYaw - mech.aimYaw, -step, step)
    mech.aimPitch += THREE.MathUtils.clamp(wantPitch - mech.aimPitch, -step, step)
    const salvo = this.mechSalvo
    if (salvo.left === 0 && now > salvo.reloadUntil) salvo.left = MECH_SALVO
    setGameState({ cannon: salvo.left > 0 ? 1 : Math.round((1 - (salvo.reloadUntil - now) / (MECH_SALVO_RELOAD * 1000)) * 50) / 50 })
    if (!rig) return

    // Autocannon: from the arm's muzzle straight at what the crosshair is on
    this.mechGunCooldown = Math.max(0, this.mechGunCooldown - dt)
    if (this.mouse.shooting && this.mechGunCooldown <= 0) {
      this.mechGunCooldown = MECH_CANNON.fireRate
      const muzzle = new THREE.Vector3(), barrel = new THREE.Vector3()
      rig.gun(muzzle, barrel)
      const dir = aim.clone().sub(muzzle).normalize()
      dir.add(new THREE.Vector3((Math.random() - 0.5) * MECH_CANNON.spread, (Math.random() - 0.5) * MECH_CANNON.spread, (Math.random() - 0.5) * MECH_CANNON.spread)).normalize()
      const hits = new THREE.Raycaster(muzzle.clone().addScaledVector(dir, 0.5), dir, 0, MECH_CANNON.range).intersectObjects(targets, true)
      const end = hits[0]?.point.clone() ?? muzzle.clone().addScaledVector(dir, MECH_CANNON.range)
      this.projectiles.round('bullet_heavy', muzzle, end, MECH_CANNON.color)
      this.projectiles.muzzleFlash(muzzle, dir, 1.8)
      this.audio.shot('heavy', null)
      this.ejectCasing('bullet_heavy', muzzle.clone().addScaledVector(barrel, -1.4), dir)
      mech.gunRecoil = 1
      this.shake = Math.min(0.35, this.shake + 0.05)
      this.match.net.sendShot([end.x, end.y, end.z], MECH_CANNON.id)
      if (hits[0]) {
        this.applyImpact(hits[0], dir, true)
        this.reportHit(hits[0].object, MECH_CANNON.id)
      }
    }

    // Rocket salvo: RMB starts it, the pods take turns until it's spent, then they reload
    if (this.mouse.aiming && salvo.left > 0 && now >= salvo.next) {
      const pod = rig.pod((MECH_SALVO - salvo.left) % 2, new THREE.Vector3())
      const spread = this.mechAim.distance * 0.025
      const to = aim.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread * 0.5, (Math.random() - 0.5) * spread))
      const ground = heightAt(to.x, to.z)
      if (to.y < ground) to.y = ground
      this.match.net.sendFire('rocket', [pod.x, pod.y, pod.z], [to.x, to.y, to.z])
      this.projectiles.missile(pod, () => to, () => this.explodeAt(to, 'rocket'), false)
      this.projectiles.muzzleFlash(pod, to.clone().sub(pod).normalize(), 2.2)
      this.audio.shot('launch', pod)
      salvo.left--
      salvo.next = now + MECH_ROCKET_GAP * 1000
      if (salvo.left === 0) salvo.reloadUntil = now + MECH_SALVO_RELOAD * 1000
    }
  }

  /**
   * The tank's turret swings round (slowly — it's heavy) to put the gun on whatever the crosshair is on; the
   * HUD shows where the gun really points. LMB fires a shell down the barrel: it flies at 260 m/s and blows
   * up where it lands (the server does the damage), with a kick that rocks the view.
   */
  private updateTankGun(tank: Vehicle, dt: number) {
    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const view = this.camera.getWorldDirection(new THREE.Vector3())
    const targets = this.shootTargets()
    // What the crosshair is on (the long rays through the terrain are costly: a dozen times a second is plenty)
    const now = performance.now()
    const fire = this.mouse.shooting && this.cannonCooldown - dt <= 0
    if (fire || now - this.tankAim.at > 70) {
      const sight = new THREE.Raycaster(origin, view, 3, SHELL_RANGE).intersectObjects(targets, true)[0]
      this.tankAim.distance = sight?.distance ?? SHELL_RANGE
      this.tankAim.at = now
    }
    const aim = origin.clone().addScaledVector(view, this.tankAim.distance)
    tank.object.updateMatrixWorld()
    // Relative to the turret's turning axis; the trunnions sit (TANK_GUN_PIVOT.z - axis) ahead of it
    const local = tank.object.worldToLocal(aim.clone()).sub(TANK_TURRET_PIVOT)
    const wantYaw = Math.atan2(local.x, local.z)
    const flat = Math.max(1, Math.hypot(local.x, local.z) - (TANK_GUN_PIVOT.z - TANK_TURRET_PIVOT.z))
    const wantPitch = THREE.MathUtils.clamp(Math.atan2(local.y - TANK_GUN_PIVOT.y, flat), -TANK_GUN_PITCH.down, TANK_GUN_PITCH.up)
    const yawStep = TANK_TURRET_SPEED * dt, pitchStep = TANK_PITCH_SPEED * dt
    tank.aimYaw = wrap(tank.aimYaw + THREE.MathUtils.clamp(wrap(wantYaw - tank.aimYaw), -yawStep, yawStep))
    tank.aimPitch += THREE.MathUtils.clamp(wantPitch - tank.aimPitch, -pitchStep, pitchStep)

    // Where the barrel points now: the HUD marks it
    const muzzle = new THREE.Vector3(), dir = new THREE.Vector3()
    this.fleet.gunRay(tank, muzzle, dir)
    if (fire || now - this.tankAim.gunAt > 70) {
      const hit = new THREE.Raycaster(muzzle, dir, 0.5, SHELL_RANGE).intersectObjects(targets, true)[0]
      this.tankAim.gunDistance = hit?.distance ?? SHELL_RANGE
      this.tankAim.gunAt = now
    }
    const lands = muzzle.clone().addScaledVector(dir, this.tankAim.gunDistance)
    const screen = lands.clone().project(this.camera)
    const onScreen = screen.z < 1 && Math.abs(screen.x) < 1 && Math.abs(screen.y) < 1
    this.cannonCooldown = Math.max(0, this.cannonCooldown - dt)
    setGameState({
      gunX: onScreen ? Math.round(((screen.x + 1) / 2) * 400) / 400 : -1,
      gunY: onScreen ? Math.round(((1 - screen.y) / 2) * 400) / 400 : -1,
      cannon: Math.round((1 - this.cannonCooldown / TANK_RELOAD) * 50) / 50,
      tankSight: this.cameraMode === 'inside',
    })
    if (!this.mouse.shooting || this.cannonCooldown > 0) return
    this.cannonCooldown = TANK_RELOAD
    this.match.net.sendFire('shell', [muzzle.x, muzzle.y, muzzle.z], [lands.x, lands.y, lands.z])
    this.projectiles.shell(muzzle, lands, () => this.explodeAt(lands, 'shell'))
    this.projectiles.muzzleFlash(muzzle, dir, 3.5)
    this.projectiles.blastDust(new THREE.Vector3(muzzle.x, heightAt(muzzle.x, muzzle.z), muzzle.z), 3)
    this.audio.shot('cannon', null)
    tank.gunRecoil = 1
    this.shake = Math.min(1.4, this.shake + 0.55)
    this.player.pitch += 0.03
  }

  /** Would a car's or tank's footprint (two circles along its length) at (x, z, yaw) hit something? */
  private carBlocked(car: Vehicle, x: number, z: number, yaw: number, moving = true) {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return true
    const tank = car.kind === 'tank', mech = car.kind === 'mech'
    const offset = mech ? 0 : tank ? TANK_CIRCLE_OFFSET : CAR_CIRCLE_OFFSET
    const fx = Math.sin(yaw) * offset
    const fz = Math.cos(yaw) * offset
    const feet = [{ x: x + fx, z: z + fz }, { x: x - fx, z: z - fz }]
    // Deep water ahead
    if (heightAt(x + Math.sin(yaw) * (tank ? 3.8 : 3.2), z + Math.cos(yaw) * (tank ? 3.8 : 3.2)) < CAR_WATER_LIMIT) return true
    const others: Array<{ x: number; z: number; r: number }> = moving ? [...this.fleet.circles(car), ...this.outposts.barrelCircles()] : []
    if (moving) for (const remote of this.remotes.values()) {
      const avatar = remote.avatar?.group
      if (avatar?.visible && !remote.info.dead) others.push({ x: avatar.position.x, z: avatar.position.z, r: 0.45 })
    }
    const r = mech ? MECH_RADIUS : tank ? TANK_CIRCLE_RADIUS : CAR_CIRCLE_RADIUS
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

  /** Sit a car (on its wheels) or a tank (on its tracks) on the ground: height, pitch and roll from the slope under it. */
  private carGroundPose(car: Vehicle) {
    const { x, z } = car.object.position
    const yaw = car.object.rotation.y
    const cos = Math.cos(yaw), sin = Math.sin(yaw)
    const length = car.kind === 'tank' ? TANK_LENGTH * 0.8 : CAR_WHEELBASE
    const width = car.kind === 'tank' ? TANK_WIDTH * 0.75 : CAR_TRACK
    const f = length / 2, t = width / 2
    const at = (lx: number, lz: number) => heightAt(x + lx * cos + lz * sin, z - lx * sin + lz * cos)
    const fl = at(t, f), fr = at(-t, f), rl = at(t, -f), rr = at(-t, -f)
    car.object.position.y = Math.max((fl + fr + rl + rr) / 4, heightAt(x, z) - 0.15)
    car.object.rotation.x = Math.atan2((rl + rr - fl - fr) / 2, length)
    car.object.rotation.z = Math.atan2((fl + rl - fr - rr) / 2, width)
  }

  /** Vehicles nobody drives: helicopters sink to the ground (a wreck falls hard) and level out, cars sit on the ground. */
  private settleParkedVehicles(dt: number) {
    for (const vehicle of this.fleet.vehicles) {
      if (driverOf(vehicle) || (vehicle === this.vehicle && this.seat === 0)) continue
      const pose = vehicle.object
      if (vehicle.kind === 'mech') {
        // An empty mech stands upright where it was left (dropping to the ground if it was left in the air)
        vehicle.spin = 0
        pose.position.y = Math.max(heightAt(pose.position.x, pose.position.z), pose.position.y - 14 * dt)
        pose.rotation.x = pose.rotation.z = 0
        continue
      }
      if (vehicle.kind !== 'heli') {
        // A car rolls to a stop where it was left (a tank's tracks hold it)
        if (vehicle.kind === 'tank') vehicle.spin = 0
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
    this.projectiles.round('bullet_heavy', muzzle, end, MACHINE_GUN.color)
    this.projectiles.muzzleFlash(muzzle, dir, 1.8)
    this.audio.shot('mg', null)
    this.ejectCasing('bullet_heavy', muzzle.clone().addScaledVector(dir, -1.6), dir)
    turret.recoil = 1
    this.match.net.sendShot([end.x, end.y, end.z], MACHINE_GUN.id)
    if (hits[0]) {
      this.applyImpact(hits[0], dir, true)
      this.reportHit(hits[0].object, MACHINE_GUN.id)
    }
    // A heavy gun shakes the gunner
    this.player.pitch += 0.018
    this.player.yaw += (Math.random() - 0.5) * 0.01
  }

  /** A spent casing flung out to the right of a gun firing along `dir`. */
  private ejectCasing(kind: 'bullet_9mm' | 'bullet_556' | 'bullet_heavy', at: THREE.Vector3, dir: THREE.Vector3) {
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize()
    const velocity = right.multiplyScalar(2 + Math.random()).add(new THREE.Vector3(0, 2 + Math.random() * 1.2, 0)).addScaledVector(dir, -0.6)
    this.projectiles.casing(kind, at, velocity)
  }

  /**
   * The helicopter's gunner: the nose gun swings round to whatever the crosshair is on (within its arc under the
   * nose) and fires while the left button is held.
   */
  private updateHeliGun(heli: Vehicle, dt: number) {
    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const view = this.camera.getWorldDirection(new THREE.Vector3())
    const targets = this.shootTargets()
    const sight = new THREE.Raycaster(origin, view, 2, HELI_GUN.range).intersectObjects(targets, true)[0]
    const aim = sight?.point ?? origin.clone().addScaledVector(view, HELI_GUN.range)
    heli.object.updateMatrixWorld()
    const local = heli.object.worldToLocal(aim.clone()).sub(HELI_GUN_PIVOT)
    const wantYaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -HELI_GUN_LIMITS.yaw, HELI_GUN_LIMITS.yaw)
    const wantPitch = THREE.MathUtils.clamp(Math.atan2(local.y, Math.hypot(local.x, local.z)), -HELI_GUN_LIMITS.down, HELI_GUN_LIMITS.up)
    const turn = 3.2 * dt
    heli.aimYaw += THREE.MathUtils.clamp(wrap(wantYaw - heli.aimYaw), -turn, turn)
    heli.aimPitch += THREE.MathUtils.clamp(wantPitch - heli.aimPitch, -turn, turn)
    this.carGunCooldown = Math.max(0, this.carGunCooldown - dt)
    if (!this.mouse.shooting || this.carGunCooldown > 0) return
    this.carGunCooldown = HELI_GUN.fireRate
    const muzzle = this.fleet.carMuzzle(heli, new THREE.Vector3())
    const dir = aim.clone().sub(muzzle).normalize()
    dir.add(new THREE.Vector3((Math.random() - 0.5) * HELI_GUN.spread, (Math.random() - 0.5) * HELI_GUN.spread, (Math.random() - 0.5) * HELI_GUN.spread)).normalize()
    const hits = new THREE.Raycaster(muzzle.clone().addScaledVector(dir, 0.3), dir, 0, HELI_GUN.range).intersectObjects(targets, true)
    const end = hits[0]?.point.clone() ?? muzzle.clone().addScaledVector(dir, HELI_GUN.range)
    this.projectiles.round('bullet_heavy', muzzle, end, HELI_GUN.color)
    this.projectiles.muzzleFlash(muzzle, dir, 1.2)
    this.audio.shot('gatling', null)
    this.ejectCasing('bullet_heavy', muzzle.clone().addScaledVector(dir, -0.8), dir)
    heli.gunRecoil = 1
    this.match.net.sendShot([end.x, end.y, end.z], HELI_GUN.id)
    if (hits[0]) {
      this.applyImpact(hits[0], dir, true)
      this.reportHit(hits[0].object, HELI_GUN.id)
    }
  }

  /**
   * Driving a battle car: its roof gatling swings round to whatever the crosshair is on (at a turret's pace)
   * and fires heavy rounds while the left button is held. Works in the chase and the roof view.
   */
  private updateCarGun(car: Vehicle, dt: number) {
    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const view = this.camera.getWorldDirection(new THREE.Vector3())
    const targets = this.shootTargets()
    const sight = new THREE.Raycaster(origin, view, 2, CAR_GUN.range).intersectObjects(targets, true)[0]
    const aim = sight?.point ?? origin.clone().addScaledVector(view, CAR_GUN.range)
    // Where that is from the gun, in the car's own frame
    car.object.updateMatrixWorld()
    const local = car.object.worldToLocal(aim.clone())
    const wantYaw = Math.atan2(local.x - TURRET_PIVOT.x, local.z - TURRET_PIVOT.z)
    const flat = Math.hypot(local.x - TURRET_PIVOT.x, local.z - TURRET_PIVOT.z)
    const wantPitch = THREE.MathUtils.clamp(Math.atan2(local.y - GATLING_PIVOT.y, flat), -CAR_GUN_PITCH.down, CAR_GUN_PITCH.up)
    const turn = 3 * dt
    car.aimYaw += THREE.MathUtils.clamp(wrap(wantYaw - car.aimYaw), -turn, turn)
    car.aimPitch += THREE.MathUtils.clamp(wantPitch - car.aimPitch, -turn, turn)

    this.carGunCooldown = Math.max(0, this.carGunCooldown - dt)
    if (!this.mouse.shooting || this.carGunCooldown > 0) return
    this.carGunCooldown = CAR_GUN.fireRate
    const muzzle = this.fleet.carMuzzle(car, new THREE.Vector3())
    const dir = aim.clone().sub(muzzle).normalize()
    dir.add(new THREE.Vector3((Math.random() - 0.5) * CAR_GUN.spread, (Math.random() - 0.5) * CAR_GUN.spread, (Math.random() - 0.5) * CAR_GUN.spread)).normalize()
    const hits = new THREE.Raycaster(muzzle.clone().addScaledVector(dir, 0.3), dir, 0, CAR_GUN.range).intersectObjects(targets, true)
    const end = hits[0]?.point.clone() ?? muzzle.clone().addScaledVector(dir, CAR_GUN.range)
    this.projectiles.round('bullet_heavy', muzzle, end, CAR_GUN.color)
    this.projectiles.muzzleFlash(muzzle, dir, 1.3)
    this.audio.shot('gatling', null)
    this.ejectCasing('bullet_heavy', muzzle.clone().addScaledVector(dir, -1.2), dir)
    car.gunRecoil = 1
    this.match.net.sendShot([end.x, end.y, end.z], CAR_GUN.id)
    if (hits[0]) {
      this.applyImpact(hits[0], dir, true)
      this.reportHit(hits[0].object, CAR_GUN.id)
    }
  }

  /** Right mouse: aim down the sights (a little zoom), or look through a sniper's scope; a tank's gunner sight magnifies too. */
  private updateZoom(dt: number, canShoot: boolean) {
    const def = this.arsenal.def
    const sight = this.vehicle?.kind === 'tank' && this.seat === 0 && this.cameraMode === 'inside' && !this.transition
    const want = sight ? TANK_SIGHT_ZOOM : canShoot && this.mouse.aiming && def && !this.arsenal.reloading ? def.zoom : 1
    const next = THREE.MathUtils.lerp(this.zoom, want, Math.min(1, dt * 12))
    this.zoom = Math.abs(next - want) < 0.01 ? want : next
    const fov = 75 / this.zoom
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov
      this.camera.updateProjectionMatrix()
    }
    const scoped = !!def?.scope && this.zoom > def.zoom * 0.8
    if (scoped !== gameState.scoped) setGameState({ scoped })
    return scoped
  }

  // ---------------------------------------------------------------- launcher

  /** Where a missile aims on a helicopter (its cabin). */
  private aimPoint(vehicle: Vehicle) {
    return vehicle.object.localToWorld(new THREE.Vector3(0, 1.7, 0.9))
  }

  /** A helicopter with an enemy aboard (anyone may fly anyone's helicopter, so it's about who is inside). */
  private hostileAircraft(vehicle: Vehicle) {
    return vehicle.kind === 'heli' && !vehicle.destroyed && vehicle.occupants.some((id) => id && id !== this.match.you && this.teamOf(id) !== this.team && !this.remotes.get(id)?.info.dead)
  }

  /**
   * Holding the launcher on foot: keep an enemy aircraft in the sights for LOCK_TIME to lock on and the missile
   * homes on it; fire without a lock and it's an unguided rocket that flies straight (good against cars, tanks
   * and people). Returns true when the launcher is in hand (so the normal guns don't fire).
   */
  private updateLauncher(dt: number, canShoot: boolean): boolean {
    const holding = canShoot && this.arsenal.current === 'launcher' && !this.vehicle
    if (!holding) {
      if (gameState.lock !== -1) setGameState({ lock: -1, lockX: -1, lockY: -1 })
      this.lock = { target: null, time: 0 }
      this.audio.lockTone(-1, 0)
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
    this.audio.lockTone(best ? progress : -1, performance.now() / 1000)

    const locked = best && progress >= 1
    if (this.arsenal.mag <= 0 && this.mouse.shooting) {
      if (this.arsenal.reserve.missile <= 0) {
        if (!gameState.message.startsWith('No missiles')) setGameState({ message: 'No missiles: take some from the missile crates in a base.' })
      } else this.arsenal.reload()
    }
    if (!this.arsenal.fireMissile(this.mouse.shooting)) return true
    const from = origin.clone().addScaledVector(forward, 1.5)
    this.audio.shot('launch', null)
    this.lock = { target: null, time: 0 }
    if (locked) {
      const target = best!
      this.match.net.sendMissile(target.id)
      this.projectiles.missile(from, () => (target.destroyed ? null : this.aimPoint(target)))
      setGameState({ message: 'Missile away — it\'s homing on them!' })
      return true
    }
    // No lock: an unguided rocket, straight where we aim
    const hit = new THREE.Raycaster(from, forward, 0, ROCKET_RANGE).intersectObjects(this.shootTargets(), true)[0]
    const to = hit?.point ?? from.clone().addScaledVector(forward, ROCKET_RANGE)
    this.match.net.sendFire('rocket', [from.x, from.y, from.z], [to.x, to.y, to.z])
    this.projectiles.missile(from, () => to, () => this.explodeAt(to, 'rocket'), false)
    setGameState({ message: 'Rocket away! (Hold on an enemy aircraft for 2 s first for a homing missile.)' })
    return true
  }

  // ---------------------------------------------------------------- grenades

  /** [Q]: pull the pin and throw a grenade where we look (a little upwards); it goes off 2.8 s later. */
  private throwGrenade() {
    if (!this.onFoot || this.grenadeCooldown > 0) return
    if (this.arsenal.reserve.grenade <= 0) {
      setGameState({ message: 'No grenades — the grenade boxes next to your base\'s gun table have more.' })
      return
    }
    if (this.grenades.live(this.match.you) >= MAX_LIVE_GRENADES) return
    this.arsenal.reserve.grenade--
    this.grenadeCooldown = GRENADE_COOLDOWN
    this.throwTimer = THROW_TIME
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    const right = new THREE.Vector3(-dir.z, 0, dir.x).normalize()
    const from = this.camera.getWorldPosition(new THREE.Vector3()).addScaledVector(dir, 0.5).addScaledVector(right, 0.25).add(new THREE.Vector3(0, -0.1, 0))
    const velocity = dir.clone().add(new THREE.Vector3(0, 0.22, 0)).normalize().multiplyScalar(THROW_SPEED)
    velocity.x += this.player.velocity.x * 0.6
    velocity.z += this.player.velocity.z * 0.6
    this.grenades.throw(this.match.you, from, velocity, GRENADE_FUSE, (at) => {
      this.match.net.sendBlast([at.x, at.y, at.z])
      this.explodeAt(at, 'grenade')
    })
    this.match.net.sendThrow([from.x, from.y, from.z], [velocity.x, velocity.y, velocity.z])
    this.audio.ui('pin')
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

  /** Our shot: the round flies from the gun's muzzle, a casing flies out, and what it hit shows it. */
  private ownShot(shot: Shot) {
    const def = WEAPONS[shot.kind]
    const gun = this.viewmodel.fired()
    const start = gun?.muzzle ?? shot.start
    this.flashLight(start, def.round === 'bolt' ? 0x7dff90 : 0xffc070, def.power >= 40 ? 60 : 30, 0.07)
    if (def.round) this.projectiles.round(def.round, start, shot.end, def.color)
    if (gun && def.round && def.round !== 'bolt') this.ejectCasing(def.round, gun.eject, shot.dir)
    this.audio.shot(SHOT_SOUND[shot.kind] ?? 'rifle', null)
    this.match.net.sendShot([shot.end.x, shot.end.y, shot.end.z], shot.kind)
    if (shot.hit) this.applyImpact(shot.hit, shot.dir, def.power >= 40 || def.round === 'bullet_heavy')
    if (shot.object) this.reportHit(shot.object, shot.kind)
  }

  private syncHudState() {
    const def = this.arsenal.def
    const weapons = this.arsenal.carried()
    const key = weapons.join(',')
    if (key !== this.lastWeaponsKey) {
      this.lastWeaponsKey = key
      setGameState({ weapons })
    }
    const vehicle = this.vehicle
    setGameState({
      current: this.arsenal.kind,
      carGun: (vehicle?.kind === 'car' && this.seat === 0) || (vehicle?.kind === 'heli' && this.seat === 1),
      grenades: this.arsenal.reserve.grenade ?? 0,
      vehicleHp: vehicle ? Math.round((vehicle.hp / VEHICLE_MAX_HP[vehicle.kind]) * 100) / 100 : 1,
      weaponName: def?.name ?? '',
      ammo: this.arsenal.mag,
      maxAmmo: def?.magSize ?? 0,
      reserve: def ? this.arsenal.reserve[def.ammo] : 0,
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
      this.water.update(time)
      this.updateFlashes()
      this.bases.blue.gem.update(time)
      this.bases.red.gem.update(time)
      this.grass?.update(this.camera.position)
      this.blades?.update(this.camera.position, time)
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
        this.grenades.update(realDt)
        this.audio.lockTone(-1, 0)
        this.graphics.render(realDt)
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
      this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt)
      this.throwTimer = Math.max(0, this.throwTimer - dt)
      // Hand weapons: on foot and in a helicopter's passenger seats. Pilots can't shoot; car drivers use the
      // roof gatling, tank drivers the cannon.
      const canShoot = !this.dead && !this.transition && !this.turret && this.throwTimer <= 0 && (!this.vehicle || (this.vehicle.kind === 'heli' && this.seat >= 2))
      const driving = this.vehicle && this.seat === 0 && !this.transition && !this.dead ? this.vehicle : null
      if (driving?.kind === 'car') this.updateCarGun(driving, dt)
      if (driving?.kind === 'tank') this.updateTankGun(driving, dt)
      if (driving?.kind === 'mech') this.updateMechGun(driving, dt)
      if (this.vehicle?.kind === 'heli' && this.seat === 1 && !this.transition && !this.dead) this.updateHeliGun(this.vehicle, dt)
      const scoped = this.updateZoom(realDt, canShoot)
      const launcherInHand = this.updateLauncher(realDt, canShoot)
      if (canShoot && !launcherInHand) {
        const shot = this.arsenal.tryFire(this.mouse, this.shootTargets(), this.mouse.aiming ? 0.3 : 1)
        if (shot) this.ownShot(shot)
      } else if (!canShoot) {
        this.arsenal.holdTrigger(this.mouse.shooting)
      }
      this.projectiles.update(realDt)
      this.grenades.update(realDt)
      this.decals.update()
      this.updateSmoke(realDt)
      this.viewmodel.show(this.arsenal.kind)
      this.viewmodel.update(dt, {
        recoilKick: this.arsenal.shotCount !== this.lastShotCount,
        reloading: this.arsenal.reloading,
        hidden: !canShoot || scoped || gameState.finished || this.dead,
        moving: this.input.forward || this.input.back || this.input.left || this.input.right,
        aiming: this.mouse.aiming && canShoot,
        time,
      })
      this.lastShotCount = this.arsenal.shotCount
      this.syncHudState()
      this.pruneKillFeed()
      this.weaponSounds(canShoot)
      if (now - this.lastRadarAt >= 120) {
        this.lastRadarAt = now
        this.updateRadar()
      }
      if (now - this.lastShadeAt >= 250) {
        this.lastShadeAt = now
        this.graphics.viewmodelSun = this.inSunlight() ? 1 : 0.3
      }
      this.audio.setListener(this.camera)
      if (now - this.lastLoopsAt >= 100) {
        this.lastLoopsAt = now
        this.audio.updateLoops(this.loopSources())
      }

      this.render(realDt)
    }
    requestAnimationFrame(loop)
  }

  /** Draw the frame, shaken by nearby blasts (the shake only lasts for this frame's picture). */
  private render(dt: number) {
    if (this.shake < 0.01) {
      this.shake = 0
      this.graphics.render(dt)
      return
    }
    const saved = this.camera.quaternion.clone()
    const k = this.shake * this.shake * 0.05
    this.camera.rotateX((Math.random() - 0.5) * k)
    this.camera.rotateY((Math.random() - 0.5) * k)
    this.camera.rotateZ((Math.random() - 0.5) * k * 0.6)
    this.graphics.render(dt)
    this.camera.quaternion.copy(saved)
    this.shake = Math.max(0, this.shake - dt * 1.8)
  }

  /** Reloading, switching weapons and pulling the trigger on an empty gun all make their little noise. */
  private weaponSounds(canShoot: boolean) {
    const st = this.soundState
    const reloading = this.arsenal.reloading
    if (reloading && !st.reloading) this.audio.ui('reload')
    if (!reloading && st.reloading && this.arsenal.mag > st.mag) this.audio.ui('reloaded')
    if (this.arsenal.kind !== st.kind && st.kind !== null && this.arsenal.kind !== null) this.audio.ui('switch')
    const pulled = this.mouse.shooting && !st.trigger
    if (pulled && canShoot && !reloading && this.arsenal.mag === 0 && this.arsenal.def && this.arsenal.def.slot !== 'launcher') this.audio.ui('empty')
    st.reloading = reloading
    if (!reloading) st.mag = this.arsenal.mag
    st.kind = this.arsenal.kind
    st.trigger = this.mouse.shooting
  }

  /** Badly damaged vehicles trail smoke. */
  private updateSmoke(dt: number) {
    this.smokeTimer -= dt
    if (this.smokeTimer > 0) return
    this.smokeTimer = 0.12
    for (const vehicle of this.fleet.vehicles) {
      const health = vehicle.hp / VEHICLE_MAX_HP[vehicle.kind]
      if (vehicle.destroyed || health > 0.4 || vehicle.object.position.distanceToSquared(this.camera.position) > 300 ** 2) continue
      const at = vehicle.object.localToWorld(new THREE.Vector3(0, vehicle.kind === 'heli' ? 2.6 : 2, vehicle.kind === 'heli' ? -1 : -1.5))
      this.projectiles.smoke(at, health < 0.2 ? 1.4 : 0.8)
    }
  }

  /** Every running vehicle near us for the sound of rotors and engines. */
  private loopSources(): LoopSource[] {
    const sources: LoopSource[] = []
    for (const v of this.fleet.vehicles) {
      if (v.destroyed) continue
      const own = v === this.vehicle
      if (v.kind === 'heli') {
        if (v.spin > 2) sources.push({ id: v.id, kind: 'rotor', position: v.object.position.clone().add(new THREE.Vector3(0, 3, 0)), rate: v.spin / MAX_ROTOR_RPM, own })
        continue
      }
      if (!own && !driverOf(v)) continue
      const heavy = v.kind === 'tank' || v.kind === 'mech'
      sources.push({ id: v.id, kind: heavy ? 'tank' : 'car', position: v.object.position.clone().add(new THREE.Vector3(0, v.kind === 'mech' ? 5 : 1, 0)), rate: Math.min(1, Math.abs(v.spin) / (v.kind === 'tank' ? TANK_MAX_SPEED : v.kind === 'mech' ? MECH_RUN : CAR_MAX_SPEED)), own })
    }
    return sources
  }

  /**
   * The radar's picture: teammates, vehicles (enemy-crewed ones only when close, flying or firing), the gems,
   * barrels near us, and enemies on foot who gave themselves away (fired, came close, or carry our gem).
   */
  private updateRadar() {
    const now = performance.now()
    const me = this.camera.position
    const view = this.camera.getWorldDirection(new THREE.Vector3())
    radar.x = me.x
    radar.z = me.z
    radar.yaw = Math.atan2(-view.x, -view.z)
    radar.range = this.vehicle?.kind === 'heli' ? 320 : 180
    const blips: RadarBlip[] = []
    const recently = (id: string | null) => !!id && now - (this.remotes.get(id)?.lastFiredAt ?? 0) < 3000
    for (const team of ['blue', 'red'] as const) {
      if (this.gemCarried(team)) continue
      const gem = this.bases[team].group.localToWorld(GEM_LOCAL.clone())
      blips.push({ x: gem.x, z: gem.z, kind: 'gem', team, yaw: 0 })
    }
    for (const barrel of BARREL_SPOTS) {
      if (this.outposts.alive(barrel.id) && Math.hypot(barrel.x - me.x, barrel.z - me.z) < 150) blips.push({ x: barrel.x, z: barrel.z, kind: 'barrel', team: null, yaw: 0 })
    }
    for (const v of this.fleet.vehicles) {
      if (v.destroyed || v === this.vehicle) continue
      const crew = v.occupants.filter((id): id is string => !!id)
      const friendly = crew.some((id) => this.teamOf(id) === this.team)
      const p = v.object.position
      if (crew.length && !friendly) {
        const flying = v.kind === 'heli' && p.y - this.fleet.restHeight(v, p.x, p.z) > 3
        if (!flying && Math.hypot(p.x - me.x, p.z - me.z) > 70 && !crew.some(recently)) continue
      }
      blips.push({ x: p.x, z: p.z, kind: v.kind, team: crew.length ? (friendly ? this.team : other(this.team)) : null, yaw: v.object.rotation.y, empty: !crew.length })
    }
    for (const remote of this.remotes.values()) {
      const s = remote.target
      if (!remote.info.online || remote.info.dead || !s || s.vehicle || !remote.avatar) continue
      const mate = remote.info.team === this.team
      const a = remote.avatar.group.position
      if (!mate && Math.hypot(a.x - me.x, a.z - me.z) > 35 && !recently(remote.info.id) && !s.flag) continue
      blips.push({ x: a.x, z: a.z, kind: mate ? 'mate' : 'enemy', team: remote.info.team, yaw: s.yaw + Math.PI, gem: s.flag })
    }
    radar.blips = blips
    radar.version++
  }

  dispose() {
    this.disposed = true
    this.audio.dispose()
    for (const [t, k, fn] of this.boundHandlers) t.removeEventListener(k, fn)
    this.boundHandlers = []
    for (const remote of this.remotes.values()) remote.avatar?.dispose()
    this.graphics.dispose()
    this.sky.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
