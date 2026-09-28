/**
 * The battlefield's ground height, the same analytic function the client draws the terrain with
 * (client/src/game/world/terrain.ts — keep the two in step). The server uses it to walk the bots over the hills.
 */
import { BASE_CENTER } from './game-layout'

const PLATEAU_HALF = 60
const PLATEAU_BLEND = 30

function rawHeight(x: number, z: number): number {
  const hills = Math.sin(x * 0.008) * Math.cos(z * 0.009) * 14
  const dunes = Math.sin(x * 0.02 + z * 0.013) * Math.cos(z * 0.017 - x * 0.011) * 5
  const ridges = Math.cos((x - z) * 0.004) * 8
  const valleys = Math.sin((x + z) * 0.005) * Math.cos((x - z) * 0.007) * 3
  return hills + dunes + ridges + valleys
}

const plateaus = (['blue', 'red'] as const).map((team) => ({ ...BASE_CENTER[team], h: rawHeight(BASE_CENTER[team].x, BASE_CENTER[team].z) }))
const smoothstep = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function heightAt(x: number, z: number): number {
  let h = rawHeight(x, z)
  for (const p of plateaus) {
    const d = Math.max(Math.abs(x - p.x), Math.abs(z - p.z))
    if (d >= PLATEAU_HALF + PLATEAU_BLEND) continue
    h = p.h + (h - p.h) * smoothstep(d, PLATEAU_HALF, PLATEAU_HALF + PLATEAU_BLEND)
  }
  return h
}
