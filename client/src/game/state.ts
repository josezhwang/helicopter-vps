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
  vehicle: 'heli' | 'car' | null
  seat: number
  /** Manning a base machine gun. */
  onGun: boolean
  /** What [E] and [G] would do right now ('' = nothing in reach). */
  interactPrompt: string
  pickupPrompt: string
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

const INITIAL_STATE: GameState = {
  ammo: 30,
  maxAmmo: 30,
  reserve: 60,
  reloading: false,
  weapons: ['handgun', 'primary'],
  current: 'primary',
  vehicle: null,
  seat: 0,
  onGun: false,
  interactPrompt: '',
  pickupPrompt: '',
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
