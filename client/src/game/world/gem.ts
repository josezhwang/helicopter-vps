import * as THREE from 'three'
import { loadModel, toStandardMaterial } from './assets'
import type { Team } from './bases'

const GEM_URL: Record<Team, string> = { blue: '/models/gem_blue.glb', red: '/models/gem_red.glb' }
export const GEM_COLOR: Record<Team, number> = { blue: 0x3d8bff, red: 0xff3b30 }
const STAND_GEM_HEIGHT = 1.5
const CARRIED_GEM_HEIGHT = 0.5
const FLOAT_HEIGHT = 2.1
const BEAM_HEIGHT = 60

const noRaycast = () => {}

/** Gem model normalised to 1 unit tall, standing on y = 0, tinted so each team's gem reads clearly. */
const templates: Partial<Record<Team, Promise<THREE.Object3D | null>>> = {}
function loadGemTemplate(team: Team): Promise<THREE.Object3D | null> {
  templates[team] ??= loadModel(GEM_URL[team]).then((gltf) => {
    const model = gltf.scene.clone()
    // The blue crystal ships with a flat helper plane under it
    const helpers: THREE.Object3D[] = []
    model.traverse((node) => { if (node.name.startsWith('pPlane')) helpers.push(node) })
    helpers.forEach((node) => node.removeFromParent())
    model.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      const material = toStandardMaterial(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).clone()
      // One glow colour per team: the blue crystal's glowing cracks were partly red
      material.emissive = new THREE.Color(GEM_COLOR[team])
      material.emissiveIntensity = team === 'blue' ? 1.1 : 0.45
      material.transparent = team === 'red'
      material.opacity = team === 'red' ? 0.93 : 1
      mesh.material = material
      mesh.castShadow = true
      mesh.raycast = noRaycast
    })
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const holder = new THREE.Group()
    model.position.set(-center.x, -box.min.y, -center.z)
    holder.add(model)
    holder.scale.setScalar(1 / size.y)
    const template = new THREE.Group()
    template.add(holder)
    return template
  }).catch((error) => {
    console.error(`[gem] ${team} gem model failed to load:`, error)
    return null
  })
  return templates[team]!
}

/** Shown until the model arrives (or if it fails): a faceted gem in the team colour. */
function placeholderGem(team: Team): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.5, 0),
    new THREE.MeshStandardMaterial({ color: GEM_COLOR[team], emissive: GEM_COLOR[team], emissiveIntensity: 0.6, roughness: 0.25, metalness: 0.1 }),
  )
  mesh.scale.set(0.8, 1, 0.8)
  mesh.position.y = 0.5
  mesh.raycast = noRaycast
  return mesh
}

let glowTexture: THREE.Texture | null = null
function glow(team: Team, size: number): THREE.Sprite {
  if (!glowTexture) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')!
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,0.9)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
    glowTexture = new THREE.CanvasTexture(canvas)
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: GEM_COLOR[team], transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  sprite.scale.setScalar(size)
  sprite.raycast = noRaycast
  return sprite
}

/** Put the real gem in place of the placeholder once it has loaded. */
function fillWithGem(holder: THREE.Object3D, team: Team, height: number) {
  const placeholder = placeholderGem(team)
  placeholder.scale.multiplyScalar(height)
  placeholder.position.y *= height
  holder.add(placeholder)
  void loadGemTemplate(team).then((template) => {
    if (!template) return
    const gem = template.clone()
    gem.traverse((node) => { node.raycast = noRaycast }) // clone() does not copy the override
    gem.scale.setScalar(height)
    holder.remove(placeholder)
    placeholder.geometry.dispose()
    ;(placeholder.material as THREE.Material).dispose()
    holder.add(gem)
  })
}

export interface GemStand {
  group: THREE.Group
  /** Pedestal collider in the stand's local space. */
  collider: THREE.Box3
  setTaken: (taken: boolean) => void
  update: (time: number) => void
}

/** A team's gem floating over its pedestal, with a light column so it can be found from afar. */
export function createGemStand(team: Team): GemStand {
  const group = new THREE.Group()
  const stone = new THREE.MeshStandardMaterial({ color: 0x6d7074, roughness: 0.9 })
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.35, 0.9, 16), stone)
  pedestal.position.y = 0.45
  pedestal.castShadow = true
  pedestal.receiveShadow = true
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.15, 0.08, 8, 32),
    new THREE.MeshStandardMaterial({ color: GEM_COLOR[team], emissive: GEM_COLOR[team], emissiveIntensity: 0.8 }),
  )
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.92
  group.add(pedestal, ring)

  const floating = new THREE.Group()
  floating.position.y = FLOAT_HEIGHT
  fillWithGem(floating, team, STAND_GEM_HEIGHT)
  const halo = glow(team, 4)
  halo.position.y = FLOAT_HEIGHT + STAND_GEM_HEIGHT / 2
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.7, BEAM_HEIGHT, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: GEM_COLOR[team], transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  )
  beam.position.y = BEAM_HEIGHT / 2 + 1
  beam.raycast = noRaycast
  group.add(floating, halo, beam)

  return {
    group,
    collider: new THREE.Box3(new THREE.Vector3(-1.2, 0, -1.2), new THREE.Vector3(1.2, 0.95, 1.2)),
    setTaken(taken) {
      floating.visible = !taken
      halo.visible = !taken
      beam.visible = !taken
    },
    update(time) {
      if (!floating.visible) return
      floating.rotation.y = time * 0.6
      floating.position.y = FLOAT_HEIGHT + Math.sin(time * 1.6) * 0.12
      halo.material.opacity = 0.75 + Math.sin(time * 2.2) * 0.2
    },
  }
}

/** Small spinning gem carried above a player's head. */
export function createCarriedGem(team: Team): THREE.Object3D {
  const group = new THREE.Group()
  fillWithGem(group, team, CARRIED_GEM_HEIGHT)
  const halo = glow(team, 1.3)
  halo.position.y = CARRIED_GEM_HEIGHT / 2
  group.add(halo)
  return group
}
