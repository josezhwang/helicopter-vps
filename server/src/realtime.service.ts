import { Injectable, OnModuleDestroy } from '@nestjs/common'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { AuthService } from './auth.service'
import { DISCORD_COLOR, DiscordService, plain } from './discord.service'
import { RoomService, Team } from './room.service'
import { AMMO, AMMO_TYPES, BARRELS, GEM_PEDESTAL, MACHINE_GUN_SPOTS, VEHICLE_HOMES, VEHICLE_MAX_HP, WEAPONS as ARMS, initialItems, isWeaponItem, type AmmoType, type Item, type ItemKind, type VehicleKindId, type WeaponKind } from './game-layout'

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
  lastCannonAt: number
  /** A mech's rocket salvo: when each of the last rockets left. */
  mechRockets: number[]
  /** Energy shield on top of health: takes damage first, recharges once you've not been hit for a moment. */
  shield: number
  hurtAt: number
  lastMeleeAt: number
  /** Kills since this player last died (killing sprees are announced on Discord). */
  streak: number
  respawnTimer?: NodeJS.Timeout
}

/** Per-room world state beyond the players: supplies on the ground, wrecks, where vehicles were left. */
interface RoomWorld {
  items: Map<string, Item>
  /** Dropped items in the order they appeared (oldest removed first when there are too many). */
  dropped: string[]
  wrecks: Map<string, NodeJS.Timeout>
  vehiclePoses: Map<string, { p: Vec3; r: Vec3 }>
  /** Damage taken per vehicle (full health when missing). */
  vehicleHp: Map<string, number>
  /** Explosive barrels: bullet damage they can still take, and whether they are standing. */
  barrels: Map<string, { x: number; z: number; hp: number; alive: boolean }>
  /** Players pulled out of a vehicle can't climb straight back in: `${userId}|${vehicleId}` → until. */
  ejectLocks: Map<string, number>
  /** Grenades in the air per thrower (where from, until when they may still go off). */
  grenades: Map<string, Array<{ from: Vec3; until: number }>>
  timers: Set<NodeJS.Timeout>
}

type BlastKind = 'shell' | 'rocket' | 'grenade' | 'barrel'
/**
 * What explosions do: radius (m), damage to a player at the centre, damage to a vehicle at the centre (armoured
 * tanks take `tank` times that). Falls off towards the edge.
 */
const BLASTS: Record<BlastKind, { radius: number; player: number; vehicle: number; tank: number }> = {
  shell: { radius: 7, player: 240, vehicle: 520, tank: 0.8 },
  rocket: { radius: 6, player: 220, vehicle: 700, tank: 1 },
  grenade: { radius: 7, player: 150, vehicle: 170, tank: 0.35 },
  barrel: { radius: 8, player: 150, vehicle: 260, tank: 0.5 },
}
/** Projectile speeds (m/s) for shells and rockets: the blast comes when it arrives. */
const PROJECTILE_SPEED = { shell: 260, rocket: 120 }
const TANK_RELOAD_MS = 3000
const ROCKET_INTERVAL_MS = 1200
/** A mech fires its rockets in salvos of up to MECH_SALVO, then reloads. */
const MECH_SALVO = 6
const MECH_SALVO_WINDOW_MS = 6500
const MECH_ROCKET_GAP_MS = 110
const BARREL_HP = 30
const BARREL_RESPAWN_MS = 45_000
const EJECT_LOCK_MS = 10_000
/** Kill streaks worth telling the Discord channel about. */
const SPREES: Record<number, string> = { 5: 'Killing spree', 10: 'Rampage', 15: 'Unstoppable', 20: 'Untouchable' }
const GRENADE_FUSE_MS = 6000
/** A vehicle's size when working out whether a blast reaches it. */
const VEHICLE_RADIUS: Record<VehicleKindId, number> = { heli: 3, car: 2.8, tank: 4, mech: 2.8, fighter: 4.4 }
const kindOf = (vehicleId: string) => vehicleId.split('-')[1] as VehicleKindId

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Each base has 5 helicopters and 5 battle cars; must match client/src/game/world/vehicles.ts */
const VEHICLE_ID = /^(blue|red)-(heli|car|tank|mech|fighter)-[0-4]$/
/** Aircraft: what anti-aircraft and fighter missiles lock on to. */
const HELI_ID = /^(blue|red)-(heli|fighter)-[0-4]$/
const GUN_ID = /^(blue|red)-mg-[0-7]$/
const SEATS = { heli: 4, car: 1, tank: 1, mech: 1, fighter: 1 }
const MIN_STATE_INTERVAL_MS = 30
const CAPTURE_RADIUS = 14
const MAX_HP = 100
/** Energy shields: this strong, back after SHIELD_DELAY_MS without a hit, refilling at SHIELD_RATE per second. */
const MAX_SHIELD = 100
const SHIELD_DELAY_MS = 4000
const SHIELD_RATE = 45
const SHIELD_TICK_MS = 250
/** Melee: a quick strike at arm's length (an instant takedown from behind), no faster than MELEE_COOLDOWN_MS. */
const MELEE_REACH = 3.2
const MELEE_DAMAGE = 70
const MELEE_COOLDOWN_MS = 800
const RESPAWN_MS = 5000
// Mirrors client/src/game/world/weapons.ts; the server never trusts client-sent damage
const WEAPONS: Record<string, { power: number; fireRate: number; range: number }> = {
  ...Object.fromEntries(Object.entries(ARMS).filter(([kind]) => kind !== 'launcher').map(([kind, w]) => [kind, { power: w.power, fireRate: w.fireRate, range: w.range }])),
  'machine-gun': { power: 45, fireRate: 0.7, range: 450 },
  'car-gun': { power: 9, fireRate: 0.05, range: 350 },
  'mech-cannon': { power: 22, fireRate: 0.11, range: 420 },
  'fighter-laser': { power: 10, fireRate: 0.05, range: 520 },
  'heli-gun': { power: 10, fireRate: 0.05, range: 400 },
}
const EMPTY_LOADOUT = (): PlayerState['inv'] => ({ s: [null, null, null], r: {} })
const MIN_FIRE_RATE = 0.045
// Positions are up to one network tick stale on each side
const RANGE_SLACK = 25
const FIRE_RATE_SLACK = 0.6
/** Anti-aircraft missiles: lock range, flight speed, how long a wreck lies before the helicopter is back. */
const MISSILE_RANGE = 700
const MISSILE_SPEED = 110
const MISSILE_INTERVAL_MS = 1200
/** A fighter's homing missiles: how often, how hard, how fast. */
const FIGHTER_MISSILE_INTERVAL_MS = 2200
const FIGHTER_MISSILE_DAMAGE = 240
const FIGHTER_MISSILE_SPEED = 170
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

/** Highest anything may be: fighters climb into the space zone. */
const CEILING = 1100

function vec(value: unknown, limit: number, minY = -100, maxY = CEILING): Vec3 | null {
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
    // Rotor speed, ground speed, or a fighter's airspeed
    const spin = num(v.spin, -250, 250)
    if (!id || seat === null || seat >= SEATS[kindOf(id)] || !vp || !r || spin === null) return null
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

  constructor(private readonly auth: AuthService, private readonly roomService: RoomService, private readonly discord: DiscordService) {}

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
    this.shieldTick = setInterval(() => this.rechargeShields(), SHIELD_TICK_MS)
  }

  private shieldTick?: NodeJS.Timeout

  /** Shields come back once a player hasn't been hit for SHIELD_DELAY_MS. */
  private rechargeShields() {
    const now = Date.now()
    for (const [roomId, room] of this.vitals) {
      for (const [userId, vitals] of room) {
        if (vitals.dead || vitals.shield >= MAX_SHIELD || now - vitals.hurtAt < SHIELD_DELAY_MS) continue
        vitals.shield = Math.min(MAX_SHIELD, vitals.shield + (SHIELD_RATE * SHIELD_TICK_MS) / 1000)
        this.broadcast(roomId, { type: 'hp', id: userId, hp: vitals.hp, shield: Math.round(vitals.shield), by: '' })
      }
    }
  }

  onModuleDestroy() {
    clearInterval(this.heartbeat)
    clearInterval(this.shieldTick)
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
        case 'hijack': this.hijack(roomId, conn, message); break
        case 'fire': this.fire(roomId, conn, message); break
        case 'throw': this.throwGrenade(roomId, conn, message); break
        case 'blast': this.grenadeBlast(roomId, conn, message); break
        case 'melee': this.melee(roomId, conn, message); break
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
      return { ...player, team: player.id === me.id ? me.team : player.team, online: !!live, state: live?.state ?? null, hp: vitals.hp, shield: Math.round(vitals.shield), dead: vitals.dead }
    })
    const world = this.worldOf(roomId)
    this.send(ws, {
      type: 'welcome', you: user.id, players,
      vehicles: Object.fromEntries(world.vehiclePoses),
      items: [...world.items.values()],
      wrecks: [...world.wrecks.keys()],
      vehicleHp: Object.fromEntries(world.vehicleHp),
      barrels: [...world.barrels].map(([id, b]) => ({ id, x: b.x, z: b.z, alive: b.alive })),
    })
    const myVitals = this.vitalsOf(roomId, user.id)
    this.broadcast(roomId, { type: 'player', player: { ...me, online: true, state: null, hp: myVitals.hp, shield: Math.round(myVitals.shield), dead: myVitals.dead } }, user.id)
    return { roomId, conn }
  }

  private worldOf(roomId: string): RoomWorld {
    let world = this.worlds.get(roomId)
    if (!world) {
      world = {
        items: new Map(initialItems().map((item) => [item.id, item])), dropped: [], wrecks: new Map(), vehiclePoses: new Map(), timers: new Set(),
        vehicleHp: new Map(), ejectLocks: new Map(), grenades: new Map(),
        barrels: new Map(BARRELS.map((b) => [b.id, { x: b.x, z: b.z, hp: BARREL_HP, alive: true }])),
      }
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
    if (!vitals) room.set(userId, (vitals = { hp: MAX_HP, dead: false, lastShotAt: 0, lastShotFxAt: 0, lastMissileAt: 0, lastDropAt: 0, lastCannonAt: 0, mechRockets: [], shield: MAX_SHIELD, hurtAt: 0, lastMeleeAt: 0, streak: 0 }))
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
    const refused = state.vehicle ? this.claimSeat(roomId, conn, state.vehicle) : null
    if (refused) {
      // One player per seat, whoever got in first keeps it; wrecks can't be boarded; nor can a vehicle you were just pulled out of
      this.send(conn.ws, { type: 'eject', vehicle: state.vehicle!.id, reason: refused })
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

  /** Take a seat (null) or say why not: 'wreck', 'locked' (pulled out of it a moment ago), 'taken'. */
  private claimSeat(roomId: string, conn: Connection, vehicle: VehicleState): string | null {
    const world = this.worldOf(roomId)
    if (world.wrecks.has(vehicle.id)) return 'wreck'
    if ((world.ejectLocks.get(`${conn.userId}|${vehicle.id}`) ?? 0) > Date.now()) return 'locked'
    const taken = this.occupants(roomId, vehicle.id).some((other) => other !== conn && other.state!.vehicle!.seat === vehicle.seat)
    if (taken) return 'taken'
    if (vehicle.seat === 0) world.vehiclePoses.set(vehicle.id, { p: vehicle.p, r: vehicle.r })
    return null
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
    const to = vec(message.to, 600)
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

  /**
   * A round struck something. `target`: a player (their health); `vehicle`: a car or helicopter (its hull —
   * tanks shrug bullets off); `barrel`: an explosive barrel. The weapon's fire rate and range are checked.
   */
  private hit(roomId: string, shooter: Connection, message: Record<string, unknown>) {
    const weaponId = typeof message.weapon === 'string' ? message.weapon : ''
    const weapon = WEAPONS[weaponId]
    if (!weapon || !shooter.state) return
    // The machine gun only hits from behind a machine gun, the car gun from a car's driver seat,
    // hand weapons from neither (nor from a helicopter's pilot seat or a tank)
    const v = shooter.state.vehicle
    const driving = v?.seat === 0
    // Vehicle guns belong to whoever drives / flies it; hand weapons are for passengers (a helicopter's co-pilot and door gunners)
    const vehicleGun = weaponId === 'car-gun' ? '-car-' : weaponId === 'mech-cannon' ? '-mech-' : weaponId === 'heli-gun' ? '-heli-' : weaponId === 'fighter-laser' ? '-fighter-' : null
    if (weaponId === 'machine-gun' ? !shooter.state.gun : vehicleGun ? !(driving && v!.id.includes(vehicleGun)) : shooter.state.gun || driving) return
    const shooterVitals = this.vitalsOf(roomId, shooter.userId)
    if (shooterVitals.dead) return
    const now = Date.now()
    if (now - shooterVitals.lastShotAt < weapon.fireRate * 1000 * FIRE_RATE_SLACK) return
    const from = this.firingPoint(shooter.state)
    const world = this.worldOf(roomId)

    const barrelId = typeof message.barrel === 'string' ? message.barrel : null
    if (barrelId) {
      const barrel = world.barrels.get(barrelId)
      if (!barrel?.alive || dist2(from, [barrel.x, barrel.z]) > weapon.range + RANGE_SLACK) return
      shooterVitals.lastShotAt = now
      barrel.hp -= weapon.power
      if (barrel.hp <= 0) this.blowBarrel(roomId, barrelId, shooter.userId)
      return
    }

    const vehicleId = typeof message.vehicle === 'string' && VEHICLE_ID.test(message.vehicle) ? message.vehicle : null
    if (vehicleId) {
      const pose = this.vehiclePosition(roomId, vehicleId)
      if (!pose || dist2(from, pose) > weapon.range + RANGE_SLACK || kindOf(vehicleId) === 'tank') return
      shooterVitals.lastShotAt = now
      // Rounds chip away at a hull (a third of their power; a mech's armour lets through far less) — not at one a teammate is riding in
      // (a fighter's lasers are made for other craft)
      const armour = kindOf(vehicleId) === 'mech' ? 0.12 : weaponId === 'fighter-laser' ? 0.6 : 0.35
      if (!this.teammateAboard(roomId, vehicleId, shooter)) this.damageVehicle(roomId, vehicleId, weapon.power * armour, shooter.userId, weaponId)
    }

    const target = typeof message.target === 'string' ? this.rooms.get(roomId)?.get(message.target) : undefined
    if (!target || target.team === shooter.team || !target.state) return
    // Inside a tank or a mech you are behind armour
    if (target.state.vehicle && ['tank', 'mech'].includes(kindOf(target.state.vehicle.id))) return
    const targetVitals = this.vitalsOf(roomId, target.userId)
    if (targetVitals.dead) return
    const to = target.state.vehicle?.p ?? target.state.p
    if (dist2(from, to) > weapon.range + RANGE_SLACK) return
    shooterVitals.lastShotAt = now
    this.damagePlayer(roomId, target, weapon.power, shooter.userId, weaponId)
  }

  /**
   * A melee strike on someone within arm's reach (both on foot): a heavy blow, or an instant takedown when it
   * comes from behind them.
   */
  private melee(roomId: string, attacker: Connection, message: Record<string, unknown>) {
    const target = typeof message.target === 'string' ? this.rooms.get(roomId)?.get(message.target) : undefined
    const a = attacker.state, t = target?.state
    if (!target || !a || !t || target.team === attacker.team || a.vehicle || a.gun || t.vehicle) return
    const vitals = this.vitalsOf(roomId, attacker.userId)
    const now = Date.now()
    if (vitals.dead || this.vitalsOf(roomId, target.userId).dead || now - vitals.lastMeleeAt < MELEE_COOLDOWN_MS) return
    if (Math.hypot(a.p[0] - t.p[0], a.p[1] - t.p[1], a.p[2] - t.p[2]) > MELEE_REACH) return
    vitals.lastMeleeAt = now
    // Behind them: we're on the side they're facing away from
    const facing = [-Math.sin(t.yaw), -Math.cos(t.yaw)]
    const behind = (a.p[0] - t.p[0]) * facing[0] + (a.p[2] - t.p[2]) * facing[1] < 0
    this.damagePlayer(roomId, target, behind ? 1000 : MELEE_DAMAGE, attacker.userId, behind ? 'assassination' : 'melee')
  }

  private damagePlayer(roomId: string, target: Connection, amount: number, by: string, how: string) {
    const vitals = this.vitalsOf(roomId, target.userId)
    if (vitals.dead || amount <= 0) return
    // The shield takes it first; what gets through comes off health
    vitals.hurtAt = Date.now()
    const absorbed = Math.min(vitals.shield, amount)
    vitals.shield -= absorbed
    vitals.hp = Math.max(0, vitals.hp - Math.round(amount - absorbed))
    this.broadcast(roomId, { type: 'hp', id: target.userId, hp: vitals.hp, shield: Math.round(vitals.shield), by })
    if (vitals.hp <= 0) this.kill(roomId, target, by, how)
  }

  /** A player dies: everyone is told (and how), what they carried is left on the ground, and they respawn in 5s. */
  private kill(roomId: string, target: Connection, by: string, how = '') {
    const vitals = this.vitalsOf(roomId, target.userId)
    if (vitals.dead) return
    vitals.hp = 0
    vitals.shield = 0
    vitals.dead = true
    vitals.streak = 0
    if (by && by !== target.userId) {
      const killer = this.vitalsOf(roomId, by)
      killer.streak++
      if (SPREES[killer.streak]) void this.announceSpree(roomId, by, killer.streak)
    }
    this.broadcast(roomId, { type: 'hp', id: target.userId, hp: 0, by })
    this.broadcast(roomId, { type: 'killed', id: target.userId, by, how })
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
      vitals.shield = MAX_SHIELD
      vitals.dead = false
      this.broadcast(roomId, { type: 'respawn', id: target.userId })
    }, RESPAWN_MS)
  }

  /** Where a vehicle is: its driver's latest report, where it was left, or its home spot. */
  private vehiclePosition(roomId: string, vehicleId: string): Vec3 | [number, number] | null {
    const world = this.worldOf(roomId)
    const driver = this.occupants(roomId, vehicleId).find((c) => c.state!.vehicle!.seat === 0)
    return driver?.state!.vehicle!.p ?? world.vehiclePoses.get(vehicleId)?.p ?? VEHICLE_HOMES.get(vehicleId) ?? null
  }

  /** Someone on the attacker's side (other than the attacker) is in this vehicle. */
  private teammateAboard(roomId: string, vehicleId: string, attacker: Connection | undefined) {
    return !!attacker && this.occupants(roomId, vehicleId).some((c) => c.team === attacker.team && c !== attacker)
  }

  private damageVehicle(roomId: string, vehicleId: string, amount: number, by: string, how: string) {
    const world = this.worldOf(roomId)
    if (world.wrecks.has(vehicleId) || amount <= 0) return
    const max = VEHICLE_MAX_HP[kindOf(vehicleId)]
    const hp = Math.max(0, (world.vehicleHp.get(vehicleId) ?? max) - Math.round(amount))
    world.vehicleHp.set(vehicleId, hp)
    this.broadcast(roomId, { type: 'vhp', id: vehicleId, hp, max })
    if (hp <= 0) this.destroyVehicle(roomId, vehicleId, by, how)
  }

  /**
   * An explosion: players on foot are hurt (not the attacker's teammates), vehicles in reach lose hull
   * (occupants are safe until it goes up), barrels nearby go off too. `at[1]` null = on the ground there.
   */
  private explode(roomId: string, at: [number, number | null, number], kind: BlastKind, by: string) {
    const spec = BLASTS[kind]
    const world = this.worldOf(roomId)
    this.broadcast(roomId, { type: 'boom', at, kind, by })
    const attacker = this.rooms.get(roomId)?.get(by)
    const reach = (p: Vec3 | [number, number], lift = 0) => {
      const flat = Math.hypot(p[0] - at[0], (p.length === 3 ? p[2] : p[1]) - at[2])
      return at[1] === null || p.length !== 3 ? flat : Math.hypot(flat, p[1] - lift - at[1])
    }
    for (const conn of this.rooms.get(roomId)?.values() ?? []) {
      if (!conn.state || conn.state.vehicle || this.vitalsOf(roomId, conn.userId).dead) continue
      if (attacker && conn.team === attacker.team && conn.userId !== by) continue
      const d = reach(conn.state.p, 1)
      if (d < spec.radius) this.damagePlayer(roomId, conn, spec.player * Math.pow(1 - d / spec.radius, 0.8), by, kind)
    }
    for (const vehicleId of VEHICLE_HOMES.keys()) {
      const pose = this.vehiclePosition(roomId, vehicleId)
      if (!pose || this.teammateAboard(roomId, vehicleId, attacker)) continue
      const vk = kindOf(vehicleId)
      const d = Math.max(0, reach(pose, -1.5) - VEHICLE_RADIUS[vk])
      const armour = vk === 'tank' ? spec.tank : vk === 'mech' ? (1 + spec.tank) / 2 : 1
      if (d < spec.radius) this.damageVehicle(roomId, vehicleId, spec.vehicle * armour * (1 - d / spec.radius), by, kind)
    }
    for (const [id, barrel] of world.barrels) {
      if (!barrel.alive || Math.hypot(barrel.x - at[0], barrel.z - at[2]) > spec.radius * 0.8) continue
      // Chain reaction, a moment later
      this.later(roomId, 180, () => this.blowBarrel(roomId, id, by))
    }
  }

  private blowBarrel(roomId: string, id: string, by: string) {
    const world = this.worldOf(roomId)
    const barrel = world.barrels.get(id)
    if (!barrel?.alive) return
    barrel.alive = false
    this.broadcast(roomId, { type: 'barrel', id, alive: false })
    this.explode(roomId, [barrel.x, null, barrel.z], 'barrel', by)
    this.later(roomId, BARREL_RESPAWN_MS, () => {
      barrel.alive = true
      barrel.hp = BARREL_HP
      this.broadcast(roomId, { type: 'barrel', id, alive: true })
    })
  }

  /**
   * A tank's cannon shell (driver seat, 3s reload) or a launcher's unguided rocket (on foot): everyone sees it
   * fly to where it was aimed, and it goes off there when it arrives.
   */
  private fire(roomId: string, shooter: Connection, message: Record<string, unknown>) {
    const kind = message.kind === 'shell' || message.kind === 'rocket' ? message.kind : null
    const to = vec(message.to, 600, -100, 600)
    const state = shooter.state
    const vitals = this.vitalsOf(roomId, shooter.userId)
    if (!kind || !to || !state || vitals.dead) return
    const now = Date.now()
    let from: Vec3
    if (kind === 'shell') {
      const v = state.vehicle
      if (!v || v.seat !== 0 || kindOf(v.id) !== 'tank' || now - vitals.lastCannonAt < TANK_RELOAD_MS * FIRE_RATE_SLACK) return
      vitals.lastCannonAt = now
      from = v.p
    } else if (state.vehicle && ['mech', 'heli', 'fighter'].includes(kindOf(state.vehicle.id))) {
      // A mech's shoulder pods / a helicopter pilot's wing pods: salvos of up to MECH_SALVO rockets, then a reload
      if (state.vehicle.seat !== 0) return
      const recent = vitals.mechRockets.filter((t) => now - t < MECH_SALVO_WINDOW_MS)
      if (recent.length >= MECH_SALVO || (recent.length && now - recent[recent.length - 1] < MECH_ROCKET_GAP_MS * FIRE_RATE_SLACK)) return
      vitals.mechRockets = [...recent, now]
      from = state.vehicle.p
    } else {
      if (state.vehicle || state.gun || now - vitals.lastMissileAt < ROCKET_INTERVAL_MS) return
      vitals.lastMissileAt = now
      from = state.p
    }
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    if (distance > (kind === 'shell' ? 650 : 450)) return
    const muzzle = vec(message.from, 600) ?? from
    this.broadcast(roomId, { type: 'fire', id: shooter.userId, kind, from: muzzle, to }, shooter.userId)
    this.later(roomId, (distance / PROJECTILE_SPEED[kind]) * 1000, () => this.explode(roomId, to, kind, shooter.userId))
  }

  /** A grenade leaves someone's hand: everyone else sees it fly (their game simulates the same throw). */
  private throwGrenade(roomId: string, conn: Connection, message: Record<string, unknown>) {
    const from = vec(message.from, 600, -100, 600)
    const velocity = vec(message.v, 60, -60, 60)
    const state = conn.state
    if (!from || !velocity || !state || state.vehicle || this.vitalsOf(roomId, conn.userId).dead) return
    if (Math.hypot(from[0] - state.p[0], from[2] - state.p[2]) > 6) return
    const world = this.worldOf(roomId)
    const now = Date.now()
    const live = (world.grenades.get(conn.userId) ?? []).filter((g) => g.until > now)
    if (live.length >= 3) return
    live.push({ from, until: now + GRENADE_FUSE_MS })
    world.grenades.set(conn.userId, live)
    this.broadcast(roomId, { type: 'throw', id: conn.userId, from, v: velocity }, conn.userId)
  }

  /** The thrower's game says where its grenade went off (it rolled and bounced there); it must be one they threw. */
  private grenadeBlast(roomId: string, conn: Connection, message: Record<string, unknown>) {
    const at = vec(message.at, 600, -100, 600)
    const world = this.worldOf(roomId)
    const now = Date.now()
    const live = (world.grenades.get(conn.userId) ?? []).filter((g) => g.until > now)
    const i = at ? live.findIndex((g) => Math.hypot(g.from[0] - at[0], g.from[2] - at[2]) < 70) : -1
    if (!at || i < 0) return
    live.splice(i, 1)
    world.grenades.set(conn.userId, live)
    this.explode(roomId, at, 'grenade', conn.userId)
  }

  /**
   * [E] at a vehicle with enemies aboard that is standing on the ground: they are pulled out (and can't jump
   * straight back in), and the seat is ours. A flying helicopter or a moving vehicle has to be stopped first.
   */
  private hijack(roomId: string, conn: Connection, message: Record<string, unknown>) {
    const vehicleId = typeof message.vehicle === 'string' && VEHICLE_ID.test(message.vehicle) ? message.vehicle : null
    const state = conn.state
    const world = this.worldOf(roomId)
    const refuse = (reason: string) => this.send(conn.ws, { type: 'hijack', vehicle: vehicleId, ok: false, reason })
    if (!vehicleId || !state || state.vehicle || state.gun || this.vitalsOf(roomId, conn.userId).dead) return refuse('')
    if (world.wrecks.has(vehicleId)) return refuse('wreck')
    // Just pulled out of it yourself: no pulling them straight back out
    if ((world.ejectLocks.get(`${conn.userId}|${vehicleId}`) ?? 0) > Date.now()) return refuse('locked')
    const aboard = this.occupants(roomId, vehicleId)
    const enemies = aboard.filter((c) => c.team !== conn.team)
    const pose = this.vehiclePosition(roomId, vehicleId)
    if (!pose || dist2(pose, state.p) > 11) return refuse('far')
    const driver = aboard.find((c) => c.state!.vehicle!.seat === 0)
    if (driver && driver.team !== conn.team) {
      const dv = driver.state!.vehicle!
      // Standing on the ground (level with us) and not driving off
      if (Math.abs(dv.p[1] - (state.p[1] - 1.7)) > 3.5 || (kindOf(vehicleId) !== 'heli' && Math.abs(dv.spin) > 4)) return refuse('moving')
    }
    const now = Date.now()
    for (const enemy of enemies) {
      world.ejectLocks.set(`${enemy.userId}|${vehicleId}`, now + EJECT_LOCK_MS)
      enemy.state!.vehicle = null
      this.send(enemy.ws, { type: 'eject', vehicle: vehicleId, by: conn.userId })
    }
    if (enemies.length) this.broadcast(roomId, { type: 'hijacked', vehicle: vehicleId, by: conn.userId, victims: enemies.map((e) => e.userId) })
    this.send(conn.ws, { type: 'hijack', vehicle: vehicleId, ok: true })
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
    // From the shoulder on foot, or from a fighter's pods (pilot)
    const fromFighter = !!state?.vehicle && kindOf(state.vehicle.id) === 'fighter' && state.vehicle.seat === 0
    if (!targetId || !state || vitals.dead || (state.vehicle && !fromFighter) || state.gun || world.wrecks.has(targetId) || targetId === state.vehicle?.id) return
    const now = Date.now()
    if (now - vitals.lastMissileAt < (fromFighter ? FIGHTER_MISSILE_INTERVAL_MS : MISSILE_INTERVAL_MS)) return
    const aboard = this.occupants(roomId, targetId)
    if (!aboard.some((c) => c.team !== shooter.team)) return
    const at = aboard.find((c) => c.state!.vehicle!.seat === 0)?.state!.vehicle!.p ?? aboard[0].state!.vehicle!.p
    const from = fromFighter ? state.vehicle!.p : state.p
    const distance = Math.hypot(at[0] - from[0], at[1] - from[1], at[2] - from[2])
    if (distance > MISSILE_RANGE + RANGE_SLACK) return
    vitals.lastMissileAt = now
    this.broadcast(roomId, { type: 'missile', id: shooter.userId, target: targetId, from: vec(message.from, 600) ?? from }, shooter.userId)
    // A launcher's missile brings an aircraft down; a fighter's tears into it
    const hit = () => (fromFighter ? this.damageVehicle(roomId, targetId, FIGHTER_MISSILE_DAMAGE, shooter.userId, 'fighter-missile') : this.destroyVehicle(roomId, targetId, shooter.userId, 'missile'))
    this.later(roomId, (distance / (fromFighter ? FIGHTER_MISSILE_SPEED : MISSILE_SPEED)) * 1000 + 400, hit)
  }

  private destroyVehicle(roomId: string, vehicleId: string, by: string, how = '') {
    const world = this.worlds.get(roomId)
    if (!world || world.wrecks.has(vehicleId)) return
    const aboard = this.occupants(roomId, vehicleId)
    const pilot = aboard.find((c) => c.state!.vehicle!.seat === 0)
    if (pilot) world.vehiclePoses.set(vehicleId, { p: pilot.state!.vehicle!.p, r: pilot.state!.vehicle!.r })
    world.vehicleHp.set(vehicleId, 0)
    this.broadcast(roomId, { type: 'wrecked', id: vehicleId, by, at: world.vehiclePoses.get(vehicleId) ?? null })
    for (const conn of aboard) this.kill(roomId, conn, by, how || 'wreck')
    world.wrecks.set(vehicleId, this.later(roomId, WRECK_MS, () => {
      world.wrecks.delete(vehicleId)
      world.vehiclePoses.delete(vehicleId)
      world.vehicleHp.delete(vehicleId)
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
    void this.announceWin(roomId, conn)
  }

  /** Discord: someone is on a killing spree. */
  private async announceSpree(roomId: string, userId: string, streak: number) {
    if (!this.discord.enabled) return
    const [roster, room] = await Promise.all([this.roomService.matchRoster(roomId), this.roomService.roomName(roomId)])
    const player = roster?.players.find((p) => p.id === userId)
    if (!player) return
    this.discord.post({ title: `${SPREES[streak]}!`, description: `**${plain(player.displayName)}** has ${streak} kills without dying in ${plain(room)}.`, color: player.team === 'red' ? DISCORD_COLOR.red : DISCORD_COLOR.blue })
  }

  /** Discord: who won, and who brought the gem home. */
  private async announceWin(roomId: string, conn: Connection) {
    if (!this.discord.enabled) return
    const [roster, room] = await Promise.all([this.roomService.matchRoster(roomId), this.roomService.roomName(roomId)])
    const hero = roster?.players.find((p) => p.id === conn.userId)
    this.discord.post({
      title: `${conn.team === 'red' ? 'Red' : 'Blue'} team wins ${plain(room)}!`,
      description: `${hero ? `**${plain(hero.displayName)}**` : 'A pilot'} stole the enemy gem and brought it home.`,
      color: conn.team === 'red' ? DISCORD_COLOR.red : DISCORD_COLOR.blue,
    })
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

