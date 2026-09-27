import * as THREE from 'three'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { loadModel, toStandardMaterial } from './assets'
import type { Team } from './layout'

/**
 * The combat mech ("Medium Mech Striker" by MSGDI, CC-BY 4.0): a 7.7 m walker with an autocannon on its left
 * arm and rocket pods on its shoulders. Each mech is its own animated model: it powers up when someone climbs
 * in, walks, runs, turns on the spot, flies on its jump-jets and lands, and falls when it is destroyed. The
 * torso twists towards where the pilot aims and the gun arm follows the aim up and down.
 */
const MECH_URL = '/models/mech.glb'
/** Where the gun's muzzle and the rocket pods' fronts are on the model (metres, bind pose). */
const GUN_TIP = new THREE.Vector3(2.22, 4.83, 1.66)
const POD_TIPS = [new THREE.Vector3(0.81, 5.85, 1.26), new THREE.Vector3(-0.81, 5.85, 1.26)]
/** Ground speeds (m/s) at which the walk and run cycles look right. */
const WALK_CYCLE_SPEED = 4.2
const RUN_CYCLE_SPEED = 8.5
const FADE = 0.3

type Clip = 'Idle' | 'Walk' | 'WalkBack' | 'Run' | 'Turn' | 'JetFly' | 'Fall' | 'Land' | 'Startup' | 'ShutdownPose' | 'Death' | 'DeathPose' | 'HitFront'

export interface MechMotion {
  /** Along its facing, m/s (negative: backing up). */
  speed: number
  /** Turning rate, rad/s. */
  turn: number
  /** Off the ground: rising on the jets or falling. */
  airborne: boolean
  rising: boolean
  /** Torso twist and gun elevation relative to the legs (radians). */
  aimYaw: number
  aimPitch: number
  occupied: boolean
  destroyed: boolean
}

export interface MechRig {
  /** Holds the animated model: give it the vehicle's pose. */
  object: THREE.Group
  update: (dt: number, motion: MechMotion, detailed: boolean) => void
  /** A hit landed: flinch. */
  flinch: () => void
  /** World position of the gun's muzzle, and the way it points. */
  gun: (muzzle: THREE.Vector3, dir: THREE.Vector3) => void
  /** World position of rocket pod `i` (0 left, 1 right). */
  pod: (i: number, out: THREE.Vector3) => THREE.Vector3
  /** The cockpit (for the pilot's view), world space. */
  cockpit: (out: THREE.Vector3) => THREE.Vector3
  dispose: () => void
}

interface MechAsset {
  scene: THREE.Object3D
  clips: Map<string, THREE.AnimationClip>
}
let asset: Promise<MechAsset> | null = null
const loadMech = () => (asset ??= loadModel(MECH_URL).then((gltf) => ({ scene: gltf.scene, clips: new Map(gltf.animations.map((clip) => [clip.name, clip])) })))

/** The red team's mechs: the blue armour repainted red (only strongly blue texels change). */
function redPaint(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
{
  float blue = diffuseColor.b - max(diffuseColor.r, diffuseColor.g);
  float k = smoothstep(0.04, 0.16, blue);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(diffuseColor.b * 1.05, diffuseColor.g * 0.55, diffuseColor.r * 0.6), k);
}`)
  }
  material.customProgramCacheKey = () => 'aerium-mech-red'
}

export function createMechRig(team: Team): MechRig {
  const object = new THREE.Group()
  object.name = `mech-${team}`
  let mixer: THREE.AnimationMixer | null = null
  const actions = new Map<Clip, THREE.AnimationAction>()
  let model: THREE.Object3D | null = null
  let torso: THREE.Bone | null = null
  let gunArm: THREE.Bone | null = null
  let forearm: THREE.Bone | null = null
  const gunTip = new THREE.Vector3(), gunBack = new THREE.Vector3()
  const podTips: THREE.Vector3[] = []
  const cockpitLocal = new THREE.Vector3(0, 6.5, 1.7)
  const materials: THREE.MeshStandardMaterial[] = []
  const meshes: THREE.SkinnedMesh[] = []
  let current: Clip | null = null
  let oneShot: { clip: Clip; until: number } | null = null
  let wasOccupied = false
  let wasAirborne = false
  let wasDestroyed = false
  let disposed = false

  void loadMech().then(({ scene, clips }) => {
    if (disposed) return
    model = SkeletonUtils.clone(scene)
    model.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh
      if ((node as THREE.Bone).isBone) {
        if (node.name.startsWith('UpperTorso')) torso = node as THREE.Bone
        if (node.name.startsWith('UpperArm_L')) gunArm = node as THREE.Bone
        if (node.name.startsWith('LowerArm_L')) forearm = node as THREE.Bone
      }
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.raycast = () => {}
      const material = toStandardMaterial(mesh.material as THREE.Material).clone()
      if (team === 'red') redPaint(material)
      mesh.material = material
      materials.push(material)
      meshes.push(mesh)
    })
    object.add(model)
    // Tips measured on the model in its bind pose, kept relative to the bones that carry them (in the model's
    // own space: the mech may already be standing somewhere in the world when the model arrives)
    model.updateMatrixWorld(true)
    const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert()
    const boneInModel = (bone: THREE.Object3D) => new THREE.Matrix4().multiplyMatrices(toModel, bone.matrixWorld).invert()
    if (forearm) {
      const inverse = boneInModel(forearm)
      gunTip.copy(GUN_TIP).applyMatrix4(inverse)
      gunBack.copy(GUN_TIP).add(new THREE.Vector3(0, 0, -1)).applyMatrix4(inverse)
    }
    if (torso) {
      const inverse = boneInModel(torso)
      for (const tip of POD_TIPS) podTips.push(tip.clone().applyMatrix4(inverse))
      cockpitLocal.applyMatrix4(inverse)
    }
    mixer = new THREE.AnimationMixer(model)
    for (const name of ['Idle', 'Walk', 'WalkBack', 'Run', 'Turn', 'JetFly', 'Fall', 'Land', 'Startup', 'ShutdownPose', 'Death', 'DeathPose', 'HitFront'] as Clip[]) {
      const clip = clips.get(name)
      if (!clip) continue
      const action = mixer.clipAction(clip)
      if (['Land', 'Startup', 'Death', 'HitFront'].includes(name)) {
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
      }
      actions.set(name, action)
    }
    play('ShutdownPose', 0)
  }).catch((error) => console.error('[mechs] mech model failed to load:', error))

  function play(clip: Clip, fade = FADE) {
    if (current === clip) return
    const next = actions.get(clip)
    if (!next) return
    next.reset().setEffectiveWeight(1).play()
    const previous = current ? actions.get(current) : null
    if (previous && fade > 0) previous.crossFadeTo(next, fade, false)
    else if (previous) previous.stop()
    current = clip
  }

  const axis = new THREE.Vector3(), q = new THREE.Quaternion(), pq = new THREE.Quaternion(), oq = new THREE.Quaternion()
  /** Turn a bone about one of the mech's own axes (in its parent's frame, after the animation posed it). */
  function turnBone(bone: THREE.Bone, localAxis: THREE.Vector3, angle: number) {
    if (!bone.parent || Math.abs(angle) < 1e-4) return
    object.getWorldQuaternion(oq)
    bone.parent.getWorldQuaternion(pq)
    axis.copy(localAxis).applyQuaternion(oq).applyQuaternion(pq.invert()).normalize()
    bone.quaternion.premultiply(q.setFromAxisAngle(axis, angle))
  }

  let lastTwist = 0, lastPitch = 0
  return {
    object,
    update(dt, m, detailed) {
      if (!mixer) return
      for (const mesh of meshes) mesh.castShadow = detailed
      const now = performance.now()
      // Powered down / starting up / wrecked
      if (m.destroyed) {
        if (!wasDestroyed) { oneShot = { clip: 'Death', until: now + 1300 }; play('Death', 0.15) }
        wasDestroyed = true
        if (oneShot && now > oneShot.until) { oneShot = null; play('DeathPose', 0) }
        for (const material of materials) material.color.setScalar(0.22)
      } else {
        if (wasDestroyed) for (const material of materials) material.color.setScalar(1)
        wasDestroyed = false
        if (m.occupied && !wasOccupied) oneShot = { clip: 'Startup', until: now + 1250 }
        if (m.airborne !== wasAirborne && !m.airborne) oneShot = { clip: 'Land', until: now + 600 }
        if (oneShot && now > oneShot.until) oneShot = null
        let clip: Clip
        if (!m.occupied) clip = 'ShutdownPose'
        else if (oneShot) clip = oneShot.clip
        else if (m.airborne) clip = m.rising ? 'JetFly' : 'Fall'
        else if (m.speed > RUN_CYCLE_SPEED * 0.7) clip = 'Run'
        else if (m.speed > 0.4) clip = 'Walk'
        else if (m.speed < -0.4) clip = 'WalkBack'
        else if (Math.abs(m.turn) > 0.25) clip = 'Turn'
        else clip = 'Idle'
        play(clip)
        const action = actions.get(clip)
        if (action) {
          if (clip === 'Walk' || clip === 'WalkBack') action.timeScale = THREE.MathUtils.clamp(Math.abs(m.speed) / WALK_CYCLE_SPEED, 0.5, 1.6)
          else if (clip === 'Run') action.timeScale = THREE.MathUtils.clamp(m.speed / RUN_CYCLE_SPEED, 0.7, 1.4)
          else action.timeScale = 1
        }
      }
      wasOccupied = m.occupied
      wasAirborne = m.airborne
      mixer.update(dt)
      // Torso twist and gun elevation on top of whatever the legs are doing
      const alive = !m.destroyed && m.occupied
      lastTwist = THREE.MathUtils.lerp(lastTwist, alive ? m.aimYaw : 0, 1 - Math.exp(-dt * 10))
      lastPitch = THREE.MathUtils.lerp(lastPitch, alive ? m.aimPitch : 0, 1 - Math.exp(-dt * 10))
      object.updateMatrixWorld(true)
      if (torso) turnBone(torso, new THREE.Vector3(0, 1, 0), lastTwist)
      if (gunArm) {
        object.updateMatrixWorld(true)
        // About the twisted torso's own side axis
        turnBone(gunArm, new THREE.Vector3(Math.cos(lastTwist), 0, -Math.sin(lastTwist)), -lastPitch)
      }
      object.updateMatrixWorld(true)
    },
    flinch() {
      if (!oneShot && actions.has('HitFront')) oneShot = { clip: 'HitFront', until: performance.now() + 380 }
    },
    gun(muzzle, dir) {
      object.updateMatrixWorld(true)
      if (!forearm) {
        muzzle.copy(GUN_TIP).applyMatrix4(object.matrixWorld)
        dir.set(0, 0, 1).transformDirection(object.matrixWorld)
        return
      }
      const bone = forearm as THREE.Bone
      muzzle.copy(gunTip).applyMatrix4(bone.matrixWorld)
      dir.copy(gunBack).applyMatrix4(bone.matrixWorld)
      dir.subVectors(muzzle, dir).normalize()
    },
    pod(i, out) {
      object.updateMatrixWorld(true)
      if (!torso || !podTips[i]) return out.copy(POD_TIPS[i] ?? POD_TIPS[0]).applyMatrix4(object.matrixWorld)
      return out.copy(podTips[i]).applyMatrix4((torso as THREE.Bone).matrixWorld)
    },
    cockpit(out) {
      object.updateMatrixWorld(true)
      if (!torso) return out.set(0, 6.5, 1.7).applyMatrix4(object.matrixWorld)
      return out.copy(cockpitLocal).applyMatrix4((torso as THREE.Bone).matrixWorld)
    },
    dispose() {
      disposed = true
      mixer?.stopAllAction()
      for (const material of materials) material.dispose()
    },
  }
}
