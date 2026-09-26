import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'

/**
 * Environment models live in /public/models. They were pre-processed from environment_material/
 * (simplified meshes, 512px WebP textures), so they are small; each is fetched and parsed once.
 */
const loader = new GLTFLoader()
const cache = new Map<string, Promise<GLTF>>()

export function loadModel(url: string): Promise<GLTF> {
  let model = cache.get(url)
  if (!model) cache.set(url, (model = loader.loadAsync(url)))
  return model
}

/**
 * Sketchfab exports often use MeshPhysicalMaterial (specular / IOR / transmission extensions).
 * Physical shading costs more per pixel, and any transmissive material makes three.js render the
 * whole scene a second time, so props use the plain standard material with the same textures.
 */
export function toStandardMaterial(material: THREE.Material): THREE.MeshStandardMaterial {
  if (!(material instanceof THREE.MeshStandardMaterial)) return new THREE.MeshStandardMaterial({ color: 0x888888 })
  if (!(material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return material
  return THREE.MeshStandardMaterial.prototype.copy.call(new THREE.MeshStandardMaterial(), material) as THREE.MeshStandardMaterial
}

/** The first mesh of a single-mesh prop, with its transform baked into the geometry (root space). */
export function firstMeshGeometry(root: THREE.Object3D): { geometry: THREE.BufferGeometry; material: THREE.Material } | null {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  let found: THREE.Mesh | null = null
  root.traverse((node) => {
    if (!found && (node as THREE.Mesh).isMesh) found = node as THREE.Mesh
  })
  if (!found) return null
  const mesh = found as THREE.Mesh
  const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld))
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  return { geometry, material }
}
