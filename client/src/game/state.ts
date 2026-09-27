import type { Quality } from './world/graphics'
import type { Team } from './world/bases'
import type { WeaponKind } from './world/weapons'

export type PlayerStatus = 'on foot' | 'flying' | 'driving' | 'carrying gem' | 'dead' | 'offline'

export interface RosterEntry {
  id: string
  name: string
  team: Team | null
  status: PlayerStatus
  hp: number
  you: boolean
}

/** One line of the kill feed. */
export interface KillEntry {
  id: number
  killer: string
  killerTeam: Team | null
  victim: string
  victimTeam: Team | null
  /** What did it (weapon / explosion name). */
  how: string
  /** We were the killer or the victim. */
  mine: boolean
}

export interface GameState {
  /** Loaded rounds, magazine size and spare rounds of the weapon in hand. */
  ammo: number
  maxAmmo: number
  reserve: number
  reloading: boolean
  /** Weapons carried, and the one in hand. */
  weapons: WeaponKind[]
  current: WeaponKind | null
  /** What we are flying/driving, if anything, and in which seat (0 = pilot / driver). */
  vehicle: 'heli' | 'car' | 'tank' | 'mech' | null
  /** Our vehicle's hull strength, 0..1. */
  vehicleHp: number
  /** Tank cannon: 0..1 loaded (1 = ready), -1 when not driving a tank. */
  cannon: number
  /** Where the tank's gun is pointing on screen (0..1), -1 when not driving one. */
  gunX: number
  gunY: number
  /** Looking through the tank's gunner sight. */
  tankSight: boolean
  /** Hand grenades carried ([Q] throws one). */
  grenades: number
  killFeed: KillEntry[]
  /** Graphics setting in use (Ultra / High / Medium / Low). */
  quality: Quality
  /** A mech's jump-jet fuel, 0..1. */
  jet: number
  /** Where the last damage came from, relative to where we look (radians, 0 = ahead, + = to the right); null = unknown. */
  damageDir: number | null
  seat: number
  /** Manning a base machine gun. */
  onGun: boolean
  /** What [E] and [G] would do right now ('' = nothing in reach). */
  interactPrompt: string
  pickupPrompt: string
  /** Looking through a sniper scope. */
  scoped: boolean
  /** Driving a battle car: the roof gatling is ours to fire. */
  carGun: boolean
  /** Launcher lock-on: -1 when not aiming the launcher, else 0..1 (1 = locked); where the target is on screen (0..1). */
  lock: number
  lockX: number
  lockY: number
  carryingGem: boolean
  score: number
  message: string
  /** Rotor RPM while piloting (0–1000, viewer-style x10 readout). */
  rotorRpm: number
  /** Car speed while driving, km/h. */
  speedKmh: number
  /** Player health — starts at 100. */
  health: number
  weaponName: string
  /** True once either team steals the other's gem: result screen shows. */
  finished: boolean
  team: Team | null
  players: RosterEntry[]
  winner: Team | null
  connected: boolean
  dead: boolean
  /** Increments on every confirmed hit we land / damage we take, to flash the HUD. */
  hitsLanded: number
  damageTaken: number
}

type Listener = (s: GameState) => void

/** Something on the radar (world XZ). */
export interface RadarBlip {
  x: number
  z: number
  kind: 'mate' | 'enemy' | 'heli' | 'car' | 'tank' | 'mech' | 'gem' | 'barrel'
  team: Team | null
  /** Heading (world, 0 = +Z) for players and vehicles. */
  yaw: number
  /** A vehicle: nobody in it (drawn dim). */
  empty?: boolean
  /** Carrying a gem. */
  gem?: boolean
}

/**
 * The radar's picture, written by the game a few times a second and drawn by the HUD on its own clock (so it
 * never re-renders the rest of the HUD). `version` goes up with every new picture.
 */
export const radar = { x: 0, z: 0, yaw: 0, range: 180, blips: [] as RadarBlip[], version: 0 }

const INITIAL_STATE: GameState = {
  ammo: 30,
  maxAmmo: 30,
  reserve: 60,
  reloading: false,
  weapons: ['handgun', 'primary'],
  current: 'primary',
  vehicle: null,
  vehicleHp: 1,
  cannon: -1,
  gunX: -1,
  gunY: -1,
  tankSight: false,
  grenades: 2,
  killFeed: [],
  quality: 'ultra',
  jet: 1,
  damageDir: null,
  seat: 0,
  onGun: false,
  interactPrompt: '',
  pickupPrompt: '',
  scoped: false,
  carGun: false,
  lock: -1,
  lockX: -1,
  lockY: -1,
  carryingGem: false,
  score: 0,
  rotorRpm: 0,
  speedKmh: 0,
  health: 100,
  weaponName: 'Primary Gun',
  finished: false,
  message: 'Connecting to the battle…',
  team: null,
  players: [],
  winner: null,
  connected: false,
  dead: false,
  hitsLanded: 0,
  damageTaken: 0,
}

export const gameState: GameState = { ...INITIAL_STATE }

const listeners = new Set<Listener>()

const notify = () => {
  const snapshot = { ...gameState }
  listeners.forEach((fn) => fn(snapshot))
}

export function resetGameState() {
  Object.assign(gameState, INITIAL_STATE)
  notify()
}

export function subscribeGameState(fn: Listener): () => void {
  listeners.add(fn)
  fn({ ...gameState })
  return () => {
    listeners.delete(fn)
  }
}

export function setGameState(patch: Partial<GameState>) {
  // Called every frame; only re-render the HUD when something actually changed
  const changed = (Object.keys(patch) as Array<keyof GameState>).some((key) => !Object.is(gameState[key], patch[key]))
  if (!changed) return
  Object.assign(gameState, patch)
  notify()
}
