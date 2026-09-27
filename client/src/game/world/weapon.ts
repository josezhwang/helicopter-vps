import * as THREE from 'three'
import { AMMO, AMMO_TYPES, SLOTS, WEAPONS, type AmmoType, type Slot, type WeaponDef, type WeaponKind } from './weapons'

export interface Shot {
  /** Where the round left (just in front of the camera) and where it stopped. */
  start: THREE.Vector3
  end: THREE.Vector3
  /** What it hit first (null = open air), and the hit details for marks and dust. */
  object: THREE.Object3D | null
  hit: THREE.Intersection | null
  dir: THREE.Vector3
  kind: WeaponKind
}

/** Loadout on the wire: one [kind, loaded rounds] per slot (null = empty) and spare rounds per ammo type. */
export interface Loadout {
  s: Array<[WeaponKind, number] | null>
  r: Partial<Record<AmmoType, number>>
}

/**
 * What a player carries: one weapon per slot (sidearm, long gun, launcher) with its loaded magazine, and
 * spare rounds per ammo type. Handles switching, reloading and hitscan fire.
 */
export class Arsenal {
  slots: Partial<Record<Slot, { kind: WeaponKind; mag: number }>> = {}
  reserve = {} as Record<AmmoType, number>
  current: Slot | null = null
  reloading = false
  private reloadTimer = 0
  private cooldown = 0
  private wasShooting = false
  private shotsFired = 0
  private flashLight: THREE.PointLight
  private flashTimer = 0

  constructor(scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private onShoot?: (def: WeaponDef) => void) {
    this.flashLight = new THREE.PointLight(0xffc873, 0, 18)
    scene.add(this.flashLight)
    this.reset()
  }

  /** The starting loadout: handgun and primary gun, each with three magazines. */
  reset() {
    this.slots = { sidearm: { kind: 'handgun', mag: WEAPONS.handgun.magSize }, long: { kind: 'primary', mag: WEAPONS.primary.magSize } }
    this.reserve = Object.fromEntries(AMMO_TYPES.map((a) => [a, 0])) as Record<AmmoType, number>
    this.reserve['9mm'] = WEAPONS.handgun.magSize * 2
    this.reserve['556'] = WEAPONS.primary.magSize * 2
    this.current = 'long'
    this.cancelReload()
  }

  /** Nothing at all (dead: it was all left on the ground). */
  clear() {
    this.slots = {}
    this.reserve = Object.fromEntries(AMMO_TYPES.map((a) => [a, 0])) as Record<AmmoType, number>
    this.current = null
    this.cancelReload()
  }

  get kind(): WeaponKind | null {
    return this.current ? this.slots[this.current]?.kind ?? null : null
  }

  get def(): WeaponDef | null {
    const kind = this.kind
    return kind ? WEAPONS[kind] : null
  }

  get mag(): number {
    return this.current ? this.slots[this.current]?.mag ?? 0 : 0
  }

  get shotCount(): number {
    return this.shotsFired
  }

  carried(): WeaponKind[] {
    return SLOTS.map((s) => this.slots[s]?.kind).filter((k): k is WeaponKind => !!k)
  }

  has(kind: WeaponKind) {
    return this.slots[WEAPONS[kind].slot]?.kind === kind
  }

  /** What is in the slot a weapon would go into. */
  inSlotOf(kind: WeaponKind) {
    return this.slots[WEAPONS[kind].slot] ?? null
  }

  /** Spare rounds (or missiles) that still fit. */
  space(ammo: AmmoType) {
    return Math.max(0, AMMO[ammo].max - this.reserve[ammo])
  }

  addReserve(ammo: AmmoType, rounds: number) {
    const added = Math.min(this.space(ammo), Math.max(0, rounds))
    this.reserve[ammo] += added
    return added
  }

  /** Take a weapon into its (empty) slot with whatever its magazine holds, and switch to it. */
  give(kind: WeaponKind, mag: number) {
    const slot = WEAPONS[kind].slot
    this.slots[slot] = { kind, mag: THREE.MathUtils.clamp(Math.round(mag), 0, WEAPONS[kind].magSize) }
    this.select(slot)
  }

  /** Put a weapon down: its loaded rounds and the spare rounds only it uses go with it; switches to the next one. */
  remove(slot: Slot): { kind: WeaponKind; mag: number; spare: number } | null {
    const held = this.slots[slot]
    if (!held) return null
    delete this.slots[slot]
    const ammo = WEAPONS[held.kind].ammo
    const shared = SLOTS.some((s) => this.slots[s] && WEAPONS[this.slots[s]!.kind].ammo === ammo)
    const spare = shared ? 0 : this.reserve[ammo]
    if (!shared) this.reserve[ammo] = 0
    if (this.current === slot) {
      this.current = SLOTS.find((s) => this.slots[s]) ?? null
      this.cancelReload()
    }
    return { kind: held.kind, mag: held.mag, spare }
  }

  select(slot: Slot) {
    if (!this.slots[slot] || this.current === slot) return
    this.current = slot
    this.cancelReload()
    this.cooldown = Math.max(this.cooldown, 0.3)
  }

  /** [F]: the next weapon we carry. */
  switchNext() {
    const owned = SLOTS.filter((s) => this.slots[s])
    if (owned.length < 2) return
    this.select(owned[(owned.indexOf(this.current ?? owned[0]) + 1) % owned.length])
  }

  reload() {
    const def = this.def
    const held = this.current ? this.slots[this.current] : undefined
    if (!def || !held || this.reloading || held.mag >= def.magSize || this.reserve[def.ammo] <= 0) return
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
    const held = this.current ? this.slots[this.current] : undefined
    if (this.reloadTimer > 0 || !def || !held) return
    const moved = Math.min(def.magSize - held.mag, this.reserve[def.ammo])
    held.mag += moved
    this.reserve[def.ammo] -= moved
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

  /** Hitscan: the nearest thing along the (slightly spread) aim line takes the round. `steady` narrows the spread (aiming). */
  tryFire(input: { shooting: boolean }, targets: THREE.Object3D[], steady = 1): Shot | null {
    const def = this.def
    if (!this.trigger(input.shooting) || !def || def.slot === 'launcher') return null
    const held = this.slots[def.slot]!
    if (held.mag <= 0) {
      this.reload()
      return null
    }
    this.cooldown = def.fireRate
    held.mag--
    this.shotsFired++
    this.onShoot?.(def)

    const origin = this.camera.getWorldPosition(new THREE.Vector3())
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    const spread = def.spread * steady
    if (spread > 0) dir.add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread)).normalize()
    this.flash(origin, dir)
    const hits = new THREE.Raycaster(origin, dir, 0.5, def.range).intersectObjects(targets, true)
    const end = hits.length > 0 ? hits[0].point.clone() : origin.clone().addScaledVector(dir, def.range)
    if (held.mag === 0) this.reload()
    return { start: origin.clone().addScaledVector(dir, 1.2), end, object: hits[0]?.object ?? null, hit: hits[0] ?? null, dir, kind: def.kind }
  }

  /** Launcher: true (and one missile used) when a loaded launcher is fired. */
  fireMissile(shooting: boolean): boolean {
    if (this.current !== 'launcher' || !this.trigger(shooting)) return false
    const held = this.slots.launcher!
    if (held.mag <= 0) {
      this.reload()
      return false
    }
    held.mag--
    this.cooldown = WEAPONS.launcher.fireRate
    this.shotsFired++
    this.onShoot?.(WEAPONS.launcher)
    this.flash(this.camera.getWorldPosition(new THREE.Vector3()), this.camera.getWorldDirection(new THREE.Vector3()))
    if (this.reserve.missile > 0) this.reload()
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

  /** For the network: what we would leave on the ground if we died. */
  snapshot(): Loadout {
    const r: Partial<Record<AmmoType, number>> = {}
    for (const a of AMMO_TYPES) if (this.reserve[a] > 0) r[a] = this.reserve[a]
    return { s: SLOTS.map((s) => (this.slots[s] ? [this.slots[s]!.kind, this.slots[s]!.mag] : null)), r }
  }
}
