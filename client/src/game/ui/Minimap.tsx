import { useEffect, useRef } from 'react'
import { radar, type RadarBlip } from '../state'
import { heightAt, WORLD_SIZE } from '../world/terrain'
import { BASE_CENTER, BASE_HALF, OUTPOSTS, outpostYaw } from '../world/layout'

/**
 * The radar: a relief map of the battlefield turned so that where we look is up, with teammates, vehicles,
 * the gems and any enemy that gave itself away (fired, or came close). Drawn on its own clock from the
 * `radar` picture the game keeps up to date, so it never re-renders the rest of the HUD.
 */
const SIZE = 200
const MAP_PIXELS = 384
const TEAM_RGB = { blue: '#6fb1ff', red: '#ff6f61' } as const
const WATER_LEVEL = -6

/** The whole map as a picture: water, sand, grass, dirt and rock, lit from the north-west. */
function reliefMap(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = MAP_PIXELS
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(MAP_PIXELS, MAP_PIXELS)
  const step = WORLD_SIZE / MAP_PIXELS
  // Heights on a grid one sample wider all round, so slopes come from neighbours instead of more lookups
  const N = MAP_PIXELS + 2
  const heights = new Float32Array(N * N)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) heights[j * N + i] = heightAt(-WORLD_SIZE / 2 + (i - 0.5) * step, -WORLD_SIZE / 2 + (j - 0.5) * step)
  for (let j = 0; j < MAP_PIXELS; j++) {
    for (let i = 0; i < MAP_PIXELS; i++) {
      const x = -WORLD_SIZE / 2 + (i + 0.5) * step, z = -WORLD_SIZE / 2 + (j + 0.5) * step
      const k0 = (j + 1) * N + i + 1
      const h = heights[k0]
      const dx = heights[k0 + 1] - heights[k0 - 1], dz = heights[k0 + N] - heights[k0 - N]
      const slope = Math.hypot(dx, dz) / (2 * step)
      let r: number, g: number, b: number
      if (h < WATER_LEVEL) {
        const deep = Math.min(1, (WATER_LEVEL - h) / 6)
        r = 58 - deep * 20; g = 98 - deep * 22; b = 122 - deep * 12
      } else {
        const noise = Math.sin(x * 0.05) * Math.cos(z * 0.043) * 0.5 + Math.sin((x + z) * 0.021) * 0.5
        const rock = Math.min(1, Math.max(0, (h - 18) / 12) + Math.max(0, Math.min(1, (slope - 0.32) / 0.23)))
        const sand = Math.min(1, Math.max(0, (-1.2 - h) / 2))
        const dirt = Math.max(0, Math.min(0.55, 0.12 + noise * 0.25)) * (1 - rock) * (1 - sand)
        const grass = Math.max(0, 1 - rock - sand - dirt)
        r = grass * 74 + dirt * 118 + rock * 126 + sand * 178
        g = grass * 108 + dirt * 100 + rock * 122 + sand * 162
        b = grass * 50 + dirt * 72 + rock * 114 + sand * 120
        // Hill shading: slopes facing the north-west light are brighter
        const shade = Math.max(0.62, Math.min(1.25, 1 + (dx + dz) * 0.35 / step))
        r *= shade; g *= shade; b *= shade
      }
      const k = (j * MAP_PIXELS + i) * 4
      image.data[k] = r; image.data[k + 1] = g; image.data[k + 2] = b; image.data[k + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  // The bases (concrete squares in their team's colour) and the sandbag outposts
  const toPx = (v: number) => ((v + WORLD_SIZE / 2) / WORLD_SIZE) * MAP_PIXELS
  const scale = MAP_PIXELS / WORLD_SIZE
  for (const team of ['blue', 'red'] as const) {
    const c = BASE_CENTER[team]
    ctx.fillStyle = 'rgba(150, 150, 146, 0.85)'
    ctx.fillRect(toPx(c.x - BASE_HALF), toPx(c.z - BASE_HALF), BASE_HALF * 2 * scale, BASE_HALF * 2 * scale)
    ctx.strokeStyle = TEAM_RGB[team]
    ctx.lineWidth = 2
    ctx.strokeRect(toPx(c.x - BASE_HALF), toPx(c.z - BASE_HALF), BASE_HALF * 2 * scale, BASE_HALF * 2 * scale)
  }
  OUTPOSTS.forEach(([x, z], i) => {
    ctx.save()
    ctx.translate(toPx(x), toPx(z))
    ctx.rotate(-outpostYaw(i))
    ctx.fillStyle = 'rgba(196, 170, 118, 0.95)'
    ctx.fillRect(-4.5 * scale, 2.5 * scale, 9 * scale, 1.2 * scale)
    ctx.fillRect(-4.8 * scale, -0.5 * scale, 1.2 * scale, 3.5 * scale)
    ctx.fillRect(3.6 * scale, -0.5 * scale, 1.2 * scale, 3.5 * scale)
    ctx.restore()
  })
  return canvas
}

function drawBlip(ctx: CanvasRenderingContext2D, blip: RadarBlip, sx: number, sy: number, turn: number) {
  const color = blip.team ? TEAM_RGB[blip.team] : '#d8d8d0'
  ctx.save()
  ctx.translate(sx, sy)
  switch (blip.kind) {
    case 'gem':
      ctx.fillStyle = color
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(0, -6); ctx.lineTo(5, 0); ctx.lineTo(0, 6); ctx.lineTo(-5, 0); ctx.closePath()
      ctx.fill(); ctx.stroke()
      break
    case 'barrel':
      ctx.fillStyle = '#ff8a3d'
      ctx.beginPath(); ctx.arc(0, 0, 1.8, 0, Math.PI * 2); ctx.fill()
      break
    case 'mate':
    case 'enemy':
      ctx.rotate(turn)
      ctx.fillStyle = color
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'
      ctx.lineWidth = 1
      ctx.beginPath()
      if (blip.kind === 'mate') { ctx.moveTo(0, -5.5); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4); ctx.closePath() } else ctx.arc(0, 0, 3.6, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
      if (blip.gem) { ctx.rotate(-turn); ctx.fillStyle = '#ffe28a'; ctx.fillRect(-2, -11, 4, 4) }
      break
    default: {
      ctx.rotate(turn)
      ctx.globalAlpha = blip.empty ? 0.55 : 1
      ctx.fillStyle = blip.empty ? '#b9bcb5' : color
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.lineWidth = 1
      if (blip.kind === 'heli') {
        ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        ctx.strokeStyle = ctx.fillStyle
        ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(7, 0); ctx.moveTo(0, -7); ctx.lineTo(0, 7); ctx.stroke()
      } else if (blip.kind === 'mech') {
        // A walker: a body with two legs
        ctx.beginPath(); ctx.arc(0, -1.5, 4.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        ctx.fillRect(-4, 2, 2.4, 5); ctx.fillRect(1.6, 2, 2.4, 5)
      } else if (blip.kind === 'tank') {
        ctx.fillRect(-4, -5, 8, 10); ctx.strokeRect(-4, -5, 8, 10)
        ctx.fillRect(-0.8, -10, 1.6, 6)
      } else {
        ctx.fillRect(-3, -4.5, 6, 9); ctx.strokeRect(-3, -4.5, 6, 9)
      }
    }
  }
  ctx.restore()
}

export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = SIZE * ratio
    canvas.height = SIZE * ratio
    ctx.scale(ratio, ratio)
    let map: HTMLCanvasElement | null = null
    let frame = 0
    let drawn = -1
    let lastAt = 0
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      // A dozen pictures a second is plenty for a radar
      if (radar.version === drawn || now - lastAt < 80) return
      map ??= reliefMap()
      drawn = radar.version
      lastAt = now
      const range = radar.range
      const scale = (SIZE / 2 - 6) / range
      const c = SIZE / 2
      const yaw = radar.yaw
      ctx.clearRect(0, 0, SIZE, SIZE)
      ctx.save()
      ctx.beginPath()
      ctx.arc(c, c, SIZE / 2 - 2, 0, Math.PI * 2)
      ctx.clip()
      // The map turned so our view is up
      ctx.save()
      ctx.translate(c, c)
      ctx.rotate(yaw)
      ctx.scale(scale, scale)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(map, -WORLD_SIZE / 2 - radar.x, -WORLD_SIZE / 2 - radar.z, WORLD_SIZE, WORLD_SIZE)
      ctx.restore()
      ctx.fillStyle = 'rgba(5, 12, 20, 0.18)'
      ctx.fillRect(0, 0, SIZE, SIZE)
      // Range rings
      ctx.strokeStyle = 'rgba(200, 230, 255, 0.18)'
      ctx.lineWidth = 1
      for (const f of [1 / 3, 2 / 3]) { ctx.beginPath(); ctx.arc(c, c, (SIZE / 2 - 6) * f, 0, Math.PI * 2); ctx.stroke() }
      const cos = Math.cos(yaw), sin = Math.sin(yaw)
      for (const blip of radar.blips) {
        const dx = blip.x - radar.x, dz = blip.z - radar.z
        let sx = (dx * cos - dz * sin) * scale, sy = (dx * sin + dz * cos) * scale
        const d = Math.hypot(sx, sy), edge = SIZE / 2 - 9
        // Gems and vehicles out of range stay on the rim so you know which way they are
        if (d > edge) {
          if (blip.kind !== 'gem') continue
          sx *= edge / d; sy *= edge / d
        }
        drawBlip(ctx, blip, c + sx, c + sy, Math.PI - (blip.yaw - yaw))
      }
      // Us: an arrow in the middle, always pointing up
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = 'rgba(0,0,0,0.9)'
      ctx.beginPath()
      ctx.moveTo(c, c - 7); ctx.lineTo(c + 5, c + 5); ctx.lineTo(c, c + 2.5); ctx.lineTo(c - 5, c + 5); ctx.closePath()
      ctx.fill(); ctx.stroke()
      // North (-Z) on the rim
      const nx = c + sin * (SIZE / 2 - 12), ny = c - cos * (SIZE / 2 - 12)
      ctx.font = 'bold 11px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffe28a'
      ctx.fillText('N', nx, ny)
      ctx.restore()
      ctx.strokeStyle = 'rgba(120, 180, 255, 0.55)'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(c, c, SIZE / 2 - 2, 0, Math.PI * 2); ctx.stroke()
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  return <canvas ref={canvasRef} style={{ position: 'absolute', left: 16, top: 62, width: SIZE, height: SIZE, borderRadius: '50%', background: 'rgba(6, 10, 18, 0.6)' }} />
}
