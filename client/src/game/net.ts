import { API_URL } from '../config'
import type { ItemKind, NetItem } from './world/items'
import type { Loadout } from './world/weapon'
import type { WeaponKind } from './world/weapons'

export type Team = 'red' | 'blue'
export type Vec3 = [number, number, number]

/**
 * `id` is `<team>-<heli|car>-<0..4>`; `seat` 0 flies / drives (helicopters also have passenger seats 1-3);
 * `r` is the rotation (YXZ order); `spin` is rotor RPM or car speed (m/s). Only seat 0 moves the vehicle.
 */
export interface NetVehicle {
  id: string
  seat: number
  p: Vec3
  r: Vec3
  spin: number
  /** Battle car roof gun aim: yaw and pitch relative to the car. */
  aim?: [number, number]
}

/** Where each vehicle was last left, keyed by id (sent on joining so parked vehicles show up in the right place). */
export type VehiclePoses = Record<string, { p: Vec3; r: Vec3 }>

export interface NetState {
  p: Vec3
  yaw: number
  pitch: number
  /** The vehicle this player is driving or flying; everyone moves it to match. */
  vehicle: NetVehicle | null
  /** Manning a base machine gun (`<team>-mg-<0..4>`), aimed at yaw / pitch relative to the gun's facing. */
  gun: { id: string; yaw: number; pitch: number } | null
  /** Weapon in hand ('' = none). */
  w: WeaponKind | ''
  /** What they carry (dropped where they die). */
  inv: Loadout
  /** Carrying the enemy team's gem (named `flag` from before gems replaced flags). */
  flag: boolean
  hp: number
}

export interface NetPlayer {
  id: string
  displayId: string
  displayName: string
  team: Team | null
  online: boolean
  state: NetState | null
  hp: number
  dead: boolean
}

export interface NetHandlers {
  onWelcome: (you: string, players: NetPlayer[], world: WorldSnapshot) => void
  onPlayer: (player: NetPlayer) => void
  onLeave: (id: string) => void
  onState: (id: string, state: NetState) => void
  onEnd: (winner: Team, by: string) => void
  onHp: (id: string, hp: number, by: string) => void
  onKilled: (id: string, by: string) => void
  onRespawn: (id: string) => void
  onShot: (id: string, to: Vec3, weapon: string) => void
  /** Someone else got into this seat first (or it's a wreck): we have to leave it. */
  onEject: (vehicleId: string) => void
  /** Someone else is already on this machine gun. */
  onUngun: (gunId: string) => void
  onItem: (item: NetItem) => void
  onItemGone: (id: string) => void
  /** The server's answer to our [G]: what we got (count 0 = nothing). */
  onTook: (took: Took) => void
  /** Another player fired an anti-aircraft missile at a helicopter. */
  onMissile: (id: string, target: string, from: Vec3) => void
  onWrecked: (vehicleId: string, by: string, at: { p: Vec3; r: Vec3 } | null) => void
  onRepaired: (vehicleId: string) => void
  onError: (message: string) => void
  onConnection: (connected: boolean) => void
}

export interface WorldSnapshot {
  vehicles: VehiclePoses
  items: NetItem[]
  wrecks: string[]
}

export interface Took {
  id: string
  kind: ItemKind | null
  mode: 'weapon' | 'ammo'
  /** Loaded rounds of a weapon taken whole. */
  mag: number
  /** Spare rounds / missiles received. */
  count: number
  /** A whole weapon was handed over. */
  weapon: boolean
}

const RECONNECT_MS = 2000

export class Multiplayer {
  private ws: WebSocket | null = null
  private closed = false
  private fatal = false
  private retryTimer = 0

  constructor(private readonly roomId: string, private readonly token: string, private readonly handlers: NetHandlers) {
    this.connect()
  }

  private connect() {
    const ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws`)
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', token: this.token, roomId: this.roomId }))
    ws.onmessage = (event) => {
      if (this.closed) return
      let message: Record<string, unknown>
      try { message = JSON.parse(String(event.data)) } catch { return }
      switch (message.type) {
        case 'welcome':
          this.handlers.onConnection(true)
          this.handlers.onWelcome(String(message.you), message.players as NetPlayer[], {
            vehicles: (message.vehicles ?? {}) as VehiclePoses,
            items: (message.items ?? []) as NetItem[],
            wrecks: (message.wrecks ?? []) as string[],
          })
          break
        case 'player': this.handlers.onPlayer(message.player as NetPlayer); break
        case 'leave': this.handlers.onLeave(String(message.id)); break
        case 'state': this.handlers.onState(String(message.id), message.s as NetState); break
        case 'end': this.handlers.onEnd(message.winner as Team, String(message.by)); break
        case 'hp': this.handlers.onHp(String(message.id), Number(message.hp), String(message.by)); break
        case 'killed': this.handlers.onKilled(String(message.id), String(message.by)); break
        case 'respawn': this.handlers.onRespawn(String(message.id)); break
        case 'shot': this.handlers.onShot(String(message.id), message.to as Vec3, String(message.w ?? 'primary')); break
        case 'eject': this.handlers.onEject(String(message.vehicle)); break
        case 'ungun': this.handlers.onUngun(String(message.gun)); break
        case 'item': this.handlers.onItem(message.item as NetItem); break
        case 'itemGone': this.handlers.onItemGone(String(message.id)); break
        case 'took': this.handlers.onTook(message as unknown as Took); break
        case 'missile': this.handlers.onMissile(String(message.id), String(message.target), message.from as Vec3); break
        case 'wrecked': this.handlers.onWrecked(String(message.id), String(message.by), (message.at ?? null) as { p: Vec3; r: Vec3 } | null); break
        case 'repaired': this.handlers.onRepaired(String(message.id)); break
        case 'error':
          this.fatal = true
          this.handlers.onError(String(message.message))
          break
      }
    }
    ws.onclose = (event) => {
      if (this.ws === ws) this.ws = null
      if (this.closed || this.fatal) return
      if (event.code === 4000) {
        this.handlers.onError('This battle was opened in another tab.')
        return
      }
      this.handlers.onConnection(false)
      this.retryTimer = window.setTimeout(() => this.connect(), RECONNECT_MS)
    }
  }

  sendState(state: NetState) {
    this.send({ type: 'state', s: state })
  }

  sendShot(to: Vec3, weapon: string) {
    this.send({ type: 'shot', to, w: weapon })
  }

  sendMissile(target: string) {
    this.send({ type: 'missile', target })
  }

  sendTake(id: string, mode: 'weapon' | 'ammo', want: number) {
    this.send({ type: 'take', id, mode, want })
  }

  sendDrop(kind: string, mag: number, count: number) {
    this.send({ type: 'drop', kind, mag, count })
  }

  sendHit(target: string, weapon: string) {
    this.send({ type: 'hit', target, weapon })
  }

  sendCapture() {
    this.send({ type: 'capture' })
  }

  close() {
    this.closed = true
    window.clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
  }

  private send(payload: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }
}
