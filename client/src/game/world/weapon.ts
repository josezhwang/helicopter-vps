import * as THREE from 'three'
import { WEAPONS, WEAPON_KINDS, type WeaponDef, type WeaponKind } from './weapons'

export interface Shot {
  /** Where the round left (just in front of the camera) and where it stopped. */
  start: THREE.Vector3
  end: THREE.Vector3
  /** What it hit first (null = open air). */
  object: THREE.Object3D | null
  kind: WeaponKind
}

/**
 * What a player carries: up to one weapon of each kind with its loaded magazine, plus spare rounds per
 * ammo type (the launcher's spare rounds are missiles). Handles switching, reloading and hitscan fire.
 */
export class Arsenal {
  slots: Partial<Record<WeaponKind, { mag: number }>> = {}
  reserve: Record<WeaponKind, number> = { handgun: 0, primary: 0, launcher: 0 }
  current: WeaponKind | null = null
  reloading = false
  private reloadTimer = 0
  private cooldown = 0
  private wasShooting = false
  private shotsFired = 0
  private flashLight: THREE.PointLight
  private flashTimer = 0

  constructor(scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private onShoot?: () => void) {
    this.flashLight = new THREE.PointLight(0xffc873, 0, 18)
    scene.add(this.flashLight)
    this.reset()
  }

  /** The starting loadout: handgun and primary gun, each with three magazines. */
  reset() {
    this.slots = { handgun: { mag: WEAPONS.handgun.magSize }, primary: { mag: WEAPONS.primary.magSize } }
    this.reserve = { handgun: WEAPONS.handgun.maxReserve, primary: WEAPONS.primary.maxReserve, launcher: 0 }
    this.current = 'primary'
    this.cancelReload()
  }

  get def(): WeaponDef | null {
    return this.current ? WEAPONS[this.current] : null
  }

  get mag(): number {
    return this.current ? this.slots[this.current]?.mag ?? 0 : 0
  }

  get shotCount(): number {
    return this.shotsFired
  }

  has(kind: WeaponKind) {
    return !!this.slots[kind]
  }

  /** Spare rounds (or missiles) that still fit. */
  space(kind: WeaponKind) {
    return Math.max(0, WEAPONS[kind].maxReserve - this.reserve[kind])
  }

  addReserve(kind: WeaponKind, rounds: number) {
    const added = Math.min(this.space(kind), Math.max(0, rounds))
    this.reserve[kind] += added
    return added
  }

  /** Pick up a weapon we don't have yet, with whatever its magazine holds; switches to it. */
  give(kind: WeaponKind, mag: number) {
    this.slots[kind] = { mag: THREE.MathUtils.clamp(Math.round(mag), 0, WEAPONS[kind].magSize) }
    this.select(kind)
  }

  /** Put a weapon down: returns its loaded rounds and all spare rounds for it, and switches to the next one. */
  remove(kind: WeaponKind): { mag: number; spare: number } | null {
    const slot = this.slots[kind]
    if (!slot) return null
    delete this.slots[kind]
    const spare = this.reserve[kind]
    this.reserve[kind] = 0
    if (this.current === kind) {
      this.current = WEAPON_KINDS.find((k) => this.slots[k]) ?? null
      this.cancelReload()
    }
    return { mag: slot.mag, spare }
  }

  select(kind: WeaponKind) {
    if (!this.slots[kind] || this.current === kind) return
    this.current = kind
    this.cancelReload()
    this.cooldown = Math.max(this.cooldown, 0.25)
  }

  /** [F]: the next weapon we carry. */
  switchNext() {
    const owned = WEAPON_KINDS.filter((k) => this.slots[k])
    if (owned.length < 2) return
    const next = owned[(owned.indexOf(this.current ?? owned[0]) + 1) % owned.length]
    this.select(next)
  }

  reload() {
    const def = this.def
    const slot = this.current ? this.slots[this.current] : undefined
    if (!def || !slot || this.reloading || slot.mag >= def.magSize || this.reserve[def.kind] <= 0) return
    this.reloading = true
    this.reloadTimer = def.reloadTime
  }

  private cancelReload() {
    this.reloading = false
    this.reloadTimer = 0
  }

  /** Call once per frame so reload timers and cooldowns keep running. */
  tick(dt: number) {
    this.cooldown = Math.max(0, this.cooldown - dt)
    this.flashTimer -= dt
    if (this.flashTimer <= 0) this.flashLight.intensity = 0
    if (!this.reloading) return
    this.reloadTimer -= dt
    const def = this.def
    const slot = this.current ? this.slots[this.current] : undefined
    if (this.reloadTimer > 0 || !def || !slot) return
    const moved = Math.min(def.magSize - slot.mag, this.reserve[def.kind])
    slot.mag += moved
    this.reserve[def.kind] -= moved
    this.reloading = false
  }

  /** Whether the trigger fires this frame (automatic weapons while held, others once per click). */
  private trigger(shooting: boolean) {
    const pressed = shooting && !this.wasShooting
    this.wasShooting = shooting
    const def = this.def
    if (!def || this.reloading || this.cooldown > 0) return false
    return def.automatic ? shooting : pressed
  }

  /** Handgun / primary gun hitscan: the nearest thing along the (slightly spread) aim line takes the round. */
  tryFire(input: { shooting: boolean }, targets: THREE.Object3D[]): Shot | null {
    const def = this.def
    if (!this.trigger(input.shooting) || !def || def.kind === 'launcher') return null
    const slot = this.slots[def.kind]!
    if (slot.mag <= 0) {
      this.reload()
      return null
    }
    this.cooldown = def.fireRate
    slot.mag--
    this.shotsFired++
    this.onShoot?.()

    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    if (def.spread > 0) dir.add(new THREE.Vector3((Math.random() - 0.5) * def.spread, (Math.random() - 0.5) * def.spread, (Math.random() - 0.5) * def.spread)).normalize()
    this.flash(origin, dir)
    const hits = new THREE.Raycaster(origin, dir, 0.5, def.range).intersectObjects(targets, true)
    const end = hits.length > 0 ? hits[0].point.clone() : origin.clone().addScaledVector(dir, def.range)
    if (slot.mag === 0) this.reload()
    return { start: origin.clone().addScaledVector(dir, 1.2), end, object: hits[0]?.object ?? null, kind: def.kind }
  }

  /** Launcher: true (and one missile used) when a loaded launcher is fired. */
  fireMissile(shooting: boolean): boolean {
    if (this.current !== 'launcher' || !this.trigger(shooting)) return false
    const slot = this.slots.launcher!
    if (slot.mag <= 0) {
      this.reload()
      return false
    }
    slot.mag--
    this.cooldown = WEAPONS.launcher.fireRate
    this.shotsFired++
    this.onShoot?.()
    this.flash(this.camera.getWorldPosition(new THREE.Vector3()), this.camera.getWorldDirection(new THREE.Vector3()))
    if (this.reserve.launcher > 0) this.reload()
    return true
  }

  /** Keep the trigger state current on frames where firing isn't allowed (so a held button doesn't count as a click). */
  holdTrigger(shooting: boolean) {
    this.wasShooting = shooting
  }

  private flash(origin: THREE.Vector3, dir: THREE.Vector3) {
    this.flashLight.position.copy(origin).addScaledVector(dir, 1.2)
    this.flashLight.intensity = 30
    this.flashTimer = 0.06
  }

  /** Compact loadout for the network (dropped as pickups where we die): [loaded, spare] per kind, loaded = -1 if not carried. */
  snapshot(): number[] {
    return WEAPON_KINDS.flatMap((k) => [this.slots[k]?.mag ?? -1, this.reserve[k]])
  }
}
