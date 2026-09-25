import { useEffect, useRef } from 'react'
import { BattlefieldGame } from './BattlefieldGame'
import { resetGameState } from './state'
import { Hud } from './ui/Hud'

export function Game() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mountRef.current) return
    resetGameState()
    const game = new BattlefieldGame(mountRef.current)
    game.start()
    return () => game.dispose()
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <Hud />
    </div>
  )
}
