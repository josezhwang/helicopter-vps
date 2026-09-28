import * as THREE from 'three'
import { HALF_WORLD, WORLD_SIZE, heightAt } from './terrain'

/**
 * One map of the island's ground, 2 m per texel, shared by the terrain shader and the grass so they agree:
 * R = bare dirt, G = meadow (grass with soil showing), B = how thick the grass grows. Worn earth shows round the
 * outposts and where vehicles park; no grass grows in bases, outposts, parking spots, on rock, sand or in water.
 */
export const GROUND_MAP_SIZE = 512

// Deterministic value noise (the same on every PC)
function hash(i: number, j: number) {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
function noise(x: number, z: number) {
  const i = Math.floor(x), j = Math.floor(z)
  const fx = x - i, fz = z - j
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
const fbm = (x: number, z: number) => noise(x, z) * 0.55 + noise(x * 2.03 + 17.1, z * 2.03 + 3.3) * 0.3 + noise(x * 4.07 + 31.7, z * 4.07 + 9.1) * 0.15

export interface GroundMap {
  texture: THREE.DataTexture
  /** Grass thickness 0..1 at a spot (what the map's B channel holds). */
  grass: (x: number, z: number) => number
}

/**
 * `noGrass(x, z)`: true where nothing may grow (bases, outposts, parking). `worn(x, z)`: 0..1 extra bare earth
 * (trampled ground round outposts and vehicle spots).
 */
export function bakeGroundMap(noGrass: (x: number, z: number) => boolean, worn: (x: number, z: number) => number): GroundMap {
  const size = GROUND_MAP_SIZE
  const data = new Uint8Array(size * size * 4)
  const grass = new Float32Array(size * size)
  const step = WORLD_SIZE / size
  const e = 1.5
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = -HALF_WORLD + (i + 0.5) * step, z = -HALF_WORLD + (j + 0.5) * step
      const h = heightAt(x, z)
      const slope = Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e)
      const patches = fbm(x * 0.011, z * 0.011)
      const fine = fbm(x * 0.05 + 7, z * 0.05 - 3)
      let dirt = THREE.MathUtils.clamp((patches - 0.55) * 3.2 + (fine - 0.5) * 0.5, 0, 0.8) + (Math.abs(x + z) > 660 ? 0.2 : 0)
      dirt = Math.min(1, dirt + worn(x, z))
      const meadow = THREE.MathUtils.clamp(1 - Math.abs(patches - 0.46) * 11, 0, 0.6)
      const rock = Math.min(1, THREE.MathUtils.clamp((h - 18) / 12, 0, 1) + THREE.MathUtils.smoothstep(slope, 0.3, 0.55))
      const sand = THREE.MathUtils.clamp((-1 - h) / 2, 0, 1)
      let g = (1 - dirt * 1.3) * (1 - meadow * 0.55) * (1 - rock) * (1 - sand) * (0.55 + fine * 0.6)
      if (h < -1.6 || noGrass(x, z)) g = 0
      g = THREE.MathUtils.clamp(g, 0, 1)
      grass[j * size + i] = g
      const k = (j * size + i) * 4
      data[k] = Math.round(dirt * 255)
      data[k + 1] = Math.round(meadow * 255)
      data[k + 2] = Math.round(g * 255)
      data[k + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  return {
    texture,
    grass(x, z) {
      const i = THREE.MathUtils.clamp(Math.floor((x + HALF_WORLD) / step), 0, size - 1)
      const j = THREE.MathUtils.clamp(Math.floor((z + HALF_WORLD) / step), 0, size - 1)
      return grass[j * size + i]
    },
  }
}
