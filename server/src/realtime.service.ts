import { Injectable, OnModuleDestroy } from '@nestjs/common'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { AuthService } from './auth.service'
import { RoomService, Team } from './room.service'
import { AMMO, AMMO_TYPES, GEM_PEDESTAL, MACHINE_GUN_SPOTS, WEAPONS as ARMS, initialItems, isWeaponItem, type AmmoType, type Item, type ItemKind, type WeaponKind } from './game-layout'

type Vec3 = [number, number, number]

interface VehicleState {
  id: string
  /** 0 flies / drives; helicopters have passenger seats 1-3. */
  seat: number
  p: Vec3
  r: Vec3
  spin: number
  /** Battle car roof gun aim (yaw, pitch relative to the car). */
  aim?: [number, number]
}

interface PlayerState {
  p: Vec3
  yaw: number
  pitch: number
  vehicle: VehicleState | null
  /** Manning a base machine gun. */
  gun: { id: string; yaw: number; pitch: number } | null
  /** Weapon in hand ('' = none). */
  w: WeaponKind | ''
  /** Loadout — dropped where the player dies: [kind, loaded rounds] per slot, spare rounds per ammo type. */
  inv: { s: Array<[WeaponKind, number] | null>; r: Partial<Record<AmmoType, number>> }
  flag: boolean
  hp: number
}

interface Connection {
  ws: WebSocket
  userId: string
  team: Team
  state: PlayerState | null
  lastStateAt: number
  alive: boolean
}

/** Survives reconnects so leaving and rejoining can't heal a player. */
interface Vitals {
  hp: number
  dead: boolean
  lastShotAt: number
  lastShotFxAt: number
  lastMissileAt: number
  lastDropAt: number
  respawnTimer?: NodeJS.Timeout
}

/** Per-room world state beyond the players: supplies on the ground, wrecks, where vehicles were left. */
interface RoomWorld {
  items: Map<string, Item>
  /** Dropped items in the order they appeared (oldest removed first when there are too many). */
  dropped: string[]
  wrecks: Map<string, NodeJS.Timeout>
  vehiclePoses: Map<string, { p: Vec3; r: Vec3 }>
  timers: Set<NodeJS.Timeout>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Each base has 5 helicopters and 5 battle cars; must match client/src/game/world/vehicles.ts */
const VEHICLE_ID = /^(blue|red)-(heli|car)-[0-4]$/
const HELI_ID = /^(blue|red)-heli-[0-4]$/
const GUN_ID = /^(blue|red)-mg-[0-4]$/
const SEATS = { heli: 4, car: 1 }
const MIN_STATE_INTERVAL_MS = 30
const CAPTURE_RADIUS = 14
const MAX_HP = 100
const RESPAWN_MS = 5000
// Mirrors client/src/game/world/weapons.ts; the server never trusts client-sent damage
const WEAPONS: Record<string, { power: number; fireRate: number; range: number }> = {
  ...Object.fromEntries(Object.entries(ARMS).filter(([kind]) => kind !== 'launcher').map(([kind, w]) => [kind, { power: w.power, fireRate: w.fireRate, range: w.range }])),
  'machine-gun': { power: 45, fireRate: 0.7, range: 450 },
  'car-gun': { power: 14, fireRate: 0.1, range: 350 },
}
const EMPTY_LOADOUT = (): PlayerState['inv'] => ({ s: [null, null, null], r: {} })
const MIN_FIRE_RATE = 0.07
// Positions are up to one network tick stale on each side
const RANGE_SLACK = 25
const FIRE_RATE_SLACK = 0.6
/** Anti-aircraft missiles: lock range, flight speed, how long a wreck lies before the helicopter is back. */
const MISSILE_RANGE = 700
const MISSILE_SPEED = 110
const MISSILE_INTERVAL_MS = 1200
const WRECK_MS = 30_000
/** A player can reach supplies this far away (the client's reach plus lag). */
const TAKE_REACH = 4.5
const GUN_REACH = 5
const RACK_RESPAWN_MS = 60_000
const MAX_DROPPED = 80

const num = (value: unknown, min: number, max: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null)
const int = (value: unknown, min: number, max: number) => { const n = num(value, min, max); return n === null ? null : Math.round(n) }
const dist2 = (a: [number, number] | Vec3, b: [number, number] | Vec3) => {
  const ax = a[0], az = a.length === 3 ? a[2] : a[1], bx = b[0], bz = b.length === 3 ? b[2] : b[1]
  return Math.hypot(ax - bx, az - bz)
}

function vec(value: unknown, limit: number, minY = -100, maxY = 500): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const x = num(value[0], -limit, limit)
  const y = num(value[1], minY, maxY)
  const z = num(value[2], -limit, limit)
  return x === null || y === null || z === null ? null : [x, y, z]
}

function parseState(raw: unknown): PlayerState | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const p = vec(s.p, 500)
  const yaw = num(s.yaw, -1e4, 1e4)
  const pitch = num(s.pitch, -Math.PI, Math.PI)
  const hp = num(s.hp, 0, 100)
  if (!p || yaw === null || pitch === null || hp === null) return null
  let vehicle: VehicleState | null = null
  if (s.vehicle && typeof s.vehicle === 'object') {
    const v = s.vehicle as Record<string, unknown>
    const id = typeof v.id === 'string' && VEHICLE_ID.test(v.id) ? v.id : null
    const seat = int(v.seat ?? 0, 0, 3)
    const vp = vec(v.p, 500)
    const r = vec(v.r, 1e4, -1e4, 1e4)
    const spin = num(v.spin, -100, 100)
    if (!id || seat === null || seat >= SEATS[id.includes('-heli-') ? 'heli' : 'car'] || !vp || !r || spin === null) return null
    vehicle = { id, seat, p: vp, r, spin }
    if (Array.isArray(v.aim) && v.aim.length === 2) {
      const aimYaw = num(v.aim[0], -10, 10), aimPitch = num(v.aim[1], -2, 2)
      if (aimYaw !== null && aimPitch !== null) vehicle.aim = [aimYaw, aimPitch]
    }
  }
  let gun: PlayerState['gun'] = null
  if (s.gun && typeof s.gun === 'object') {
    const g = s.gun as Record<string, unknown>
    const gunYaw = num(g.yaw, -1e4, 1e4)
    const gunPitch = num(g.pitch, -Math.PI, Math.PI)
    if (typeof g.id !== 'string' || !GUN_ID.test(g.id) || gunYaw === null || gunPitch === null) return null
    gun = { id: g.id, yaw: gunYaw, pitch: gunPitch }
  }
  const w = typeof s.w === 'string' && isWeaponItem(s.w) ? s.w : ''
  return { p, yaw, pitch, vehicle, gun, w, inv: parseLoadout(s.inv), flag: s.flag === true, hp }
}

/** Only real weapons in their own slots, magazines and spare rounds within limits. */
function parseLoadout(raw: unknown): PlayerState['inv'] {
  const inv = EMPTY_LOADOUT()
  if (!raw || typeof raw !== 'object') return inv
  const o = raw as { s?: unknown; r?: unknown }
  const slots = ['sidearm', 'long', 'launcher']
  if (Array.isArray(o.s)) o.s.slice(0, 3).forEach((entry, i) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !isWeaponItem(entry[0])) return
    const kind = entry[0]
    if (ARMS[kind].slot !== slots[i]) return
    inv.s[i] = [kind, int(entry[1], 0, ARMS[kind].mag) ?? 0]
  })
  if (o.r && typeof o.r === 'object') for (const a of AMMO_TYPES) {
    const n = int((o.r as Record<string, unknown>)[a], 0, AMMO[a].max)
    if (n) inv.r[a] = n
  }
  return inv
}

@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  private readonly rooms = new Map<string, Map<string, Connection>>()
  private readonly vitals = new Map<string, Map<string, Vitals>>()
  private readonly worlds = new Map<string, RoomWorld>()
  private dropCounter = 0
  private heartbeat?: NodeJS.Timeout

  constructor(private readonly auth: AuthService, private readonly roomService: RoomService) {}

  attach(server: Server) {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws))
    })
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.values()) {
        for (const conn of room.values()) {
          if (!conn.alive) conn.ws.terminate()
          else { conn.alive = false; conn.ws.ping() }
        }
      }
    }, 30_000)
  }

  onModuleDestroy() {
    clearInterval(this.heartbeat)
    for (const roomId of new Set([...this.vitals.keys(), ...this.worlds.keys()])) this.clearRoom(roomId)
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
  }

  private onConnection(ws: WebSocket) {
    let joined: { roomId: string; conn: Connection } | null = null
    const joinTimeout = setTimeout(() => { if (!joined) ws.close(4001, 'Join timeout') }, 10_000)

    ws.on('message', async (data) => {
      let message: Record<string, unknown>
      try { message = JSON.parse(String(data)) } catch { return }
      if (!message || typeof message !== 'object') return

      if (!joined) {
        if (message.type !== 'join') return
        const result = await this.join(ws, message).catch((error: Error) => ({ error: error.message }))
        if ('error' in result) {
          this.send(ws, { type: 'error', message: result.error })
          ws.close(4003, result.error.slice(0, 120))
          return
        }
        joined = result
        clearTimeout(joinTimeout)
        return
      }

      const { roomId, conn } = joined
      switch (message.type) {
        case 'state': this.state(roomId, conn, message); break
        case 'shot': this.shot(roomId, conn, message); break
        case 'hit': this.hit(roomId, conn, message); break
        case 'missile': this.missile(roomId, conn, message); break
        case 'take': this.take(roomId, conn, message); break
        case 'drop': this.drop(roomId, conn, message); break
        case 'capture': await this.capture(roomId, conn); break
      }
    })

    ws.on('pong', () => { if (joined) joined.conn.alive = true })
    ws.on('close', () => {
      clearTimeout(joinTimeout)
      if (!joined) return
      const room = this.rooms.get(joined.roomId)
      if (room?.get(joined.conn.userId) !== joined.conn) return
      room.delete(joined.conn.userId)
      if (room.size === 0) this.rooms.delete(joined.roomId)
      this.broadcast(joined.roomId, { type: 'leave', id: joined.conn.userId })
    })
  }

  private async join(ws: WebSocket, message: Record<string, unknown>) {
    const roomId = typeof message.roomId === 'string' && UUID.test(message.roomId) ? message.roomId : null
    if (!roomId) throw new Error('Invalid room')
    const user = await this.auth.authenticate(`Bearer ${typeof message.token === 'string' ? message.token : ''}`)
    const roster = await this.roomService.matchRoster(roomId)
    if (!roster) throw new Error('Room not found')
    if (roster.status !== 'live') throw new Error(roster.status === 'finished' ? 'This battle has ended' : 'This battle has not started yet')
    const me = roster.players.find((player) => player.id === user.id)
    if (!me) throw new Error('You are not a member of this room')

    if (!me.team) {
      // Rooms started before teams existed: balance late joiners
      const red = roster.players.filter((player) => player.team === 'red').length
      const blue = roster.players.filter((player) => player.team === 'blue').length
      me.team = red <= blue ? 'red' : 'blue'
      await this.roomService.assignTeam(roomId, me.id, me.team)
    }

    const room = this.rooms.get(roomId) ?? new Map<string, Connection>()
    this.rooms.set(roomId, room)
    room.get(user.id)?.ws.close(4000, 'Connected from another tab')
    const conn: Connection = { ws, userId: user.id, team: me.team, state: null, lastStateAt: 0, alive: true }
    room.set(user.id, conn)

    const players = roster.players.map((player) => {
      const live = room.get(player.id)
      const vitals = this.vitalsOf(roomId, player.id)
      return { ...player, team: player.id === me.id ? me.team : player.team, online: !!live, state: live?.state ?? null, hp: vitals.hp, dead: vitals.dead }
    })
    const world = this.worldOf(roomId)
    this.send(ws, {
      type: 'welcome', you: user.id, players,
      vehicles: Object.fromEntries(world.vehiclePoses),
      items: [...world.items.values()],
      wrecks: [...world.wrecks.keys()],
    })
    const myVitals = this.vitalsOf(roomId, user.id)
    this.broadcast(roomId, { type: 'player', player: { ...me, online: true, state: null, hp: myVitals.hp, dead: myVitals.dead } }, user.id)
    return { roomId, conn }
  }

  private worldOf(roomId: string): RoomWorld {
    let world = this.worlds.get(roomId)
    if (!world) {
      world = { items: new Map(initialItems().map((item) => [item.id, item])), dropped: [], wrecks: new Map(), vehiclePoses: new Map(), timers: new Set() }
      this.worlds.set(roomId, world)
    }
    return world
  }

  private later(roomId: string, ms: number, fn: () => void) {
    const world = this.worldOf(roomId)
    const timer = setTimeout(() => { world.timers.delete(timer); fn() }, ms)
    world.timers.add(timer)
    return timer
  }

  private vitalsOf(roomId: string, userId: string): Vitals {
    let room = this.vitals.get(roomId)
    if (!room) this.vitals.set(roomId, (room = new Map()))
    let vitals = room.get(userId)
    if (!vitals) room.set(userId, (vitals = { hp: MAX_HP, dead: false, lastShotAt: 0, lastShotFxAt: 0, lastMissileAt: 0, lastDropAt: 0 }))
    return vitals
  }

  private clearRoom(roomId: string) {
    for (const vitals of this.vitals.get(roomId)?.values() ?? []) clearTimeout(vitals.respawnTimer)
    this.vitals.delete(roomId)
    const world = this.worlds.get(roomId)
    if (world) {
      for (const timer of world.timers) clearTimeout(timer)
      for (const timer of world.wrecks.values()) clearTimeout(timer)
    }
    this.worlds.delete(roomId)
  }

  private state(roomId: string, conn: Connection, message: Record<string, unknown>) {
    const now = Date.now()
    if (now - conn.lastStateAt < MIN_STATE_INTERVAL_MS) return
    const state = parseState(message.s)
    if (!state) return
    conn.lastStateAt = now
    const vitals = this.vitalsOf(roomId, conn.userId)
    state.hp = vitals.hp
    if (vitals.dead) {
      state.vehicle = null
      state.gun = null
    }
    if (state.vehicle && !this.claimSeat(roomId, conn, state.vehicle)) {
      // One player per seat, whoever got in first keeps it; wrecks can't be boarded
      this.send(conn.ws, { type: 'eject', vehicle: state.vehicle.id })
      state.vehicle = null
    }
    if (state.gun && !this.claimGun(roomId, conn, state)) {
      this.send(conn.ws, { type: 'ungun', gun: state.gun.id })
      state.gun = null
    }
    conn.state = state
    this.broadcast(roomId, { type: 'state', id: conn.userId, s: state }, conn.userId)
  }

  private occupants(roomId: string, vehicleId: string) {
    return [...(this.rooms.get(roomId)?.values() ?? [])].filter((c) => c.state?.vehicle?.id === vehicleId && !this.vitalsOf(roomId, c.userId).dead)
  }

  private claimSeat(roomId: string, conn: Connection, vehicle: VehicleState) {
    const world = this.worldOf(roomId)
    if (world.wrecks.has(vehicle.id)) return false
    const taken = this.occupants(roomId, vehicle.id).some((other) => other !== conn && other.state!.vehicle!.seat === vehicle.seat)
    if (taken) return false
    if (vehicle.seat === 0) world.vehiclePoses.set(vehicle.id, { p: vehicle.p, r: vehicle.r })
    return true
  }

  private claimGun(roomId: string, conn: Connection, state: PlayerState) {
    const spot = MACHINE_GUN_SPOTS.get(state.gun!.id)
    if (!spot || state.vehicle || dist2(spot, state.p) > GUN_REACH) return false
    for (const other of this.rooms.get(roomId)?.values() ?? []) {
      if (other !== conn && other.state?.gun?.id === state.gun!.id && !this.vitalsOf(roomId, other.userId).dead) return false
    }
    return true
  }

  /** Relay a fired shot so everyone else sees the muzzle flash and the round. */
  private shot(roomId: string, shooter: Connection, message: Record<string, unknown>) {
    const to = vec(message.to, 600, -100, 600)
    const vitals = this.vitalsOf(roomId, shooter.userId)
    if (!to || vitals.dead) return
    const now = Date.now()
    if (now - vitals.lastShotFxAt < MIN_FIRE_RATE * 1000 * FIRE_RATE_SLACK) return
    vitals.lastShotFxAt = now
    const w = typeof message.w === 'string' && message.w in WEAPONS ? message.w : 'primary'
    this.broadcast(roomId, { type: 'shot', id: shooter.userId, to, w }, shooter.userId)
  }

  /** Where a shooter fires from: their machine gun, their vehicle, or where they stand. */
  private firingPoint(state: PlayerState): [number, number] | Vec3 {
    if (state.gun) return MACHINE_GUN_SPOTS.get(state.gun.id) ?? state.p
    return state.vehicle?.p ?? state.p
  }

  private hit(roomId: string, shooter: Connection, message: Record<string, unknown>) {
    const weaponId = typeof message.weapon === 'string' ? message.weapon : ''
    const weapon = WEAPONS[weaponId]
    const target = typeof message.target === 'string' ? this.rooms.get(roomId)?.get(message.target) : undefined
    if (!weapon || !target || target.team === shooter.team || !shooter.state || !target.state) return
    // The machine gun only hits from behind a machine gun, the car gun from a car's driver seat,
    // hand weapons from neither (nor from a helicopter's pilot seat)
    const v = shooter.state.vehicle
    const driving = v?.seat === 0
    if (weaponId === 'machine-gun' ? !shooter.state.gun : weaponId === 'car-gun' ? !(driving && v!.id.includes('-car-')) : shooter.state.gun || driving) return
    const shooterVitals = this.vitalsOf(roomId, shooter.userId)
    const targetVitals = this.vitalsOf(roomId, target.userId)
    if (shooterVitals.dead || targetVitals.dead) return

    const now = Date.now()
    if (now - shooterVitals.lastShotAt < weapon.fireRate * 1000 * FIRE_RATE_SLACK) return
    const from = this.firingPoint(shooter.state)
    const to = target.state.vehicle?.p ?? target.state.p
    if (dist2(from, to) > weapon.range + RANGE_SLACK) return
    shooterVitals.lastShotAt = now

    targetVitals.hp = Math.max(0, targetVitals.hp - weapon.power)
    this.broadcast(roomId, { type: 'hp', id: target.userId, hp: targetVitals.hp, by: shooter.userId })
    if (targetVitals.hp <= 0) this.kill(roomId, target, shooter.userId)
  }

  /** A player dies: everyone is told, what they carried is left on the ground, and they respawn in 5s. */
  private kill(roomId: string, target: Connection, by: string) {
    const vitals = this.vitalsOf(roomId, target.userId)
    if (vitals.dead) return
    vitals.hp = 0
    vitals.dead = true
    this.broadcast(roomId, { type: 'hp', id: target.userId, hp: 0, by })
    this.broadcast(roomId, { type: 'killed', id: target.userId, by })
    const state = target.state
    if (state) {
      // Each weapon with the spare rounds it uses; any other spare rounds as loose ammo
      const where = state.vehicle?.p ?? state.p
      const spare = { ...state.inv.r }
      for (const held of state.inv.s) {
        if (!held) continue
        const ammo = ARMS[held[0]].ammo
        this.addDropped(roomId, held[0], where, held[1], spare[ammo] ?? 0)
        delete spare[ammo]
      }
      for (const [ammo, n] of Object.entries(spare)) if (n) this.addDropped(roomId, `ammo-${ammo as AmmoType}`, where, 0, n)
      state.flag = false
      state.vehicle = null
      state.gun = null
      state.inv = EMPTY_LOADOUT()
    }
    vitals.respawnTimer = setTimeout(() => {
      vitals.hp = MAX_HP
      vitals.dead = false
      this.broadcast(roomId, { type: 'respawn', id: target.userId })
    }, RESPAWN_MS)
  }

  /**
   * An anti-aircraft missile, fired after a 2s lock on a helicopter with an enemy aboard. Everyone sees it fly;
   * when it arrives the helicopter is destroyed with everyone in it, and it is back at home 30s later.
   */
  private missile(roomId: string, shooter: Connection, message: Record<string, unknown>) {
    const targetId = typeof message.target === 'string' && HELI_ID.test(message.target) ? message.target : null
    const state = shooter.state
    const vitals = this.vitalsOf(roomId, shooter.userId)
    const world = this.worldOf(roomId)
    if (!targetId || !state || vitals.dead || state.vehicle || state.gun || world.wrecks.has(targetId)) return
    const now = Date.now()
    if (now - vitals.lastMissileAt < MISSILE_INTERVAL_MS) return
    const aboard = this.occupants(roomId, targetId)
    if (!aboard.some((c) => c.team !== shooter.team)) return
    const at = aboard.find((c) => c.state!.vehicle!.seat === 0)?.state!.vehicle!.p ?? aboard[0].state!.vehicle!.p
    const distance = Math.hypot(at[0] - state.p[0], at[1] - state.p[1], at[2] - state.p[2])
    if (distance > MISSILE_RANGE + RANGE_SLACK) return
    vitals.lastMissileAt = now
    this.broadcast(roomId, { type: 'missile', id: shooter.userId, target: targetId, from: state.p }, shooter.userId)
    this.later(roomId, (distance / MISSILE_SPEED) * 1000 + 400, () => this.destroyVehicle(roomId, targetId, shooter.userId))
  }

  private destroyVehicle(roomId: string, vehicleId: string, by: string) {
    const world = this.worlds.get(roomId)
    if (!world || world.wrecks.has(vehicleId)) return
    const aboard = this.occupants(roomId, vehicleId)
    const pilot = aboard.find((c) => c.state!.vehicle!.seat === 0)
    if (pilot) world.vehiclePoses.set(vehicleId, { p: pilot.state!.vehicle!.p, r: pilot.state!.vehicle!.r })
    this.broadcast(roomId, { type: 'wrecked', id: vehicleId, by, at: world.vehiclePoses.get(vehicleId) ?? null })
    for (const conn of aboard) this.kill(roomId, conn, by)
    world.wrecks.set(vehicleId, this.later(roomId, WRECK_MS, () => {
      world.wrecks.delete(vehicleId)
      world.vehiclePoses.delete(vehicleId)
      this.broadcast(roomId, { type: 'repaired', id: vehicleId })
    }))
  }

  private itemUpdate(roomId: string, item: Item) {
    this.broadcast(roomId, { type: 'item', item })
  }

  private removeItem(roomId: string, id: string) {
    const world = this.worldOf(roomId)
    world.items.delete(id)
    world.dropped = world.dropped.filter((d) => d !== id)
    this.broadcast(roomId, { type: 'itemGone', id })
  }

  private addDropped(roomId: string, kind: ItemKind, where: Vec3, mag: number, count: number) {
    const world = this.worldOf(roomId)
    const id = `drop-${++this.dropCounter}`
    const angle = Math.random() * Math.PI * 2, spread = 0.6 + Math.random() * 0.8
    const item: Item = { id, kind, x: where[0] + Math.cos(angle) * spread, z: where[2] + Math.sin(angle) * spread, yaw: Math.random() * Math.PI * 2, count, mag, fixed: false }
    world.items.set(id, item)
    world.dropped.push(id)
    this.itemUpdate(roomId, item)
    while (world.dropped.length > MAX_DROPPED) this.removeItem(roomId, world.dropped[0])
  }

  /**
   * [G] on a supply: `weapon` takes a weapon we don't carry (with its loaded rounds and up to `want` spare);
   * `ammo` takes up to `want` rounds / missiles out of it. Only the server decides who gets what.
   */
  private take(roomId: string, conn: Connection, message: Record<string, unknown>) {
    const world = this.worldOf(roomId)
    const item = typeof message.id === 'string' ? world.items.get(message.id) : undefined
    const want = int(message.want, 0, 300) ?? 0
    const mode = message.mode === 'weapon' ? 'weapon' : 'ammo'
    const state = conn.state
    const refuse = () => this.send(conn.ws, { type: 'took', id: message.id, kind: item?.kind ?? null, mode, mag: 0, count: 0, weapon: false })
    if (!item || item.gone || !state || state.vehicle || state.gun || this.vitalsOf(roomId, conn.userId).dead || dist2([item.x, item.z], state.p) > TAKE_REACH) return refuse()

    if (mode === 'weapon') {
      if (!isWeaponItem(item.kind)) return refuse()
      const count = Math.min(item.count, want)
      this.send(conn.ws, { type: 'took', id: item.id, kind: item.kind, mode, mag: item.mag, count, weapon: true })
      if (item.fixed) {
        // A rack launcher / table gun comes back a minute later (launchers empty: missiles come from the crates)
        item.gone = true
        this.itemUpdate(roomId, item)
        const kind = item.kind
        this.later(roomId, RACK_RESPAWN_MS, () => {
          item.gone = false
          item.mag = kind === 'launcher' ? 0 : ARMS[kind].mag
          item.count = 0
          this.itemUpdate(roomId, item)
        })
      } else {
        this.removeItem(roomId, item.id)
      }
      return
    }

    const isWeapon = isWeaponItem(item.kind)
    const available = item.count + (isWeapon ? item.mag : 0)
    const give = Math.min(want, available)
    if (give <= 0) return refuse()
    const fromCount = Math.min(item.count, give)
    item.count -= fromCount
    if (isWeapon) item.mag -= give - fromCount
    this.send(conn.ws, { type: 'took', id: item.id, kind: item.kind, mode, mag: 0, count: give, weapon: false })
    if (!item.fixed && !isWeapon && item.count <= 0) this.removeItem(roomId, item.id)
    else this.itemUpdate(roomId, item)
  }

  /** [G] with nothing in reach (or swapping long guns): put a weapon down (with its rounds) for anyone to pick up. */
  private drop(roomId: string, conn: Connection, message: Record<string, unknown>) {
    const kind = typeof message.kind === 'string' && isWeaponItem(message.kind) ? message.kind : null
    const vitals = this.vitalsOf(roomId, conn.userId)
    const state = conn.state
    if (!kind || !state || vitals.dead || state.vehicle || state.gun) return
    const now = Date.now()
    if (now - vitals.lastDropAt < 150) return
    vitals.lastDropAt = now
    const mag = int(message.mag, 0, ARMS[kind].mag) ?? 0
    const count = int(message.count, 0, AMMO[ARMS[kind].ammo].max) ?? 0
    this.addDropped(roomId, kind, state.p, mag, count)
  }

  private async capture(roomId: string, conn: Connection) {
    const state = conn.state
    if (!state?.flag || state.vehicle || this.vitalsOf(roomId, conn.userId).dead) return
    const [fx, fz] = GEM_PEDESTAL[conn.team]
    if (Math.hypot(state.p[0] - fx, state.p[2] - fz) > CAPTURE_RADIUS) return
    if (!(await this.roomService.finish(roomId))) return
    this.broadcast(roomId, { type: 'end', winner: conn.team, by: conn.userId })
    this.clearRoom(roomId)
  }

  private broadcast(roomId: string, payload: object, exceptUserId?: string) {
    const room = this.rooms.get(roomId)
    if (!room) return
    const data = JSON.stringify(payload)
    for (const conn of room.values()) {
      if (conn.userId !== exceptUserId && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data)
    }
  }

  private send(ws: WebSocket, payload: object) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }
}

