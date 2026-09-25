import * as THREE from 'three'
import { createTerrain, createWater, createSkyAndLights, heightAt } from './world/terrain'
import { createBase, animateFlag, type BaseObjects, type Team } from './world/bases'
import { createForest, createRocks, createBushes, createClouds } from './world/nature'
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
  heli: Helicopter | null
  target: NetState | null
  snapped: boolean
}

const NET_SEND_INTERVAL = 1 / 15
const ROSTER_INTERVAL = 0.3
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
  private netTimer = 0
  private rosterTimer = 0
  private lastRosterJson = ''
  private captureSent = false
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private player: Player
  private weapon: Weapon
  private viewmodel: Viewmodel
  private heli: Helicopter
  private heliPadWorld: THREE.Vector3
  private ourBase: BaseObjects
  private enemyBase: BaseObjects
  private flags: { blue: BaseObjects; red: BaseObjects }
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
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    // Scene + camera
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      2200,
    )
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.camera)

    // World
    createSkyAndLights(this.scene)
    const terrain = createTerrain()
    const worldCircles: Array<{ x: number; z: number; r: number }> = []
    this.scene.add(terrain)
    this.scene.add(createWater())
    this.scene.add(createForest(worldCircles))
    this.scene.add(createRocks(worldCircles))
    this.scene.add(createBushes(worldCircles))
    this.scene.add(createClouds())

    // Bases: blue in the south-west corner, red in the north-east; "ours" depends on the team
    const blueBase = createBase('blue', new THREE.Vector3(-380, 0, -380))
    const redBase = createBase('red', new THREE.Vector3(380, 0, 380))
    this.flags = { blue: blueBase, red: redBase }
    this.ourBase = this.flags[this.team]
    this.enemyBase = this.flags[other(this.team)]
    this.scene.add(blueBase.group)
    this.scene.add(redBase.group)
    const ourPos = this.ourBase.group.position

    // Helicopter parked on OUR base pad, nose toward the enemy
    this.heliPadWorld = new THREE.Vector3(ourPos.x + 20, 0, ourPos.z - 18)
    this.heliPadWorld.y = heightAt(this.heliPadWorld.x, this.heliPadWorld.z) + 0.05
    this.heliYaw = this.team === 'blue' ? Math.PI * 0.25 : Math.PI * 1.25
    this.heli = createHelicopter(this.heliPadWorld, () => {
      setGameState({ message: 'Helicopter ready at your base helipad. Press [E] near it to board.' })
    })
    this.heli.object.rotation.y = this.heliYaw
    this.scene.add(this.heli.object)

    // Player: spawn just outside our gate (blue gate faces +X, red gate faces -X), teammates side by side
    this.player = new Player(this.camera)
    const mates = match.players.filter((p) => p.team === this.team)
    const slot = Math.max(0, mates.findIndex((p) => p.id === match.you))
    const gateDir = this.team === 'blue' ? 1 : -1
    const spread = (slot - (mates.length - 1) / 2) * 4
    this.player.spawn(new THREE.Vector3(ourPos.x + gateDir * 56, 0, ourPos.z + gateDir * 8 + spread))

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

    // Raycast targets for shooting: terrain + bases + nature groups + heli
    this.targetList = [terrain, this.ourBase.group, this.enemyBase.group, this.heli.object]

    // Debug handle for console/preview smoke tests
    ;(window as unknown as { __game?: BattlefieldGame }).__game = this

    for (const player of match.players) this.upsertPlayer(player)
    const enemy = TEAM_NAME[other(this.team)]
    setGameState({
      team: this.team,
      message: `You are on the ${TEAM_NAME[this.team]} team. Steal the ${enemy} flag and bring it to your ${TEAM_NAME[this.team]} flagpole. [E] to interact.`,
    })
    this.publishRoster()

    this.bindEvents()
  }

  upsertPlayer(player: NetPlayer) {
    if (player.id === this.match.you) return
    let remote = this.remotes.get(player.id)
    if (!remote) {
      remote = { info: player, avatar: null, heli: null, target: null, snapped: false }
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
      remote.avatar.group.visible = false
      this.scene.add(remote.avatar.group)
    }
    if (player.state) this.applyRemoteState(player.id, player.state)
    if (!player.online) this.removePlayer(player.id)
  }

  /** After a reconnect the server's roster is authoritative: anyone missing is offline. */
  syncRoster(players: NetPlayer[]) {
    for (const player of players) this.upsertPlayer(player)
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
    if (remote.heli) remote.heli.object.visible = false
  }

  applyRemoteState(id: string, state: NetState) {
    const remote = this.remotes.get(id)
    if (!remote) return
    remote.info.online = true
    remote.target = state
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
      carryingFlag: false,
      score: this.score,
      message: won
        ? `VICTORY! The ${TEAM_NAME[winner]} team captured the enemy flag.`
        : `DEFEAT. The ${TEAM_NAME[winner]} team captured your flag.`,
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
      const feet = new THREE.Vector3(s.p[0], s.p[1] - EYE_HEIGHT, s.p[2])
      if (!remote.snapped || avatar.position.distanceToSquared(feet) > SNAP_DISTANCE ** 2) {
        avatar.position.copy(feet)
        avatar.rotation.y = s.yaw
        remote.snapped = true
      } else {
        avatar.position.lerp(feet, k)
        avatar.rotation.y = lerpAngle(avatar.rotation.y, s.yaw, k)
      }
      avatar.visible = !s.heli
      remote.avatar.carriedFlag.visible = s.flag

      if (s.heli) {
        if (!remote.heli) {
          remote.heli = createHelicopter(new THREE.Vector3(...s.heli.p))
          remote.heli.setParked(false)
          remote.heli.object.rotation.set(...s.heli.r)
          this.scene.add(remote.heli.object)
        }
        const obj = remote.heli.object
        obj.visible = true
        obj.position.lerp(new THREE.Vector3(...s.heli.p), k)
        obj.rotation.set(
          THREE.MathUtils.lerp(obj.rotation.x, s.heli.r[0], k),
          lerpAngle(obj.rotation.y, s.heli.r[1], k),
          THREE.MathUtils.lerp(obj.rotation.z, s.heli.r[2], k),
        )
        remote.heli.setRotorTarget(s.heli.rpm)
        remote.heli.update(dt, time)
      } else if (remote.heli) {
        remote.heli.object.visible = false
      }
    }
  }

  /** A flag is "taken" while anyone — us or a remote player — carries it. */
  private flagCarried(flagTeam: Team) {
    if (this.carryTarget === flagTeam) return true
    for (const remote of this.remotes.values()) {
      if (remote.info.online && remote.target?.flag && remote.info.team === other(flagTeam)) return true
    }
    return false
  }

  private updateFlagVisibility() {
    for (const team of ['blue', 'red'] as const) {
      const base = this.flags[team]
      const carried = this.flagCarried(team)
      base.flagState.carried = carried
      base.flagCloth.visible = !carried
      base.flagTip.visible = !carried
    }
  }

  private publishRoster() {
    const me = this.match.players.find((p) => p.id === this.match.you)
    const entries: RosterEntry[] = [{
      id: this.match.you,
      name: me?.displayName ?? 'You',
      team: this.team,
      status: this.carryTarget ? 'carrying flag' : this.inHeli ? 'flying' : 'on foot',
      you: true,
    }]
    for (const remote of this.remotes.values()) {
      const s = remote.target
      entries.push({
        id: remote.info.id,
        name: remote.info.displayName,
        team: remote.info.team,
        status: !remote.info.online ? 'offline' : s?.flag ? 'carrying flag' : s?.heli ? 'flying' : 'on foot',
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
    if (this.boarding) return
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
    if (dist < 8) void this.boardHelicopter()
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

  private updateFlagsAndCapture() {
    // Flag waving needs world position
    const ourFlagPos = this.ourBase.group.position
    const enemyFlagPos = this.enemyBase.group.position
    animateFlag(this.ourBase, this.clock.elapsedTime, ourFlagPos)
    animateFlag(this.enemyBase, this.clock.elapsedTime, enemyFlagPos)

    // Carry logic — only when on foot
    if (this.inHeli || this.carryTarget) {
      // While carrying, the pole cloth stays hidden; HUD shows carrier state
      this.updateNearHeliState()
      return
    }

    // Pickup: proximity to the enemy flagpole base (reachable on foot), unless a teammate already has it
    const enemyTeam = other(this.team)
    const flagLocal = new THREE.Vector3(-12, 0, 0)
    const enemyFlagWorld = this.enemyBase.group.localToWorld(flagLocal.clone())
    const d = this.player.position.distanceTo(enemyFlagWorld)
    if (d < 7 && !this.flagCarried(enemyTeam)) {
      this.carryTarget = enemyTeam
      setGameState({
        carryingFlag: true,
        message: `${TEAM_NAME[enemyTeam]} flag taken! Bring it to the ${TEAM_NAME[this.team]} flagpole.`,
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
    const ourFlagWorld = this.ourBase.group.localToWorld(new THREE.Vector3(-12, 0, 0))
    const d = this.player.position.distanceTo(ourFlagWorld)
    if (d >= 9) {
      this.captureSent = false
      return
    }
    if (this.captureSent) return
    // The server confirms the capture and ends the match for every player
    this.captureSent = true
    this.sendNetState()
    this.match.net.sendCapture()
    setGameState({ message: 'Flag delivered — confirming capture…' })
  }

  private score = 0

  private updatePlayer(dt: number) {
    this.player.setExtraCircle(
      this.heli.object.position.x,
      this.heli.object.position.z,
      this.inHeli ? 0 : 3.8,
    )
    if (this.inHeli) {
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
      carryingFlag: this.carryTarget !== null,
    })
  }

  start() {
    const loop = () => {
      if (this.disposed) return
      requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), 0.05)
      const time = this.clock.elapsedTime

      this.updateRemotes(dt, time)
      this.updateFlagVisibility()
      this.rosterTimer += dt
      if (this.rosterTimer >= ROSTER_INTERVAL) {
        this.rosterTimer = 0
        this.publishRoster()
      }

      if (gameState.finished) {
        this.mouse.shooting = false
        this.renderer.render(this.scene, this.camera)
        return
      }

      this.updatePlayer(dt)
      this.updateHelicopter(dt, time)
      this.updateFlagsAndCapture()

      this.netTimer += dt
      if (this.netTimer >= NET_SEND_INTERVAL) {
        this.netTimer = 0
        this.sendNetState()
      }

      this.weapon.tick(dt)
      const cockpitCombat = this.inHeli && this.heliCameraMode === 'cockpit'
      if (!this.inHeli || cockpitCombat) {
        this.weapon.tryFire(this.mouse, dt, this.targetList)
      }
      this.viewmodel.show(this.weapon.weaponId)
      this.viewmodel.update(dt, {
        recoilKick: this.weapon.shotCount !== this.lastShotCount,
        reloading: this.weapon.reloading,
        hidden: (this.inHeli && !cockpitCombat) || gameState.finished,
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
