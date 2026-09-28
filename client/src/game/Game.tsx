import { useEffect, useRef, useState } from 'react'
import { BattlefieldGame } from './BattlefieldGame'
import { Multiplayer } from './net'
import { resetGameState, setGameState } from './state'
import { QUALITIES, QUALITY_LABEL, loadQuality, type Quality } from './world/graphics'
import { loadingProgress } from './world/loading'
import { Hud } from './ui/Hud'

export function Game({ roomId, token }: { roomId: string; token: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  /** 0..1 while the battlefield's models and textures load; null once everything is in. */
  const [loading, setLoading] = useState<number | null>(0)
  const [quality, setQuality] = useState<Quality>(loadQuality)
  const gameRef = useRef<BattlefieldGame | null>(null)
  const pollRef = useRef(0)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    resetGameState()
    let game: BattlefieldGame | null = null
    const net: Multiplayer = new Multiplayer(roomId, token, {
      onWelcome: (you, players, world) => {
        if (game) {
          game.syncRoster(players, world)
          return
        }
        game = new BattlefieldGame(mount, { you, players, net, world })
        gameRef.current = game
        game.start()
        setReady(true)
        // Hold the loading screen until every model and texture has arrived
        const poll = window.setInterval(() => {
          const progress = loadingProgress()
          if (progress.done) {
            window.clearInterval(poll)
            setLoading(null)
          } else {
            setLoading(progress.fraction)
          }
        }, 200)
        pollRef.current = poll
      },
      onPlayer: (player) => game?.upsertPlayer(player),
      onLeave: (id) => game?.removePlayer(id),
      onState: (id, state) => game?.applyRemoteState(id, state),
      onEnd: (winner) => game?.endMatch(winner),
      onHp: (id, hp, by, shield) => game?.applyHp(id, hp, by, shield),
      onKilled: (id, by, how) => game?.playerKilled(id, by, how),
      onRespawn: (id) => game?.playerRespawned(id),
      onShot: (id, to, weapon) => game?.remoteShot(id, to, weapon),
      onEject: (vehicleId, by, reason) => game?.ejectFrom(vehicleId, by, reason),
      onUngun: (gunId) => game?.ungun(gunId),
      onItem: (item) => game?.itemChanged(item),
      onItemGone: (id) => game?.itemGone(id),
      onTook: (took) => game?.took(took),
      onMissile: (id, target, from) => game?.remoteMissile(id, target, from),
      onWrecked: (vehicleId, by, at) => game?.vehicleWrecked(vehicleId, by, at),
      onRepaired: (vehicleId) => game?.vehicleRepaired(vehicleId),
      onHijack: (vehicleId, ok, reason) => game?.hijackAnswer(vehicleId, ok, reason),
      onHijacked: (vehicleId, by, victims) => game?.vehicleHijacked(vehicleId, by, victims),
      onFire: (id, kind, from, to) => game?.remoteFire(id, kind, from, to),
      onThrow: (id, from, velocity) => game?.remoteThrow(id, from, velocity),
      onBoom: (at, kind, by) => game?.blast(at, kind, by),
      onVehicleHp: (id, hp, max) => game?.vehicleHpChanged(id, hp, max),
      onBarrel: (id, alive) => game?.barrelChanged(id, alive),
      onShip: (team, hp, wrecked, by) => game?.shipChanged(team, hp, wrecked, by),
      onError: (message) => setError(message),
      onConnection: (connected) => setGameState({ connected }),
    })
    return () => {
      net.close()
      game?.dispose()
      gameRef.current = null
      window.clearInterval(pollRef.current)
    }
  }, [roomId, token])

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      {ready && <Hud />}
      {ready && (
        <div style={{ position: 'absolute', left: 16, top: 272, display: 'flex', gap: 4, alignItems: 'center', padding: '4px 6px', borderRadius: 6, background: 'rgba(6, 10, 18, 0.55)', font: '700 11px monospace', color: '#cfe6ff' }}>
          <span style={{ marginRight: 4 }}>GRAPHICS</span>
          {QUALITIES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => { setQuality(q); gameRef.current?.setQuality(q) }}
              style={{ padding: '3px 7px', border: `1px solid ${q === quality ? 'rgba(143, 208, 255, 0.9)' : 'rgba(143, 208, 255, 0.3)'}`, borderRadius: 4, background: q === quality ? 'rgba(40, 90, 130, 0.85)' : 'rgba(6, 10, 18, 0.6)', color: q === quality ? '#eaf8ff' : '#9fb4c8', font: '700 11px monospace', cursor: 'pointer' }}
            >
              {QUALITY_LABEL[q].toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {ready && !error && loading !== null && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at center, rgba(14, 30, 48, 0.97), rgba(3, 7, 12, 1))', color: '#e8f8ff', fontFamily: 'monospace', zIndex: 20 }}>
          <div style={{ display: 'grid', justifyItems: 'center', gap: 16, width: 'min(520px, 80vw)' }}>
            <div style={{ fontSize: 26, letterSpacing: 6, color: '#8fd0ff' }}>DEPLOYING</div>
            <div style={{ fontSize: 14, opacity: 0.8 }}>Loading the battlefield — models, textures, sky…</div>
            <div style={{ width: '100%', height: 10, background: 'rgba(143, 208, 255, 0.15)', border: '1px solid rgba(143, 208, 255, 0.5)', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(loading * 100)}%`, height: '100%', background: 'linear-gradient(90deg, #3fa4ff, #8fe8ff)', transition: 'width 200ms ease' }} />
            </div>
            <div style={{ fontSize: 14, color: '#b9d4ea' }}>{Math.round(loading * 100)}%</div>
          </div>
        </div>
      )}
      {(!ready || error) && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(5, 12, 18, 0.85)', color: '#e8f8ff', fontFamily: 'monospace' }}>
          <div style={{ display: 'grid', justifyItems: 'center', gap: 18, textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 22 }}>{error || 'Connecting to the battle…'}</div>
            {error && (
              <button type="button" onClick={() => { window.location.hash = '' }} style={{ padding: '10px 24px', border: '1px solid rgba(143, 208, 255, 0.7)', borderRadius: 6, background: 'rgba(20, 54, 78, 0.9)', color: '#eaf8ff', font: '700 15px monospace', cursor: 'pointer' }}>
                BACK TO OPERATIONS
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
