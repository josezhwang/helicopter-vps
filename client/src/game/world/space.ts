import * as THREE from 'three'
import { firstMeshGeometry, loadModel, toStandardMaterial } from './assets'
import { BASE_CENTER, type Team } from './layout'
import { ORBIT_START } from './sky'

/**
 * The space zone above the battlefield: each team's capital ship holding station high over its base, and a field
 * of tumbling asteroids between them where the fighters dogfight. Fighters bounce off both (solid spheres).
 */
export interface SpaceZone {
  group: THREE.Group
  /** If a sphere at `at` (radius r) overlaps a ship or an asteroid, where it should be pushed to; else null. */
  pushOut: (at: THREE.Vector3, radius: number) => THREE.Vector3 | null
  update: (dt: number, camera: THREE.Vector3) => void
  dispose: () => void
}

/** Capital ships: this high over their base. */
const SHIP_ALTITUDE = 700
const ASTEROIDS = 70
/** Deterministic randomness, so every player sees the same field. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const TEAM_GLOW: Record<Team, number> = { blue: 0x58b8ff, red: 0xff7a4a }
/**
 * The capital ship ("D.S.S. Harbinger battle cruiser" by Comrade1280, CC-BY 4.0; its name decal removed), 300 m
 * long, centred, nose +Z; its lights shine in the team colour. Solid spheres along the hull (ship frame).
 */
const CAPITAL_URL = '/models/capital.glb'
const CAPITAL_SPHERES: Array<[number, number, number, number]> = [
  [0.18, -14.3, 124.9, 31.2], [0.4, -10.25, 73.7, 31.9], [0.74, -2.73, 25.6, 27], [-0.14, 0.89, -25.5, 49.9], [0, 6.13, -76.1, 64.8], [-0.22, 12.35, -123.1, 50.5],
]
const LIGHT_MATERIALS = /windows|Light|EngineGlow/
/** The space station ("Gangut space hub" by Comrade1280, CC-BY 4.0) hangs far overhead, out of reach. */
const STATION_URL = '/models/station.glb'
const ASTEROID_URLS = [0, 1, 2, 3, 4, 5].map((i) => `/models/asteroid_${i}.glb`)

/** A lumpy rock: an icosphere pushed in and out by a few octaves of cheap noise. */
function asteroidGeometry(seed: number) {
  const geometry = new THREE.IcosahedronGeometry(1, 3)
  const rand = random(seed)
  const bumps = Array.from({ length: 7 }, () => ({ d: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), k: 0.12 + rand() * 0.22 }))
  const p = geometry.attributes.position as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    let r = 1
    for (const b of bumps) r += b.k * Math.pow(Math.max(0, v.dot(b.d)), 3) - b.k * 0.35 * Math.pow(Math.max(0, -v.dot(b.d)), 2)
    r += (Math.sin(v.x * 9.1 + seed) * Math.sin(v.y * 7.3) * Math.sin(v.z * 8.7)) * 0.05
    v.multiplyScalar(r)
    p.setXYZ(i, v.x, v.y * 0.8, v.z)
  }
  geometry.computeVertexNormals()
  return geometry
}

export function createSpaceZone(): SpaceZone {
  const group = new THREE.Group()
  group.name = 'space'
  const colliders: Array<{ at: THREE.Vector3; r: number; ship?: Team }> = []
  const shipMaterials = new Map<string, THREE.MeshStandardMaterial>()

  // Capital ships, noses towards the enemy's
  const ships = (['blue', 'red'] as Team[]).map((team) => {
    const ship = new THREE.Group()
    const c = BASE_CENTER[team]
    ship.position.set(c.x * 0.8, SHIP_ALTITUDE, c.z * 0.8)
    ship.rotation.y = Math.atan2(-c.x, -c.z)
    ship.updateMatrixWorld()
    ship.add(shipModel(team))
    group.add(ship)
    for (const [x, y, z, r] of CAPITAL_SPHERES) colliders.push({ at: new THREE.Vector3(x, y, z).applyMatrix4(ship.matrixWorld), r, ship: team })
    return { team, group: ship, base: ship.position.clone() }
  })
  function shipModel(team: Team) {
    const holder = new THREE.Group()
    void loadModel(CAPITAL_URL).then((gltf) => {
      const model = gltf.scene.clone(true)
      model.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.raycast = () => {}
        const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        let material = shipMaterials.get(`${team}|${source.uuid}`)
        if (!material) {
          material = toStandardMaterial(source).clone()
          if (LIGHT_MATERIALS.test(material.name)) {
            material.emissive = new THREE.Color(TEAM_GLOW[team])
            material.emissiveIntensity = 2.4
          }
          shipMaterials.set(`${team}|${source.uuid}`, material)
        }
        mesh.material = material
      })
      holder.add(model)
    }).catch((error) => console.error('[space] capital ship failed to load:', error))
    return holder
  }

  // The station, far overhead
  const station = new THREE.Group()
  station.position.set(0, 1250, 0)
  station.scale.setScalar(0.5)
  group.add(station)
  void loadModel(STATION_URL).then((gltf) => {
    const model = gltf.scene.clone(true)
    model.traverse((node) => { (node as THREE.Mesh).raycast = () => {} })
    station.add(model)
  }).catch((error) => console.error('[space] station failed to load:', error))

  // The asteroid field: a few rock shapes, instanced, scattered between the atmosphere's edge and the ships
  const rand = random(7331)
  const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x6f6660, roughness: 0.95, metalness: 0.05, flatShading: true })
  const shapes = [11, 23, 37, 51].map((seed) => asteroidGeometry(seed))
  const perShape = Math.ceil(ASTEROIDS / shapes.length)
  const rocks: Array<{ mesh: THREE.InstancedMesh; index: number; at: THREE.Vector3; size: number; spin: THREE.Vector3; turn: THREE.Euler }> = []
  const meshes: THREE.InstancedMesh[] = shapes.map((geometry) => {
    const mesh: THREE.InstancedMesh = new THREE.InstancedMesh(geometry, rockMaterial, perShape)
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    group.add(mesh)
    return mesh
  })
  for (let i = 0; i < ASTEROIDS; i++) {
    const mesh = meshes[i % meshes.length]
    const size = 5 + Math.pow(rand(), 2.2) * 38
    const at = new THREE.Vector3((rand() - 0.5) * 900, ORBIT_START + 180 + rand() * 420, (rand() - 0.5) * 900)
    // (clear of the capital ships)
    if (ships.some((ship) => ship.base.distanceTo(at) < 190)) continue
    const rock = { mesh, index: Math.floor(i / meshes.length), at, size, spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.25), turn: new THREE.Euler(rand() * 6, rand() * 6, rand() * 6) }
    rocks.push(rock)
    colliders.push({ at, r: size * 0.92 })
  }
  for (const mesh of meshes) mesh.count = rocks.filter((r) => r.mesh === mesh).length
  // The real asteroid models replace the stand-in shapes as they load (same slots, radius 1)
  const perModel = Math.ceil(rocks.length / ASTEROID_URLS.length)
  void Promise.all(ASTEROID_URLS.map((url) => loadModel(url))).then((models) => {
    const parts = models.map((gltf) => firstMeshGeometry(gltf.scene)).filter((p): p is NonNullable<typeof p> => !!p)
    if (parts.length !== models.length) return
    const real = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, toStandardMaterial(part.material), perModel)
      mesh.frustumCulled = false
      mesh.raycast = () => {}
      mesh.count = 0
      group.add(mesh)
      return mesh
    })
    const counts = real.map(() => 0)
    rocks.forEach((rock, i) => {
      const k = i % real.length
      rock.mesh = real[k]
      rock.index = counts[k]++
    })
    real.forEach((mesh, k) => { mesh.count = counts[k] })
    for (const mesh of meshes) mesh.removeFromParent()
    meshes.splice(0, meshes.length, ...real)
  }).catch((error) => console.error('[space] asteroids failed to load:', error))

  const matrix = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  let time = 0
  const pushOut = (at: THREE.Vector3, radius: number) => {
    if (at.y < ORBIT_START) return null
    for (const c of colliders) {
      const d = at.distanceTo(c.at)
      const min = c.r + radius
      if (d < min) return c.at.clone().add(at.clone().sub(c.at).normalize().multiplyScalar(min + 0.1))
    }
    return null
  }
  return {
    group,
    pushOut,
    update(dt, camera) {
      time += dt
      // Everything up here is out of sight from the ground bar the ships; skip the rocks unless we're near
      const near = camera.y > ORBIT_START - 150
      for (const mesh of meshes) mesh.visible = near
      if (near) {
        for (const rock of rocks) {
          rock.turn.x += rock.spin.x * dt; rock.turn.y += rock.spin.y * dt; rock.turn.z += rock.spin.z * dt
          matrix.compose(rock.at, quaternion.setFromEuler(rock.turn), scale.setScalar(rock.size))
          rock.mesh.setMatrixAt(rock.index, matrix)
        }
        for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true
      }
      // The ships ride gently on station
      for (const ship of ships) ship.group.position.y = ship.base.y + Math.sin(time * 0.2 + (ship.team === 'red' ? 2 : 0)) * 3
      station.rotation.y += dt * 0.01
    },
    dispose() {
      for (const m of shipMaterials.values()) m.dispose()
      for (const geometry of shapes) geometry.dispose()
      rockMaterial.dispose()
    },
  }
}
