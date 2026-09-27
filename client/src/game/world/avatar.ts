import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import type { Team } from './bases'
import { createCarriedGem } from './gem'
import { loadProp, propGroup } from './props'
import { WEAPONS, type WeaponKind } from './weapons'

export const TEAM_COLOR: Record<Team, number> = { blue: 0x2e6fbd, red: 0xb03a2e }
/** The robots' eye light in each team's colour. */
const VISOR_COLOR: Record<Team, number> = { blue: 0x3fa4ff, red: 0xff3a24 }

/**
 * Every player is a combat robot: the "Security Bot" of Blender Studio's open film Charge (CC-BY 4.0), with
 * baked film textures and Quaternius' Universal Animation Library (CC0) moved onto its skeleton. The legs walk,
 * run and sprint with the player's speed while the upper body holds the gun up and leans with the aim; it
 * flinches when hit, throws grenades, and falls when it dies. Its eye glows in the team colour.
 */
let robotUrl = '/models/robot.glb'
/** Weak PCs get the lighter robot (a third of the triangles, smaller textures). Set before the first avatar. */
export function setRobotDetail(lite: boolean) {
  if (!robotAsset) robotUrl = lite ? '/models/robot_lite.glb' : '/models/robot.glb'
}
const ROBOT_HEIGHT = 2.0
/** Ground speeds (m/s) at which the walk, run and sprint cycles look right. */
const WALK_CYCLE_SPEED = 1.6
const RUN_CYCLE_SPEED = 4.4
const SPRINT_CYCLE_SPEED = 7.2
const MOVING_SPEED = 0.8
/** Held guns are drawn a bit oversized so they read clearly at a distance. */
const HELD_SCALE: Partial<Record<WeaponKind, number>> = { handgun: 1.5, launcher: 1 }
const LONG_GUN_SCALE = 0.8
const FLASH_MS = 70
/** Robots further than this skip shadows and animate at a third of the rate (hard to notice at that range). */
const DETAIL_DISTANCE = 70
const FAR_ANIMATION_DISTANCE = 120
// Death: the fall (the animation), lying still, then sinking away before the respawn
const DEATH_FALL = 2.3
const DEATH_LIE = 1.6
const DEATH_SINK = 0.8
/** Bones the upper-body layer (aiming, flinching, throwing) owns; the legs' clips own the rest. */
const UPPER_BODY = /^(spine_02|spine_roll|spine_03|neck_yaw|neck_01|Head|clavicle_|shoulder_|upperarm_|lowerarm_|hand_|thumb_|index_|ring_|grip_)/

export interface Avatar {
  group: THREE.Group
  /** The enemy gem, shown spinning above the head while this player carries it. */
  carriedGem: THREE.Object3D
  /** Advance animation; `speed` is ground speed (units/s), `pitch` the aim pitch, `distance` from the camera. */
  update: (dt: number, speed: number, pitch: number, distance: number, airborne?: boolean) => void
  /** Play the death: the fall, lying still, sinking away. */
  die: () => void
  revive: () => void
  /** True while the death animation should still be shown (it hides itself once sunk). */
  deathVisible: () => boolean
  /** Show the muzzle flash and return the muzzle's world position for the tracer. */
  fire: () => THREE.Vector3
  /** A hit landed: flinch. */
  flinch: () => void
  /** Throw a grenade (the arm swings over). */
  throwGrenade: () => void
  /** The weapon in their hands (null = none). */
  setWeapon: (kind: WeaponKind | null) => void
  dispose: () => void
}

let flashTexture: THREE.Texture | null = null
export function muzzleFlashTexture(): THREE.Texture {
  if (flashTexture) return flashTexture
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  glow.addColorStop(0, 'rgba(255, 255, 230, 1)')
  glow.addColorStop(0.25, 'rgba(255, 210, 90, 0.95)')
  glow.addColorStop(0.6, 'rgba(255, 120, 20, 0.45)')
  glow.addColorStop(1, 'rgba(255, 80, 0, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, 64, 64)
  flashTexture = new THREE.CanvasTexture(canvas)
  flashTexture.colorSpace = THREE.SRGBColorSpace
  return flashTexture
}

type ClipName = 'Idle' | 'Walk' | 'Run' | 'Sprint' | 'Death' | 'JumpLoop' | 'AimPistol' | 'Hit' | 'Throw'

interface RobotAsset {
  scene: THREE.Object3D
  /** Whole-body clips (idle, walk, run, sprint, jump, death), and the same with the upper body left out. */
  full: Map<ClipName, THREE.AnimationClip>
  legs: Map<ClipName, THREE.AnimationClip>
  /** Upper-body-only clips: the gun held up, the flinch, the throw. */
  upper: Map<ClipName, THREE.AnimationClip>
  scale: number
  lift: number
}

let robotAsset: Promise<RobotAsset | null> | null = null

const boneOf = (track: THREE.KeyframeTrack) => track.name.slice(0, track.name.lastIndexOf('.'))

/** Loaded once and shared; every avatar gets its own skeleton clone. */
function loadRobot(): Promise<RobotAsset | null> {
  robotAsset ??= new GLTFLoader().loadAsync(robotUrl).then((gltf) => {
    const byName = new Map(gltf.animations.map((clip) => [clip.name, clip]))
    const need = (name: ClipName) => {
      const clip = byName.get(name)
      if (!clip) throw new Error(`robot model is missing its ${name} animation`)
      return clip
    }
    const full = new Map<ClipName, THREE.AnimationClip>()
    const legs = new Map<ClipName, THREE.AnimationClip>()
    const upper = new Map<ClipName, THREE.AnimationClip>()
    for (const name of ['Idle', 'Walk', 'Run', 'Sprint', 'JumpLoop', 'Death'] as ClipName[]) {
      const clip = need(name)
      full.set(name, clip)
      legs.set(name, new THREE.AnimationClip(`${name}-legs`, clip.duration, clip.tracks.filter((t) => !UPPER_BODY.test(boneOf(t)))))
    }
    for (const name of ['AimPistol', 'Hit', 'Throw'] as ClipName[]) {
      const clip = need(name)
      upper.set(name, new THREE.AnimationClip(`${name}-upper`, clip.duration, clip.tracks.filter((t) => UPPER_BODY.test(boneOf(t)))))
    }
    // Measure the robot as it renders: posed by its idle clip
    const probe = new THREE.AnimationMixer(gltf.scene)
    probe.clipAction(need('Idle')).play()
    probe.update(0)
    gltf.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(gltf.scene, true)
    probe.stopAllAction()
    probe.uncacheRoot(gltf.scene)
    const scale = ROBOT_HEIGHT / (box.max.y - box.min.y)
    return { scene: gltf.scene, full, legs, upper, scale, lift: -box.min.y * scale }
  }).catch((error) => {
    console.error('[avatar] robot model failed to load, keeping simple soldiers:', error)
    return null
  })
  return robotAsset
}

// Per team: the eye in the team colour, the white plates faintly tinted (shared by every robot of the team)
const teamMaterials: Record<Team, Map<THREE.Material, THREE.Material>> = { blue: new Map(), red: new Map() }
function teamMaterial(source: THREE.Material, team: Team): THREE.Material {
  let material = teamMaterials[team].get(source)
  if (!material) {
    material = source.clone()
    if (material instanceof THREE.MeshStandardMaterial) {
      if (material.name === 'visor') {
        material.emissive = new THREE.Color(VISOR_COLOR[team])
        material.emissiveIntensity = 6
      } else if (material.name === 'robot') {
        material.color = new THREE.Color(1, 1, 1).lerp(new THREE.Color(TEAM_COLOR[team]), 0.14)
      }
    }
    teamMaterials[team].set(source, material)
  }
  return material
}

function nameLabel(text: string, team: Team): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = team === 'blue' ? 'rgba(20, 60, 120, 0.82)' : 'rgba(130, 30, 24, 0.82)'
  ctx.beginPath()
  ctx.roundRect(8, 8, 496, 80, 18)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 44px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text.length > 18 ? `${text.slice(0, 17)}…` : text, 256, 50)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }))
  sprite.scale.set(3.2, 0.6, 1)
  return sprite
}

const noRaycast = () => {}

/** Remote soldier; origin at the feet, facing -Z like the camera so rotation.y = yaw. */
export function createAvatar(name: string, team: Team): Avatar {
  const group = new THREE.Group()
  const own: Array<THREE.Mesh | THREE.Sprite> = []
  // Pivot at the feet (the death clip does the falling, the sink moves this down)
  const body = new THREE.Group()
  group.add(body)

  // Simple soldier shown until the robot model has loaded (or if it fails to load)
  const fallback = new THREE.Group()
  const teamMat = new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], roughness: 0.7 })
  const gearMat = new THREE.MeshStandardMaterial({ color: 0x2f3a2c, roughness: 0.9 })
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9d9d9, roughness: 0.5, metalness: 0.4 })
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 4, 12), teamMat)
  torso.position.y = 1.0
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), skinMat)
  head.position.y = 1.78
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), gearMat)
  helmet.position.y = 1.82
  for (const mesh of [torso, head, helmet]) {
    mesh.castShadow = true
    mesh.raycast = noRaycast
    fallback.add(mesh)
    own.push(mesh)
  }
  body.add(fallback)

  // Invisible capsule used for bullet hits, so hit detection doesn't depend on the animated mesh
  const hitbox = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.0, 2, 8), new THREE.MeshBasicMaterial({ visible: false }))
  hitbox.position.y = 1.0
  group.add(hitbox)
  own.push(hitbox)

  // Shared gem model/materials: not in `own`, so disposing an avatar leaves them for everyone else
  const carriedGem = createCarriedGem(team === 'blue' ? 'red' : 'blue')
  carriedGem.position.set(0, 2.2, 0.15)
  carriedGem.visible = false
  body.add(carriedGem)

  // Held weapon: rides in the right hand's grip (the launcher on the shoulder), pointing where the player aims
  const gunHolder = new THREE.Group()
  gunHolder.position.set(0.3, 1.3, -0.35)
  body.add(gunHolder)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.05, -0.3)
  gunHolder.add(muzzle)
  const guns = new Map<WeaponKind, { model: THREE.Object3D; muzzle: THREE.Vector3 }>()
  let held: WeaponKind | null = 'primary'
  const showHeld = () => {
    for (const [kind, gun] of guns) gun.model.visible = kind === held
    const gun = held ? guns.get(held) : undefined
    if (gun) muzzle.position.copy(gun.muzzle)
  }
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  flash.scale.setScalar(0.9)
  flash.visible = false
  flash.raycast = noRaycast
  muzzle.add(flash)
  let flashUntil = 0
  const loading = new Set<WeaponKind>()
  /** Guns are loaded the first time this soldier holds them. */
  const loadGun = (kind: WeaponKind) => {
    if (loading.has(kind)) return
    loading.add(kind)
    void loadProp(WEAPONS[kind].model).then((prop) => {
      if (disposed) return
      const scale = HELD_SCALE[kind] ?? LONG_GUN_SCALE
      const model = propGroup(prop)
      model.scale.setScalar(scale)
      // Long guns sit with their grip in the hand, most of the barrel ahead of it
      if (kind !== 'handgun' && kind !== 'launcher') model.position.z = -0.15 * (prop.box.max.z - prop.box.min.z) * scale
      gunHolder.add(model)
      guns.set(kind, { model, muzzle: prop.tip.clone().multiplyScalar(scale).add(model.position) })
      showHeld()
    }).catch((error) => console.error(`[avatar] ${kind} model failed to load:`, error))
  }
  loadGun('primary')

  const label = nameLabel(name, team)
  label.position.y = 2.75
  // Bullets pass through name tags (sprite raycasts also need a camera on the raycaster)
  label.raycast = noRaycast
  group.add(label)
  own.push(label)
  own.push(flash)

  let disposed = false
  let mixer: THREE.AnimationMixer | null = null
  const legActions = new Map<ClipName, THREE.AnimationAction>()
  const fullActions = new Map<ClipName, THREE.AnimationAction>()
  let aimAction: THREE.AnimationAction | null = null
  let hitAction: THREE.AnimationAction | null = null
  let throwAction: THREE.AnimationAction | null = null
  let deathAction: THREE.AnimationAction | null = null
  let grip: THREE.Object3D | null = null
  let spine: THREE.Object3D[] = []
  const gripPos = new THREE.Vector3()
  const robotMeshes: THREE.Mesh[] = []
  let detailed = true
  let farSkip = 0
  let farDt = 0
  /** Seconds since death, or -1 while alive (from the real clock, so slow frames can't stretch it). */
  let deathTime = -1
  let deathStart = 0
  const weights: Record<'Idle' | 'Walk' | 'Run' | 'Sprint' | 'JumpLoop', number> = { Idle: 1, Walk: 0, Run: 0, Sprint: 0, JumpLoop: 0 }

  void loadRobot().then((asset) => {
    if (!asset || disposed) return
    const model = SkeletonUtils.clone(asset.scene)
    model.traverse((node) => {
      if (node.name === 'grip_r') grip = node
      if (node.name === 'spine_02' || node.name === 'spine_03') spine.push(node)
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = detailed
      mesh.raycast = noRaycast
      mesh.frustumCulled = false
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => teamMaterial(m, team)) : teamMaterial(mesh.material, team)
      robotMeshes.push(mesh)
    })
    const holder = new THREE.Group()
    holder.scale.setScalar(asset.scale)
    holder.position.y = asset.lift
    holder.rotation.y = Math.PI // model faces +Z; avatars face -Z
    holder.add(model)
    body.add(holder)
    fallback.visible = false

    mixer = new THREE.AnimationMixer(model)
    for (const [name, clip] of asset.legs) {
      if (name === 'Death') continue
      const action = mixer.clipAction(clip).play()
      action.setEffectiveWeight(weights[name as keyof typeof weights] ?? 0)
      legActions.set(name, action)
    }
    const death = asset.full.get('Death')!
    deathAction = mixer.clipAction(death)
    deathAction.setLoop(THREE.LoopOnce, 1)
    deathAction.clampWhenFinished = true
    fullActions.set('Death', deathAction)
    aimAction = mixer.clipAction(asset.upper.get('AimPistol')!).play()
    hitAction = mixer.clipAction(asset.upper.get('Hit')!)
    hitAction.setLoop(THREE.LoopOnce, 1)
    throwAction = mixer.clipAction(asset.upper.get('Throw')!)
    throwAction.setLoop(THREE.LoopOnce, 1)
    if (deathTime >= 0) startDeathClip()
  })

  function startDeathClip() {
    if (!deathAction) return
    for (const action of legActions.values()) action.setEffectiveWeight(0)
    aimAction?.setEffectiveWeight(0)
    hitAction?.stop()
    throwAction?.stop()
    deathAction.reset().setEffectiveWeight(1).play()
  }

  /** One-off upper-body moves (flinch, throw) fade in over the held-up gun and back out. */
  function playOnce(action: THREE.AnimationAction | null, timeScale = 1) {
    if (!action || deathTime >= 0) return
    action.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(0.08).play()
    aimAction?.fadeOut(0.08)
    const back = () => {
      aimAction?.reset().fadeIn(0.15).play()
      mixer?.removeEventListener('finished', onFinished)
    }
    const onFinished = (event: { action: THREE.AnimationAction }) => { if (event.action === action) back() }
    mixer?.addEventListener('finished', onFinished)
  }

  function updateDeath(dt: number) {
    deathTime = (performance.now() - deathStart) / 1000
    const sink = THREE.MathUtils.clamp((deathTime - DEATH_FALL - DEATH_LIE) / DEATH_SINK, 0, 1)
    body.position.y = -sink * 0.9
    // Once down, the pose is frozen: no more skinning work for a wreck
    if (mixer && deathTime < DEATH_FALL + 0.2) mixer.update(dt)
  }

  const blend = (target: number, current: number, k: number) => current + (target - current) * k
  return {
    group,
    carriedGem,
    update(dt, speed, pitch, distance, airborne = false) {
      if (flash.visible && performance.now() > flashUntil) flash.visible = false
      if (carriedGem.visible) carriedGem.rotation.y += dt * 2.5
      const near = distance < DETAIL_DISTANCE
      if (near !== detailed) {
        detailed = near
        for (const mesh of robotMeshes) mesh.castShadow = near
      }
      if (deathTime >= 0) {
        updateDeath(dt)
        return
      }
      if (!mixer) {
        gunHolder.rotation.set(pitch, 0, 0)
        return
      }
      // Far away, advance the skeleton every third frame (same total time, a third of the CPU)
      farDt += dt
      if (distance > FAR_ANIMATION_DISTANCE && ++farSkip % 3 !== 0) return
      const step = farDt
      farDt = 0
      // Legs: idle / walk / run / sprint by speed (the jump pose in the air), cross-faded
      const want = { Idle: 0, Walk: 0, Run: 0, Sprint: 0, JumpLoop: 0 }
      if (airborne) want.JumpLoop = 1
      else if (speed < MOVING_SPEED) want.Idle = 1
      else if (speed < 3) want.Walk = 1
      else if (speed < 11) want.Run = 1
      else want.Sprint = 1
      const k = 1 - Math.exp(-step * 9)
      for (const name of Object.keys(weights) as Array<keyof typeof weights>) {
        weights[name] = blend(want[name], weights[name], k)
        legActions.get(name)?.setEffectiveWeight(weights[name])
      }
      const walk = legActions.get('Walk'), run = legActions.get('Run'), sprint = legActions.get('Sprint')
      if (walk) walk.timeScale = THREE.MathUtils.clamp(speed / WALK_CYCLE_SPEED, 0.6, 1.8)
      if (run) run.timeScale = THREE.MathUtils.clamp(speed / RUN_CYCLE_SPEED, 0.8, 2.1)
      if (sprint) sprint.timeScale = THREE.MathUtils.clamp(speed / SPRINT_CYCLE_SPEED, 0.9, 2.1)
      mixer.update(step)
      // The chest leans with the aim (the upper-body pose holds the gun up)
      for (const bone of spine) bone.rotateX(-pitch * 0.5)
      group.updateMatrixWorld(true)
      if (held === 'launcher') {
        // On the right shoulder, pointing where they aim
        gunHolder.position.set(0.24, 1.72, 0)
        gunHolder.rotation.set(pitch, 0, 0)
      } else if (grip) {
        grip.getWorldPosition(gripPos)
        gunHolder.position.copy(body.worldToLocal(gripPos))
        gunHolder.rotation.set(pitch, 0, 0)
      }
    },
    die() {
      if (deathTime >= 0) return
      deathTime = 0
      deathStart = performance.now()
      carriedGem.visible = false
      label.visible = false
      flash.visible = false
      gunHolder.visible = false
      startDeathClip()
    },
    revive() {
      deathTime = -1
      body.position.y = 0
      label.visible = true
      gunHolder.visible = true
      deathAction?.stop()
      for (const name of Object.keys(weights) as Array<keyof typeof weights>) weights[name] = name === 'Idle' ? 1 : 0
      for (const [name, action] of legActions) action.setEffectiveWeight(weights[name as keyof typeof weights] ?? 0)
      aimAction?.reset().setEffectiveWeight(1).play()
    },
    deathVisible() {
      if (deathTime < 0) return false
      return (performance.now() - deathStart) / 1000 < DEATH_FALL + DEATH_LIE + DEATH_SINK
    },
    flinch() {
      playOnce(hitAction, 1.3)
    },
    throwGrenade() {
      playOnce(throwAction, 1.6)
    },
    setWeapon(kind) {
      if (kind === held) return
      held = kind
      if (kind) loadGun(kind)
      showHeld()
    },
    fire() {
      flash.visible = true
      flash.material.rotation = Math.random() * Math.PI * 2
      flash.scale.setScalar(0.7 + Math.random() * 0.5)
      flashUntil = performance.now() + FLASH_MS
      group.updateMatrixWorld(true)
      return muzzle.getWorldPosition(new THREE.Vector3())
    },
    dispose() {
      disposed = true
      mixer?.stopAllAction()
      // The robot's geometry, textures and team materials are shared between avatars; only free our own
      for (const object of own) {
        // Sprites share one built-in geometry, and the flash texture is shared by every avatar
        if ((object as THREE.Mesh).isMesh) object.geometry.dispose()
        const material = object.material as THREE.Material & { map?: THREE.Texture | null }
        if (material.map && material.map !== flashTexture) material.map.dispose()
        material.dispose()
      }
    },
  }
}
