import { API_URL } from '../config'
import type { ItemKind, NetItem } from './world/items'
import type { Loadout } from './world/weapon'
import type { WeaponKind } from './world/weapons'

export type Team = 'red' | 'blue'
export type Vec3 = [number, number, number]

/**
 * `id` is `<team>-<heli|car|tank>-<n>`; `seat` 0 flies / drives (helicopters also have passenger seats 1-3);
 * `r` is the rotation (YXZ order); `spin` is rotor RPM or car / tank speed (m/s). Only seat 0 moves the vehicle.
 */
export interface NetVehicle {
  id: string
  seat: number
  p: Vec3
  r: Vec3
  spin: number
  /** Battle car roof gun / tank turret aim: yaw and pitch relative to the vehicle. */
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
  /** Energy shield (0..100). */
  shield?: number
  dead: boolean
}

export interface NetHandlers {
  onWelcome: (you: string, players: NetPlayer[], world: WorldSnapshot) => void
  onPlayer: (player: NetPlayer) => void
  onLeave: (id: string) => void
  onState: (id: string, state: NetState) => void
  onEnd: (winner: Team, by: string) => void
  /** Health and shield changed (`by` is empty when the shield is just recharging; shield -1 = unknown). */
  onHp: (id: string, hp: number, by: string, shield: number) => void
  /** `how`: the weapon id, 'missile', 'shell', 'rocket', 'grenade', 'barrel' or 'wreck'. */
  onKilled: (id: string, by: string, how: string) => void
  onRespawn: (id: string) => void
  onShot: (id: string, to: Vec3, weapon: string) => void
  /**
   * We have to leave this seat: `by` pulled us out, or the server refused it (`reason`: 'taken' — someone got in
   * first, 'wreck', 'locked' — we were pulled out of it a moment ago).
   */
  onEject: (vehicleId: string, by: string | null, reason: string) => void
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
  /** The server's answer to our [E] on a vehicle with enemies aboard (ok: they were pulled out). */
  onHijack: (vehicleId: string, ok: boolean, reason: string) => void
  /** Someone pulled the enemies out of a vehicle. */
  onHijacked: (vehicleId: string, by: string, victims: string[]) => void
  /** Another player fired a tank shell or an unguided rocket. */
  onFire: (id: string, kind: ProjectileKind, from: Vec3, to: Vec3) => void
  /** Another player threw a grenade. */
  onThrow: (id: string, from: Vec3, velocity: Vec3) => void
  /** Something blew up (`at[1]` null = on the ground there). */
  onBoom: (at: [number, number | null, number], kind: BlastKind, by: string) => void
  /** A vehicle's hull strength changed. */
  onVehicleHp: (id: string, hp: number, max: number) => void
  /** An explosive barrel went up (or is back). */
  onBarrel: (id: string, alive: boolean) => void
  onError: (message: string) => void
  onConnection: (connected: boolean) => void
}

export type ProjectileKind = 'shell' | 'rocket'
export type BlastKind = 'shell' | 'rocket' | 'grenade' | 'barrel'

export interface WorldSnapshot {
  vehicles: VehiclePoses
  items: NetItem[]
  wrecks: string[]
  /** Hull strength of damaged vehicles (full when missing). */
  vehicleHp: Record<string, number>
  barrels: Array<{ id: string; alive: boolean }>
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
            vehicleHp: (message.vehicleHp ?? {}) as Record<string, number>,
            barrels: (message.barrels ?? []) as WorldSnapshot['barrels'],
          })
          break
        case 'player': this.handlers.onPlayer(message.player as NetPlayer); break
        case 'leave': this.handlers.onLeave(String(message.id)); break
        case 'state': this.handlers.onState(String(message.id), message.s as NetState); break
        case 'end': this.handlers.onEnd(message.winner as Team, String(message.by)); break
        case 'hp': this.handlers.onHp(String(message.id), Number(message.hp), String(message.by ?? ''), message.shield === undefined ? -1 : Number(message.shield)); break
        case 'killed': this.handlers.onKilled(String(message.id), String(message.by), String(message.how ?? '')); break
        case 'respawn': this.handlers.onRespawn(String(message.id)); break
        case 'shot': this.handlers.onShot(String(message.id), message.to as Vec3, String(message.w ?? 'primary')); break
        case 'eject': this.handlers.onEject(String(message.vehicle), typeof message.by === 'string' ? message.by : null, String(message.reason ?? 'taken')); break
        case 'ungun': this.handlers.onUngun(String(message.gun)); break
        case 'item': this.handlers.onItem(message.item as NetItem); break
        case 'itemGone': this.handlers.onItemGone(String(message.id)); break
        case 'took': this.handlers.onTook(message as unknown as Took); break
        case 'missile': this.handlers.onMissile(String(message.id), String(message.target), message.from as Vec3); break
        case 'wrecked': this.handlers.onWrecked(String(message.id), String(message.by), (message.at ?? null) as { p: Vec3; r: Vec3 } | null); break
        case 'repaired': this.handlers.onRepaired(String(message.id)); break
        case 'hijack': this.handlers.onHijack(String(message.vehicle), message.ok === true, String(message.reason ?? '')); break
        case 'hijacked': this.handlers.onHijacked(String(message.vehicle), String(message.by), (message.victims ?? []) as string[]); break
        case 'fire': this.handlers.onFire(String(message.id), message.kind as ProjectileKind, message.from as Vec3, message.to as Vec3); break
        case 'throw': this.handlers.onThrow(String(message.id), message.from as Vec3, message.v as Vec3); break
        case 'boom': this.handlers.onBoom(message.at as [number, number | null, number], message.kind as BlastKind, String(message.by)); break
        case 'vhp': this.handlers.onVehicleHp(String(message.id), Number(message.hp), Number(message.max)); break
        case 'barrel': this.handlers.onBarrel(String(message.id), message.alive === true); break
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

  /** A round of ours struck a player, a vehicle's hull (and whoever is inside) or an explosive barrel. */
  sendHit(weapon: string, what: { target?: string; vehicle?: string; barrel?: string }) {
    this.send({ type: 'hit', weapon, ...what })
  }

  /** A melee strike on the player in front of us. */
  sendMelee(target: string) {
    this.send({ type: 'melee', target })
  }

  /** [E] on a vehicle with enemies aboard: pull them out. */
  sendHijack(vehicle: string) {
    this.send({ type: 'hijack', vehicle })
  }

  /** A tank shell or an unguided rocket, from the muzzle to where it will go off. */
  sendFire(kind: ProjectileKind, from: Vec3, to: Vec3) {
    this.send({ type: 'fire', kind, from, to })
  }

  sendThrow(from: Vec3, velocity: Vec3) {
    this.send({ type: 'throw', from, v: velocity })
  }

  /** Our grenade went off here. */
  sendBlast(at: Vec3) {
    this.send({ type: 'blast', at })
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
