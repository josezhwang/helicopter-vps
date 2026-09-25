import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Game } from './game/Game'
import './styles.css'

type AuthView = 'login' | 'signup' | 'forgot'
type SiteView = AuthView | 'dashboard' | 'room'
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
  const [view, setView] = useState<SiteView>(() => {
    const hash = window.location.hash.replace('#/', '') as SiteView
    return ['login', 'signup', 'forgot', 'room'].includes(hash) ? hash : 'login'
  })
  const [rooms, setRooms] = useState(initialRooms)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const activeRoom = rooms.find((room) => room.id === activeRoomId) ?? null

  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash.replace('#/', '')
      if (hash === 'play') return
      const nextView: SiteView = hash === 'signup' || hash === 'forgot' || hash === 'room'
        ? hash
        : hash === 'dashboard'
          ? 'dashboard'
          : 'login'
      setView(nextView)
    }
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  if (window.location.hash === '#/play') return <Game />

  const enterDashboard = () => {
    setView('dashboard')
    navigate('dashboard')
  }

  if (view === 'login' || view === 'signup' || view === 'forgot') {
    return <AuthScreen mode={view} onNavigate={navigate} onSuccess={enterDashboard} />
  }

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
      onCreateRoom={(room) => { setRooms((current) => [room, ...current]); setActiveRoomId(room.id); navigate('room') }}
      onPlay={() => { window.location.hash = 'play' }}
    />
  )
}

function AuthScreen({ mode, onNavigate, onSuccess }: { mode: AuthView; onNavigate: (view: SiteView) => void; onSuccess: () => void }) {
  const [submitted, setSubmitted] = useState(false)
  const isForgot = mode === 'forgot'
  const isSignup = mode === 'signup'
  const title = isForgot ? 'Reset your access' : isSignup ? 'Create your pilot identity' : 'Welcome back, pilot'
  const eyebrow = isForgot ? 'Account recovery' : isSignup ? 'Join the international arena' : 'Command center access'

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isForgot) setSubmitted(true)
    else onSuccess()
  }

  return (
    <main className="auth-page">
      <section className="auth-visual">
        <div className="brand-mark"><span className="brand-cross">+</span> AERIUM</div>
        <div className="visual-copy">
          <p className="kicker">GLOBAL COMBAT NETWORK / 01</p>
          <h1>Every front has a story.</h1>
          <p>Find your squad, command the room, and take the flag beyond borders.</p>
        </div>
        <div className="visual-coordinates">45° 12' 08" N<br />09° 11' 42" E</div>
        <div className="visual-grid" />
      </section>
      <section className="auth-panel">
        <div className="auth-panel-top"><span>INTERNATIONAL GAME SITE</span><button className="text-button" onClick={() => onNavigate('login')}>EN / US</button></div>
        <div className="auth-form-wrap">
          <p className="kicker">{eyebrow}</p>
          <h2>{title}</h2>
          {submitted ? (
            <div className="notice success"><strong>Check your inbox.</strong><span>A recovery link is ready for your account.</span><button className="button primary" onClick={() => onNavigate('login')}>Return to login</button></div>
          ) : (
            <form className="auth-form" onSubmit={submit}>
              {isSignup && <label>Callsign<input required placeholder="Your public name" /></label>}
              <label>Email address<input required type="email" placeholder="pilot@aerium.world" /></label>
              {!isForgot && <label>Password<input required type="password" placeholder="At least 8 characters" /></label>}
              {isSignup && <label className="check-row"><input type="checkbox" required /> <span>I agree to the community code.</span></label>}
              <button className="button primary" type="submit">{isForgot ? 'Send recovery link' : isSignup ? 'Create account' : 'Enter command'}</button>
            </form>
          )}
          <div className="auth-links">
            {!isForgot && <button className="text-button" onClick={() => onNavigate('forgot')}>Forgot password?</button>}
            <span>{isSignup ? 'Already enlisted?' : 'New to Aerium?'}</span>
            <button className="text-button accent" onClick={() => onNavigate(isSignup ? 'login' : 'signup')}>{isSignup ? 'Log in' : 'Sign up'}</button>
          </div>
        </div>
        <footer className="auth-footer"><span>© 2026 AERIUM NETWORK</span><span>Terms / Privacy / Support</span></footer>
      </section>
    </main>
  )
}

function Dashboard({ rooms, onOpenRoom, onCreateRoom, onPlay }: { rooms: Room[]; onOpenRoom: (id: string) => void; onCreateRoom: (room: Room) => void; onPlay: () => void }) {
  const [showCreate, setShowCreate] = useState(false)
  const [roomName, setRoomName] = useState('')
  const [maxPlayers, setMaxPlayers] = useState('8')
  const [mode, setMode] = useState('Flag Assault')
  const [map, setMap] = useState('Sierra Basin')
  const openRooms = useMemo(() => rooms.filter((room) => room.status !== 'live'), [rooms])

  const createRoom = (event: FormEvent) => {
    event.preventDefault()
    const limit = Number(maxPlayers)
      onCreateRoom({ id: `${Date.now()}`, name: roomName || 'Untitled operation', map, mode, maxPlayers: limit, players: [currentUser], ping: 24, status: limit === 1 ? 'full' : 'open', creator: currentUser })
    setShowCreate(false)
  }

  return (
    <main className="site-shell">
      <nav className="topbar"><div className="brand-mark dark"><span className="brand-cross">+</span> AERIUM</div><div className="nav-center"><span className="active">OPERATIONS</span><span>COMMUNITY</span><span>INTEL</span></div><div className="profile"><span className="online-dot" /> {currentUser}<span className="avatar">NP</span></div></nav>
      <div className="dashboard-grid">
        <aside className="side-rail"><div className="rail-label">COMMAND / 01</div><div className="pilot-card"><div className="pilot-avatar">NP</div><strong>{currentUser}</strong><span>RANK 04 / PATHFINDER</span><div className="rank-line"><i /></div></div><button className="rail-link active"><span>◈</span> Operations</button><button className="rail-link"><span>◇</span> Squad finder</button><button className="rail-link"><span>◌</span> Records</button><div className="rail-bottom"><span className="online-dot" /> Server cluster: EU-2<br /><small>48 ms average latency</small></div></aside>
        <section className="dashboard-main"><header className="page-heading"><div><p className="kicker">THURSDAY / 25 SEPTEMBER 2026</p><h1>Operations room</h1><p className="muted">Assemble your squad. Cross the line.</p></div><button className="button primary" onClick={() => setShowCreate(true)}><span className="button-plus">+</span> Create room</button></header><div className="status-strip"><div><span className="status-number">{openRooms.length}</span><span>rooms open</span></div><div><span className="status-number">24</span><span>pilots online</span></div><div><span className="status-number">03</span><span>regions live</span></div><button className="play-link" onClick={onPlay}>Preview battlefield <span>→</span></button></div><div className="room-heading"><h2>Open operations</h2><button className="text-button">Filter: all regions⌄</button></div><div className="room-list">{openRooms.map((room) => <RoomCard key={room.id} room={room} onOpen={() => onOpenRoom(room.id)} />)}</div></section>
      </div>
        {showCreate && <div className="modal-backdrop"><form className="create-modal" onSubmit={createRoom}><button type="button" className="modal-close" onClick={() => setShowCreate(false)}>×</button><p className="kicker">NEW OPERATION</p><h2>Set the parameters.</h2><label>Room name<input autoFocus value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="e.g. Dawn Patrol" /></label><div className="form-two"><label>Game mode<select value={mode} onChange={(event) => setMode(event.target.value)}><option>Flag Assault</option><option>Team Skirmish</option></select></label><label>Map<select value={map} onChange={(event) => setMap(event.target.value)}><option>Sierra Basin</option><option>Copper Valley</option><option>Northwatch</option></select></label></div><label>Attendance limit<select value={maxPlayers} onChange={(event) => setMaxPlayers(event.target.value)}>{[1, 2, 4, 6, 8, 12, 16].map((number) => <option key={number} value={number}>{number} pilots</option>)}</select></label><p className="form-hint">The operation starts when the room reaches this limit. You can launch it from the lobby.</p><button className="button primary" type="submit">Create operation</button></form></div>}
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
