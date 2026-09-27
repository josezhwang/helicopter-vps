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
const PRIMARY_AMMO: Array<[number, number]> = [[-8, 42], [-8, 44.5], [-8, 47]]
const HANDGUN_AMMO: Array<[number, number]> = [[8, 42], [8, 44.5], [8, 47]]

/** Gem pedestal per team (world XZ). */
export const GEM_PEDESTAL: Record<Team, [number, number]> = { blue: baseToWorld('blue', ...GEM), red: baseToWorld('red', ...GEM) }

/** Machine guns by id (`<team>-mg-<n>`), world XZ. */
export const MACHINE_GUN_SPOTS = new Map<string, [number, number]>(
  TEAMS.flatMap((team) => MACHINE_GUNS.map((spot, i) => [`${team}-mg-${i}`, baseToWorld(team, ...spot)] as const)),
)

export type ItemKind = 'handgun' | 'primary' | 'launcher' | 'missiles' | 'ammo-primary' | 'ammo-handgun'
export const WEAPON_ITEMS: ItemKind[] = ['handgun', 'primary', 'launcher']

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

/** Rounds (or missiles) per full supply: each missile crate holds 4 missiles. */
export const SUPPLY: Record<'missiles' | 'ammo-primary' | 'ammo-handgun', number> = { missiles: 4, 'ammo-primary': 120, 'ammo-handgun': 42 }

/** A fresh match's supplies: per base 10 launchers on the rack, 10 missile crates, 3 boxes of each ammo. */
export function initialItems(): Item[] {
  const items: Item[] = []
  for (const team of TEAMS) {
    const put = (id: string, kind: ItemKind, spot: [number, number], count: number) => {
      const [x, z] = baseToWorld(team, ...spot)
      items.push({ id: `${team}-${id}`, kind, x, z, yaw: baseYaw(team, Math.PI), count, mag: 0, fixed: true })
    }
    for (let i = 0; i < LAUNCHER_RACK.count; i++) put(`launcher-${i}`, 'launcher', [LAUNCHER_RACK.x0 + i * LAUNCHER_RACK.dx, LAUNCHER_RACK.z], 0)
    MISSILE_CRATES.forEach((spot, i) => put(`missiles-${i}`, 'missiles', spot, SUPPLY.missiles))
    PRIMARY_AMMO.forEach((spot, i) => put(`ammo-primary-${i}`, 'ammo-primary', spot, SUPPLY['ammo-primary']))
    HANDGUN_AMMO.forEach((spot, i) => put(`ammo-handgun-${i}`, 'ammo-handgun', spot, SUPPLY['ammo-handgun']))
  }
  return items
}
