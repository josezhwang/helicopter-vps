/**
 * Carried weapons. Every player starts with the handgun and the primary gun; the anti-aircraft launcher is
 * picked up from a base rack. "Loads" are magazines: the gun holds one, the rest are carried spare.
 * The server has its own copy of power / fire rate / range and never trusts the client's damage.
 */
export type WeaponKind = 'handgun' | 'primary' | 'launcher'
export const WEAPON_KINDS: WeaponKind[] = ['handgun', 'primary', 'launcher']

export interface WeaponDef {
  kind: WeaponKind
  name: string
  /** Damage per bullet (the launcher's missile destroys a helicopter outright). */
  power: number
  magSize: number
  /** Spare rounds you can carry on top of the loaded magazine. */
  maxReserve: number
  /** Seconds between shots. */
  fireRate: number
  range: number
  /** Spread in radians. */
  spread: number
  reloadTime: number
  /** Keeps firing while the button is held (otherwise one shot per click). */
  automatic: boolean
  /** What the round looks like in flight. */
  bullet: 'bullet_9mm' | 'bullet_556' | null
  color: number
}

export const WEAPONS: Record<WeaponKind, WeaponDef> = {
  handgun: {
    kind: 'handgun', name: 'Handgun', power: 15, magSize: 7, maxReserve: 14, fireRate: 0.28, range: 160,
    spread: 0.006, reloadTime: 1.2, automatic: false, bullet: 'bullet_9mm', color: 0xffe8a3,
  },
  primary: {
    kind: 'primary', name: 'Primary Gun', power: 9, magSize: 30, maxReserve: 60, fireRate: 0.1, range: 260,
    spread: 0.012, reloadTime: 1.8, automatic: true, bullet: 'bullet_556', color: 0xffd27a,
  },
  launcher: {
    kind: 'launcher', name: 'AA Launcher', power: 0, magSize: 1, maxReserve: 4, fireRate: 1.5, range: 700,
    spread: 0, reloadTime: 2.2, automatic: false, bullet: null, color: 0xffffff,
  },
}

/** Base machine guns: slow but hard-hitting. */
export const MACHINE_GUN = { id: 'machine-gun', power: 45, fireRate: 0.7, range: 450, spread: 0.004, color: 0xffb35a }

/** Holding the launcher on an enemy aircraft this long locks on. */
export const LOCK_TIME = 2
/** How far off the crosshair (radians) an aircraft can be and still count as aimed at. */
export const LOCK_CONE = 0.07
