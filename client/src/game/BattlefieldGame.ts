import * as THREE from 'three'
import { createTerrain, createWater, createSkyAndLights, heightAt, SHADOW_RANGE, SUN_OFFSET, FOG_FAR } from './world/terrain'
import { createBase, GEM_LOCAL, turretPlacements, BASE_HALF, type BaseObjects, type Team } from './world/bases'
import { createForest, createRocks, createBushes, createClouds, createGrass, type GrassField, type RockField } from './world/nature'
import { createTurrets, type TurretField } from './world/turrets'
import { createHelicopter, HELI_SEAT_OFFSET, type Helicopter } from './world/helicopter'
import { Player, EYE_HEIGHT } from './world/player'
import { Viewmodel } from './world/viewmodel'
import { Weapon } from './world/weapon'
import { createAvatar, type Avatar } from './world/avatar'
import { gameState, setGameState, type RosterEntry } from './state'
import type { Multiplayer, NetPlayer, NetState } from './net'

export interface MatchSetup {
  you: string
  players: NetPlayer[]
  net: Multiplayer
}

interface RemotePlayer {
  info: NetPlayer
  avatar: Avatar | null
  target: NetState | null
  snapped: boolean
  /** Died while flying: the body is inside the falling helicopter, so no death animation on the ground. */
  diedFlying: boolean
  /** Smoothed ground speed of the rendered avatar, drives idle/run blending. */
  speed: number
}

const NET_SEND_INTERVAL = 1 / 15
const ROSTER_INTERVAL = 0.3
/** Other players' solid radius; with the player's own 0.6 radius, bodies keep ~1m apart. */
const PLAYER_BLOCK_RADIUS = 0.45
const PLAYER_BLOCK_HEIGHT = 1.8
const HELI_BLOCK_RADIUS = 3.8
/** A helicopter higher than this above the ground is flying and doesn't block walking under it. */
const HELI_GROUND_CLEARANCE = 3
/** Jumps further than this (respawn, leaving a helicopter) snap instead of gliding across the map. */
const SNAP_DISTANCE = 25
const TEAM_NAME: Record<Team, string> = { blue: 'BLUE', red: 'RED' }
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
  /** One helicopter per team, visible to everyone; ours is `this.heli`. */
  private helis!: Record<Team, Helicopter>
  /** Remote player currently flying each team's helicopter. */
  private heliPilot: Record<Team, string | null> = { blue: null, red: null }
  /** Last pose a remote pilot reported, so a landed helicopter rests exactly where they left it. */
  private heliLastPose: Record<Team, NonNullable<NetState['heli']> | null> = { blue: null, red: null }
  private dead = false
  private sun!: THREE.DirectionalLight
  private deathCamRoll = 0
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private player: Player
  private weapon: Weapon
  private viewmodel: Viewmodel
  private heli: Helicopter
  private ourBase: BaseObjects
  private enemyBase: BaseObjects
  private bases: { blue: BaseObjects; red: BaseObjects }
  private turrets: TurretField
  private grass: GrassField
  private rocks: RockField
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
  private inHeli = false
  private carryTarget: Team | null = null
  private clock = new THREE.Clock()
  private disposed = false
  private targetList: THREE.Object3D[] = []
  private boundHandlers: Array<[EventTarget, string, EventListener]> = []
  private lastShotCount = 0
  private boarding = false
  private lastHeliYaw = 0
  private heliCameraMode: 'cockpit' | 'chase' = 'cockpit'

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
    const worldCircles: Array<{ x: number; z: number; r: number }> = []
    this.scene.add(terrain)
    this.scene.add(createWater())
    const forest = createForest(worldCircles)
    this.rocks = createRocks(worldCircles)
    this.scene.add(forest)
    this.scene.add(this.rocks.group)
    this.scene.add(createBushes(worldCircles))
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
      this.turrets.turrets.some((t) => Math.hypot(x - t.x, z - t.z) < 4))
    this.scene.add(this.grass.group)

    // Each team's helicopter parked on its own base pad, nose toward the enemy base
    const heliYaw = (team: Team) => (team === 'blue' ? Math.PI * 0.25 : Math.PI * 1.25)
    const makeHeli = (team: Team) => {
      const base = this.bases[team].group.position
      const pad = new THREE.Vector3(base.x + 20, 0, base.z - 18)
      pad.y = heightAt(pad.x, pad.z) + 0.05
      const heli = createHelicopter(pad, team === this.team
        ? () => setGameState({ message: 'Helicopter ready at your base helipad. Press [E] near it to board.' })
        : undefined)
      heli.object.rotation.y = heliYaw(team)
      heli.object.userData.heliTeam = team
      this.scene.add(heli.object)
      return heli
    }
    this.helis = { blue: makeHeli('blue'), red: makeHeli('red') }
    this.heli = this.helis[this.team]
    this.heliYaw = heliYaw(this.team)

    this.player = new Player(this.camera)
    this.player.spawn(this.spawnPoint())

    // Colliders from both bases for player/wall collision
    const colliders = [...this.ourBase.colliders, ...this.enemyBase.colliders]
    this.player.setColliders(colliders)
    this.player.setCircles(worldCircles)

    // Weapon
    this.weapon = new Weapon(this.scene, this.camera, () => {
      // small recoil kick
      this.player.pitch += 0.004
    })
    this.viewmodel = new Viewmodel(this.camera)
    this.viewmodel.loadHandgun()
    this.viewmodel.show('primary-handgun')

    // Everything that stops a bullet: terrain, bases, trees, rocks, helicopters, machine guns (player avatars are
    // added per shot). Bushes and grass are left out on purpose: they hide you but don't stop bullets.
    this.targetList = [terrain, this.ourBase.group, this.enemyBase.group, forest, this.rocks.group, this.helis.blue.object, this.helis.red.object, this.turrets.group]

    // Debug handle for console/preview smoke tests
    ;(window as unknown as { __game?: BattlefieldGame }).__game = this

    for (const player of match.players) this.upsertPlayer(player)
    this.applyOwnVitals(match.players)
    const enemy = TEAM_NAME[other(this.team)]
    setGameState({
      team: this.team,
      message: `You are on the ${TEAM_NAME[this.team]} team. Steal the ${enemy} gem and bring it to your ${TEAM_NAME[this.team]} gem. [E] to interact.`,
    })
    this.publishRoster()

    this.bindEvents()
  }

  upsertPlayer(player: NetPlayer) {
    if (player.id === this.match.you) return
    let remote = this.remotes.get(player.id)
    if (!remote) {
      remote = { info: player, avatar: null, target: null, snapped: false, speed: 0, diedFlying: false }
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
  syncRoster(players: NetPlayer[]) {
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
    this.releaseHeliFrom(id)
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
    remote.diedFlying = !!remote.target?.heli
    remote.avatar?.die()
    this.releaseHeliFrom(id)
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
    remote.diedFlying = false
    remote.avatar?.revive()
    this.publishRoster()
  }

  /** Another player fired: muzzle flash on their gun (or their helicopter) and a tracer to where it landed. */
  remoteShot(id: string, to: [number, number, number]) {
    const remote = this.remotes.get(id)
    if (!remote?.avatar || !remote.info.online || remote.info.dead || !remote.target) return
    const end = new THREE.Vector3(...to)
    let start: THREE.Vector3
    if (remote.avatar.group.visible) {
      start = remote.avatar.fire()
    } else if (remote.target.heli && remote.info.team) {
      start = this.helis[remote.info.team].object.localToWorld(new THREE.Vector3(0, 1.4, 4))
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
    if (this.inHeli) {
      this.inHeli = false
      this.heli.setParked(true)
      setGameState({ inHelicopter: false })
    }
    // Put the body on the ground (it may have been in a helicopter seat) so others see it fall there
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

  private releaseHeliFrom(pilotId: string) {
    for (const team of ['blue', 'red'] as const) {
      if (this.heliPilot[team] !== pilotId) continue
      this.heliPilot[team] = null
      const heli = this.helis[team]
      const last = this.heliLastPose[team]
      if (last) {
        heli.object.position.set(...last.p)
        heli.object.rotation.y = last.r[1]
      }
      heli.setParked(true)
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
      const heliTeam = node.userData.heliTeam as Team | undefined
      if (heliTeam) {
        const pilot = this.heliPilot[heliTeam]
        if (heliTeam !== this.team && pilot) this.match.net.sendHit(pilot, this.weapon.weaponId)
        return
      }
    }
  }

  /** Other players on foot and helicopters sitting on the ground are solid: you can't walk through them. */
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
    for (const team of ['blue', 'red'] as const) {
      const heli = this.helis[team].object
      if (team === this.team && this.inHeli) continue
      if (heli.position.y - heightAt(heli.position.x, heli.position.z) > HELI_GROUND_CLEARANCE) continue
      obstacles.push({ x: heli.position.x, z: heli.position.z, r: HELI_BLOCK_RADIUS })
    }
    return obstacles
  }

  private shootTargets() {
    const avatars: THREE.Object3D[] = []
    for (const remote of this.remotes.values()) if (remote.avatar?.group.visible && !remote.info.dead) avatars.push(remote.avatar.group)
    // From the cockpit, don't let shots hit the helicopter we're sitting in
    const targets = this.inHeli ? this.targetList.filter((t) => t !== this.heli.object) : this.targetList
    return [...targets, ...avatars]
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
    const heli = this.heli.object
    this.match.net.sendState({
      p: [p.x, p.y, p.z],
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      heli: this.inHeli
        ? { p: [heli.position.x, heli.position.y, heli.position.z], r: [heli.rotation.x, heli.rotation.y, heli.rotation.z], rpm: this.heli.getRotorSpeed() }
        : null,
      flag: this.carryTarget !== null,
      hp: gameState.health,
    })
  }

  private updateRemotes(dt: number, time: number) {
    const k = 1 - Math.exp(-dt * 12)
    for (const remote of this.remotes.values()) {
      const s = remote.target
      if (!remote.info.online || !s || !remote.avatar) continue
      const avatar = remote.avatar.group
      const distance = avatar.position.distanceTo(this.camera.position)
      if (remote.info.dead) {
        // The body stays where it fell while the death animation plays
        avatar.visible = !remote.diedFlying && remote.avatar.deathVisible()
        remote.avatar.carriedGem.visible = false
        if (avatar.visible) remote.avatar.update(dt, 0, 0, distance)
        if (remote.info.team && this.heliPilot[remote.info.team] === remote.info.id) this.releaseHeliFrom(remote.info.id)
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
      const flying = !!s.heli
      avatar.visible = !flying
      remote.avatar.carriedGem.visible = s.flag
      if (avatar.visible) remote.avatar.update(dt, remote.speed, s.pitch, distance)

      // A remote pilot drives their team's shared helicopter; we never override our own while flying it
      const team = remote.info.team
      if (!team || (team === this.team && this.inHeli)) continue
      if (flying && s.heli) {
        const heli = this.helis[team]
        if (this.heliPilot[team] !== remote.info.id) {
          this.heliPilot[team] = remote.info.id
          heli.setParked(false)
        }
        const obj = heli.object
        obj.position.lerp(new THREE.Vector3(...s.heli.p), k)
        obj.rotation.set(
          THREE.MathUtils.lerp(obj.rotation.x, s.heli.r[0], k),
          lerpAngle(obj.rotation.y, s.heli.r[1], k),
          THREE.MathUtils.lerp(obj.rotation.z, s.heli.r[2], k),
        )
        heli.setRotorTarget(s.heli.rpm)
        this.heliLastPose[team] = s.heli
      } else if (this.heliPilot[team] === remote.info.id) {
        this.releaseHeliFrom(remote.info.id)
      }
    }
    // Our own helicopter is updated by the flight code; the enemy's is updated here
    this.helis[other(this.team)].update(dt, time)
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
      status: this.dead ? 'dead' : this.carryTarget ? 'carrying gem' : this.inHeli ? 'flying' : 'on foot',
      hp: gameState.health,
      you: true,
    }]
    for (const remote of this.remotes.values()) {
      const s = remote.target
      entries.push({
        id: remote.info.id,
        name: remote.info.displayName,
        team: remote.info.team,
        status: !remote.info.online ? 'offline' : remote.info.dead ? 'dead' : s?.flag ? 'carrying gem' : s?.heli ? 'flying' : 'on foot',
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
      if (!this.inHeli) this.renderer.domElement.requestPointerLock()
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
      if (this.inHeli) {
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
          this.toggleHelicopter()
          break
        case 'KeyV':
          this.cycleHelicopterCamera()
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

  private toggleHelicopter() {
    if (this.boarding || this.dead) return
    if (this.inHeli) {
      // Dismount: place player beside heli on the ground
      this.inHeli = false
      this.heli.setParked(true)
      const drop = this.heli.object.position.clone()
      drop.x += 6
      drop.z += 6
      this.player.spawn(drop)
      setGameState({ inHelicopter: false, nearHelicopter: false })
      return
    }

    // Board if close enough
    const eye = this.player.position
    const heliPos = this.heli.object.position
    const dist = eye.distanceTo(heliPos)
    if (dist >= 8) return
    const pilot = this.heliPilot[this.team]
    if (pilot) {
      setGameState({ message: `The helicopter is being flown by ${this.nameOf(pilot)}.` })
      return
    }
    void this.boardHelicopter()
  }

  private async boardHelicopter() {
    this.boarding = true
    this.heli.setDoorOpen(true)
    setGameState({ message: 'Opening helicopter door...' })
    await new Promise((resolve) => window.setTimeout(resolve, 900))

    const seat = this.heli.object.localToWorld(HELI_SEAT_OFFSET.clone())
    this.player.position.copy(seat)
    this.player.velocity.set(0, 0, 0)
    this.player.yaw = this.heliYaw
    this.player.pitch = 0
    this.lastHeliYaw = this.heliYaw
    this.heliCameraMode = 'cockpit'
    this.inHeli = true
    this.heli.setParked(false)
    this.heliFlightAltitude = this.heli.object.position.y
    setGameState({ inHelicopter: true, message: 'Press SPACE to spin up the rotor. W/S fly, A/D turn, ↑/↓ altitude, ←/→ roll, V camera, E to exit.' })

    await new Promise((resolve) => window.setTimeout(resolve, 550))
    this.heli.setDoorOpen(false)
    this.boarding = false
  }

  private cycleHelicopterCamera() {
    if (!this.inHeli || this.boarding) return
    this.heliCameraMode = this.heliCameraMode === 'cockpit' ? 'chase' : 'cockpit'
    const label = this.heliCameraMode === 'cockpit' ? 'COCKPIT VIEW' : 'CHASE VIEW'
    setGameState({ message: `${label} — press V to change camera.` })
  }

  private heliFlightAltitude = 0

  private updateHelicopter(dt: number, time: number) {
    const heliObj = this.heli.object

    if (!this.inHeli) {
      this.heli.update(dt, time)
      return
    }

    // --- Player-piloted flight model (viewer formulas, adapted):
    //     SPACE spools the propeller, W/S fly, A/D turn, Arrows altitude+roll.
    //     Model nose is +Z (tail rotor node sits at z = -4.43). ---
    const turnInput = (this.input.left ? 1 : 0) - (this.input.right ? 1 : 0)
    const fwdInput = (this.input.forward ? 1 : 0) - (this.input.back ? 1 : 0)
    const climbing = this.input.arrowUp
    const descending = this.input.arrowDown
    const rollLeft = this.input.arrowLeft
    const rollRight = this.input.arrowRight

    // SPACE spins up the propeller, Shift spools it down (viewer-style)
    this.heli.updateRotorInput(this.input.jump, this.input.sprint, dt)

    // Rotor must be spooled up before the heli responds
    const rpm = this.heli.getRotorSpeed()
    const liftReady = THREE.MathUtils.clamp((rpm - 40) / 30, 0, 1)

    this.heliYaw += turnInput * dt * 1.1 * liftReady
    const yaw = this.heliYaw
    if (this.inHeli) {
      this.player.yaw += yaw - this.lastHeliYaw
      this.lastHeliYaw = yaw
    }

    // Nose direction = local +Z rotated by yaw: (sin yaw, cos yaw)
    const dirX = Math.sin(yaw)
    const dirZ = Math.cos(yaw)

    const targetThrottle = fwdInput * liftReady
    this.heliThrottle = THREE.MathUtils.lerp(this.heliThrottle, targetThrottle, dt * 1.2)
    const speed = this.heliThrottle * 60

    const nextX = heliObj.position.x + dirX * speed * dt
    const nextZ = heliObj.position.z + dirZ * speed * dt

    // Altitude control (ArrowUp/ArrowDown), ground clamp, ceiling 220
    const climbRate = climbing ? 22 : descending ? -18 : 0
    this.heliFlightAltitude = Math.max(
      heightAt(nextX, nextZ) + 2.5,
      Math.min(220, this.heliFlightAltitude + climbRate * dt * liftReady),
    )

    // Keep within world
    const lim = 480
    const cx = THREE.MathUtils.clamp(nextX, -lim, lim)
    const cz = THREE.MathUtils.clamp(nextZ, -lim, lim)

    heliObj.position.x = cx
    heliObj.position.z = cz

    // Bank: Arrow keys roll lean (viewer-style), turns add a little bank.
    // Forward flight pitches the nose down (+rotation.x lowers the +Z nose).
    let targetRoll = 0
    if (rollLeft) targetRoll = 0.3
    else if (rollRight) targetRoll = -0.3
    else targetRoll = -turnInput * 0.18 * Math.abs(this.heliThrottle)
    const targetPitch = this.heliThrottle * 0.22
    this.heliRoll = THREE.MathUtils.lerp(this.heliRoll, targetRoll, dt * 5)
    this.heliPitch = THREE.MathUtils.lerp(this.heliPitch, targetPitch, dt * 2.5)

    this.heli.update(dt, time)
    if (this.inHeli) {
      heliObj.position.y = this.heliFlightAltitude
      heliObj.rotation.set(this.heliPitch, yaw, this.heliRoll)
    }

    if (this.heliCameraMode === 'cockpit') {
      const cockpitPosition = heliObj.localToWorld(HELI_SEAT_OFFSET.clone())
      this.camera.position.lerp(cockpitPosition, Math.min(1, dt * 12))
      this.camera.rotation.order = 'YXZ'
      this.camera.rotation.set(this.player.pitch, this.player.yaw, 0)
    } else if (this.heliCameraMode === 'chase') {
      const back = new THREE.Vector3(-dirX, 0, -dirZ).multiplyScalar(18)
      const camTarget = new THREE.Vector3(
        heliObj.position.x + back.x,
        heliObj.position.y + 7,
        heliObj.position.z + back.z,
      )
      this.camera.position.lerp(camTarget, Math.min(1, dt * 4))
      this.camera.lookAt(heliObj.position.x, heliObj.position.y + 2, heliObj.position.z)
    }
  }

  private heliYaw = Math.PI * 0.25
  private heliThrottle = 0
  private heliRoll = 0
  private heliPitch = 0

  private updateGemsAndCapture() {
    // Carry logic — only when on foot
    if (this.inHeli || this.carryTarget) {
      this.updateNearHeliState()
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

    this.updateNearHeliState()
  }

  private updateNearHeliState() {
    const near = this.player.position.distanceTo(this.heli.object.position) < 14
    setGameState({ nearHelicopter: near && !this.inHeli })
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
    if (this.inHeli || this.dead) {
      setGameState({ nearHelicopter: false })
      return
    }
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

      this.updateRemotes(realDt, time)
      this.updateShadowArea()
      this.bases.blue.gem.update(time)
      this.bases.red.gem.update(time)
      this.turrets.update(time, this.camera.position)
      this.grass.update(this.camera.position)
      this.rocks.update(this.camera.position)
      this.updateGemVisibility()
      // Real time, not the capped frame dt, so slow machines don't fall behind
      const now = performance.now()
      if (now - this.lastRosterAt >= ROSTER_INTERVAL * 1000) {
        this.lastRosterAt = now
        this.publishRoster()
      }

      if (gameState.finished) {
        this.mouse.shooting = false
        this.renderer.render(this.scene, this.camera)
        return
      }

      this.updatePlayer(dt)
      if (this.dead) this.updateDeathCamera(realDt)
      this.updateHelicopter(dt, time)
      this.updateGemsAndCapture()

      if (now - this.lastNetSend >= NET_SEND_INTERVAL * 1000) {
        this.lastNetSend = now
        this.sendNetState()
      }

      this.weapon.tick(dt)
      const cockpitCombat = this.inHeli && this.heliCameraMode === 'cockpit'
      if (!this.dead && (!this.inHeli || cockpitCombat)) {
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
        hidden: (this.inHeli && !cockpitCombat) || gameState.finished || this.dead,
        moving: this.input.forward || this.input.back || this.input.left || this.input.right,
        time,
      })
      this.lastShotCount = this.weapon.shotCount
      this.syncHudState()

      // HUD: pilot telemetry (rotor RPM matches the classic x10 readout)
      if (this.inHeli) {
        setGameState({ rotorRpm: Math.round(this.heli.getRotorSpeed() * 10) })
      }

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
