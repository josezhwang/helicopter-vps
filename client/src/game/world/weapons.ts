/**
 * Carried weapons. Everyone starts with the handgun (sidearm) and the primary gun (long gun); the bases'
 * gun tables hold more long guns, and the rack the anti-aircraft launcher. You carry one weapon per slot:
 * picking up another long gun puts yours down. Rounds are shared per ammo type (e.g. every 5.56 rifle).
 * The server has its own copy of power / fire rate / range / magazine sizes and never trusts the client.
 */
export type WeaponKind = 'handgun' | 'primary' | 'm4a1' | 'm254' | 'pulse' | 'm240b' | 'plasma' | 'm170' | 'svd' | 'launcher'
export type Slot = 'sidearm' | 'long' | 'launcher'
export type AmmoType = '9mm' | '556' | '762' | 'sniper' | 'plasma' | 'missile'
export type RoundKind = 'bullet_9mm' | 'bullet_556' | 'bullet_heavy' | 'bolt'
export type GunModel = 'handgun' | 'primary' | 'launcher' | 'gun_m4a1' | 'gun_m254' | 'gun_pulse' | 'gun_m240b' | 'gun_plasma' | 'gun_m170' | 'gun_svd'

export const SLOTS: Slot[] = ['sidearm', 'long', 'launcher']
export const WEAPON_KINDS: WeaponKind[] = ['handgun', 'primary', 'm4a1', 'm254', 'pulse', 'm240b', 'plasma', 'm170', 'svd', 'launcher']
/** Long guns laid out on each base's gun table. */
export const TABLE_GUNS: WeaponKind[] = ['m4a1', 'm254', 'pulse', 'm240b', 'plasma', 'm170', 'svd']

export interface WeaponDef {
  kind: WeaponKind
  name: string
  slot: Slot
  ammo: AmmoType
  model: GunModel
  /** Damage per round (the launcher's missile destroys a helicopter outright). */
  power: number
  magSize: number
  /** Seconds between shots. */
  fireRate: number
  range: number
  /** Spread in radians. */
  spread: number
  reloadTime: number
  /** Keeps firing while the button is held (otherwise one shot per click). */
  automatic: boolean
  round: RoundKind | null
  color: number
  /** How far the view kicks up per shot (radians). */
  kick: number
  /** Right mouse: aim down the sights (field of view divided by this). Snipers get a scope. */
  zoom: number
  scope?: boolean
}

const def = (d: WeaponDef) => d
export const WEAPONS: Record<WeaponKind, WeaponDef> = {
  handgun: def({ kind: 'handgun', name: 'Handgun', slot: 'sidearm', ammo: '9mm', model: 'handgun', power: 15, magSize: 7, fireRate: 0.28, range: 160, spread: 0.006, reloadTime: 1.2, automatic: false, round: 'bullet_9mm', color: 0xffe8a3, kick: 0.02, zoom: 1.25 }),
  primary: def({ kind: 'primary', name: 'Primary Gun', slot: 'long', ammo: '556', model: 'primary', power: 9, magSize: 30, fireRate: 0.1, range: 260, spread: 0.012, reloadTime: 1.8, automatic: true, round: 'bullet_556', color: 0xffd27a, kick: 0.006, zoom: 1.4 }),
  m4a1: def({ kind: 'm4a1', name: 'M4A1', slot: 'long', ammo: '556', model: 'gun_m4a1', power: 11, magSize: 30, fireRate: 0.085, range: 300, spread: 0.009, reloadTime: 2, automatic: true, round: 'bullet_556', color: 0xffd27a, kick: 0.007, zoom: 1.5 }),
  m254: def({ kind: 'm254', name: 'M254 Rifle', slot: 'long', ammo: '556', model: 'gun_m254', power: 13, magSize: 36, fireRate: 0.11, range: 320, spread: 0.008, reloadTime: 2.2, automatic: true, round: 'bullet_556', color: 0x9fe0ff, kick: 0.008, zoom: 1.6 }),
  pulse: def({ kind: 'pulse', name: 'Heavy Pulse MG', slot: 'long', ammo: '762', model: 'gun_pulse', power: 12, magSize: 60, fireRate: 0.07, range: 280, spread: 0.03, reloadTime: 3.2, automatic: true, round: 'bullet_heavy', color: 0x8fd8ff, kick: 0.01, zoom: 1.3 }),
  m240b: def({ kind: 'm240b', name: 'M240B', slot: 'long', ammo: '762', model: 'gun_m240b', power: 15, magSize: 100, fireRate: 0.09, range: 350, spread: 0.025, reloadTime: 4.2, automatic: true, round: 'bullet_heavy', color: 0xffc070, kick: 0.012, zoom: 1.3 }),
  plasma: def({ kind: 'plasma', name: 'Plasma Gun', slot: 'long', ammo: 'plasma', model: 'gun_plasma', power: 34, magSize: 8, fireRate: 0.55, range: 140, spread: 0.01, reloadTime: 2.5, automatic: false, round: 'bolt', color: 0x6dff7a, kick: 0.03, zoom: 1.3 }),
  m170: def({ kind: 'm170', name: 'M170 Sniper', slot: 'long', ammo: 'sniper', model: 'gun_m170', power: 80, magSize: 5, fireRate: 1.3, range: 650, spread: 0, reloadTime: 3, automatic: false, round: 'bullet_556', color: 0xfff2c0, kick: 0.05, zoom: 5, scope: true }),
  svd: def({ kind: 'svd', name: 'SVD Dragunov', slot: 'long', ammo: 'sniper', model: 'gun_svd', power: 55, magSize: 10, fireRate: 0.45, range: 550, spread: 0.002, reloadTime: 2.6, automatic: false, round: 'bullet_556', color: 0xfff2c0, kick: 0.035, zoom: 4, scope: true }),
  launcher: def({ kind: 'launcher', name: 'AA Launcher', slot: 'launcher', ammo: 'missile', model: 'launcher', power: 0, magSize: 1, fireRate: 1.5, range: 700, spread: 0, reloadTime: 2.2, automatic: false, round: null, color: 0xffffff, kick: 0.03, zoom: 1.5 }),
}

/** Spare rounds you can carry per ammo type (on top of what is loaded), and what the bases' ammo boxes hold. */
export const AMMO: Record<AmmoType, { name: string; max: number; box: number }> = {
  '9mm': { name: '9mm rounds', max: 14, box: 42 },
  '556': { name: '5.56 rounds', max: 60, box: 120 },
  '762': { name: '7.62 belts', max: 200, box: 300 },
  sniper: { name: 'sniper rounds', max: 20, box: 30 },
  plasma: { name: 'plasma cells', max: 24, box: 32 },
  missile: { name: 'AA missiles', max: 4, box: 4 },
}
export const AMMO_TYPES = Object.keys(AMMO) as AmmoType[]

/** Base machine guns: slow, heavy rounds. */
export const MACHINE_GUN = { id: 'machine-gun', power: 45, fireRate: 0.7, range: 450, spread: 0.004, color: 0xffb35a }
/** The battle car's roof gatling. */
export const CAR_GUN = { id: 'car-gun', power: 14, fireRate: 0.1, range: 350, spread: 0.014, color: 0xffcf6a }

/** Holding the launcher on an enemy aircraft this long locks on. */
export const LOCK_TIME = 2
/** How far off the crosshair (radians) an aircraft can be and still count as aimed at. */
export const LOCK_CONE = 0.07
