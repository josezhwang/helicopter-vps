import { useEffect, useRef } from 'react'
import { BattlefieldGame } from './BattlefieldGame'
import { Hud } from './ui/Hud'

export function Game() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mountRef.current) return
    const game = new BattlefieldGame(mountRef.current)
    game.start()
    return () => game.dispose()
  }, [])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <Hud />
    </div>
  )
}
