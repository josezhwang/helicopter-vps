import * as THREE from 'three'

/**
 * Trails behind aircraft: ribbons that always face the camera, laid through the points an emitter has passed,
 * thinning and fading with age. A hot engine glow (short, additive) and a vapour contrail (long, soft).
 */
const MAX_POINTS = 64

interface Style { life: number; width: number; spacing: number; additive: boolean; opacity: number }
export const TRAIL_STYLES = {
  glow: { life: 0.55, width: 0.9, spacing: 1.2, additive: true, opacity: 0.9 },
  vapour: { life: 2.6, width: 1.1, spacing: 3, additive: false, opacity: 0.35 },
} satisfies Record<string, Style>
export type TrailStyle = keyof typeof TRAIL_STYLES

interface Trail {
  style: Style
  color: THREE.Color
  points: Array<{ p: THREE.Vector3; age: number }>
  mesh: THREE.Mesh
  position: THREE.BufferAttribute
  colour: THREE.BufferAttribute
  /** Seen this frame (an emitter that stops being fed just fades out). */
  fed: boolean
}

export interface Trails {
  group: THREE.Group
  /** Feed an emitter this frame: where it is, whether it is leaving a trail right now, and a strength 0..1. */
  emit: (id: string, style: TrailStyle, at: THREE.Vector3, color: THREE.ColorRepresentation, on: boolean, strength?: number) => void
  update: (dt: number, camera: THREE.Vector3) => void
  dispose: () => void
}

export function createTrails(): Trails {
  const group = new THREE.Group()
  group.name = 'trails'
  const trails = new Map<string, Trail>()
  const additive = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })
  const soft = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  const strengths = new Map<string, number>()

  const make = (style: Style, color: THREE.Color): Trail => {
    const geometry = new THREE.BufferGeometry()
    const position = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3)
    const colour = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * 4), 4)
    position.setUsage(THREE.DynamicDrawUsage)
    colour.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', position)
    geometry.setAttribute('color', colour)
    const index: number[] = []
    for (let i = 0; i < MAX_POINTS - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    geometry.setIndex(index)
    const mesh = new THREE.Mesh(geometry, style.additive ? additive : soft)
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    mesh.renderOrder = 4
    group.add(mesh)
    return { style, color, points: [], mesh, position, colour, fed: false }
  }

  const side = new THREE.Vector3(), along = new THREE.Vector3(), view = new THREE.Vector3()
  return {
    group,
    emit(id, styleName, at, color, on, strength = 1) {
      const key = `${id}|${styleName}`
      let trail = trails.get(key)
      if (!trail) trails.set(key, (trail = make(TRAIL_STYLES[styleName], new THREE.Color(color))))
      trail.fed = true
      strengths.set(key, strength)
      if (!on) return
      const last = trail.points[0]
      if (last && last.p.distanceTo(at) < trail.style.spacing) {
        // Keep the head glued to the emitter between samples
        last.p.copy(at)
        return
      }
      trail.points.unshift({ p: at.clone(), age: 0 })
      if (trail.points.length > MAX_POINTS) trail.points.length = MAX_POINTS
    },
    update(dt, camera) {
      for (const [key, trail] of trails) {
        const { style, points } = trail
        for (const point of points) point.age += dt
        while (points.length && points[points.length - 1].age > style.life) points.pop()
        if (!trail.fed && !points.length) {
          trail.mesh.removeFromParent()
          trail.mesh.geometry.dispose()
          trails.delete(key)
          continue
        }
        trail.fed = false
        const strength = strengths.get(key) ?? 1
        const n = points.length
        for (let i = 0; i < n; i++) {
          const p = points[i].p
          const next = points[Math.min(n - 1, i + 1)].p, prev = points[Math.max(0, i - 1)].p
          along.subVectors(prev, next)
          if (along.lengthSq() < 1e-6) along.set(0, 0, 1)
          view.subVectors(camera, p)
          side.crossVectors(along, view).normalize()
          const fade = 1 - points[i].age / style.life
          const width = style.width * (style.additive ? fade : 0.6 + (1 - fade) * 1.6) * strength
          trail.position.setXYZ(i * 2, p.x + side.x * width, p.y + side.y * width, p.z + side.z * width)
          trail.position.setXYZ(i * 2 + 1, p.x - side.x * width, p.y - side.y * width, p.z - side.z * width)
          const a = Math.pow(fade, 1.4) * style.opacity * strength * (i === 0 ? 0 : 1)
          const c = trail.color
          for (const v of [i * 2, i * 2 + 1]) trail.colour.setXYZW(v, c.r, c.g, c.b, a)
        }
        trail.position.needsUpdate = true
        trail.colour.needsUpdate = true
        trail.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6)
      }
    },
    dispose() {
      for (const trail of trails.values()) trail.mesh.geometry.dispose()
      additive.dispose()
      soft.dispose()
    },
  }
}
