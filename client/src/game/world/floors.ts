import * as THREE from 'three'
import { heightAt } from './terrain'

/**
 * Walkable floors above the terrain (the capital ships' flight decks): flat tops that players stand on and
 * fighters land on. Boxes in world space; only their tops count.
 */
const floors: THREE.Box3[] = []

export function addFloor(box: THREE.Box3) {
  floors.push(box)
}

/**
 * The ground under (x, z) for something at height `fromY`: the terrain, or the top of a floor it is standing on
 * or above (up to `step` metres below its top, so walking onto a deck works).
 */
export function groundAt(x: number, z: number, fromY = Infinity, step = 0.6): number {
  let ground = heightAt(x, z)
  for (const box of floors) {
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
    if (fromY >= box.max.y - step && box.max.y > ground) ground = box.max.y
  }
  return ground
}
