import * as THREE from 'three'
import { loadModel, toStandardMaterial } from './assets'
import type { Team } from './layout'

/**
 * Space fighters: single-seat strike craft that take off from pads beside each base (they hover at low speed),
 * fly like jets once up to speed, and climb right out of the atmosphere into the space zone. Nose guns fire
 * lasers, the pods homing missiles.
 *
 * Each team's pads hold its own design: blue flies "Space Fighter", red "Space Ship" (both by Comrade1280,
 * CC-BY 4.0), painted in the team colour. Fighter space (metres): nose +Z, origin on the ground under the middle.
 */
export interface FighterSpec {
  url: string
  /** The pilot's eye in the cockpit. */
  cockpit: THREE.Vector3
  /** The nose guns (they fire in turn). */
  guns: THREE.Vector3[]
  /** The missile pods. */
  pods: THREE.Vector3[]
  /** Engine nozzles (thruster flames), with their radius. */
  engines: Array<{ at: THREE.Vector3; radius: number }>
  /** Its body for bullets. */
  body: { min: THREE.Vector3; max: THREE.Vector3 }
  wings: { min: THREE.Vector3; max: THREE.Vector3 }
  /** Solid radius (bumping into things up in space). */
  radius: number
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export const FIGHTERS: Record<Team, FighterSpec> = {
  blue: {
    url: '/models/fighter_a.glb',
    cockpit: v(0, 2.35, 3.0),
    guns: [v(0.1, 0.16, 6.5), v(-0.1, 0.16, 6.5)],
    pods: [v(1.25, 0.8, 1.0), v(-1.25, 0.8, 1.0)],
    engines: [
      { at: v(2.344, 1.709, -1.362), radius: 0.304 }, { at: v(0.888, 2.51, -1.068), radius: 0.21 },
      { at: v(-0.888, 2.51, -1.068), radius: 0.21 }, { at: v(-2.344, 1.709, -1.362), radius: 0.304 },
    ],
    body: { min: v(-1.6, 0, -6.5), max: v(1.6, 3.1, 6.5) },
    wings: { min: v(-3.63, 1.0, -4.2), max: v(3.63, 2.5, 0.8) },
    radius: 4.6,
  },
  red: {
    url: '/models/fighter_b.glb',
    cockpit: v(0, 3.35, 2.3),
    guns: [v(0.2, 1.0, 6.0), v(-0.2, 1.0, 6.0)],
    pods: [v(1.0, 2.0, 0.5), v(-1.0, 2.0, 0.5)],
    engines: [{ at: v(0, 3.25, -6.2), radius: 0.35 }],
    body: { min: v(-0.9, 0.3, -6.3), max: v(0.9, 3.75, 6.2) },
    wings: { min: v(-1.4, 1.5, -1.5), max: v(1.4, 3.2, 3.0) },
    radius: 4.2,
  },
}
/** The design a fighter has (its home base's). */
export const fighterSpec = (team: Team) => FIGHTERS[team]
/** Paint on the team-coloured panels. */
const TEAM_PAINT: Record<Team, THREE.Color> = { blue: new THREE.Color(0.5, 0.68, 1.1), red: new THREE.Color(1.1, 0.52, 0.46) }

export interface FighterRig {
  object: THREE.Group
  /** Place the craft (pose from its vehicle) and light the engines: 0 idle … 1 full thrust (> 1 boosting). */
  update: (pose: THREE.Object3D, thrust: number, dt: number) => void
  /** Show as a burnt wreck. */
  setWrecked: (wrecked: boolean) => void
  dispose: () => void
}

/** Thruster flames: additive cones out of the nozzles, longer and brighter with thrust. */
function makeFlame(color: THREE.Color) {
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  const geometry = new THREE.ConeGeometry(1, 1, 12, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5)
  return { material, geometry }
}

export function createFighterRig(team: Team): FighterRig {
  const spec = FIGHTERS[team]
  const object = new THREE.Group()
  object.name = `fighter-${team}`
  object.rotation.order = 'YXZ'
  const materials: THREE.MeshStandardMaterial[] = []
  const originals: THREE.Color[] = []
  const wreck = new THREE.Color(0.15, 0.14, 0.13)
  let wrecked = false
  void loadModel(spec.url).then((gltf) => {
    const model = gltf.scene.clone(true)
    const cache = new Map<THREE.Material, THREE.MeshStandardMaterial>()
    model.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.raycast = () => {}
      const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      let material = cache.get(source)
      if (!material) {
        material = toStandardMaterial(source).clone()
        if (material.name.endsWith('_team')) material.color.multiply(TEAM_PAINT[team])
        cache.set(source, material)
        materials.push(material)
        originals.push(material.color.clone())
      }
      mesh.material = material
    })
    object.add(model)
    if (wrecked) materials.forEach((m) => m.color.copy(wreck))
  }).catch((error) => console.error('[fighters] model failed to load:', error))

  const flame = makeFlame(new THREE.Color(team === 'blue' ? 0x6fd4ff : 0xffa15a))
  const flames = spec.engines.map(({ at, radius }) => {
    const mesh = new THREE.Mesh(flame.geometry, flame.material)
    mesh.position.copy(at)
    mesh.userData.radius = radius
    mesh.raycast = () => {}
    object.add(mesh)
    return mesh
  })
  let glow = 0
  return {
    object,
    update(pose, thrust, dt) {
      object.position.copy(pose.position)
      object.quaternion.copy(pose.quaternion)
      glow += (thrust - glow) * Math.min(1, dt * 6)
      const flicker = 0.9 + Math.random() * 0.2
      for (const mesh of flames) {
        const r = mesh.userData.radius as number
        mesh.visible = !wrecked && glow > 0.02
        mesh.scale.set(r * (0.8 + glow * 0.3), r * (0.8 + glow * 0.3), r * 8 * (0.6 + glow * 3.4) * flicker)
      }
      flame.material.opacity = Math.min(1, 0.35 + glow * 0.6)
    },
    setWrecked(state) {
      if (state === wrecked) return
      wrecked = state
      materials.forEach((m, i) => m.color.copy(state ? wreck : originals[i]))
    },
    dispose() {
      for (const m of materials) m.dispose()
      flame.geometry.dispose()
      flame.material.dispose()
    },
  }
}
