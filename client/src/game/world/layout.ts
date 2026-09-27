/**
 * Where everything sits in and around a base, in the base model's own frame (metres): +Z is the gate side,
 * +X the helicopter side. Each team's base is the same model turned so its gate faces the middle of the map
 * (blue's towards +X, red's towards -X), which makes the map point-symmetric.
 *
 * The server keeps a copy of the positions it checks (gem, machine guns, supply items): server/src/game-layout.ts
 */
export type Team = 'blue' | 'red'

export const BASE_CENTER: Record<Team, { x: number; z: number }> = { blue: { x: -380, z: -380 }, red: { x: 380, z: 380 } }
/** Yaw that turns the base model (gate along +Z) so the gate faces midfield. */
export const BASE_ROTATION: Record<Team, number> = { blue: Math.PI / 2, red: -Math.PI / 2 }
/** Half the base model's footprint (its walls), and the flat ground around it. */
export const BASE_HALF = 53
export const PLATEAU_HALF = 60

export function baseToWorld(team: Team, x: number, z: number): { x: number; z: number } {
  const c = BASE_CENTER[team]
  const a = BASE_ROTATION[team]
  const cos = Math.cos(a), sin = Math.sin(a)
  return { x: c.x + x * cos + z * sin, z: c.z - x * sin + z * cos }
}

/** A heading in the base frame (0 = towards the gate) turned into a world heading (0 = +Z). */
export const baseYaw = (team: Team, yaw: number) => yaw + BASE_ROTATION[team]

type Spot = readonly [number, number]
const row = (count: number, x0: number, dx: number, z: number): Spot[] => Array.from({ length: count }, (_, i) => [x0 + i * dx, z] as const)

export const LAYOUT = {
  /** The team's gem, on open ground in the middle of the base. */
  gem: [-8, 2] as Spot,
  /** Respawn spots just inside the gate, two rows. */
  spawn: [...row(8, -7, 2, 37), ...row(8, -7, 2, 40)],
  /** Helicopters on the landing area, noses towards the middle of the base. */
  helis: row(5, 34, 0, -42).map(([x], i) => [x, -42 + i * 14] as const),
  heliYaw: -Math.PI / 2,
  /** Battle cars parked side by side outside, beside the gate, noses out. */
  cars: row(5, 24, 6, 66),
  carYaw: 0,
  /** Machine guns just outside the walls, barrels pointing away from the base. */
  machineGuns: [[-62, 0], [62, 0], [0, -63], [-18, 60], [18, 60]] as Spot[],
  /** Anti-aircraft launchers lying on a rack in front of the warehouse. */
  launcherRack: { x0: 3, dx: 2, z: -2, count: 10 },
  /** Missile crates (4 missiles each), two rows of five. */
  missileCrates: [...row(5, 4, 4, 5), ...row(5, 4, 4, 9)],
  /** The gun table beside the helicopter row: two of every long gun, lying across it. */
  gunTable: { x: 20, z0: -40, dz: 2, count: 14 },
  /** Ammo for the table's guns, in a row beside it. */
  ammoRow: { x: 24.5, z0: -40, dz: 3.5, types: ['556', '556', '762', '762', 'sniper', 'sniper', 'plasma', 'plasma'] as const },
  /** Ammo boxes in the fenced gate lane behind the spawn: primary-gun (5.56) rounds left, handgun (9mm) rounds right. */
  primaryAmmo: [[-8, 42], [-8, 44.5], [-8, 47]] as Spot[],
  handgunAmmo: [[8, 42], [8, 44.5], [8, 47]] as Spot[],
}
