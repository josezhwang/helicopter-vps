import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import type { Team } from './bases'

export const TEAM_COLOR: Record<Team, number> = { blue: 0x2e6fbd, red: 0xb03a2e }

const ROBOT_URL = '/robot_animated_1.glb'
const ROBOT_HEIGHT = 2.0
/** Ground speed (world units/s) at which the robot's run cycle plays at normal speed. */
const RUN_CYCLE_SPEED = 12
const MOVING_SPEED = 0.8
const GUN_URL = '/primary-handgun.glb'
/** Held pistol, a bit oversized so it reads clearly at a distance. */
const GUN_LENGTH = 0.55
const FLASH_MS = 70

export interface Avatar {
  group: THREE.Group
  carriedFlag: THREE.Object3D
  /** Advance animation; `speed` is ground speed in world units/s, `pitch` the player's aim pitch. */
  update: (dt: number, speed: number, pitch: number) => void
  /** Show the muzzle flash and return the muzzle's world position for the tracer. */
  fire: () => THREE.Vector3
  dispose: () => void
}

interface GunAsset {
  model: THREE.Object3D
  /** Barrel tip in the model's local space (barrel points along -Z). */
  muzzle: THREE.Vector3
}

let gunAsset: Promise<GunAsset | null> | null = null

/** A separate copy from the first-person viewmodel, whose materials are tuned to draw on top. */
function loadGun(): Promise<GunAsset | null> {
  gunAsset ??= new GLTFLoader().loadAsync(GUN_URL).then((gltf) => {
    const inner = gltf.scene
    const size = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3())
    inner.scale.setScalar(GUN_LENGTH / (Math.max(size.x, size.y, size.z) || 1))
    inner.rotation.y = -Math.PI / 2 // same orientation as the viewmodel: barrel along -Z
    const model = new THREE.Group()
    model.add(inner)
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    // Centre the grip area on the origin so the hand holds the middle, barrel pointing forward
    const center = box.getCenter(new THREE.Vector3())
    inner.position.sub(center)
    model.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.raycast = noRaycast
    })
    const muzzle = new THREE.Vector3(0, box.max.y - center.y - (box.max.y - box.min.y) * 0.3, box.min.z - center.z)
    return { model, muzzle }
  }).catch((error) => {
    console.error('[avatar] handgun model failed to load:', error)
    return null
  })
  return gunAsset
}

let flashTexture: THREE.Texture | null = null
function muzzleFlashTexture(): THREE.Texture {
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

interface RobotAsset {
  scene: THREE.Object3D
  idle: THREE.AnimationClip
  run: THREE.AnimationClip
  scale: number
  lift: number
}

let robotAsset: Promise<RobotAsset | null> | null = null

/** Loaded once and shared; every avatar gets its own skeleton clone. */
function loadRobot(): Promise<RobotAsset | null> {
  robotAsset ??= new GLTFLoader().loadAsync(ROBOT_URL).then((gltf) => {
    const idle = gltf.animations.find((clip) => clip.name.endsWith('idle01'))
    const run = gltf.animations.find((clip) => clip.name.endsWith('dash'))
    if (!idle || !run) throw new Error('robot model is missing its idle01/dash animations')
    // The clips rescale the bones, so measure the robot as it actually renders: posed by its idle clip
    const probe = new THREE.AnimationMixer(gltf.scene)
    probe.clipAction(idle).play()
    probe.update(0)
    gltf.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(gltf.scene, true)
    probe.stopAllAction()
    probe.uncacheRoot(gltf.scene)
    const scale = ROBOT_HEIGHT / (box.max.y - box.min.y)
    return { scene: gltf.scene, idle, run, scale, lift: -box.min.y * scale }
  }).catch((error) => {
    console.error('[avatar] robot model failed to load, keeping simple soldiers:', error)
    return null
  })
  return robotAsset
}

// Team tint as a soft emissive glow over the robot's own paint, shared per team
const teamMaterials: Record<Team, Map<THREE.Material, THREE.Material>> = { blue: new Map(), red: new Map() }
function teamMaterial(source: THREE.Material, team: Team): THREE.Material {
  let material = teamMaterials[team].get(source)
  if (!material) {
    material = source.clone()
    if (material instanceof THREE.MeshStandardMaterial) {
      material.emissive = new THREE.Color(TEAM_COLOR[team])
      material.emissiveIntensity = 0.45
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

  // Simple soldier shown until the robot model has loaded (or if it fails to load)
  const fallback = new THREE.Group()
  const teamMat = new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], roughness: 0.7 })
  const gearMat = new THREE.MeshStandardMaterial({ color: 0x2f3a2c, roughness: 0.9 })
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a77e, roughness: 0.8 })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 4, 12), teamMat)
  body.position.y = 1.0
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), skinMat)
  head.position.y = 1.78
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), gearMat)
  helmet.position.y = 1.82
  for (const mesh of [body, head, helmet]) {
    mesh.castShadow = true
    mesh.raycast = noRaycast
    fallback.add(mesh)
    own.push(mesh)
  }
  group.add(fallback)

  // Invisible capsule used for bullet hits, so hit detection doesn't depend on the animated mesh
  const hitbox = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.0, 2, 8), new THREE.MeshBasicMaterial({ visible: false }))
  hitbox.position.y = 1.0
  group.add(hitbox)
  own.push(hitbox)

  const carriedFlag = new THREE.Group()
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 6), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.8 }))
  pole.position.y = 0.9
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.55),
    new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team === 'blue' ? 'red' : 'blue'], side: THREE.DoubleSide }),
  )
  cloth.position.set(0.45, 1.5, 0)
  for (const mesh of [pole, cloth]) {
    mesh.raycast = noRaycast
    own.push(mesh)
  }
  carriedFlag.add(pole, cloth)
  carriedFlag.position.set(-0.2, 1.1, 0.35)
  carriedFlag.visible = false
  group.add(carriedFlag)

  // Held handgun: follows the robot's right hand, points where the player aims
  const gunHolder = new THREE.Group()
  gunHolder.position.set(0.32, 1.25, -0.3)
  group.add(gunHolder)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.05, -GUN_LENGTH / 2)
  gunHolder.add(muzzle)
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  flash.scale.setScalar(0.9)
  flash.visible = false
  flash.raycast = noRaycast
  muzzle.add(flash)
  let flashUntil = 0
  void loadGun().then((asset) => {
    if (!asset || disposed) return
    gunHolder.add(asset.model.clone())
    muzzle.position.copy(asset.muzzle)
  })

  const label = nameLabel(name, team)
  label.position.y = 2.55
  // Bullets pass through name tags (sprite raycasts also need a camera on the raycaster)
  label.raycast = noRaycast
  group.add(label)
  own.push(label)
  own.push(flash)

  let disposed = false
  let mixer: THREE.AnimationMixer | null = null
  let idle: THREE.AnimationAction | null = null
  let run: THREE.AnimationAction | null = null
  let runWeight = 0
  let rightHand: THREE.Object3D | null = null
  const handPos = new THREE.Vector3()

  void loadRobot().then((asset) => {
    if (!asset || disposed) return
    const model = SkeletonUtils.clone(asset.scene)
    model.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.raycast = noRaycast
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => teamMaterial(m, team)) : teamMaterial(mesh.material, team)
    })
    const holder = new THREE.Group()
    holder.scale.setScalar(asset.scale)
    holder.position.y = asset.lift
    holder.rotation.y = Math.PI // model faces +Z; avatars face -Z
    holder.add(model)
    group.add(holder)
    fallback.visible = false

    mixer = new THREE.AnimationMixer(model)
    idle = mixer.clipAction(asset.idle).play()
    run = mixer.clipAction(asset.run).play()
    run.setEffectiveWeight(0)
    model.traverse((node) => { if (/^Bip001.R.Hand/.test(node.name)) rightHand = node })
  })

  return {
    group,
    carriedFlag,
    update(dt, speed, pitch) {
      if (flash.visible && performance.now() > flashUntil) flash.visible = false
      gunHolder.rotation.set(pitch, 0, 0)
      if (!mixer || !idle || !run) return
      const moving = speed > MOVING_SPEED
      runWeight = THREE.MathUtils.lerp(runWeight, moving ? 1 : 0, 1 - Math.exp(-dt * 8))
      idle.setEffectiveWeight(1 - runWeight)
      run.setEffectiveWeight(runWeight)
      run.timeScale = THREE.MathUtils.clamp(speed / RUN_CYCLE_SPEED, 0.6, 1.4)
      mixer.update(dt)
      if (rightHand) {
        group.updateMatrixWorld(true)
        rightHand.getWorldPosition(handPos)
        gunHolder.position.copy(group.worldToLocal(handPos))
      }
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
