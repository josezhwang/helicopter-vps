import * as THREE from 'three'
import { heightAt } from './terrain'

export interface PlayerInput {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
  sprint: boolean
  jump: boolean
}

const PLAYER_RADIUS = 0.6
const EYE_HEIGHT = 1.7
const GRAVITY = 24
const JUMP_SPEED = 8.5
const WALK_SPEED = 9
const SPRINT_SPEED = 15

export class Player {
  position = new THREE.Vector3()
  velocity = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = true
  camera: THREE.PerspectiveCamera

  private colliders: THREE.Box3[] = []
  /** Tall solid circles: tree trunks, boulders — {worldX, worldZ, radius}. */
  private circles: Array<{ x: number; z: number; r: number }> = []
  /** Dynamic circle (the parked helicopter) refreshed each frame by the game. */
  private extraCircle: { x: number; z: number; r: number } | null = null

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera
  }

  setColliders(colliders: THREE.Box3[]) {
    this.colliders = colliders
  }

  setCircles(circles: Array<{ x: number; z: number; r: number }>) {
    this.circles = circles
  }

  setExtraCircle(x: number, z: number, r: number) {
    this.extraCircle = { x, z, r }
  }

  spawn(position: THREE.Vector3) {
    this.position.copy(position)
    this.position.y = heightAt(position.x, position.z) + EYE_HEIGHT
    this.velocity.set(0, 0, 0)
    this.yaw = Math.atan2(position.x, position.z) // face midfield (camera forward = (-sin, -cos))
    this.pitch = 0
  }

  look(dx: number, dy: number) {
    this.yaw -= dx * 0.0022
    this.pitch -= dy * 0.0022
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05)
  }

  update(dt: number, input: PlayerInput, locked: boolean) {
    if (!locked) {
      this.velocity.x = 0
      this.velocity.z = 0
    } else {
      // Horizontal wish direction in yaw space
      const wish = new THREE.Vector3()
      if (input.forward) wish.z -= 1
      if (input.back) wish.z += 1
      if (input.left) wish.x -= 1
      if (input.right) wish.x += 1
      if (wish.lengthSq() > 0) wish.normalize()

      const speed = input.sprint ? SPRINT_SPEED : WALK_SPEED
      const sin = Math.sin(this.yaw)
      const cos = Math.cos(this.yaw)
      // Rotate wish into world space (Y-rotation matching the camera)
      const worldX = wish.x * cos + wish.z * sin
      const worldZ = -wish.x * sin + wish.z * cos
      this.velocity.x = worldX * speed
      this.velocity.z = worldZ * speed
    }

    // Jump / gravity
    if (input.jump && this.onGround) {
      this.velocity.y = JUMP_SPEED
      this.onGround = false
    }
    this.velocity.y -= GRAVITY * dt

    const next = this.position.clone().addScaledVector(this.velocity, dt)

    // --- Wall collision: push out of base colliders (cylinder vs AABB approx) ---
    for (const box of this.colliders) {
      const feetY = next.y - EYE_HEIGHT
      const headY = next.y + 0.2
      if (headY < box.min.y || feetY > box.max.y) continue

      // Closest point on box (XZ) to player (XZ)
      const cx = THREE.MathUtils.clamp(next.x, box.min.x, box.max.x)
      const cz = THREE.MathUtils.clamp(next.z, box.min.z, box.max.z)
      const dx = next.x - cx
      const dz = next.z - cz
      const distSq = dx * dx + dz * dz
      if (distSq < PLAYER_RADIUS * PLAYER_RADIUS) {
        const dist = Math.sqrt(distSq) || 0.0001
        const push = (PLAYER_RADIUS - dist) / dist
        next.x += dx * push
        next.z += dz * push
        next.y = this.position.y // don't step up walls
      }
    }

    // --- Circle collision: trees, boulders, parked helicopter ---
    const allCircles = this.extraCircle
      ? [...this.circles, this.extraCircle]
      : this.circles
    for (const c of allCircles) {
      const dx = next.x - c.x
      const dz = next.z - c.z
      const minDist = c.r + PLAYER_RADIUS
      const distSq = dx * dx + dz * dz
      if (distSq >= minDist * minDist || distSq < 1e-8) continue
      const dist = Math.sqrt(distSq)
      const push = (minDist - dist) / dist
      next.x += dx * push
      next.z += dz * push
    }

    // World bounds
    next.x = THREE.MathUtils.clamp(next.x, -490, 490)
    next.z = THREE.MathUtils.clamp(next.z, -490, 490)

    // Ground follow (terrain height)
    const groundY = heightAt(next.x, next.z) + EYE_HEIGHT
    if (next.y <= groundY) {
      next.y = groundY
      this.velocity.y = 0
      this.onGround = true
    } else {
      this.onGround = false
    }

    this.position.copy(next)

    // Slope-based FOV kick while sprinting feels good
    this.camera.position.copy(this.position)
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.set(this.pitch, this.yaw, 0)
  }

  eyePosition(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.position)
  }
}

export { EYE_HEIGHT }
