import * as THREE from 'three'
import { loadProp, propGroup, type Prop } from './props'
import { WEAPONS, WEAPON_KINDS, type WeaponKind } from './weapons'

/** How big each weapon is drawn in first person (the handgun a little larger than life, so it reads clearly). */
const VIEW_SCALE: Partial<Record<WeaponKind, number>> = { handgun: 1.3 }

interface Pose { pos: THREE.Vector3; yaw: number; roll: number }

/** Held at the hip (bottom right) or aimed down the sights (centred, closer), per weapon length. */
function poses(kind: WeaponKind, length: number): { hip: Pose; aim: Pose } {
  if (kind === 'handgun') {
    return { hip: { pos: new THREE.Vector3(0.24, -0.2, -0.48), yaw: -0.04, roll: 0.02 }, aim: { pos: new THREE.Vector3(0, -0.13, -0.42), yaw: 0, roll: 0 } }
  }
  if (kind === 'launcher') {
    // Over the right shoulder, most of the tube ahead of the eye
    return { hip: { pos: new THREE.Vector3(0.42, -0.26, -0.45), yaw: -0.04, roll: 0 }, aim: { pos: new THREE.Vector3(0.2, -0.2, -0.4), yaw: 0, roll: 0 } }
  }
  const heavy = kind === 'm240b' || kind === 'pulse'
  return {
    hip: { pos: new THREE.Vector3(0.3, heavy ? -0.36 : -0.3, -0.25 - length * 0.42), yaw: -0.07, roll: 0.05 },
    aim: { pos: new THREE.Vector3(0, heavy ? -0.24 : -0.19, -0.18 - length * 0.42), yaw: 0, roll: 0 },
  }
}

/**
 * First-person weapon, CS-style: no hands, the gun in the bottom-right of the screen (centred when aiming),
 * drawn on top of everything so it never clips into walls. Flashes at the muzzle when it fires.
 */
export class Viewmodel {
  group = new THREE.Group()
  private current: WeaponKind | null = null
  private recoil = 0
  private switchDip = 0
  /** Melee strike progress (1 → 0). */
  private bashing = 0
  private aim = 0
  private models = new Map<WeaponKind, { model: THREE.Object3D; prop: Prop; poses: { hip: Pose; aim: Pose }; flash: THREE.Sprite; eject: THREE.Object3D }>()
  private flashUntil = 0

  /** `rig` follows the camera in the viewmodel's own scene (see Graphics). */
  constructor(private camera: THREE.PerspectiveCamera, private rig: THREE.Object3D, flashTexture: THREE.Texture) {
    this.rig.add(this.group)
    for (const kind of WEAPON_KINDS) {
      void loadProp(WEAPONS[kind].model).then((prop) => {
        const model = propGroup(prop, false)
        model.scale.setScalar(VIEW_SCALE[kind] ?? 1)
        model.traverse((node) => {
          node.frustumCulled = false
        })
        const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture, color: kind === 'plasma' ? 0x8dff9a : 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }))
        flash.position.copy(prop.tip)
        flash.scale.setScalar(kind === 'handgun' ? 0.22 : 0.4)
        flash.renderOrder = 1001
        flash.visible = false
        model.add(flash)
        // Where casings fly out: the right side of the gun, a bit behind the middle
        const eject = new THREE.Object3D()
        eject.position.set(prop.box.max.x, (prop.box.max.y + prop.box.min.y) / 2 + 0.03, (prop.box.min.z + prop.box.max.z) / 2 + 0.05)
        model.add(eject)
        const length = (prop.box.max.z - prop.box.min.z) * (VIEW_SCALE[kind] ?? 1)
        this.models.set(kind, { model, prop, poses: poses(kind, length), flash, eject })
        if (this.current === kind) this.attach(kind)
      }).catch((error) => console.error(`[viewmodel] ${kind} model failed to load:`, error))
    }
  }

  show(kind: WeaponKind | null) {
    if (this.current === kind) return
    this.current = kind
    this.switchDip = 1
    this.attach(kind)
  }

  private attach(kind: WeaponKind | null) {
    this.group.clear()
    const entry = kind ? this.models.get(kind) : null
    if (entry) this.group.add(entry.model)
  }

  /** The gun fired: flash at the muzzle. Returns where the muzzle and the ejection port are in the world. */
  fired(): { muzzle: THREE.Vector3; eject: THREE.Vector3 } | null {
    const entry = this.current ? this.models.get(this.current) : null
    if (!entry || !this.group.visible) return null
    entry.flash.visible = true
    entry.flash.material.rotation = Math.random() * Math.PI * 2
    this.flashUntil = performance.now() + 50
    this.camera.updateMatrixWorld(true)
    this.rig.matrix.copy(this.camera.matrixWorld)
    this.rig.updateMatrixWorld(true)
    return { muzzle: entry.flash.getWorldPosition(new THREE.Vector3()), eject: entry.eject.getWorldPosition(new THREE.Vector3()) }
  }

  /** A melee strike: the gun butt swings forward and across. */
  bash() {
    this.bashing = 1
  }

  /** Recoil kick, reload dip, weapon-switch dip, aiming and walking sway. Call every frame. */
  update(dt: number, opts: { recoilKick: boolean; reloading: boolean; hidden: boolean; moving: boolean; aiming: boolean; time: number }) {
    this.group.visible = !opts.hidden && !!this.current
    const entry = this.current ? this.models.get(this.current) : null
    if (entry && performance.now() > this.flashUntil) entry.flash.visible = false
    if (!this.group.visible || !this.current || !entry) return
    const def = WEAPONS[this.current]
    if (opts.recoilKick) this.recoil = 1
    this.recoil = Math.max(0, this.recoil - dt * (def.automatic ? 10 : 6))
    this.switchDip = Math.max(0, this.switchDip - dt * 4)
    this.bashing = Math.max(0, this.bashing - dt * 3.2)
    // Out fast, back slower
    const phase = 1 - this.bashing
    const bash = this.bashing > 0 ? (phase < 0.35 ? phase / 0.35 : 1 - (phase - 0.35) / 0.65) : 0
    this.aim = THREE.MathUtils.clamp(this.aim + (opts.aiming ? dt : -dt) * 6, 0, 1)
    const { hip, aim } = entry.poses
    const k = this.aim
    const sway = (opts.moving ? Math.sin(opts.time * 9) * 0.012 : Math.sin(opts.time * 1.6) * 0.004) * (1 - k * 0.8)
    const reloadDip = opts.reloading ? 0.22 : 0
    const kick = (this.current === 'launcher' ? 0.25 : def.kick > 0.03 ? 0.14 : 0.06) * this.recoil
    this.group.position.set(
      THREE.MathUtils.lerp(hip.pos.x, aim.pos.x, k) - bash * 0.14,
      THREE.MathUtils.lerp(hip.pos.y, aim.pos.y, k) + sway - reloadDip - this.switchDip * 0.3 + bash * 0.06,
      THREE.MathUtils.lerp(hip.pos.z, aim.pos.z, k) + kick - bash * 0.32,
    )
    this.group.rotation.set(
      this.recoil * Math.min(0.35, def.kick * 8) + reloadDip * 2.2 - bash * 0.45,
      THREE.MathUtils.lerp(hip.yaw, aim.yaw, k) + bash * 0.5,
      THREE.MathUtils.lerp(hip.roll, aim.roll, k) + this.recoil * 0.08 + bash * 0.9,
    )
  }
}
