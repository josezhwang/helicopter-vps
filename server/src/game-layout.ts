/**
 * The parts of the map the server checks: where each base's gem, machine guns and supplies are.
 * Must match client/src/game/world/layout.ts (base frame: +Z is the gate side; each base is turned so its
 * gate faces midfield).
 */
export type Team = 'blue' | 'red'
export const TEAMS: Team[] = ['blue', 'red']

const BASE_CENTER: Record<Team, { x: number; z: number }> = { blue: { x: -380, z: -380 }, red: { x: 380, z: 380 } }
const BASE_ROTATION: Record<Team, number> = { blue: Math.PI / 2, red: -Math.PI / 2 }

export function baseToWorld(team: Team, x: number, z: number): [number, number] {
  const c = BASE_CENTER[team]
  const a = BASE_ROTATION[team]
  return [c.x + x * Math.cos(a) + z * Math.sin(a), c.z - x * Math.sin(a) + z * Math.cos(a)]
}

const baseYaw = (team: Team, yaw: number) => yaw + BASE_ROTATION[team]

const GEM: [number, number] = [-8, 2]
const MACHINE_GUNS: Array<[number, number]> = [[-62, 0], [62, 0], [0, -63], [-18, 60], [18, 60]]
const LAUNCHER_RACK = { x0: 3, dx: 2, z: -2, count: 10 }
const row = (count: number, x0: number, dx: number, z: number) => Array.from({ length: count }, (_, i) => [x0 + i * dx, z] as [number, number])
const MISSILE_CRATES = [...row(5, 4, 4, 5), ...row(5, 4, 4, 9)]
const GUN_TABLE = { x: 20, z0: -40, dz: 2, count: 14 }
const TABLE_GUNS = ['m4a1', 'm254', 'pulse', 'm240b', 'plasma', 'm170', 'svd'] as const
const AMMO_ROW = { x: 24.5, z0: -40, dz: 3.5, types: ['556', '556', '762', '762', 'sniper', 'sniper', 'plasma', 'plasma'] as const }
const PRIMARY_AMMO: Array<[number, number]> = [[-8, 42], [-8, 44.5], [-8, 47]]
const HANDGUN_AMMO: Array<[number, number]> = [[8, 42], [8, 44.5], [8, 47]]

/** Gem pedestal per team (world XZ). */
export const GEM_PEDESTAL: Record<Team, [number, number]> = { blue: baseToWorld('blue', ...GEM), red: baseToWorld('red', ...GEM) }

/** Machine guns by id (`<team>-mg-<n>`), world XZ. */
export const MACHINE_GUN_SPOTS = new Map<string, [number, number]>(
  TEAMS.flatMap((team) => MACHINE_GUNS.map((spot, i) => [`${team}-mg-${i}`, baseToWorld(team, ...spot)] as const)),
)

/** Must match client/src/game/world/weapons.ts */
export const WEAPONS = {
  handgun: { slot: 'sidearm', ammo: '9mm', mag: 7, power: 15, fireRate: 0.28, range: 160 },
  primary: { slot: 'long', ammo: '556', mag: 30, power: 9, fireRate: 0.1, range: 260 },
  m4a1: { slot: 'long', ammo: '556', mag: 30, power: 11, fireRate: 0.085, range: 300 },
  m254: { slot: 'long', ammo: '556', mag: 36, power: 13, fireRate: 0.11, range: 320 },
  pulse: { slot: 'long', ammo: '762', mag: 60, power: 12, fireRate: 0.07, range: 280 },
  m240b: { slot: 'long', ammo: '762', mag: 100, power: 15, fireRate: 0.09, range: 350 },
  plasma: { slot: 'long', ammo: 'plasma', mag: 8, power: 34, fireRate: 0.55, range: 140 },
  m170: { slot: 'long', ammo: 'sniper', mag: 5, power: 80, fireRate: 1.3, range: 650 },
  svd: { slot: 'long', ammo: 'sniper', mag: 10, power: 55, fireRate: 0.45, range: 550 },
  launcher: { slot: 'launcher', ammo: 'missile', mag: 1, power: 0, fireRate: 1.5, range: 700 },
} as const
export type WeaponKind = keyof typeof WEAPONS
export type AmmoType = '9mm' | '556' | '762' | 'sniper' | 'plasma' | 'missile'
/** Spare rounds a player can carry, and what a base's ammo box holds. */
export const AMMO: Record<AmmoType, { max: number; box: number }> = {
  '9mm': { max: 14, box: 42 }, '556': { max: 60, box: 120 }, '762': { max: 200, box: 300 },
  sniper: { max: 20, box: 30 }, plasma: { max: 24, box: 32 }, missile: { max: 4, box: 4 },
}
export const AMMO_TYPES = Object.keys(AMMO) as AmmoType[]

/** A weapon lying around, `ammo-<type>` boxes, or a crate of AA missiles (`ammo-missile`). */
export type ItemKind = WeaponKind | `ammo-${AmmoType}`
export const isWeaponItem = (kind: string): kind is WeaponKind => kind in WEAPONS
export const isItemKind = (kind: string): kind is ItemKind => isWeaponItem(kind) || AMMO_TYPES.some((a) => kind === `ammo-${a}`)
/** Which spare rounds an item holds. */
export const ammoOf = (kind: ItemKind): AmmoType => (isWeaponItem(kind) ? WEAPONS[kind].ammo : (kind.slice(5) as AmmoType))

export interface Item {
  id: string
  kind: ItemKind
  x: number
  z: number
  yaw: number
  count: number
  mag: number
  fixed: boolean
  gone?: boolean
}

/** A fresh match's supplies: per base 10 launchers on the rack, 10 missile crates (4 each), 14 long guns on the gun table, ammo boxes. */
export function initialItems(): Item[] {
  const items: Item[] = []
  for (const team of TEAMS) {
    const put = (id: string, kind: ItemKind, spot: [number, number], count: number) => {
      const [x, z] = baseToWorld(team, ...spot)
      items.push({ id: `${team}-${id}`, kind, x, z, yaw: baseYaw(team, Math.PI), count, mag: 0, fixed: true })
    }
    for (let i = 0; i < LAUNCHER_RACK.count; i++) put(`launcher-${i}`, 'launcher', [LAUNCHER_RACK.x0 + i * LAUNCHER_RACK.dx, LAUNCHER_RACK.z], 0)
    MISSILE_CRATES.forEach((spot, i) => put(`missiles-${i}`, 'ammo-missile', spot, AMMO.missile.box))
    PRIMARY_AMMO.forEach((spot, i) => put(`ammo-556-${i}`, 'ammo-556', spot, AMMO['556'].box))
    HANDGUN_AMMO.forEach((spot, i) => put(`ammo-9mm-${i}`, 'ammo-9mm', spot, AMMO['9mm'].box))
    for (let i = 0; i < GUN_TABLE.count; i++) {
      const kind = TABLE_GUNS[i % TABLE_GUNS.length]
      put(`gun-${i}`, kind, [GUN_TABLE.x, GUN_TABLE.z0 + i * GUN_TABLE.dz], 0)
      // Table guns come loaded, lying across the table
      items[items.length - 1].mag = WEAPONS[kind].mag
      items[items.length - 1].yaw = baseYaw(team, -Math.PI / 2)
    }
    AMMO_ROW.types.forEach((type, i) => put(`ammo-row-${i}`, `ammo-${type}`, [AMMO_ROW.x, AMMO_ROW.z0 + i * AMMO_ROW.dz], AMMO[type].box))
  }
  return items
}
