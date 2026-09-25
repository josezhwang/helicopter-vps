export interface GameState {
  ammo: number
  maxAmmo: number
  reloading: boolean
  inHelicopter: boolean
  nearHelicopter: boolean
  nearPickupLabel: string
  carryingFlag: boolean
  score: number
  message: string
  /** Rotor RPM while piloting (0–1000, viewer-style x10 readout). */
  rotorRpm: number
  /** Player health — starts at 100. */
  health: number
  weaponName: string
  weaponPower: number
  /** True once the flag is captured: victory screen shows. */
  finished: boolean
}

type Listener = (s: GameState) => void

const INITIAL_STATE: GameState = {
  ammo: 12,
  maxAmmo: 12,
  reloading: false,
  inHelicopter: false,
  nearHelicopter: false,
  nearPickupLabel: '',
  carryingFlag: false,
  score: 0,
  rotorRpm: 0,
  health: 100,
  weaponName: 'Primary Handgun',
  weaponPower: 5,
  finished: false,
  message: 'Steal the RED flag from the enemy base and bring it to your BLUE base to WIN. [E] to interact.',
}

export const gameState: GameState = { ...INITIAL_STATE }

const listeners = new Set<Listener>()

export function resetGameState() {
  Object.assign(gameState, INITIAL_STATE)
  listeners.forEach((fn) => fn(gameState))
}

export function subscribeGameState(fn: Listener): () => void {
  listeners.add(fn)
  fn(gameState)
  return () => {
    listeners.delete(fn)
  }
}

export function setGameState(patch: Partial<GameState>) {
  Object.assign(gameState, patch)
  listeners.forEach((fn) => fn(gameState))
}
