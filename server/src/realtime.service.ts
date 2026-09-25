import { Injectable, OnModuleDestroy } from '@nestjs/common'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { AuthService } from './auth.service'
import { RoomService, Team } from './room.service'

type Vec3 = [number, number, number]

interface PlayerState {
  p: Vec3
  yaw: number
  pitch: number
  heli: { p: Vec3; r: Vec3; rpm: number } | null
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIN_STATE_INTERVAL_MS = 30
const CAPTURE_RADIUS = 14
// Flagpole world XZ per team; must match the client world layout (bases at ±380, pole at local x = -12)
const FLAGPOLE: Record<Team, [number, number]> = { blue: [-392, -380], red: [368, 380] }

const num = (value: unknown, min: number, max: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null)

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
  let heli: PlayerState['heli'] = null
  if (s.heli && typeof s.heli === 'object') {
    const h = s.heli as Record<string, unknown>
    const hp3 = vec(h.p, 500)
    const r = vec(h.r, 1e4, -1e4, 1e4)
    const rpm = num(h.rpm, 0, 100)
    if (!hp3 || !r || rpm === null) return null
    heli = { p: hp3, r, rpm }
  }
  return { p, yaw, pitch, heli, flag: s.flag === true, hp }
}

@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
  private readonly rooms = new Map<string, Map<string, Connection>>()
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
      if (message.type === 'state') {
        const now = Date.now()
        if (now - conn.lastStateAt < MIN_STATE_INTERVAL_MS) return
        const state = parseState(message.s)
        if (!state) return
        conn.lastStateAt = now
        conn.state = state
        this.broadcast(roomId, { type: 'state', id: conn.userId, s: state }, conn.userId)
      } else if (message.type === 'capture') {
        await this.capture(roomId, conn)
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
      return { ...player, team: player.id === me.id ? me.team : player.team, online: !!live, state: live?.state ?? null }
    })
    this.send(ws, { type: 'welcome', you: user.id, players })
    this.broadcast(roomId, { type: 'player', player: { ...me, online: true, state: null } }, user.id)
    return { roomId, conn }
  }

  private async capture(roomId: string, conn: Connection) {
    const state = conn.state
    if (!state?.flag || state.heli) return
    const [fx, fz] = FLAGPOLE[conn.team]
    if (Math.hypot(state.p[0] - fx, state.p[2] - fz) > CAPTURE_RADIUS) return
    if (!(await this.roomService.finish(roomId))) return
    this.broadcast(roomId, { type: 'end', winner: conn.team, by: conn.userId })
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
