import * as THREE from 'three'
import { WEAPONS, type WeaponDef, type WeaponId } from './weapons'

export class Weapon {
  def: WeaponDef = WEAPONS['primary-handgun']
  ammo = this.def.magSize
  reloading = false
  private reloadTimer = 0
  private cooldown = 0
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private tracerPool: THREE.Mesh[] = []
  private flashLight: THREE.PointLight
  private flashTimer = 0
  private onShoot?: () => void

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, onShoot?: () => void) {
    this.scene = scene
    this.camera = camera
    this.onShoot = onShoot

    this.flashLight = new THREE.PointLight(0xffc873, 0, 18)
    scene.add(this.flashLight)

    const tracerGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 4)
    tracerGeo.rotateX(Math.PI / 2)
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe8a3, transparent: true, opacity: 0.9 })
    for (let i = 0; i < 24; i++) {
      const tracer = new THREE.Mesh(tracerGeo, tracerMat.clone())
      tracer.visible = false
      this.scene.add(tracer)
      this.tracerPool.push(tracer)
    }
  }

  /** Own a new weapon: full mag, no reload in progress. */
  setWeapon(id: WeaponId) {
    this.def = WEAPONS[id]
    this.ammo = this.def.magSize
    this.reloading = false
    this.reloadTimer = 0
    this.cooldown = 0
  }

  get weaponId(): WeaponId {
    return this.def.id
  }

  tryFire(input: { shooting: boolean }, dt: number, targets: THREE.Object3D[]) {
    this.cooldown -= dt
    this.flashTimer -= dt
    if (this.flashTimer <= 0) this.flashLight.intensity = 0

    if (!input.shooting || this.reloading || this.cooldown > 0 || this.ammo <= 0) return

    this.cooldown = this.def.fireRate
    this.ammo--
    this.onShoot?.()

    // Muzzle flash + hitscan with per-weapon spread
    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    if (this.def.spread > 0) {
      const spreadX = (Math.random() - 0.5) * this.def.spread
      const spreadY = (Math.random() - 0.5) * this.def.spread
      dir.add(new THREE.Vector3(spreadX, spreadY, 0)).normalize()
    }
    this.flashLight.position.copy(origin).addScaledVector(dir, 1.2)
    this.flashLight.intensity = 30

    const raycaster = new THREE.Raycaster(origin, dir, 0.5, this.def.range)
    const hits = raycaster.intersectObjects(targets, true)

    const tracer = this.tracerPool.find((t) => !t.visible)
    if (tracer) {
      const end = hits.length > 0 ? hits[0].point : origin.clone().addScaledVector(dir, this.def.range)
      const start = origin.clone().addScaledVector(dir, 1.4)
      const len = start.distanceTo(end)
      tracer.position.copy(start).lerp(end, 0.5)
      tracer.lookAt(end)
      tracer.scale.set(1, 1, len)
      tracer.visible = true
      const mat = tracer.material as THREE.MeshBasicMaterial
      mat.color.setHex(this.def.color)
      mat.opacity = 0.9
      const fade = () => {
        mat.opacity -= 0.12
        if (mat.opacity > 0) requestAnimationFrame(fade)
        else tracer.visible = false
      }
      requestAnimationFrame(fade)
    }
  }

  reload() {
    if (this.reloading || this.ammo === this.def.magSize) return
    this.reloading = true
    this.reloadTimer = this.def.reloadTime
  }

  /** Call once per frame so reload timers progress even while flying. */
  tick(dt: number) {
    this.cooldown = Math.max(0, this.cooldown - dt)
    if (this.reloading) {
      this.reloadTimer -= dt
      if (this.reloadTimer <= 0) {
        this.ammo = this.def.magSize
        this.reloading = false
      }
    }
  }
}