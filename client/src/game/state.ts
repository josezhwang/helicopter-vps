import type { Team } from './world/bases'

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
  ammo: number
  maxAmmo: number
  reloading: boolean
  /** What we are flying/driving, if anything, and what we could board with [E]. */
  vehicle: 'heli' | 'car' | null
  nearVehicle: 'heli' | 'car' | null
  nearPickupLabel: string
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
  weaponPower: number
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
  ammo: 12,
  maxAmmo: 12,
  reloading: false,
  vehicle: null,
  nearVehicle: null,
  nearPickupLabel: '',
  carryingGem: false,
  score: 0,
  rotorRpm: 0,
  speedKmh: 0,
  health: 100,
  weaponName: 'Primary Handgun',
  weaponPower: 5,
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
