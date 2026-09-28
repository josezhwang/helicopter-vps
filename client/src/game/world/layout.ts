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
  /** Ammo for the table's guns (and grenades), in a row beside it. */
  ammoRow: { x: 24.5, z0: -40, dz: 3.5, types: ['556', '556', '762', '762', 'sniper', 'sniper', 'plasma', 'plasma', 'grenade', 'grenade'] as const },
  /** Two tanks left of the gate, outside the walls, noses out. */
  tanks: [[-30, 68], [-44, 68]] as Spot[],
  tankYaw: 0,
  /** Two combat mechs either side of the gate, outside the walls, facing out. */
  mechs: [[-58, 72], [62, 72]] as Spot[],
  mechYaw: 0,
  /** Two space fighters on pads outside the wall on the far side from the helicopters, noses towards midfield. */
  fighters: [[-74, 24], [-74, -12]] as Spot[],
  fighterYaw: 0,
  /** Explosive barrels: two by the gate, one by the fuel tanker. */
  barrels: [[-26, 57], [26, 57], [-21, 27]] as Spot[],
  /** Ammo boxes in the fenced gate lane behind the spawn: primary-gun (5.56) rounds left, handgun (9mm) rounds right. */
  primaryAmmo: [[-8, 42], [-8, 44.5], [-8, 47]] as Spot[],
  handgunAmmo: [[8, 42], [8, 44.5], [8, 47]] as Spot[],
}

/**
 * The capital ships hold station high over the map (noses along the X axis so their decks line up with the world
 * axes), each with a flight deck built out from its side: walkable, fighters can land on it, three heavy guns
 * along its rail. World coordinates; the server keeps a copy of the deck guns (server/src/game-layout.ts).
 */
export const SHIP_ALTITUDE = 700
export const SHIP_CENTER: Record<Team, { x: number; z: number }> = { blue: { x: -304, z: -304 }, red: { x: 304, z: 304 } }
export const SHIP_YAW: Record<Team, number> = { blue: Math.PI / 2, red: -Math.PI / 2 }
export const DECK_TOP = SHIP_ALTITUDE + 4
export const DECK: Record<Team, { minX: number; maxX: number; minZ: number; maxZ: number }> = {
  blue: { minX: -364, maxX: -244, minZ: -400, maxZ: -376 },
  red: { minX: 244, maxX: 364, minZ: 376, maxZ: 400 },
}
/** The hangar bay: an enclosed room on the deck's far end (world X range), open to the deck through a wide doorway. */
export const HANGAR: Record<Team, { minX: number; maxX: number; door: number }> = {
  blue: { minX: -364, maxX: -324, door: -324 },
  red: { minX: 324, maxX: 364, door: 324 },
}
export const HANGAR_HEIGHT = 10
/** Heavy guns on each deck's outer rail, facing out (0 = +Z). */
export const DECK_GUNS: Record<Team, { spots: Array<[number, number]>; facing: number }> = {
  blue: { spots: [[-314, -396], [-284, -396], [-254, -396]], facing: Math.PI },
  red: { spots: [[314, 396], [284, 396], [254, 396]], facing: 0 },
}
/** Teleport pads: one on the ground by each base's fighter pads, one inside its ship's hangar bay; each sends you to the other. */
export const TELEPORTS: Record<Team, { ground: { x: number; z: number }; deck: { x: number; z: number } }> = {
  blue: { ground: baseToWorld('blue', -74, 6), deck: { x: -354, z: -388 } },
  red: { ground: baseToWorld('red', -74, 6), deck: { x: 354, z: 388 } },
}

/**
 * Sandbag outposts in the open between the bases (world XZ, point-symmetric pairs). Each faces the base it is
 * further from: a U of sandbag walls with an explosive barrel and an ammo box. Must match the server.
 */
export const OUTPOSTS: Array<[number, number]> = [[-50, 80], [50, -80], [140, -120], [-140, 120], [130, 120], [-130, -120]]
export function outpostYaw(i: number): number {
  const [x, z] = OUTPOSTS[i]
  const far = Math.hypot(x + 380, z + 380) > Math.hypot(x - 380, z - 380) ? [-380, -380] : [380, 380]
  return Math.atan2(far[0] - x, far[1] - z)
}
/** A point in an outpost's own frame (+Z = the side it faces) in world XZ. */
export function outpostToWorld(i: number, x: number, z: number): { x: number; z: number } {
  const [cx, cz] = OUTPOSTS[i]
  const a = outpostYaw(i)
  return { x: cx + x * Math.cos(a) + z * Math.sin(a), z: cz - x * Math.sin(a) + z * Math.cos(a) }
}
export const OUTPOST_BARREL: Spot = [-4.6, -1.2]
export const OUTPOST_AMMO: Spot = [2.6, -1.6]
/** Sandbag walls of an outpost (own frame): centre, heading. Two across the front, one angled back on each side. */
export const OUTPOST_WALLS: Array<{ x: number; z: number; yaw: number }> = [
  { x: -1.6, z: 3, yaw: 0 }, { x: 1.6, z: 3, yaw: 0 },
  { x: -4.1, z: 1.2, yaw: Math.PI / 2 - 0.35 }, { x: 4.1, z: 1.2, yaw: -Math.PI / 2 + 0.35 },
]

/** Every explosive barrel, world XZ (ids as the server's). */
export const BARREL_SPOTS: Array<{ id: string; x: number; z: number }> = [
  ...(['blue', 'red'] as Team[]).flatMap((team) => LAYOUT.barrels.map(([x, z], i) => ({ id: `${team}-barrel-${i}`, ...baseToWorld(team, x, z) }))),
  ...OUTPOSTS.map((_, i) => ({ id: `outpost-${i}-barrel`, ...outpostToWorld(i, ...OUTPOST_BARREL) })),
]
