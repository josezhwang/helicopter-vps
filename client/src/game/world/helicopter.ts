import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { heightAt } from './terrain'

/** Seat offset where the player camera sits while piloting. */
export const HELI_SEAT_OFFSET = new THREE.Vector3(0.0, 1.6, 0.4)

/** Hard RPM ceiling — Space can never spool the propeller past this. */
export const MAX_ROTOR_RPM = 100

export interface Helicopter {
  object: THREE.Group
  update: (dt: number, time: number) => void
  /** Space = spool up, Shift = spool down (viewer-style RPM control). */
  updateRotorInput: (spoolUp: boolean, spoolDown: boolean, dt: number) => void
  setParked: (parked: boolean) => void
  setDoorOpen: (open: boolean) => void
  parked: boolean
  /** 0..MAX_ROTOR_RPM, matches the classic RPM HUD readout (x10 => up to 1000). */
  getRotorSpeed: () => number
}

/**
 * Loads the animated helicopter GLB and drives its rotors manually exactly
 * like the standalone viewer: Space ramps target RPM (clamped at
 * MAX_ROTOR_RPM), Shift ramps it down, the main rotor spins on its local Z
 * and the rear rotor on its local X (correct for this model's bakes).
 *
 * Node names in this GLB: "main_rotor__0" and "rear_rotor_1" (rear, NOT tail —
 * which is why name searches for "tail rotor" used to fail).
 */
export function createHelicopter(padWorldPos: THREE.Vector3, onLoaded?: (h: Helicopter) => void): Helicopter {
  const object = new THREE.Group()
  object.position.copy(padWorldPos)

  const bodyLight = new THREE.PointLight(0xffd7a0, 9, 30)
  bodyLight.position.set(2.5, 4.5, 1.5)
  object.add(bodyLight)

  // --- Viewer-style rotor state ---
  const state = {
    rotorSpeed: 0,
    targetRotorSpeed: 0,
    maxRotorSpeed: MAX_ROTOR_RPM,
    parked: true,
  }

  // Rotor nodes found by name in the GLB
  let mainRotor: THREE.Object3D | null = null
  let tailRotor: THREE.Object3D | null = null

  // Synthesized rotors, only if the model ever ships without named ones
  let fallbackMainRotor: THREE.Object3D | null = null
  let fallbackTailRotor: THREE.Object3D | null = null
  const doorNodes: THREE.Object3D[] = []
  const doorBaseRotations = new Map<THREE.Object3D, number>()
  let doorProgress = 0
  let doorTarget = 0

  const addFallbackModel = () => {
    if (object.children.length > 0) return

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3c5664, roughness: 0.7, metalness: 0.2 })
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x8dc4d6, roughness: 0.2, metalness: 0.1 })
    const rotorMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.4 })

    const body = new THREE.Mesh(new THREE.SphereGeometry(2.1, 16, 10), bodyMat)
    body.scale.set(1, 0.75, 1.8)
    body.position.y = 2.2
    body.castShadow = true
    object.add(body)

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(1.35, 16, 8), glassMat)
    cockpit.scale.set(1, 0.75, 0.9)
    cockpit.position.set(0, 2.35, 1.45)
    cockpit.castShadow = true
    object.add(cockpit)

    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 5.5), bodyMat)
    tail.position.set(0, 2.45, -3.4)
    tail.castShadow = true
    object.add(tail)

    const rotorGroup = new THREE.Group()
    rotorGroup.position.y = 4.15
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(8, 0.08, 0.35), rotorMat)
      blade.rotation.y = (i / 4) * Math.PI
      rotorGroup.add(blade)
    }
    rotorGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.45, 8), rotorMat))
    object.add(rotorGroup)
    fallbackMainRotor = rotorGroup

    const rearRotorGroup = new THREE.Group()
    rearRotorGroup.position.set(0, 2.6, -6.05)
    for (let i = 0; i < 2; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.1, 0.25), rotorMat)
      blade.rotation.z = (i / 2) * Math.PI
      rearRotorGroup.add(blade)
    }
    object.add(rearRotorGroup)
    fallbackTailRotor = rearRotorGroup
  }

  const heli: Helicopter = {
    object,
    parked: true,
    getRotorSpeed: () => state.rotorSpeed,

    updateRotorInput(spoolUp: boolean, spoolDown: boolean, dt: number) {
      if (spoolUp) state.targetRotorSpeed += 25 * dt
      if (spoolDown) state.targetRotorSpeed -= 35 * dt
      // Hard boundary: Space alone can never exceed MAX_ROTOR_RPM
      state.targetRotorSpeed = THREE.MathUtils.clamp(
        state.targetRotorSpeed,
        0,
        state.maxRotorSpeed,
      )
    },

    setParked(p: boolean) {
      state.parked = p
      heli.parked = p
      // Engines cut when parked: propeller winds down to a stop
      if (p) {
        state.targetRotorSpeed = 0
      }
    },

    setDoorOpen(open: boolean) {
      doorTarget = open ? 1 : 0
    },

    update(dt: number, time: number) {
      // Smooth rotor acceleration toward target — runs ALWAYS so the
      // propeller winds down after dismount, not just while piloted.
      // (Same lerp factor as the viewer: 4 * delta)
      state.rotorSpeed = THREE.MathUtils.lerp(
        state.rotorSpeed,
        state.targetRotorSpeed,
        4 * dt,
      )
      // Belt-and-braces: RPM itself is also bounded
      state.rotorSpeed = THREE.MathUtils.clamp(state.rotorSpeed, 0, state.maxRotorSpeed)

      // Main rotor spins about its LOCAL Z, rear rotor about its LOCAL X —
      // exactly the viewer's formulas (correct for this model's bakes).
      const spin = state.rotorSpeed
      if (mainRotor) mainRotor.rotation.z += spin * dt
      if (tailRotor) tailRotor.rotation.x += spin * 1.5 * dt
      if (fallbackMainRotor) fallbackMainRotor.rotation.y += (spin / 100) * 40 * dt
      if (fallbackTailRotor) fallbackTailRotor.rotation.x += (spin / 100) * 56 * dt

      doorProgress = THREE.MathUtils.lerp(doorProgress, doorTarget, Math.min(1, dt * 2.5))
      for (const door of doorNodes) {
        const baseY = doorBaseRotations.get(door) ?? door.rotation.y
        door.rotation.y = baseY - doorProgress * 1.1
      }

      if (state.parked) {
        object.position.y = padWorldPos.y + Math.sin(time * 1.2) * 0.05
      }
      // While piloted, the flight controller owns position.y entirely
    },
  }

  const loader = new GLTFLoader()
  loader.load(
    '/animated_helicopter.glb',
    (gltf) => {
      const model = gltf.scene
      model.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true
          child.receiveShadow = true
        }
      })

      // Normalize size: longest dimension ~ 16 units
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const scale = 16 / maxDim
      model.scale.setScalar(scale)
      model.position.y -= box.min.y * scale // sit on ground

      object.add(model)

      // Find rotors by name: main_rotor__0 / rear_rotor_1 (also accept tail_*)
      model.traverse((node) => {
        const name = node.name.toLowerCase()
        if (name.includes('rotor') || name.includes('propeller')) {
          if (name.includes('main')) mainRotor = node
          else if (name.includes('rear') || name.includes('tail')) tailRotor = node
        }
        // Animate only the side entry door; the other GLB door panels stay closed.
        if (name.startsWith('doors.003')) {
          doorNodes.push(node)
          doorBaseRotations.set(node, node.rotation.y)
        }
      })

      if (!mainRotor || !tailRotor) {
        console.warn(
          '[helicopter] rotor nodes missing — main:',
          mainRotor?.name ?? null,
          'rear/tail:',
          tailRotor?.name ?? null,
        )
      }

      // Fallback: synthesized blades if the model ever loses its named nodes
      if (!mainRotor) {
        const rotorGroup = new THREE.Group()
        const bladeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.4 })
        for (let i = 0; i < 4; i++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(9, 0.08, 0.7), bladeMat)
          blade.rotation.y = (i / 4) * Math.PI
          rotorGroup.add(blade)
        }
        rotorGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.5, 8), bladeMat))
        const bbox = new THREE.Box3().setFromObject(model)
        rotorGroup.position.y = bbox.max.y - object.position.y + 0.05
        object.add(rotorGroup)
        fallbackMainRotor = rotorGroup
      }
      if (!tailRotor) {
        const tailGroup = new THREE.Group()
        const bladeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.4 })
        for (let i = 0; i < 2; i++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.4, 0.3), bladeMat)
          blade.rotation.x = (i / 2) * Math.PI
          tailGroup.add(blade)
        }
        const tailBbox = new THREE.Box3().setFromObject(model)
        tailGroup.position.set(tailBbox.max.x - 0.4, tailBbox.max.y - 1.2, 0)
        object.add(tailGroup)
        fallbackTailRotor = tailGroup
      }

      console.log(
        '[helicopter] loaded — main rotor:',
        mainRotor ? (mainRotor as THREE.Object3D).name : 'fallback',
        '| rear rotor:',
        tailRotor ? (tailRotor as THREE.Object3D).name : 'fallback',
      )
      onLoaded?.(heli)
    },
    undefined,
    (err) => {
      console.error('Failed to load helicopter GLB:', err)
      addFallbackModel()
      onLoaded?.(heli)
    },
  )

  return heli
}

/** Ground-follow helper used by the flight controller. */
export function heliGroundClearance(x: number, z: number, alt: number): number {
  return alt - heightAt(x, z)
}
