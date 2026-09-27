import * as THREE from 'three'
import { loadProp, propInstances, type Prop } from './props'

/**
 * Everything that flies: visible rounds (the hit itself is decided instantly by hitscan; the round is drawn
 * travelling along that line), homing anti-aircraft missiles with smoke trails, explosions and burning wrecks.
 * All drawn with a few instanced meshes; smoke and fire are camera-facing quads from one pool.
 */
export type RoundKind = 'bullet_9mm' | 'bullet_556'

const ROUND_SPEED = 260
const ROUND_CAPACITY = 64
const MISSILE_SPEED = 110
const MISSILE_CAPACITY = 16
/** A missile closer than this to its target has hit it. */
const MISSILE_HIT_RADIUS = 3
const MISSILE_MAX_LIFE = 12
const PARTICLES = 700

interface Round { kind: RoundKind; start: THREE.Vector3; dir: THREE.Vector3; length: number; travelled: number; color: THREE.Color }
interface Missile { position: THREE.Vector3; velocity: THREE.Vector3; target: () => THREE.Vector3 | null; onArrive?: () => void; age: number; smokeTimer: number }
interface Particle { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number; size0: number; size1: number; alpha: number; fire: boolean; color: THREE.Color }
interface Burner { position: () => THREE.Vector3 | null; until: number; timer: number }

function softTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Camera-facing quads: position and size from the instance matrix, colour per instance, fade per instance. */
function particleMaterial(texture: THREE.Texture, additive: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vAlpha;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        vAlpha = aAlpha;
        vColor = instanceColor;
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float size = length(instanceMatrix[0].xyz);
        center.xy += position.xy * size;
        gl_Position = projectionMatrix * center;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying float vAlpha;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
}

export interface Projectiles {
  group: THREE.Group
  /** A visible round flying from `start` to where the hitscan said it stops. */
  round: (kind: RoundKind, start: THREE.Vector3, end: THREE.Vector3, color?: number) => void
  /** A homing missile; `target` returns where the aircraft is now (null once it's gone). */
  missile: (from: THREE.Vector3, target: () => THREE.Vector3 | null, onArrive?: () => void) => void
  explosion: (at: THREE.Vector3, scale?: number) => void
  /** Smoke and flames rising from a wreck for `seconds`. */
  burn: (position: () => THREE.Vector3 | null, seconds: number) => void
  update: (dt: number) => void
}

export function createProjectiles(): Projectiles {
  const group = new THREE.Group()
  group.name = 'projectiles'
  const rounds: Round[] = []
  const missiles: Missile[] = []
  const particles: Particle[] = []
  const burners: Burner[] = []
  const roundMeshes = new Map<RoundKind, { prop: Prop; meshes: THREE.InstancedMesh[] }>()
  let missileMeshes: THREE.InstancedMesh[] = []

  for (const kind of ['bullet_9mm', 'bullet_556'] as RoundKind[]) {
    void loadProp(kind).then((prop) => roundMeshes.set(kind, { prop, meshes: propInstances(prop, ROUND_CAPACITY, false, group) }))
      .catch((error) => console.error(`[projectiles] ${kind} model failed to load:`, error))
  }
  void loadProp('missile').then((prop) => { missileMeshes = propInstances(prop, MISSILE_CAPACITY, true, group) })
    .catch((error) => console.error('[projectiles] missile model failed to load:', error))

  // Streaks behind flying rounds (so a 16cm round is still visible), additive and tinted per round
  const streakGeometry = new THREE.CylinderGeometry(0.004, 0.022, 1, 5, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5)
  const streaks = new THREE.InstancedMesh(streakGeometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }), ROUND_CAPACITY * 2)
  streaks.count = 0
  streaks.frustumCulled = false
  streaks.raycast = () => {}
  streaks.setColorAt(0, new THREE.Color())
  group.add(streaks)

  // Smoke (normal blending) and fire (additive) particles
  const texture = softTexture()
  const quad = new THREE.PlaneGeometry(1, 1)
  const makeParticles = (additive: boolean) => {
    const geometry = quad.clone()
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(PARTICLES), 1)
    alpha.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('aAlpha', alpha)
    const mesh = new THREE.InstancedMesh(geometry, particleMaterial(texture, additive), PARTICLES)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    mesh.setColorAt(0, new THREE.Color())
    mesh.renderOrder = additive ? 11 : 10
    group.add(mesh)
    return { mesh, alpha }
  }
  const smoke = makeParticles(false)
  const fire = makeParticles(true)
  const flash = new THREE.PointLight(0xffaa55, 0, 90, 1.6)
  group.add(flash)

  const emit = (position: THREE.Vector3, velocity: THREE.Vector3, life: number, size0: number, size1: number, alpha: number, isFire: boolean, color: number) => {
    if (particles.length >= PARTICLES * 2 - 2) particles.shift()
    particles.push({ position: position.clone(), velocity: velocity.clone(), age: 0, life, size0, size1, alpha, fire: isFire, color: new THREE.Color(color) })
  }
  const random = (scale: number) => new THREE.Vector3((Math.random() - 0.5) * scale, (Math.random() - 0.5) * scale, (Math.random() - 0.5) * scale)

  const explosion = (at: THREE.Vector3, scale = 1) => {
    for (let i = 0; i < 26 * scale; i++) emit(at.clone().add(random(2 * scale)), random(22 * scale).add(new THREE.Vector3(0, 4, 0)), 0.5 + Math.random() * 0.4, 1.5 * scale, 6 * scale, 1, true, i % 3 ? 0xffa040 : 0xffe07a)
    for (let i = 0; i < 18 * scale; i++) emit(at.clone().add(random(3 * scale)), random(8 * scale).add(new THREE.Vector3(0, 3, 0)), 2.2 + Math.random() * 1.5, 3 * scale, 11 * scale, 0.7, false, 0x3a3a3a)
    flash.position.copy(at)
    flash.intensity = 900 * scale
  }

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), forward = new THREE.Vector3(0, 0, -1), p = new THREE.Vector3()
  const back = new THREE.Vector3(0, 0, 1)

  return {
    group,
    round(kind, start, end, color = 0xffe8a3) {
      const dir = end.clone().sub(start)
      const length = dir.length()
      if (length < 0.5) return
      if (rounds.length >= ROUND_CAPACITY) rounds.shift()
      rounds.push({ kind, start: start.clone(), dir: dir.divideScalar(length), length, travelled: 0, color: new THREE.Color(color) })
    },
    missile(from, target, onArrive) {
      if (missiles.length >= MISSILE_CAPACITY) missiles.shift()
      const aim = target()
      const dir = aim ? aim.clone().sub(from).normalize() : new THREE.Vector3(0, 1, 0)
      missiles.push({ position: from.clone(), velocity: dir.multiplyScalar(MISSILE_SPEED * 0.6), target, onArrive, age: 0, smokeTimer: 0 })
    },
    explosion,
    burn(position, seconds) {
      burners.push({ position, until: performance.now() + seconds * 1000, timer: 0 })
    },
    update(dt) {
      // Rounds
      let streakCount = 0
      const used = new Map<RoundKind, number>()
      for (let i = rounds.length - 1; i >= 0; i--) {
        const r = rounds[i]
        r.travelled += ROUND_SPEED * dt
        if (r.travelled >= r.length) { rounds.splice(i, 1); continue }
        const set = roundMeshes.get(r.kind)
        p.copy(r.start).addScaledVector(r.dir, r.travelled)
        q.setFromUnitVectors(forward, r.dir)
        if (set) {
          const slot = used.get(r.kind) ?? 0
          used.set(r.kind, slot + 1)
          m.compose(p, q, s.set(1, 1, 1))
          for (const mesh of set.meshes) mesh.setMatrixAt(slot, m)
        }
        const tail = Math.min(r.travelled, 5)
        m.compose(p, q.setFromUnitVectors(back, r.dir.clone().negate()), s.set(1, 1, tail))
        streaks.setMatrixAt(streakCount, m)
        streaks.setColorAt(streakCount, r.color)
        streakCount++
      }
      for (const [kind, set] of roundMeshes) for (const mesh of set.meshes) { mesh.count = used.get(kind) ?? 0; mesh.instanceMatrix.needsUpdate = true }
      streaks.count = streakCount
      streaks.instanceMatrix.needsUpdate = true
      if (streaks.instanceColor) streaks.instanceColor.needsUpdate = true

      // Missiles: accelerate and steer onto the target, smoke behind
      for (let i = missiles.length - 1; i >= 0; i--) {
        const missile = missiles[i]
        missile.age += dt
        const aim = missile.target()
        if (aim) {
          const want = aim.clone().sub(missile.position)
          if (want.length() < MISSILE_HIT_RADIUS + MISSILE_SPEED * dt) {
            explosion(aim, 1.4)
            missile.onArrive?.()
            missiles.splice(i, 1)
            continue
          }
          missile.velocity.lerp(want.normalize().multiplyScalar(MISSILE_SPEED), Math.min(1, dt * 5))
        }
        if (missile.age > MISSILE_MAX_LIFE) { explosion(missile.position, 0.6); missiles.splice(i, 1); continue }
        missile.position.addScaledVector(missile.velocity, dt)
        missile.smokeTimer -= dt
        if (missile.smokeTimer <= 0) {
          missile.smokeTimer = 0.025
          emit(missile.position, random(1.5), 1.6, 0.6, 3.2, 0.55, false, 0xd8d8d8)
          emit(missile.position, random(0.5), 0.12, 0.7, 0.3, 1, true, 0xffc060)
        }
      }
      missiles.forEach((missile, slot) => {
        m.compose(missile.position, q.setFromUnitVectors(forward, missile.velocity.clone().normalize()), s.set(1, 1, 1))
        for (const mesh of missileMeshes) mesh.setMatrixAt(slot, m)
      })
      for (const mesh of missileMeshes) { mesh.count = missiles.length; mesh.instanceMatrix.needsUpdate = true }

      // Wrecks keep burning
      const now = performance.now()
      for (let i = burners.length - 1; i >= 0; i--) {
        const b = burners[i]
        const at = b.position()
        if (!at || now > b.until) { burners.splice(i, 1); continue }
        b.timer -= dt
        if (b.timer > 0) continue
        b.timer = 0.08
        emit(at.clone().add(random(2)), new THREE.Vector3((Math.random() - 0.5) * 1.5, 3 + Math.random() * 2, (Math.random() - 0.5) * 1.5), 3, 1.5, 7, 0.55, false, 0x2b2b2b)
        emit(at.clone().add(random(1.5)), new THREE.Vector3(0, 2.5, 0), 0.6, 1.2, 0.3, 0.9, true, 0xff8a30)
      }

      // Particles
      const counts = { smoke: 0, fire: 0 }
      for (let i = particles.length - 1; i >= 0; i--) {
        const pt = particles[i]
        pt.age += dt
        if (pt.age >= pt.life) { particles.splice(i, 1); continue }
        pt.position.addScaledVector(pt.velocity, dt)
        pt.velocity.multiplyScalar(pt.fire ? 1 - dt * 3 : 1 - dt * 0.8)
        const t = pt.age / pt.life
        const target = pt.fire ? fire : smoke
        const slot = pt.fire ? counts.fire++ : counts.smoke++
        if (slot >= PARTICLES) continue
        const size = pt.size0 + (pt.size1 - pt.size0) * t
        m.makeScale(size, size, size).setPosition(pt.position)
        target.mesh.setMatrixAt(slot, m)
        target.mesh.setColorAt(slot, pt.color)
        target.alpha.setX(slot, pt.alpha * (1 - t) * Math.min(1, pt.age * 12))
      }
      for (const [target, count] of [[smoke, counts.smoke], [fire, counts.fire]] as const) {
        target.mesh.count = Math.min(count, PARTICLES)
        target.mesh.instanceMatrix.needsUpdate = true
        if (target.mesh.instanceColor) target.mesh.instanceColor.needsUpdate = true
        target.alpha.needsUpdate = true
      }
      flash.intensity = Math.max(0, flash.intensity - dt * 2400)
    },
  }
}
