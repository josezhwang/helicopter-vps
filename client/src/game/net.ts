import { API_URL } from '../config'

export type Team = 'red' | 'blue'
export type Vec3 = [number, number, number]

export interface NetState {
  p: Vec3
  yaw: number
  pitch: number
  heli: { p: Vec3; r: Vec3; rpm: number } | null
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
}

export interface NetHandlers {
  onWelcome: (you: string, players: NetPlayer[]) => void
  onPlayer: (player: NetPlayer) => void
  onLeave: (id: string) => void
  onState: (id: string, state: NetState) => void
  onEnd: (winner: Team, by: string) => void
  onError: (message: string) => void
  onConnection: (connected: boolean) => void
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
          this.handlers.onWelcome(String(message.you), message.players as NetPlayer[])
          break
        case 'player': this.handlers.onPlayer(message.player as NetPlayer); break
        case 'leave': this.handlers.onLeave(String(message.id)); break
        case 'state': this.handlers.onState(String(message.id), message.s as NetState); break
        case 'end': this.handlers.onEnd(message.winner as Team, String(message.by)); break
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
