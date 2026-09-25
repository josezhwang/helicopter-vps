import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { WEAPONS, type WeaponId } from './weapons'

/**
 * First-person weapon viewmodel — CS-style, no hands, just the gun sitting in
 * the bottom-right of the screen. The starting handgun loads from the GLB the
 * user provided; pickup weapons use matching procedural models.
 */
export class Viewmodel {
  group = new THREE.Group()
  private currentId: WeaponId | null = null
  private recoil = 0
  private models = new Map<WeaponId, THREE.Object3D>()
  private basePos = new THREE.Vector3(0.62, -0.42, -0.8)

  constructor(private camera: THREE.PerspectiveCamera) {
    this.camera.add(this.group)
    this.group.position.copy(this.basePos)
    this.group.rotation.y = -0.2
    this.group.rotation.z = 0.08
    this.group.traverse((o) => {
      o.frustumCulled = false
    })
  }

  /** Loads the GLB handgun once at startup; failures fall back to a box model. */
  loadHandgun() {
    const loader = new GLTFLoader()
    loader.load(
      '/primary-handgun.glb',
      (gltf) => {
        const model = gltf.scene
        model.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = false
            const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial
            if (mat) mat.envMapIntensity = 0.4
          }
        })
        // Normalize to ~0.5 units long, orient along -Z, grip in hand
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        model.scale.setScalar(0.5 / maxDim)
        model.position.set(0, 0, 0)
        model.rotation.y = Math.PI / 2
        const gun = new THREE.Group()
        gun.add(model)
        this.models.set('primary-handgun', gun)
        if (this.currentId === 'primary-handgun') this.show('primary-handgun')
      },
      undefined,
      () => {
        this.models.set('primary-handgun', this.proceduralPistol())
        if (this.currentId === 'primary-handgun') this.show('primary-handgun')
      },
    )
  }

  private proceduralPistol(): THREE.Group {
    const g = new THREE.Group()
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.5, metalness: 0.5 })
    const grip = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.9 })
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      m.rotation.x = rx
      g.add(m)
    }
    add(new THREE.BoxGeometry(0.06, 0.09, 0.3), dark, 0, 0, -0.05) // slide
    const barrel = add(new THREE.CylinderGeometry(0.014, 0.014, 0.14, 8), dark, 0, 0.01, -0.25, Math.PI / 2)
    void barrel
    add(new THREE.BoxGeometry(0.05, 0.14, 0.07), grip, 0, -0.1, 0.06, 0.28) // grip
    return g
  }

  /** Procedural long-guns for the field pickups. */
  private proceduralLong(id: WeaponId): THREE.Group {
    const g = new THREE.Group()
    const color = WEAPONS[id].color
    const body = new THREE.MeshStandardMaterial({ color: 0x26292e, roughness: 0.5, metalness: 0.45 })
    const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 })
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, z)
      m.rotation.x = rx
      g.add(m)
      return m
    }
    if (id === 'smg') {
      add(new THREE.BoxGeometry(0.07, 0.1, 0.42), body, 0, 0, -0.05)
      add(new THREE.BoxGeometry(0.05, 0.05, 0.22), accent, 0, 0.005, -0.34)
      add(new THREE.BoxGeometry(0.05, 0.16, 0.08), body, 0, -0.12, -0.02)
      add(new THREE.BoxGeometry(0.06, 0.08, 0.16), body, 0, -0.01, 0.2)
    } else if (id === 'battle-rifle') {
      add(new THREE.BoxGeometry(0.08, 0.11, 0.55), body, 0, 0, -0.05)
      add(new THREE.CylinderGeometry(0.02, 0.02, 0.34, 8), accent, 0, 0.01, -0.42, Math.PI / 2)
      add(new THREE.BoxGeometry(0.06, 0.18, 0.09), body, 0, -0.13, -0.02)
      add(new THREE.BoxGeometry(0.07, 0.1, 0.24), body, 0, -0.01, 0.3)
      add(new THREE.BoxGeometry(0.03, 0.05, 0.1), body, 0, 0.085, -0.08)
    } else {
      // magnum
      add(new THREE.BoxGeometry(0.06, 0.1, 0.32), body, 0, 0, -0.06)
      const cylinder = add(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 8), accent, 0, -0.01, -0.08, Math.PI / 2)
      void cylinder
      add(new THREE.BoxGeometry(0.05, 0.13, 0.07), body, 0, -0.1, 0.08, 0.32)
      add(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8), body, 0, 0.02, -0.28, Math.PI / 2)
    }
    return g
  }

  show(id: WeaponId) {
    if (this.currentId === id && this.group.children.length > 0) return
    this.group.clear()
    this.currentId = id
    let model = this.models.get(id)
    if (!model && id !== 'primary-handgun') {
      model = this.proceduralLong(id)
      this.models.set(id, model)
    }
    if (model) {
      this.group.add(model)
      this.group.traverse((o) => {
        o.frustumCulled = false
      })
    }
  }

  /** Recoil kick + reload dip. Call every frame. */
  update(dt: number, opts: { recoilKick: boolean; reloading: boolean; hidden: boolean; moving: boolean; time: number }) {
    this.group.visible = !opts.hidden
    if (opts.hidden) return

    if (opts.recoilKick) this.recoil = 1
    this.recoil = Math.max(0, this.recoil - dt * 7)

    const sway = opts.moving ? Math.sin(opts.time * 9) * 0.012 : Math.sin(opts.time * 1.6) * 0.004
    const reloadDip = opts.reloading ? 0.22 : 0

    this.group.position.set(
      this.basePos.x,
      this.basePos.y + sway - reloadDip,
      this.basePos.z + this.recoil * 0.09,
    )
    this.group.rotation.x = this.recoil * 0.22 + reloadDip * 2.2
    this.group.rotation.z = 0.08 + this.recoil * 0.4
  }
}
