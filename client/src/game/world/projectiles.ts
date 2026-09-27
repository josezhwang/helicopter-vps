import * as THREE from 'three'
import { loadProp, propInstances, type Prop } from './props'
import { heightAt } from './terrain'
import type { RoundKind } from './weapons'

/**
 * Everything that flies: visible rounds (the hit itself is decided instantly by hitscan; the round is drawn
 * travelling along that line), brass casings, muzzle flashes, what a hit throws up (dust, chips, splinters,
 * sparks), homing anti-aircraft missiles with smoke trails, explosions and burning wrecks.
 * All drawn with a few instanced meshes; smoke, fire and sparks are camera-facing quads from one pool.
 */
export type { RoundKind }
export type Surface = 'dirt' | 'rock' | 'concrete' | 'wood' | 'metal' | 'robot'

const ROUND_SPEED = 260
const ROUND_CAPACITY = 80
const CASING_CAPACITY = 60
const MISSILE_SPEED = 110
const MISSILE_CAPACITY = 16
/** A missile closer than this to its target has hit it. */
const MISSILE_HIT_RADIUS = 3
const MISSILE_MAX_LIFE = 12
const PARTICLES = 900
const CASING_LIFE = 2.5

interface Round { kind: RoundKind; start: THREE.Vector3; dir: THREE.Vector3; length: number; travelled: number; color: THREE.Color }
interface Casing { kind: CasingKind; position: THREE.Vector3; velocity: THREE.Vector3; spin: THREE.Quaternion; rotation: THREE.Quaternion; age: number; resting: boolean }
interface Missile { position: THREE.Vector3; velocity: THREE.Vector3; target: () => THREE.Vector3 | null; onArrive?: () => void; age: number; smokeTimer: number }
interface Particle { position: THREE.Vector3; velocity: THREE.Vector3; age: number; life: number; size0: number; size1: number; alpha: number; fire: boolean; color: THREE.Color; gravity: number; drag: number }
interface Burner { position: () => THREE.Vector3 | null; until: number; timer: number }
type CasingKind = 'bullet_9mm' | 'bullet_556' | 'bullet_heavy'

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

/** What each surface throws up when hit: dust colour, debris colour, sparks. */
const SURFACES: Record<Surface, { dust: number; debris: number; sparks: number; dustAmount: number }> = {
  dirt: { dust: 0x7a6548, debris: 0x4a3b28, sparks: 0, dustAmount: 1 },
  rock: { dust: 0x9a9690, debris: 0x6d6a66, sparks: 2, dustAmount: 0.8 },
  concrete: { dust: 0xb8b2a6, debris: 0x8a857c, sparks: 1, dustAmount: 0.9 },
  wood: { dust: 0x8a6a45, debris: 0x6b4a2a, sparks: 0, dustAmount: 0.5 },
  metal: { dust: 0x5a5a5a, debris: 0x3a3a3a, sparks: 9, dustAmount: 0.25 },
  robot: { dust: 0x333333, debris: 0x222222, sparks: 7, dustAmount: 0.3 },
}

export interface Projectiles {
  group: THREE.Group
  /** A visible round flying from `start` to where the hitscan said it stops. */
  round: (kind: RoundKind, start: THREE.Vector3, end: THREE.Vector3, color?: number) => void
  /** What a round throws up where it hits (heavy = machine guns, snipers: more of it). */
  impact: (point: THREE.Vector3, normal: THREE.Vector3, surface: Surface, heavy?: boolean) => void
  /** Flash and a puff of smoke at a muzzle. */
  muzzleFlash: (at: THREE.Vector3, dir: THREE.Vector3, scale?: number) => void
  /** A spent casing flung out of a gun: it tumbles, falls, bounces and lies there a moment. */
  casing: (kind: CasingKind, at: THREE.Vector3, velocity: THREE.Vector3) => void
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
  const casings: Casing[] = []
  const missiles: Missile[] = []
  const particles: Particle[] = []
  const burners: Burner[] = []
  const roundMeshes = new Map<RoundKind, { prop: Prop; meshes: THREE.InstancedMesh[] }>()
  const casingMeshes = new Map<CasingKind, THREE.InstancedMesh[]>()
  let missileMeshes: THREE.InstancedMesh[] = []

  for (const kind of ['bullet_9mm', 'bullet_556', 'bullet_heavy'] as CasingKind[]) {
    void loadProp(kind).then((prop) => {
      roundMeshes.set(kind, { prop, meshes: propInstances(prop, ROUND_CAPACITY, false, group) })
      casingMeshes.set(kind, propInstances(prop, CASING_CAPACITY, false, group))
    }).catch((error) => console.error(`[projectiles] ${kind} model failed to load:`, error))
  }
  void loadProp('missile').then((prop) => { missileMeshes = propInstances(prop, MISSILE_CAPACITY, true, group) })
    .catch((error) => console.error('[projectiles] missile model failed to load:', error))

  // Streaks behind flying rounds (so a small round is still visible), additive and tinted per round
  const streakGeometry = new THREE.CylinderGeometry(0.004, 0.022, 1, 5, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5)
  const streaks = new THREE.InstancedMesh(streakGeometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }), ROUND_CAPACITY)
  streaks.count = 0
  streaks.frustumCulled = false
  streaks.raycast = () => {}
  streaks.setColorAt(0, new THREE.Color())
  group.add(streaks)

  // Smoke / dust (normal blending) and fire / sparks (additive) particles
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
  const muzzleLight = new THREE.PointLight(0xffc873, 0, 14, 1.8)
  group.add(muzzleLight)

  const emit = (position: THREE.Vector3, velocity: THREE.Vector3, life: number, size0: number, size1: number, alpha: number, isFire: boolean, color: number, gravity = 0, drag = isFire ? 3 : 0.8) => {
    if (particles.length >= PARTICLES * 2 - 2) particles.shift()
    particles.push({ position: position.clone(), velocity: velocity.clone(), age: 0, life, size0, size1, alpha, fire: isFire, color: new THREE.Color(color), gravity, drag })
  }
  const random = (scale: number) => new THREE.Vector3((Math.random() - 0.5) * scale, (Math.random() - 0.5) * scale, (Math.random() - 0.5) * scale)

  const explosion = (at: THREE.Vector3, scale = 1) => {
    for (let i = 0; i < 26 * scale; i++) emit(at.clone().add(random(2 * scale)), random(22 * scale).add(new THREE.Vector3(0, 4, 0)), 0.5 + Math.random() * 0.4, 1.5 * scale, 6 * scale, 1, true, i % 3 ? 0xffa040 : 0xffe07a)
    for (let i = 0; i < 18 * scale; i++) emit(at.clone().add(random(3 * scale)), random(8 * scale).add(new THREE.Vector3(0, 3, 0)), 2.2 + Math.random() * 1.5, 3 * scale, 11 * scale, 0.7, false, 0x3a3a3a)
    for (let i = 0; i < 16 * scale; i++) emit(at.clone(), random(26 * scale).add(new THREE.Vector3(0, 8, 0)), 1 + Math.random(), 0.25 * scale, 0.2 * scale, 1, false, 0x2a2622, 18, 0.2)
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
    impact(point, normal, surface, heavy = false) {
      const look = SURFACES[surface]
      const k = heavy ? 2 : 1
      const n = normal.clone().normalize()
      // Dust puff off the surface
      for (let i = 0; i < Math.ceil(4 * look.dustAmount * k); i++) {
        emit(point.clone().addScaledVector(n, 0.1), n.clone().multiplyScalar(1.5 + Math.random() * 2).add(random(1.5)), 0.8 + Math.random() * 0.8, 0.25 * k, (0.9 + Math.random() * 0.6) * k, 0.6, false, look.dust, -0.3)
      }
      // Debris: chips, clods, splinters thrown out and falling back
      for (let i = 0; i < 5 * k; i++) {
        emit(point.clone().addScaledVector(n, 0.05), n.clone().multiplyScalar(3 + Math.random() * 4).add(random(5)), 0.6 + Math.random() * 0.5, 0.07 * k, 0.05 * k, 1, false, look.debris, 16, 0.3)
      }
      // Sparks off metal and stone
      for (let i = 0; i < look.sparks * k; i++) {
        emit(point.clone().addScaledVector(n, 0.05), n.clone().multiplyScalar(4 + Math.random() * 6).add(random(8)), 0.15 + Math.random() * 0.25, 0.06, 0.02, 1, true, i % 2 ? 0xffd070 : 0xfff2c0, 12, 1)
      }
      if (look.sparks > 2) emit(point.clone().addScaledVector(n, 0.1), new THREE.Vector3(), 0.06, 0.5 * k, 0.2, 1, true, 0xffe0a0)
    },
    muzzleFlash(at, dir, scale = 1) {
      const d = dir.clone().normalize()
      for (let i = 0; i < 3; i++) emit(at.clone().addScaledVector(d, 0.1 + i * 0.12 * scale), d.clone().multiplyScalar(3), 0.05, (0.35 - i * 0.07) * scale, 0.1 * scale, 1, true, i ? 0xffb050 : 0xfff0c0)
      emit(at.clone().addScaledVector(d, 0.3), d.clone().multiplyScalar(1.5).add(new THREE.Vector3(0, 0.6, 0)), 0.9, 0.15 * scale, 0.7 * scale, 0.25, false, 0xcfcfcf)
      muzzleLight.position.copy(at)
      muzzleLight.intensity = 22 * scale
    },
    casing(kind, at, velocity) {
      if (casings.length >= CASING_CAPACITY) casings.shift()
      const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      casings.push({ kind, position: at.clone(), velocity: velocity.clone(), spin: new THREE.Quaternion().setFromAxisAngle(axis, 0.35), rotation: new THREE.Quaternion().setFromAxisAngle(axis, Math.random() * 6), age: 0, resting: false })
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
      // Rounds (plasma bolts are pure light: no model, a thick glowing streak)
      let streakCount = 0
      const used = new Map<RoundKind, number>()
      for (let i = rounds.length - 1; i >= 0; i--) {
        const r = rounds[i]
        r.travelled += ROUND_SPEED * (r.kind === 'bolt' ? 0.45 : 1) * dt
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
        const heavy = r.kind === 'bullet_heavy' ? 2.6 : r.kind === 'bolt' ? 6 : 1
        const tail = Math.min(r.travelled, r.kind === 'bolt' ? 2.5 : r.kind === 'bullet_heavy' ? 8 : 5)
        m.compose(p, q.setFromUnitVectors(back, r.dir.clone().negate()), s.set(heavy, heavy, tail))
        streaks.setMatrixAt(streakCount, m)
        streaks.setColorAt(streakCount, r.color)
        streakCount++
      }
      for (const [kind, set] of roundMeshes) for (const mesh of set.meshes) { mesh.count = used.get(kind) ?? 0; mesh.instanceMatrix.needsUpdate = true }
      streaks.count = streakCount
      streaks.instanceMatrix.needsUpdate = true
      if (streaks.instanceColor) streaks.instanceColor.needsUpdate = true

      // Casings: tumble, fall, bounce once or twice, lie still, vanish
      const casingUsed = new Map<CasingKind, number>()
      for (let i = casings.length - 1; i >= 0; i--) {
        const c = casings[i]
        c.age += dt
        if (c.age > CASING_LIFE) { casings.splice(i, 1); continue }
        if (!c.resting) {
          c.velocity.y -= 9.8 * dt
          c.position.addScaledVector(c.velocity, dt)
          c.rotation.multiply(c.spin)
          const ground = heightAt(c.position.x, c.position.z) + 0.02
          if (c.position.y < ground) {
            c.position.y = ground
            if (Math.abs(c.velocity.y) < 1.2) c.resting = true
            c.velocity.set(c.velocity.x * 0.4, -c.velocity.y * 0.35, c.velocity.z * 0.4)
          }
        }
        const meshes = casingMeshes.get(c.kind)
        if (!meshes) continue
        const slot = casingUsed.get(c.kind) ?? 0
        casingUsed.set(c.kind, slot + 1)
        m.compose(c.position, c.rotation, s.setScalar(c.kind === 'bullet_heavy' ? 0.35 : 0.6))
        for (const mesh of meshes) mesh.setMatrixAt(slot, m)
      }
      for (const [kind, meshes] of casingMeshes) for (const mesh of meshes) { mesh.count = casingUsed.get(kind) ?? 0; mesh.instanceMatrix.needsUpdate = true }

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
        pt.velocity.y -= pt.gravity * dt
        pt.position.addScaledVector(pt.velocity, dt)
        pt.velocity.multiplyScalar(Math.max(0, 1 - dt * pt.drag))
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
      muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 400)
    },
  }
}
