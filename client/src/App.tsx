import { FormEvent, useEffect, useState } from 'react'
import { Game } from './game/Game'
import './styles.css'

type AuthView = 'login' | 'signup' | 'forgot'
type SiteView = AuthView | 'dashboard' | 'room'
type Room = { id: string; name: string; map: string; mode: string; maxMembers: number; memberCount: number; status: 'waiting' | 'live' | 'finished'; creatorDisplayId: string; ping?: number }
type User = { id: string; email: string; displayId: string; displayName: string }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3002'

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } })
  const data = await response.json().catch(() => ({})) as { message?: string }
  if (!response.ok) throw new ApiError(Array.isArray(data.message) ? data.message.join(', ') : data.message ?? 'Request failed', response.status)
  return data as T
}

function navigate(view: SiteView) { window.location.hash = view === 'dashboard' ? '' : view }

export function App() {
  const [view, setView] = useState<SiteView>(() => window.localStorage.getItem('aerium_token') ? 'dashboard' : 'login')
  const [token, setToken] = useState(() => window.localStorage.getItem('aerium_token') ?? '')
  const [user, setUser] = useState<User | null>(() => { try { return JSON.parse(window.localStorage.getItem('aerium_user') ?? 'null') as User | null } catch { return null } })
  const [rooms, setRooms] = useState<Room[]>([])
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const activeRoom = rooms.find((room) => room.id === activeRoomId) ?? null

  const loadRooms = async () => {
    const data = await api<Array<Record<string, unknown>>>('/rooms', {}, token)
    setRooms(data.map((room) => ({ id: String(room.id), name: String(room.name), map: 'Sierra Basin', mode: String(room.battle_type), maxMembers: Number(room.max_members), memberCount: Number(room.member_count), status: room.status as Room['status'], creatorDisplayId: String(room.creator_display_id ?? ''), ping: 24 })))
  }

  useEffect(() => {
    const handleHash = () => { const hash = window.location.hash.replace('#/', ''); if (hash !== 'play') setView(hash === 'room' ? 'room' : token ? 'dashboard' : hash === 'signup' || hash === 'forgot' ? hash : 'login') }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [token])

  const logout = () => { window.localStorage.clear(); setToken(''); setUser(null); navigate('login') }

  useEffect(() => { if (token) void loadRooms().catch((error) => { if (error instanceof ApiError && error.status === 401) logout() }) }, [token])
  if (window.location.hash === '#/play') return <Game />
  const authRoute = view === 'login' || view === 'signup' || view === 'forgot'
  if (!user || !token || authRoute && window.location.hash !== '') return <AuthScreen mode={view === 'signup' || view === 'forgot' ? view : 'login'} onNavigate={navigate} onAuthenticated={(session) => { setToken(session.token); setUser(session.user); window.localStorage.setItem('aerium_token', session.token); window.localStorage.setItem('aerium_user', JSON.stringify(session.user)); navigate('dashboard') }} />
  if (view === 'room' && activeRoom) return <RoomLobby room={activeRoom} user={user} token={token} onBack={() => navigate('dashboard')} onRefresh={loadRooms} />
  return <Dashboard rooms={rooms} user={user} token={token} onOpenRoom={(id) => { setActiveRoomId(id); navigate('room') }} onCreated={async () => { await loadRooms() }} onLogout={logout} />
}

function AuthScreen({ mode, onNavigate, onAuthenticated }: { mode: AuthView; onNavigate: (view: SiteView) => void; onAuthenticated: (session: { token: string; user: User }) => void }) {
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('')
    const form = new FormData(event.currentTarget)
    try {
      if (mode === 'forgot') { await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: form.get('email') }) }); setSent(true); return }
      const body = mode === 'signup' ? { email: form.get('email'), password: form.get('password'), checkPassword: form.get('checkPassword'), displayId: form.get('displayId'), displayName: form.get('displayName') } : { email: form.get('email'), password: form.get('password') }
      onAuthenticated(await api<{ token: string; user: User }>(`/auth/${mode}`, { method: 'POST', body: JSON.stringify(body) }))
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Request failed'
      if (message.includes('account with this email already exists')) { onNavigate('login'); return }
      setError(message)
    }
  }
  const signup = mode === 'signup'
  return <main className="auth-page"><section className="auth-visual"><div className="brand-mark"><span className="brand-cross">+</span> AERIUM</div><div className="visual-copy"><p className="kicker">GLOBAL COMBAT NETWORK / 01</p><h1>Every front has a story.</h1><p>Find your squad, command the room, and take the flag beyond borders.</p></div><div className="visual-coordinates">45° 12' 08" N<br />09° 11' 42" E</div><div className="visual-grid" /></section><section className="auth-panel"><div className="auth-panel-top"><span>INTERNATIONAL GAME SITE</span><span>EN / US</span></div><div className="auth-form-wrap"><p className="kicker">{mode === 'forgot' ? 'ACCOUNT RECOVERY' : signup ? 'JOIN THE INTERNATIONAL ARENA' : 'COMMAND CENTER ACCESS'}</p><h2>{sent ? 'Check your inbox.' : mode === 'forgot' ? 'Reset your access' : signup ? 'Create your pilot identity' : 'Welcome back, pilot'}</h2>{sent ? <div className="notice success"><span>If an account exists for that email, recovery instructions will be sent.</span><button className="button primary" onClick={() => onNavigate('login')}>Return to login</button></div> : <form className="auth-form" onSubmit={submit}>{signup && <><label>Display ID<input name="displayId" required placeholder="Unique handle" /></label><label>Display name<input name="displayName" required placeholder="Name shown to pilots" /></label></>}<label>Email address<input name="email" required type="email" placeholder="pilot@aerium.world" /></label>{mode !== 'forgot' && <label>Password<input name="password" required type="password" placeholder="At least 8 characters" /></label>}{signup && <label>Check password<input name="checkPassword" required type="password" placeholder="Repeat password" /></label>}<button className="button primary" type="submit">{mode === 'forgot' ? 'Send recovery link' : signup ? 'Create account' : 'Enter command'}</button></form>}{error && <p className="form-error">{error}</p>}<div className="auth-links">{mode === 'login' && <button className="text-button" onClick={() => onNavigate('forgot')}>Forgot password?</button>}<span>{signup ? 'Already enlisted?' : 'New to Aerium?'}</span><button className="text-button accent" onClick={() => onNavigate(signup ? 'login' : 'signup')}>{signup ? 'Log in' : 'Sign up'}</button></div></div><footer className="auth-footer"><span>© 2026 AERIUM NETWORK</span><span>Terms / Privacy / Support</span></footer></section></main>
}

function Dashboard({ rooms, user, token, onOpenRoom, onCreated, onLogout }: { rooms: Room[]; user: User; token: string; onOpenRoom: (id: string) => void; onCreated: () => Promise<void>; onLogout: () => void }) {
  const [showCreate, setShowCreate] = useState(false); const [error, setError] = useState('')
  const createRoom = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setError(''); const form = new FormData(event.currentTarget); try { await api('/rooms', { method: 'POST', body: JSON.stringify({ name: form.get('name'), maxMembers: Number(form.get('maxMembers')), battleType: 'flag steal' }) }, token); setShowCreate(false); await onCreated() } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Could not create room') } }
  return <main className="site-shell"><nav className="topbar"><div className="brand-mark dark"><span className="brand-cross">+</span> AERIUM</div><div className="nav-center"><span className="active">OPERATIONS</span><span>COMMUNITY</span><span>INTEL</span></div><div className="profile"><span className="online-dot" /> {user.displayName}<button className="text-button" onClick={onLogout}>Log out</button></div></nav><div className="dashboard-grid"><aside className="side-rail"><div className="rail-label">COMMAND / 01</div><div className="pilot-card"><div className="pilot-avatar">{user.displayId.slice(0, 2).toUpperCase()}</div><strong>{user.displayName}</strong><span>@{user.displayId}</span><div className="rank-line"><i /></div></div><button className="rail-link active"><span>◈</span> Operations</button><button className="rail-link"><span>◇</span> Squad finder</button><button className="rail-link"><span>◌</span> Records</button><div className="rail-bottom"><span className="online-dot" /> Server cluster: EU-2<br /><small>PostgreSQL connected</small></div></aside><section className="dashboard-main"><header className="page-heading"><div><p className="kicker">COMMAND CENTER</p><h1>Operations room</h1><p className="muted">Create a flag steal room and assemble your squad.</p></div><button className="button primary" onClick={() => setShowCreate(true)}><span className="button-plus">+</span> Create room</button></header><div className="status-strip"><div><span className="status-number">{rooms.filter((room) => room.status === 'waiting').length}</span><span>rooms open</span></div><div><span className="status-number">{rooms.reduce((total, room) => total + room.memberCount, 0)}</span><span>pilots in rooms</span></div><div><span className="status-number">FLAG STEAL</span><span>battle type</span></div></div><div className="room-heading"><h2>Available rooms</h2><span className="muted">Live database</span></div><div className="room-list">{rooms.filter((room) => room.status !== 'finished').map((room) => <RoomCard key={room.id} room={room} onOpen={() => onOpenRoom(room.id)} />)}</div>{showCreate && <div className="modal-backdrop"><form className="create-modal" onSubmit={createRoom}><button type="button" className="modal-close" onClick={() => setShowCreate(false)}>×</button><p className="kicker">NEW BATTLE ROOM</p><h2>Set the parameters.</h2><label>Room name<input name="name" required autoFocus placeholder="Dawn Patrol" /></label><label>Number of members<select name="maxMembers" defaultValue="4">{[1, 2, 4, 6, 8, 12, 16, 32].map((number) => <option key={number} value={number}>{number} members</option>)}</select></label><label>Battle type<select name="battleType" disabled defaultValue="flag steal"><option value="flag steal">Flag steal</option></select></label>{error && <p className="form-error">{error}</p>}<p className="form-hint">The creator can start when the room reaches its member limit.</p><button className="button primary" type="submit">Create battle room</button></form></div>}</section></div></main>
}

function RoomCard({ room, onOpen }: { room: Room; onOpen: () => void }) { const full = room.memberCount >= room.maxMembers; return <article className="room-card"><div className="room-icon">◆</div><div className="room-info"><div className="room-title"><h3>{room.name}</h3><span className={`room-status ${full ? 'full' : room.status}`}>{full ? 'FULL' : room.status.toUpperCase()}</span></div><p>FLAG STEAL <span>/</span> {room.map}</p><div className="room-meta"><span>{room.memberCount} / {room.maxMembers} members</span><span>Created by @{room.creatorDisplayId}</span><span>{room.ping ?? 24} ms</span></div><div className="capacity"><i style={{ width: `${Math.min(100, (room.memberCount / room.maxMembers) * 100)}%` }} /></div></div><button className="button outline" onClick={onOpen}>{full ? 'Open room' : 'Join room'} <span>→</span></button></article> }

function RoomLobby({ room, user, token, onBack, onRefresh }: { room: Room; user: User; token: string; onBack: () => void; onRefresh: () => Promise<void> }) {
  const [error, setError] = useState(''); const isCreator = room.creatorDisplayId === user.displayId; const isFull = room.memberCount >= room.maxMembers
  const join = async () => { try { await api(`/rooms/${room.id}/join`, { method: 'POST' }, token); await onRefresh() } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Could not join room') } }
  const start = async () => { try { await api(`/rooms/${room.id}/start`, { method: 'POST' }, token); window.location.hash = 'play' } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Could not start room') } }
  return <main className="site-shell lobby-shell"><nav className="topbar"><button className="back-button" onClick={onBack}>← Operations</button><div className="brand-mark dark"><span className="brand-cross">+</span> AERIUM</div><div className="profile"><span className="online-dot" /> {user.displayName}</div></nav><section className="lobby-content"><div className="lobby-header"><div><p className="kicker">ROOM LOBBY / {room.id.slice(0, 8).toUpperCase()}</p><h1>{room.name}</h1><p className="muted">FLAG STEAL / {room.map}</p></div><span className={`room-status large ${room.status === 'waiting' ? 'open' : room.status}`}>{room.status === 'live' ? 'IN PROGRESS' : isFull ? 'ROOM FULL' : 'WAITING FOR PILOTS'}</span></div><div className="lobby-board"><div className="lobby-map"><div className="map-lines" /><span className="map-tag">FLAG STEAL</span><div className="map-coordinates">LIVE DATABASE<br />ROOM READY</div></div><div className="roster-panel"><div className="roster-title"><h2>Attendance</h2><span>{room.memberCount} / {room.maxMembers}</span></div><p className="form-hint">Members are synchronized through the room API. Socket synchronization can attach to this room ID next.</p><div className="lobby-actions">{!isCreator && room.status === 'waiting' && <button className="button outline" onClick={join}>Join room</button>}{isCreator && <button className="button primary" disabled={!isFull || room.status !== 'waiting'} onClick={start}>{isFull ? 'Start game' : `Waiting for ${room.maxMembers - room.memberCount} more`}</button>}{error && <p className="form-error">{error}</p>}</div></div></div></section></main>
}
