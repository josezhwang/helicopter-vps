import * as THREE from 'three'
import { createTerrain, createWater, createSkyAndLights, heightAt } from './world/terrain'
import { createBase, animateFlag, type BaseObjects } from './world/bases'
import { createForest, createRocks, createBushes, createClouds } from './world/nature'
import { createHelicopter, HELI_SEAT_OFFSET, type Helicopter } from './world/helicopter'
import { Player } from './world/player'
import { Viewmodel } from './world/viewmodel'
import { Weapon } from './world/weapon'
import { gameState, setGameState } from './state'

export class BattlefieldGame {
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
  private carryTarget: 'red' | null = null
  private clock = new THREE.Clock()
  private disposed = false
  private targetList: THREE.Object3D[] = []
  private boundHandlers: Array<[EventTarget, string, EventListener]> = []
  private lastShotCount = 0
  private boarding = false
  private lastHeliYaw = 0
  private heliCameraMode: 'cockpit' | 'chase' | 'under' = 'cockpit'

  constructor(private container: HTMLElement) {
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

    // Bases
    const ourPos = new THREE.Vector3(-380, 0, -380)
    const enemyPos = new THREE.Vector3(380, 0, 380)
    this.ourBase = createBase('blue', ourPos)
    this.enemyBase = createBase('red', enemyPos)
    this.scene.add(this.ourBase.group)
    this.scene.add(this.enemyBase.group)
    this.flags = { blue: this.ourBase, red: this.enemyBase }

    // Helicopter parked on OUR base pad
    this.heliPadWorld = new THREE.Vector3(ourPos.x + 20, 0, ourPos.z - 18)
    this.heliPadWorld.y = heightAt(this.heliPadWorld.x, this.heliPadWorld.z) + 0.6
    this.heli = createHelicopter(this.heliPadWorld, () => {
      setGameState({ message: 'Helicopter ready at your base helipad. Press [E] near it to board.' })
    })
    this.scene.add(this.heli.object)

    // Player
    this.player = new Player(this.camera)
    // Spawn just outside our gate, facing the open battlefield
    this.player.spawn(new THREE.Vector3(ourPos.x + 56, 0, ourPos.z + 8))

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

    this.bindEvents()
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
    if (dist < 10) void this.boardHelicopter()
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
    this.heliCameraMode = this.heliCameraMode === 'cockpit'
      ? 'chase'
      : this.heliCameraMode === 'chase'
        ? 'under'
        : 'cockpit'
    const label = this.heliCameraMode === 'cockpit'
      ? 'COCKPIT VIEW'
      : this.heliCameraMode === 'chase'
        ? 'CHASE VIEW'
        : 'UNDER HELICOPTER VIEW'
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
    } else {
      const underPosition = heliObj.localToWorld(new THREE.Vector3(0, -8, 0))
      this.camera.position.lerp(underPosition, Math.min(1, dt * 5))
      this.camera.lookAt(heliObj.position.x, heliObj.position.y + 1.5, heliObj.position.z)
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

    // Pickup: proximity to the enemy flagpole base (reachable on foot)
    const flagLocal = new THREE.Vector3(-12, 0, 0)
    const enemyFlagWorld = this.enemyBase.group.localToWorld(flagLocal.clone())
    const d = this.player.position.distanceTo(enemyFlagWorld)
    if (d < 7) {
      this.carryTarget = 'red'
      this.enemyBase.flagState.carried = true
      this.enemyBase.flagCloth.visible = false
      this.enemyBase.flagTip.visible = false
      setGameState({
        carryingFlag: true,
        message: 'Enemy flag taken! Bring it to the BLUE flagpole.',
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
    if (d < 9) {
      this.carryTarget = null
      this.enemyBase.flagState.carried = false
      this.enemyBase.flagCloth.visible = true
      this.enemyBase.flagTip.visible = true
      const score = 1
      this.score += score
      setGameState({
        carryingFlag: false,
        score: this.score,
        finished: true,
        message: 'VICTORY! You stole the enemy flag and brought it back to your base.',
      })
      this.mouse.shooting = false
      this.input.forward = false
      this.input.back = false
      this.input.left = false
      this.input.right = false
      this.input.sprint = false
      // respawn flag (it never actually left, we hid it while carried)
      this.flags.red.flagState.carried = false
    }
  }

  private score = 0

  private updatePlayer(dt: number) {
    this.player.setExtraCircle(
      this.heli.object.position.x,
      this.heli.object.position.z,
      this.inHeli ? 0 : 6,
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
      carryingFlag: this.carryTarget === 'red',
    })
  }

  start() {
    const loop = () => {
      if (this.disposed) return
      requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), 0.05)
      const time = this.clock.elapsedTime

      if (gameState.finished) {
        this.mouse.shooting = false
        this.renderer.render(this.scene, this.camera)
        return
      }

      this.updatePlayer(dt)
      this.updateHelicopter(dt, time)
      this.updateFlagsAndCapture()

      this.weapon.tick(dt)
      if (!this.inHeli) {
        this.weapon.tryFire(this.mouse, dt, this.targetList)
      }
      this.viewmodel.show(this.weapon.weaponId)
      this.viewmodel.update(dt, {
        recoilKick: this.weapon.shotCount !== this.lastShotCount,
        reloading: this.weapon.reloading,
        hidden: this.inHeli || gameState.finished,
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
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
