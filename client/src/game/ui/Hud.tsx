import { useEffect, useState } from 'react'
import { subscribeGameState, type GameState, type RosterEntry } from '../state'

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
`

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
    <div style={{ ...panel, position: 'absolute', right: 16, top: 16, minWidth: 230 }}>
      {(['red', 'blue'] as const).map((team) => (
        <div key={team} style={{ marginBottom: team === 'red' ? 8 : 0 }}>
          <div style={{ color: TEAM_CSS[team], fontWeight: 700 }}>{team.toUpperCase()} TEAM</div>
          {players.filter((p) => p.team === team).map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, opacity: p.status === 'offline' ? 0.5 : 1 }}>
              <span>{p.name}{p.you ? ' (you)' : ''}</span>
              <span style={{ color: p.status === 'dead' ? '#ef6b66' : p.status === 'carrying flag' ? '#ffd98f' : '#9fb4c8' }}>
                {p.status === 'carrying flag' ? '🚩 flag' : p.status}{p.status !== 'dead' && p.status !== 'offline' ? ` · ${Math.round(p.hp)}hp` : ''}
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

export function Hud() {
  const [state, setState] = useState<GameState | null>(null)

  useEffect(() => subscribeGameState(setState), [])

  if (!state) return null
  const team = state.team
  const won = state.winner !== null && state.winner === team

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: 'monospace' }}>
      <style>{FLASH_CSS}</style>
      {!state.dead && <Crosshair />}
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
        <div style={{ ...panel, position: 'absolute', left: 16, top: 16, color: TEAM_CSS[team], fontSize: 18, fontWeight: 700 }}>
          {team.toUpperCase()} TEAM
        </div>
      )}
      <Roster players={state.players} />
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
        <div style={{ fontSize: 18, color: '#8fd0ff' }}>
          {state.reloading ? 'RELOADING…' : `AMMO ${state.ammo} / ${state.maxAmmo}`}
        </div>
        {state.inHelicopter && <div style={{ fontSize: 16, color: '#ffe08f' }}>ROTOR {state.rotorRpm}</div>}
        <div style={{ opacity: 0.85 }}>{state.inHelicopter ? 'HELICOPTER — SPACE rotor · W/S fly · A/D turn · ↑/↓ altitude · ←/→ roll · V view · LMB fire · E exit' : 'WASD move · Shift sprint · Space jump · E helicopter · LMB shoot'}</div>
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
          {state.carryingFlag ? `🚩 CARRYING ENEMY FLAG — return to ${(team ?? 'blue').toUpperCase()} base!` : 'Capture the enemy flag'}
        </div>
        {state.nearHelicopter && !state.inHelicopter && <div style={{ color: '#8fd0ff' }}>[E] Board helicopter</div>}
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
