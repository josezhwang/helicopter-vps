import { useEffect, useState } from 'react'
import { subscribeGameState, type GameState } from '../state'

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

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: 'monospace' }}>
      <Crosshair />

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
        <div style={{ fontSize: 18, color: '#8fd0ff' }}>
          {state.reloading ? 'RELOADING…' : `AMMO ${state.ammo} / ${state.maxAmmo}`}
        </div>
        {state.inHelicopter && <div style={{ fontSize: 16, color: '#ffe08f' }}>ROTOR {state.rotorRpm}</div>}
        <div style={{ opacity: 0.85 }}>{state.inHelicopter ? 'HELICOPTER — SPACE rotor · W/S fly · A/D turn · ↑/↓ altitude · ←/→ roll · E exit' : 'WASD move · Shift sprint · Space jump · E helicopter · LMB shoot'}</div>
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
          {state.carryingFlag ? '🚩 CARRYING ENEMY FLAG — return to BLUE base!' : 'Capture the enemy flag'}
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
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: 1.5,
            textShadow: '0 0 18px rgba(86, 220, 255, 0.8)',
          }}
        >
          VICTORY
        </div>
      )}
    </div>
  )
}
