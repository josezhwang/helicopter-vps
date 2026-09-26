import { useEffect, useRef, useState } from 'react'
import { BattlefieldGame } from './BattlefieldGame'
import { Multiplayer } from './net'
import { resetGameState, setGameState } from './state'
import { Hud } from './ui/Hud'

export function Game({ roomId, token }: { roomId: string; token: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    resetGameState()
    let game: BattlefieldGame | null = null
    const net: Multiplayer = new Multiplayer(roomId, token, {
      onWelcome: (you, players, vehicles) => {
        if (game) {
          game.syncRoster(players, vehicles)
          return
        }
        game = new BattlefieldGame(mount, { you, players, net, vehicles })
        game.start()
        setReady(true)
      },
      onPlayer: (player) => game?.upsertPlayer(player),
      onLeave: (id) => game?.removePlayer(id),
      onState: (id, state) => game?.applyRemoteState(id, state),
      onEnd: (winner) => game?.endMatch(winner),
      onHp: (id, hp, by) => game?.applyHp(id, hp, by),
      onKilled: (id, by) => game?.playerKilled(id, by),
      onRespawn: (id) => game?.playerRespawned(id),
      onShot: (id, to) => game?.remoteShot(id, to),
      onEject: (vehicleId) => game?.ejectFrom(vehicleId),
      onError: (message) => setError(message),
      onConnection: (connected) => setGameState({ connected }),
    })
    return () => {
      net.close()
      game?.dispose()
    }
  }, [roomId, token])

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      {ready && <Hud />}
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
