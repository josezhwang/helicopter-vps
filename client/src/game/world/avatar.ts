import * as THREE from 'three'
import type { Team } from './bases'

export const TEAM_COLOR: Record<Team, number> = { blue: 0x2e6fbd, red: 0xb03a2e }

export interface Avatar {
  group: THREE.Group
  carriedFlag: THREE.Object3D
  dispose: () => void
}

function nameLabel(text: string, team: Team): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = team === 'blue' ? 'rgba(20, 60, 120, 0.82)' : 'rgba(130, 30, 24, 0.82)'
  ctx.beginPath()
  ctx.roundRect(8, 8, 496, 80, 18)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 44px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text.length > 18 ? `${text.slice(0, 17)}…` : text, 256, 50)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }))
  sprite.scale.set(3.2, 0.6, 1)
  return sprite
}

/** Remote soldier; origin at the feet, facing -Z like the camera so rotation.y = yaw. */
export function createAvatar(name: string, team: Team): Avatar {
  const group = new THREE.Group()
  const teamMat = new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], roughness: 0.7 })
  const gearMat = new THREE.MeshStandardMaterial({ color: 0x2f3a2c, roughness: 0.9 })
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a77e, roughness: 0.8 })

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 4, 12), teamMat)
  body.position.y = 1.0
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), skinMat)
  head.position.y = 1.78
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), gearMat)
  helmet.position.y = 1.82
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.8), gearMat)
  gun.position.set(0.32, 1.25, -0.45)
  for (const mesh of [body, head, helmet, gun]) {
    mesh.castShadow = true
    group.add(mesh)
  }

  const carriedFlag = new THREE.Group()
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 6), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.8 }))
  pole.position.y = 0.9
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.55),
    new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team === 'blue' ? 'red' : 'blue'], side: THREE.DoubleSide }),
  )
  cloth.position.set(0.45, 1.5, 0)
  carriedFlag.add(pole, cloth)
  carriedFlag.position.set(-0.2, 1.1, 0.35)
  carriedFlag.visible = false
  group.add(carriedFlag)

  const label = nameLabel(name, team)
  label.position.y = 2.55
  // Bullets pass through name tags (sprite raycasts also need a camera on the raycaster)
  label.raycast = () => {}
  group.add(label)

  return {
    group,
    carriedFlag,
    dispose: () => group.traverse((node) => {
      const mesh = node as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material & { map?: THREE.Texture }
      material?.map?.dispose()
      material?.dispose()
    }),
  }
}
