import { useEffect, useState } from 'react'
import { subscribeGameState, type GameState, type KillEntry, type RosterEntry } from '../state'
import { WEAPONS } from '../world/weapons'
import { Minimap } from './Minimap'

const TEAM_CSS = { red: '#ff7a6e', blue: '#7fb6ff' } as const
const panel = {
  padding: '10px 14px',
  background: 'rgba(6, 10, 18, 0.65)',
  border: '1px solid rgba(120, 180, 255, 0.35)',
  borderRadius: 8,
  color: '#cfe6ff',
  fontSize: 14,
  lineHeight: 1.5,
} as const

const FLASH_CSS = `
@keyframes hud-hitmarker { from { opacity: 1; transform: translate(-50%, -50%) scale(1.25) } to { opacity: 0; transform: translate(-50%, -50%) scale(1) } }
@keyframes hud-damage { from { opacity: 0.55 } to { opacity: 0 } }
@keyframes hud-arrow { 0% { opacity: 0 } 12% { opacity: 1 } 100% { opacity: 0 } }
@keyframes hud-feed { from { opacity: 0; transform: translateX(24px) } to { opacity: 1; transform: none } }
`

/** A red arc round the crosshair on the side the damage came from. */
function DamageArrow({ angle }: { angle: number }) {
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', width: 0, height: 0, transform: `rotate(${angle}rad)`, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: -60, top: -150, width: 120, height: 42, borderTop: '6px solid rgba(255, 50, 35, 0.95)', borderRadius: '50% 50% 0 0 / 100% 100% 0 0', filter: 'drop-shadow(0 0 6px rgba(255, 40, 20, 0.9))', animation: 'hud-arrow 1400ms ease-out forwards' }} />
    </div>
  )
}

function KillFeed({ entries }: { entries: KillEntry[] }) {
  if (!entries.length) return null
  const name = (text: string, team: KillEntry['killerTeam']) => <span style={{ color: team ? TEAM_CSS[team] : '#e8f0f8', fontWeight: 700 }}>{text}</span>
  return (
    <div style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
      {entries.map((e) => (
        <div key={e.id} style={{ padding: '4px 10px', background: e.mine ? 'rgba(90, 20, 14, 0.72)' : 'rgba(6, 10, 18, 0.62)', border: `1px solid ${e.mine ? 'rgba(255, 120, 100, 0.6)' : 'rgba(120, 180, 255, 0.25)'}`, borderRadius: 6, fontSize: 13, color: '#b9c9d8', animation: 'hud-feed 220ms ease-out' }}>
          {e.killer ? <>{name(e.killer, e.killerTeam)} <span style={{ color: '#ffd98f' }}>[{e.how}]</span> {name(e.victim, e.victimTeam)}</> : <>{name(e.victim, e.victimTeam)} <span style={{ color: '#ffd98f' }}>[{e.how}]</span></>}
        </div>
      ))}
    </div>
  )
}

/** Tank: where the gun really points (it swings round slower than you look), and the gunner's sight. */
function TankSight({ state }: { state: GameState }) {
  const ready = state.cannon >= 1
  return (
    <>
      {state.tankSight && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 220px 90px rgba(0, 0, 0, 0.85)' }}>
          <div style={{ position: 'absolute', left: '50%', top: '50%', width: 2, height: 120, background: 'rgba(20, 255, 140, 0.7)', transform: 'translate(-50%, 8px)' }} />
          <div style={{ position: 'absolute', left: 'calc(50% - 160px)', top: '50%', width: 150, height: 2, background: 'rgba(20, 255, 140, 0.7)' }} />
          <div style={{ position: 'absolute', left: 'calc(50% + 10px)', top: '50%', width: 150, height: 2, background: 'rgba(20, 255, 140, 0.7)' }} />
          {[1, 2, 3, 4].map((k) => (
            <div key={k} style={{ position: 'absolute', left: `calc(50% - ${14 - k * 2}px)`, top: `calc(50% + ${k * 24}px)`, width: 28 - k * 4, height: 2, background: 'rgba(20, 255, 140, 0.7)' }} />
          ))}
        </div>
      )}
      {state.gunX >= 0 && (
        <div style={{ position: 'absolute', left: `${state.gunX * 100}%`, top: `${state.gunY * 100}%`, width: 26, height: 26, transform: 'translate(-50%, -50%)', borderRadius: '50%', border: `2px solid ${ready ? '#5dff8a' : '#ffb35a'}`, boxShadow: `0 0 8px ${ready ? '#5dff8a' : '#ffb35a'}`, pointerEvents: 'none' }} />
      )}
    </>
  )
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color }}>
        <span>{label}</span>
        <span>{Math.round(value * 100)}%</span>
      </div>
      <div style={{ width: 190, height: 7, marginTop: 2, background: 'rgba(255, 255, 255, 0.16)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: '100%', background: color, transition: 'width 160ms ease' }} />
      </div>
    </div>
  )
}

function HitMarker() {
  const arm = (rotate: number) => (
    <div style={{ position: 'absolute', left: 13, top: 4, width: 2, height: 8, background: '#ff5a4e', transform: `rotate(${rotate}deg)`, transformOrigin: '1px 10px' }} />
  )
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', width: 28, height: 28, animation: 'hud-hitmarker 260ms ease-out forwards', pointerEvents: 'none' }}>
      {arm(45)}{arm(135)}{arm(225)}{arm(315)}
    </div>
  )
}

function Roster({ players }: { players: RosterEntry[] }) {
  return (
    <div style={{ ...panel, minWidth: 230 }}>
      {(['red', 'blue'] as const).map((team) => (
        <div key={team} style={{ marginBottom: team === 'red' ? 8 : 0 }}>
          <div style={{ color: TEAM_CSS[team], fontWeight: 700 }}>{team.toUpperCase()} TEAM</div>
          {players.filter((p) => p.team === team).map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, opacity: p.status === 'offline' ? 0.5 : 1 }}>
              <span>{p.name}{p.you ? ' (you)' : ''}</span>
              <span style={{ color: p.status === 'dead' ? '#ef6b66' : p.status === 'carrying gem' ? '#ffd98f' : '#9fb4c8' }}>
                {p.status === 'carrying gem' ? '💎 gem' : p.status}{p.status !== 'dead' && p.status !== 'offline' ? ` · ${Math.round(p.hp)}hp` : ''}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Crosshair() {
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
      }}
    >
      <div style={{ position: 'relative', width: 22, height: 22 }}>
        <div style={{ position: 'absolute', left: 10, top: 0, width: 2, height: 6, background: '#eaf2ff', opacity: 0.9 }} />
        <div style={{ position: 'absolute', left: 10, bottom: 0, width: 2, height: 6, background: '#eaf2ff', opacity: 0.9 }} />
        <div style={{ position: 'absolute', top: 10, left: 0, width: 6, height: 2, background: '#eaf2ff', opacity: 0.9 }} />
        <div style={{ position: 'absolute', top: 10, right: 0, width: 6, height: 2, background: '#eaf2ff', opacity: 0.9 }} />
      </div>
    </div>
  )
}

/** Sniper scope: black all round a clear circle, with fine cross hairs. */
function Scope() {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: '72vmin', height: '72vmin', transform: 'translate(-50%, -50%)', borderRadius: '50%', boxShadow: '0 0 0 200vmax #000', border: '3px solid #111' }} />
      <div style={{ position: 'absolute', left: '50%', top: '14vmin', bottom: '14vmin', width: 1, background: 'rgba(0,0,0,0.85)' }} />
      <div style={{ position: 'absolute', top: '50%', left: 'calc(50% - 36vmin)', width: '72vmin', height: 1, background: 'rgba(0,0,0,0.85)' }} />
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 6, height: 6, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: '#ff3b30' }} />
    </div>
  )
}

/** Launcher lock-on: a box around the aircraft being tracked, amber while locking, green once locked. */
function LockOn({ state }: { state: GameState }) {
  if (state.lock < 0) return null
  const locked = state.lock >= 1
  const color = locked ? '#5dff8a' : '#ffc14d'
  const onScreen = state.lockX >= 0
  return (
    <>
      {onScreen && (
        <div style={{ position: 'absolute', left: `${state.lockX * 100}%`, top: `${state.lockY * 100}%`, width: 54, height: 54, transform: 'translate(-50%, -50%)', border: `2px solid ${color}`, boxShadow: `0 0 10px ${color}` }} />
      )}
      <div style={{ position: 'absolute', left: '50%', top: 'calc(50% + 34px)', transform: 'translateX(-50%)', color, fontSize: 14, fontWeight: 700, textShadow: '0 0 6px #000' }}>
        {locked ? 'LOCKED — FIRE!' : onScreen ? `LOCKING ${Math.round(state.lock * 100)}% (fire now: unguided)` : 'NO LOCK — FIRES AN UNGUIDED ROCKET'}
      </div>
    </>
  )
}

function controlsHint(state: GameState) {
  if (state.onGun) return 'MACHINE GUN — mouse aim · LMB fire (slow, heavy rounds) · E leave the gun'
  if (state.vehicle === 'heli') {
    return state.seat === 0
      ? 'PILOT — SPACE rotor · W/S fly · A/D turn · ↑/↓ altitude · ←/→ roll · V view · E get out (pilots can\'t shoot)'
      : state.seat === 1
        ? 'GUNNER — mouse aims the nose gun · LMB fire · E get out'
        : 'DOOR GUNNER — mouse aim · LMB fire out of the door · F switch weapon · R reload · E get out'
  }
  if (state.vehicle === 'car') return 'BATTLE CAR — W/S drive · A/D steer · SPACE brake · mouse aims the roof gatling · LMB fire · V view · E exit'
  if (state.vehicle === 'tank') return 'TANK — W/S drive · A/D turn the hull · mouse aims the turret · LMB fire the cannon · V gunner sight · E exit'
  if (state.vehicle === 'mech') return 'MECH — W/S walk · Shift run · A/D turn · SPACE jump-jets · mouse aims the torso · LMB autocannon · RMB rocket salvo · V view · E exit'
  return 'WASD move · Shift sprint · Space jump · F switch weapon · R reload · Q grenade · G pick up / drop · E vehicle / machine gun · LMB shoot · RMB aim'
}

export function Hud() {
  const [state, setState] = useState<GameState | null>(null)

  useEffect(() => subscribeGameState(setState), [])

  if (!state) return null
  const team = state.team
  const won = state.winner !== null && state.winner === team

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: 'monospace' }}>
      <style>{FLASH_CSS}</style>
      {state.scoped && !state.dead && <Scope />}
      {!state.dead && (state.cannon >= 0 || state.gunX >= 0) && <TankSight state={state} />}
      {!state.dead && !state.scoped && <Crosshair />}
      {!state.dead && <LockOn state={state} />}
      {state.damageTaken > 0 && state.damageDir !== null && !state.dead && <DamageArrow key={`arrow-${state.damageTaken}`} angle={state.damageDir} />}
      {state.hitsLanded > 0 && <HitMarker key={`hit-${state.hitsLanded}`} />}
      {state.damageTaken > 0 && (
        <div key={`dmg-${state.damageTaken}`} style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 160px 40px rgba(220, 30, 20, 0.9)', animation: 'hud-damage 450ms ease-out forwards' }} />
      )}
      {state.dead && !state.finished && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(60, 5, 5, 0.45)', color: '#ffd6d2', fontSize: 30, fontWeight: 700, letterSpacing: 1.5, textShadow: '0 0 16px rgba(255, 60, 40, 0.8)' }}>
          ELIMINATED — RESPAWNING…
        </div>
      )}

      {team && (
        <div style={{ ...panel, position: 'absolute', left: 16, top: 16, padding: '6px 14px', color: TEAM_CSS[team], fontSize: 17, fontWeight: 700 }}>
          {team.toUpperCase()} TEAM
        </div>
      )}
      <Minimap />
      <div style={{ position: 'absolute', right: 16, top: 16, display: 'grid', justifyItems: 'end', gap: 10 }}>
        <Roster players={state.players} />
        <KillFeed entries={state.killFeed} />
      </div>
      {!state.connected && !state.finished && (
        <div style={{ ...panel, position: 'absolute', left: '50%', top: 64, transform: 'translateX(-50%)', color: '#ffd98f' }}>
          Connection lost — reconnecting…
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          left: 16,
          bottom: 16,
          padding: '10px 14px',
          background: 'rgba(6, 10, 18, 0.65)',
          border: '1px solid rgba(120, 180, 255, 0.35)',
          borderRadius: 8,
          color: '#cfe6ff',
          fontSize: 14,
          lineHeight: 1.5,
          maxWidth: 440,
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ffb0a8' }}>
            <span>HEALTH</span>
            <span>{Math.round(state.health)}%</span>
          </div>
          <div style={{ width: 190, height: 8, marginTop: 3, background: 'rgba(255, 255, 255, 0.16)', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, state.health))}%`,
                height: '100%',
                background: state.health > 50 ? '#57d68d' : state.health > 25 ? '#f4c95d' : '#ef6b66',
                transition: 'width 160ms ease, background 160ms ease',
              }}
            />
          </div>
        </div>
        {state.vehicle && <Bar label={state.vehicle === 'heli' ? 'AIRFRAME' : 'HULL'} value={state.vehicleHp} color={state.vehicleHp > 0.5 ? '#8fd0ff' : state.vehicleHp > 0.25 ? '#f4c95d' : '#ef6b66'} />}
        {state.onGun ? (
          <div style={{ fontSize: 18, color: '#ffb35a' }}>MACHINE GUN</div>
        ) : state.carGun ? (
          <div style={{ fontSize: 18, color: '#ffb35a' }}>{state.vehicle === 'heli' ? 'NOSE GUN' : 'ROOF GATLING'}</div>
        ) : state.vehicle === 'mech' ? (
          <div style={{ fontSize: 18, color: state.cannon >= 1 ? '#5dff8a' : '#ffb35a' }}>
            AUTOCANNON · {state.cannon >= 1 ? 'ROCKETS READY' : `ROCKETS RELOADING ${Math.round(Math.max(0, state.cannon) * 100)}%`}
          </div>
        ) : state.cannon >= 0 ? (
          <div style={{ fontSize: 18, color: state.cannon >= 1 ? '#5dff8a' : '#ffb35a' }}>
            {state.cannon >= 1 ? 'CANNON READY' : `CANNON LOADING ${Math.round(state.cannon * 100)}%`}
          </div>
        ) : state.current ? (
          <div style={{ fontSize: 18, color: '#8fd0ff' }}>
            {state.reloading ? 'RELOADING…' : `${WEAPONS[state.current].name.toUpperCase()}  ${state.ammo} / ${state.reserve}`}
            {state.current === 'launcher' && <span style={{ fontSize: 13, color: '#b9d4ea' }}>{'  missiles'}</span>}
          </div>
        ) : (
          <div style={{ fontSize: 18, color: '#9fb4c8' }}>NO WEAPON</div>
        )}
        {state.weapons.length > 0 && (
          <div style={{ fontSize: 12, color: '#9fb4c8' }}>
            [F] {state.weapons.map((w) => <span key={w} style={{ color: w === state.current ? '#eaf6ff' : '#6f8599', fontWeight: w === state.current ? 700 : 400, marginRight: 8 }}>{WEAPONS[w].name.toUpperCase()}</span>)}
          </div>
        )}
        {!state.vehicle && !state.onGun && <div style={{ fontSize: 13, color: state.grenades ? '#c8e6a0' : '#6f8599' }}>[Q] GRENADES {state.grenades}</div>}
        {state.vehicle === 'heli' && state.seat === 0 && <div style={{ fontSize: 16, color: '#ffe08f' }}>ROTOR {state.rotorRpm}</div>}
        {state.vehicle === 'mech' && <Bar label="JUMP-JETS" value={state.jet} color={state.jet > 0.25 ? '#7fe3ff' : '#ffb35a'} />}
        {(state.vehicle === 'car' || state.vehicle === 'tank' || state.vehicle === 'mech') && <div style={{ fontSize: 16, color: '#ffe08f' }}>{state.speedKmh} km/h</div>}
        <div style={{ opacity: 0.85 }}>{controlsHint(state)}</div>
      </div>

      <div
        style={{
          position: 'absolute',
          right: 16,
          bottom: 16,
          padding: '10px 14px',
          background: 'rgba(6, 10, 18, 0.65)',
          border: '1px solid rgba(120, 180, 255, 0.35)',
          borderRadius: 8,
          color: '#cfe6ff',
          fontSize: 14,
          lineHeight: 1.5,
          textAlign: 'right',
        }}
      >
        <div style={{ fontSize: 18, color: '#ffd98f' }}>SCORE {state.score}</div>
        <div style={{ opacity: 0.85 }}>
          {state.carryingGem ? `💎 CARRYING ENEMY GEM — bring it to your ${(team ?? 'blue').toUpperCase()} gem!` : 'Steal the enemy gem'}
        </div>
        {state.interactPrompt && <div style={{ color: '#8fd0ff' }}>[E] {state.interactPrompt}</div>}
        {state.pickupPrompt && <div style={{ color: '#b6f0a0' }}>[G] {state.pickupPrompt}</div>}
      </div>

      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 14,
          transform: 'translateX(-50%)',
          maxWidth: 620,
          padding: '8px 14px',
          background: 'rgba(6, 10, 18, 0.6)',
          border: '1px solid rgba(120, 180, 255, 0.25)',
          borderRadius: 8,
          color: '#eaf2ff',
          fontSize: 14,
          textAlign: 'center',
        }}
      >
        {state.message}
      </div>

      {state.finished && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(5, 12, 18, 0.52)',
            color: '#e8f8ff',
            textShadow: '0 0 18px rgba(86, 220, 255, 0.8)',
            pointerEvents: 'auto',
          }}
        >
          <div style={{ display: 'grid', justifyItems: 'center', gap: 18 }}>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 1.5 }}>{won ? 'VICTORY!' : 'DEFEAT'}</div>
            {state.winner && <div style={{ fontSize: 18, color: TEAM_CSS[state.winner] }}>{state.winner.toUpperCase()} TEAM WINS</div>}
            <button
              type="button"
              onClick={() => { window.location.hash = '' }}
              style={{
                padding: '10px 24px',
                border: '1px solid rgba(143, 208, 255, 0.7)',
                borderRadius: 6,
                background: 'rgba(20, 54, 78, 0.9)',
                color: '#eaf8ff',
                font: '700 15px monospace',
                cursor: 'pointer',
                pointerEvents: 'auto',
              }}
            >
              BACK TO OPERATIONS
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
