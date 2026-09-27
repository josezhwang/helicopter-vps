import * as THREE from 'three'
import { loadProp, propGroup } from './props'
import type { WeaponKind } from './weapons'

/** Where each weapon sits in view (camera space): position and a slight inward turn. */
const POSES: Record<WeaponKind, { pos: THREE.Vector3; yaw: number; roll: number }> = {
  handgun: { pos: new THREE.Vector3(0.3, -0.22, -0.55), yaw: -0.1, roll: 0.04 },
  primary: { pos: new THREE.Vector3(0.6, -0.42, -0.8), yaw: -0.2, roll: 0.08 },
  // Over the right shoulder, most of the tube ahead of the eye
  launcher: { pos: new THREE.Vector3(0.42, -0.26, -0.45), yaw: -0.04, roll: 0 },
}

/**
 * First-person weapon, CS-style: no hands, the gun in the bottom-right of the screen, drawn on top of
 * everything so it never clips into walls.
 */
export class Viewmodel {
  group = new THREE.Group()
  private current: WeaponKind | null = null
  private recoil = 0
  private switchDip = 0
  private models = new Map<WeaponKind, THREE.Object3D>()

  constructor(private camera: THREE.PerspectiveCamera) {
    this.camera.add(this.group)
    for (const kind of Object.keys(POSES) as WeaponKind[]) {
      void loadProp(kind).then((prop) => {
        const model = propGroup(prop, false)
        model.traverse((node) => {
          node.frustumCulled = false
          node.renderOrder = 1000
          const mesh = node as THREE.Mesh
          if (!mesh.isMesh) return
          // Own material copies: drawn on top of the world without touching the shared ones
          mesh.material = (mesh.material as THREE.Material).clone()
          mesh.material.depthTest = false
          mesh.material.depthWrite = false
        })
        this.models.set(kind, model)
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
    const model = kind ? this.models.get(kind) : null
    if (model) this.group.add(model)
  }

  /** Recoil kick, reload dip, weapon-switch dip and walking sway. Call every frame. */
  update(dt: number, opts: { recoilKick: boolean; reloading: boolean; hidden: boolean; moving: boolean; time: number }) {
    this.group.visible = !opts.hidden && !!this.current
    if (!this.group.visible || !this.current) return
    const pose = POSES[this.current]
    if (opts.recoilKick) this.recoil = 1
    this.recoil = Math.max(0, this.recoil - dt * 7)
    this.switchDip = Math.max(0, this.switchDip - dt * 4)
    const sway = opts.moving ? Math.sin(opts.time * 9) * 0.012 : Math.sin(opts.time * 1.6) * 0.004
    const reloadDip = opts.reloading ? 0.22 : 0
    const kick = this.current === 'launcher' ? 0.25 : 0.09
    this.group.position.set(pose.pos.x, pose.pos.y + sway - reloadDip - this.switchDip * 0.3, pose.pos.z + this.recoil * kick)
    this.group.rotation.set(this.recoil * (this.current === 'handgun' ? 0.35 : 0.22) + reloadDip * 2.2, pose.yaw, pose.roll + this.recoil * 0.2)
  }
}
