import { useEffect, useMemo, useState } from 'react'
import { Game } from './game/Game'
import './styles.css'

type SiteView = 'dashboard' | 'room'
type RoomStatus = 'open' | 'full' | 'live'

type Room = {
  id: string
  name: string
  map: string
  mode: string
  maxPlayers: number
  players: string[]
  ping: number
  status: RoomStatus
  creator: string
}

const currentUser = 'NovaPilot'

const initialRooms: Room[] = [
  { id: 'atlas-7', name: 'Atlas Frontline', map: 'Sierra Basin', mode: 'Flag Assault', maxPlayers: 8, players: ['Mara', 'Kite', 'Rook'], ping: 42, status: 'open', creator: 'Mara' },
  { id: 'cobalt-2', name: 'Cobalt Dawn', map: 'Copper Valley', mode: 'Team Skirmish', maxPlayers: 6, players: ['Orion', 'Vega', 'Iris', 'Sable', 'Juno', 'Flux'], ping: 68, status: 'full', creator: 'Orion' },
  { id: 'rook-11', name: 'Rook Eleven', map: 'Northwatch', mode: 'Flag Assault', maxPlayers: 12, players: ['Helix'], ping: 31, status: 'open', creator: 'Helix' },
]

function navigate(view: SiteView) {
  window.location.hash = view === 'dashboard' ? '' : view
}

export function App() {
  const [view, setView] = useState<SiteView>('dashboard')
  const [rooms, setRooms] = useState(initialRooms)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const activeRoom = rooms.find((room) => room.id === activeRoomId) ?? null

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#/', '')
      if (hash === 'play') return
      setView(hash === 'room' ? 'room' : 'dashboard')
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  if (window.location.hash === '#/play') return <Game />

  if (view === 'room' && activeRoom) {
    return (
      <RoomLobby
        room={activeRoom}
        onBack={() => navigate('dashboard')}
        onJoin={() => setRooms((current) => current.map((room) => room.id === activeRoom.id && !room.players.includes(currentUser) ? { ...room, players: [...room.players, currentUser], status: room.players.length + 1 >= room.maxPlayers ? 'full' : 'open' } : room))}
        onStart={() => {
          setRooms((current) => current.map((room) => room.id === activeRoom.id ? { ...room, status: 'live' } : room))
          window.location.hash = 'play'
        }}
      />
    )
  }

  return (
    <Dashboard
      rooms={rooms}
      onOpenRoom={(id) => { setActiveRoomId(id); navigate('room') }}
      onPlay={() => { window.location.hash = 'play' }}
    />
  )
}

function Dashboard({ rooms, onOpenRoom, onPlay }: { rooms: Room[]; onOpenRoom: (id: string) => void; onPlay: () => void }) {
  const openRooms = useMemo(() => rooms.filter((room) => room.status !== 'live'), [rooms])

  return (
    <main className="site-shell">
      <nav className="topbar"><div className="brand-mark dark"><span className="brand-cross">+</span> AERIUM</div><div className="nav-center"><span className="active">OPERATIONS</span><span>COMMUNITY</span><span>INTEL</span></div><div className="profile"><span className="online-dot" /> {currentUser}<span className="avatar">NP</span></div></nav>
      <div className="dashboard-grid">
        <aside className="side-rail"><div className="rail-label">COMMAND / 01</div><div className="pilot-card"><div className="pilot-avatar">NP</div><strong>{currentUser}</strong><span>RANK 04 / PATHFINDER</span><div className="rank-line"><i /></div></div><button className="rail-link active"><span>◈</span> Operations</button><button className="rail-link"><span>◇</span> Squad finder</button><button className="rail-link"><span>◌</span> Records</button><div className="rail-bottom"><span className="online-dot" /> Server cluster: EU-2<br /><small>48 ms average latency</small></div></aside>
        <section className="dashboard-main"><header className="page-heading"><div><p className="kicker">THURSDAY / 25 SEPTEMBER 2026</p><h1>Operations room</h1><p className="muted">Choose an operation and join your squad.</p></div><button className="button primary" onClick={onPlay}>Preview battlefield <span>→</span></button></header><div className="status-strip"><div><span className="status-number">{openRooms.length}</span><span>rooms open</span></div><div><span className="status-number">24</span><span>pilots online</span></div><div><span className="status-number">03</span><span>regions live</span></div></div><div className="room-heading"><h2>Open operations</h2><button className="text-button">Filter: all regions⌄</button></div><div className="room-list">{openRooms.map((room) => <RoomCard key={room.id} room={room} onOpen={() => onOpenRoom(room.id)} />)}</div></section>
      </div>
    </main>
  )
}

function RoomCard({ room, onOpen }: { room: Room; onOpen: () => void }) {
  const percentage = Math.round((room.players.length / room.maxPlayers) * 100)
  return <article className="room-card"><div className="room-icon">{room.mode === 'Flag Assault' ? '◆' : '✦'}</div><div className="room-info"><div className="room-title"><h3>{room.name}</h3><span className={`room-status ${room.status}`}>{room.status === 'full' ? 'FULL' : 'OPEN'}</span></div><p>{room.mode} <span>/</span> {room.map}</p><div className="room-meta"><span>{room.players.length} / {room.maxPlayers} pilots</span><span>Created by {room.creator}</span><span>{room.ping} ms</span></div><div className="capacity"><i style={{ width: `${percentage}%` }} /></div></div><button className="button outline" onClick={onOpen}>{room.status === 'full' ? 'Spectate' : 'Join room'} <span>→</span></button></article>
}

function RoomLobby({ room, onBack, onJoin, onStart }: { room: Room; onBack: () => void; onJoin: () => void; onStart: () => void }) {
  const isCreator = room.creator === currentUser
  const isFull = room.players.length >= room.maxPlayers
  return <main className="site-shell lobby-shell"><nav className="topbar"><button className="back-button" onClick={onBack}>← Operations</button><div className="brand-mark dark"><span className="brand-cross">+</span> AERIUM</div><div className="profile"><span className="online-dot" /> {currentUser}<span className="avatar">NP</span></div></nav><section className="lobby-content"><div className="lobby-header"><div><p className="kicker">ROOM LOBBY / {room.id.toUpperCase()}</p><h1>{room.name}</h1><p className="muted">{room.mode} / {room.map}</p></div><span className={`room-status large ${room.status}`}>{room.status === 'live' ? 'IN PROGRESS' : isFull ? 'ROOM FULL' : 'WAITING FOR PILOTS'}</span></div><div className="lobby-board"><div className="lobby-map"><div className="map-lines" /><span className="map-tag">{room.map.toUpperCase()}</span><div className="map-coordinates">FIELD MAP / 03<br />LIVE CONNECTION READY</div></div><div className="roster-panel"><div className="roster-title"><h2>Roster</h2><span>{room.players.length} / {room.maxPlayers}</span></div><div className="roster-list">{room.players.map((player, index) => <div className="roster-row" key={player}><span className={`team-dot ${index % 2 === 0 ? 'blue' : 'red'}`} /><strong>{player}</strong><span>{player === room.creator ? 'COMMANDER' : 'PILOT'}</span>{player === currentUser && <em>YOU</em>}</div>)}{Array.from({ length: Math.max(0, room.maxPlayers - room.players.length) }).slice(0, 4).map((_, index) => <div className="roster-row empty" key={`empty-${index}`}><span className="empty-dot" /><span>Awaiting pilot...</span></div>)}</div><div className="lobby-actions">{!room.players.includes(currentUser) && room.status !== 'live' && <button className="button outline" onClick={onJoin}>Join this room</button>}{isCreator && <button className="button primary" disabled={!isFull || room.status === 'live'} onClick={onStart}>{room.status === 'live' ? 'Operation live' : isFull ? 'Start operation' : `Waiting for ${room.maxPlayers - room.players.length} more`}</button>}</div></div></div></section></main>
}
