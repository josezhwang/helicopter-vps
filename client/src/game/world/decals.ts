import * as THREE from 'three'

/**
 * Bullet holes and scorch marks left where rounds and explosions hit: small dark quads laid flat on the
 * surface. Marks on vehicles ride along with them. The oldest marks are reused once the pool is full.
 */
export type DecalKind = 'hole' | 'scorch'

const CAPACITY: Record<DecalKind, number> = { hole: 500, scorch: 60 }

function holeTexture(scorch: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  if (scorch) {
    g.addColorStop(0, 'rgba(8,6,5,0.95)')
    g.addColorStop(0.45, 'rgba(20,16,12,0.75)')
    g.addColorStop(0.8, 'rgba(40,32,25,0.25)')
    g.addColorStop(1, 'rgba(40,32,25,0)')
  } else {
    // Black hole, a dark scorched rim, then a ring of lighter chipped material (reads on dark and light surfaces)
    g.addColorStop(0, 'rgba(0,0,0,1)')
    g.addColorStop(0.38, 'rgba(6,5,4,1)')
    g.addColorStop(0.52, 'rgba(35,30,25,0.95)')
    g.addColorStop(0.62, 'rgba(165,155,140,0.8)')
    g.addColorStop(0.8, 'rgba(150,140,125,0.35)')
    g.addColorStop(1, 'rgba(150,140,125,0)')
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  if (!scorch) {
    // A few cracks out of the hole
    ctx.strokeStyle = 'rgba(20,16,12,0.7)'
    ctx.lineWidth = 2
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.6
      ctx.beginPath()
      ctx.moveTo(64 + Math.cos(a) * 22, 64 + Math.sin(a) * 22)
      ctx.lineTo(64 + Math.cos(a + 0.2) * (40 + Math.random() * 18), 64 + Math.sin(a + 0.2) * (40 + Math.random() * 18))
      ctx.stroke()
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

interface Mark { local: THREE.Matrix4; attach: THREE.Object3D | null }

export interface Decals {
  group: THREE.Group
  /** A mark at `point` facing along `normal`; `attach` makes it move with that object (vehicles). */
  add: (kind: DecalKind, point: THREE.Vector3, normal: THREE.Vector3, size: number, attach?: THREE.Object3D | null, lift?: number) => void
  /** Remove every mark riding on an object (a wreck that is repaired). */
  clear: (attach: THREE.Object3D) => void
  update: () => void
}

export function createDecals(): Decals {
  const group = new THREE.Group()
  group.name = 'decals'
  const plane = new THREE.PlaneGeometry(1, 1)
  const sets = (['hole', 'scorch'] as DecalKind[]).map((kind) => {
    const material = new THREE.MeshStandardMaterial({
      map: holeTexture(kind === 'scorch'), transparent: true, depthWrite: false, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })
    const mesh = new THREE.InstancedMesh(plane, material, CAPACITY[kind])
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    mesh.renderOrder = 2
    group.add(mesh)
    return { kind, mesh, marks: [] as Mark[], next: 0, moving: 0 }
  })
  const byKind = new Map(sets.map((s) => [s.kind, s]))
  const q = new THREE.Quaternion(), m = new THREE.Matrix4(), inv = new THREE.Matrix4(), s = new THREE.Vector3(), zAxis = new THREE.Vector3(0, 0, 1)

  const write = (set: (typeof sets)[number], i: number) => {
    const mark = set.marks[i]
    if (mark.attach) m.multiplyMatrices(mark.attach.matrixWorld, mark.local)
    else m.copy(mark.local)
    set.mesh.setMatrixAt(i, m)
  }

  return {
    group,
    add(kind, point, normal, size, attach = null, lift = 0.02) {
      const set = byKind.get(kind)!
      // Face along the surface normal, a random turn, a hair off the surface
      q.setFromUnitVectors(zAxis, normal.clone().normalize()).multiply(new THREE.Quaternion().setFromAxisAngle(zAxis, Math.random() * Math.PI * 2))
      const world = new THREE.Matrix4().compose(point.clone().addScaledVector(normal, lift), q, s.set(size, size, size))
      let local = world
      if (attach) {
        attach.updateMatrixWorld()
        local = inv.copy(attach.matrixWorld).invert().multiply(world)
      }
      const i = set.next
      set.marks[i] = { local: local.clone(), attach }
      set.next = (set.next + 1) % CAPACITY[kind]
      set.mesh.count = Math.max(set.mesh.count, i + 1)
      write(set, i)
      set.mesh.instanceMatrix.needsUpdate = true
    },
    clear(attach) {
      for (const set of sets) {
        set.marks.forEach((mark, i) => {
          if (mark.attach !== attach) return
          mark.attach = null
          mark.local.makeScale(0, 0, 0)
          write(set, i)
        })
        set.mesh.instanceMatrix.needsUpdate = true
      }
    },
    update() {
      // Marks on vehicles follow them
      for (const set of sets) {
        let moved = false
        set.marks.forEach((mark, i) => { if (mark.attach) { write(set, i); moved = true } })
        if (moved) set.mesh.instanceMatrix.needsUpdate = true
      }
    },
  }
}
