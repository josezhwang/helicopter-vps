/**
 * Weapon definitions. The starting handgun is deliberately weak;
 * field pickups are stronger. Damage scales per weapon.
 */
export type WeaponId = 'primary-handgun' | 'smg' | 'battle-rifle' | 'magnum'

export interface WeaponDef {
  id: WeaponId
  name: string
  /** Damage per bullet. */
  power: number
  magSize: number
  fireRate: number // seconds between shots
  range: number
  /** Spread in radians (handgun accurate, SMG sprayier). */
  spread: number
  color: number
  reloadTime: number
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  'primary-handgun': {
    id: 'primary-handgun',
    name: 'Primary Handgun',
    power: 5,
    magSize: 12,
    fireRate: 0.35,
    range: 180,
    spread: 0.004,
    color: 0xffe8a3,
    reloadTime: 1.4,
  },
  smg: {
    id: 'smg',
    name: 'SMG',
    power: 9,
    magSize: 30,
    fireRate: 0.09,
    range: 220,
    spread: 0.02,
    color: 0xa3e0ff,
    reloadTime: 1.8,
  },
  'battle-rifle': {
    id: 'battle-rifle',
    name: 'Battle Rifle',
    power: 18,
    magSize: 20,
    fireRate: 0.18,
    range: 320,
    spread: 0.006,
    color: 0xd0ffa3,
    reloadTime: 2.2,
  },
  magnum: {
    id: 'magnum',
    name: 'Magnum',
    power: 32,
    magSize: 6,
    fireRate: 0.55,
    range: 380,
    spread: 0.002,
    color: 0xffc0a3,
    reloadTime: 2.6,
  },
}
