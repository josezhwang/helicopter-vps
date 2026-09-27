import * as THREE from 'three'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { SunLight } from 'three/addons/lights/SunLight.js'
import type { QualityProfile } from './graphics'

/**
 * Sky, sun and air. The sky is a real photographed sky (Poly Haven's "Sunflowers (Pure Sky)", CC0) on a dome
 * around the camera, its HDR version lights and reflects in everything, and the sun is lined up with the sun in
 * the photo. The air thickens towards the ground (height fog) and glows warmer looking towards the sun.
 */

/** Direction from the ground towards the sun (43° up, like the sun in the photo). */
export const SUN_OFFSET = new THREE.Vector3(-260, 286, 160)
export const SUN_DIRECTION = SUN_OFFSET.clone().normalize()
/** Beyond this the air is solid sky colour, so nothing further needs drawing. */
export const FOG_FAR = 1500
/** Half-size of the shadow box around the player on the lower settings. */
export const SHADOW_RANGE = 160
/** Where the sun is in the sky photo (0..1 across). */
const SKY_SUN_U = 0.6003
/** The photo at the horizon (sRGB): distant land fades into it. */
const HORIZON_SRGB = new THREE.Color().setRGB(165 / 255, 172 / 255, 166 / 255, THREE.SRGBColorSpace)
export const SUN_COLOR = 0xfff0d6
export const SUN_INTENSITY = 2.6
/** Height fog: how thick the air is at the water line, and how fast it thins with height (per metre). */
const FOG_DENSITY = 0.00125
const FOG_FALLOFF = 0.016
const FOG_BASE = -6

/** Inverse of three's ACES filmic curve (sRGB-linear in → scene-linear out), so a photo shows as photographed after tone mapping. */
const INVERSE_ACES_GLSL = /* glsl */ `
vec3 inverseRRTAndODTFit(vec3 c) {
  vec3 A = 1.0 - 0.983729 * c;
  vec3 B = 0.0245786 - 0.4329510 * c;
  vec3 C = -(0.000090537 + 0.238081 * c);
  return (-B + sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
}
vec3 inverseACESFilmic(vec3 color, float exposure) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  vec3 c = inverse(ACESOutputMat) * clamp(color, 0.0, 0.985);
  vec3 v = inverseRRTAndODTFit(max(c, 0.0));
  return max(inverse(ACESInputMat) * v, 0.0) * 0.6 / exposure;
}`

/** The same inverse on the CPU, for colours set from JavaScript (the fog). */
function inverseACES(color: THREE.Color, exposure = 1): THREE.Color {
  const input = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777)
  const output = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602)
  const c = new THREE.Vector3(color.r, color.g, color.b).clampScalar(0, 0.985).applyMatrix3(output.clone().invert())
  const fit = (x: number) => {
    x = Math.max(0, x)
    const A = 1 - 0.983729 * x, B = 0.0245786 - 0.432951 * x, C = -(0.000090537 + 0.238081 * x)
    return (-B + Math.sqrt(Math.max(B * B - 4 * A * C, 0))) / (2 * A)
  }
  const v = new THREE.Vector3(fit(c.x), fit(c.y), fit(c.z)).applyMatrix3(input.clone().invert()).multiplyScalar(0.6 / exposure)
  return new THREE.Color(Math.max(0, v.x), Math.max(0, v.y), Math.max(0, v.z))
}

let fogInstalled = false
/**
 * Replace three's fog with exponential height fog: thick in the valleys, thin up where the helicopters fly, a
 * warm glow in the direction of the sun, and always solid sky colour at the far plane so nothing pops.
 */
function installHeightFog() {
  if (fogInstalled) return
  fogInstalled = true
  const f = (n: number) => n.toFixed(6)
  THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPosition;
#endif`
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPosition = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif`
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPosition;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  #ifdef FOG_EXP2
  {
    vec3 fogRay = vFogWorldPosition - cameraPosition;
    float fogDist = length( fogRay );
    vec3 fogDir = fogRay / max( fogDist, 1e-4 );
    float fogB = ${f(FOG_FALLOFF)};
    float fogAmount = fogDensity * exp( - ( cameraPosition.y - (${f(FOG_BASE)}) ) * fogB ) * fogDist;
    float fogK = fogDist * fogDir.y * fogB;
    if ( abs( fogK ) > 1e-4 ) fogAmount *= ( 1.0 - exp( - fogK ) ) / fogK;
    float fogFactor = 1.0 - exp( - fogAmount );
    fogFactor = max( fogFactor, smoothstep( ${f(FOG_FAR * 0.5)}, ${f(FOG_FAR * 0.97)}, fogDist ) );
    float fogSun = pow( max( dot( fogDir, vec3( ${f(SUN_DIRECTION.x)}, ${f(SUN_DIRECTION.y)}, ${f(SUN_DIRECTION.z)} ) ), 0.0 ), 6.0 );
    vec3 fogTint = fogColor * mix( vec3( 1.0 ), vec3( 1.5, 1.34, 1.12 ), fogSun );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, clamp( fogFactor, 0.0, 1.0 ) );
  }
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif`
}

export interface SkyRig {
  sun: THREE.Light
  /** The ground-hugging air colour (scene-linear), for things that fade out by themselves. */
  horizon: THREE.Color
  /** Box shadows follow the player (cascades follow the view by themselves). */
  follow: (camera: THREE.Vector3) => void
  setProfile: (profile: QualityProfile) => void
  update: (camera: THREE.Camera) => void
  dispose: () => void
}

const textureLoader = new THREE.TextureLoader()

export function createSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer, profile: QualityProfile): SkyRig {
  installHeightFog()
  const horizon = inverseACES(HORIZON_SRGB.clone())
  scene.background = horizon.clone()
  scene.fog = new THREE.FogExp2(horizon.getHex(THREE.LinearSRGBColorSpace), FOG_DENSITY)
  scene.fog.color.copy(horizon)

  // Turn the photo so its sun sits in our sun's direction
  const sunAzimuth = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x)
  const turn = sunAzimuth - (SKY_SUN_U - 0.5) * Math.PI * 2
  const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(turn))
  // Environment lookups rotate by the inverse of environmentRotation, so this lines the lighting up with the dome
  scene.environmentRotation.set(0, -turn, 0)

  // The sky dome: drawn first, at the far plane, never writing depth (post effects see it as open sky)
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 32),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, rotation: { value: rotation }, exposure: { value: 1 }, fallback: { value: horizon.clone() } },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = position;
          vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = clip.xyww;
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        uniform sampler2D map;
        uniform mat3 rotation;
        uniform float exposure;
        uniform vec3 fallback;
        varying vec3 vDirection;
        ${INVERSE_ACES_GLSL}
        void main() {
          vec3 d = rotation * normalize(vDirection);
          vec2 uv = vec2(atan(d.z, d.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
          #ifdef HAS_MAP
            vec3 photo = texture2D(map, uv).rgb;
            gl_FragColor = vec4(inverseACESFilmic(photo, exposure), 1.0);
          #else
            gl_FragColor = vec4(fallback, 1.0);
          #endif
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  )
  dome.name = 'sky'
  dome.renderOrder = -1000
  dome.frustumCulled = false
  dome.raycast = () => {}
  scene.add(dome)
  const domeMaterial = dome.material as THREE.ShaderMaterial

  const skyUrl = profile.sky8k ? '/textures/sky_8k.jpg' : '/textures/sky_4k.jpg'
  textureLoader.load(skyUrl, (sky) => {
    sky.colorSpace = THREE.SRGBColorSpace
    sky.anisotropy = 4
    sky.generateMipmaps = true
    domeMaterial.uniforms.map.value = sky
    domeMaterial.defines = { HAS_MAP: '' }
    domeMaterial.needsUpdate = true
  })
  new HDRLoader().load('/textures/sky_2k.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromEquirectangular(hdr).texture
    scene.environmentIntensity = 0.62
    hdr.dispose()
    pmrem.dispose()
  })

  const hemi = new THREE.HemisphereLight(0xc4dcff, 0x4d5a36, 0.45)
  scene.add(hemi)

  let sun: THREE.DirectionalLight | SunLight
  let mode: QualityProfile['sun'] | null = null
  const makeSun = (p: QualityProfile) => {
    if (mode === p.sun && sun) {
      sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize)
      sun.shadow.map?.dispose()
      sun.shadow.map = null
      if (sun instanceof SunLight) sun.shadow.camera.far = p.shadowDistance
      return
    }
    if (sun) {
      scene.remove(sun)
      if (sun instanceof THREE.DirectionalLight) scene.remove(sun.target)
      sun.dispose()
    }
    mode = p.sun
    if (p.sun === 'cascades') {
      // Two cascades fitted to the view: crisp near the player, still there on the far hills
      const light = new SunLight(SUN_COLOR, SUN_INTENSITY)
      light.position.copy(SUN_DIRECTION)
      light.castShadow = true
      light.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize)
      light.shadow.camera.near = 0.5
      light.shadow.camera.far = p.shadowDistance
      light.shadow.bias = -0.00025
      light.shadow.normalBias = 0.035
      light.shadow.radius = 2.5
      sun = light
    } else {
      // One shadow map in a box that follows the player
      const light = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY)
      light.position.copy(SUN_OFFSET)
      light.castShadow = true
      light.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize)
      light.shadow.camera.near = 50
      light.shadow.camera.far = 900
      light.shadow.camera.left = -SHADOW_RANGE
      light.shadow.camera.right = SHADOW_RANGE
      light.shadow.camera.top = SHADOW_RANGE
      light.shadow.camera.bottom = -SHADOW_RANGE
      light.shadow.bias = -0.0005
      light.shadow.normalBias = 0.02
      light.shadow.radius = 1.5
      scene.add(light.target)
      sun = light
    }
    scene.add(sun)
  }
  makeSun(profile)

  return {
    get sun() { return sun },
    horizon,
    follow(camera) {
      if (!(sun instanceof THREE.DirectionalLight)) return
      // Snapped to whole shadow texels so edges don't shimmer as the player moves
      const texel = (SHADOW_RANGE * 2) / sun.shadow.mapSize.x
      const x = Math.round(camera.x / texel) * texel
      const z = Math.round(camera.z / texel) * texel
      sun.target.position.set(x, 0, z)
      sun.position.set(x + SUN_OFFSET.x, SUN_OFFSET.y, z + SUN_OFFSET.z)
      sun.target.updateMatrixWorld()
    },
    setProfile: makeSun,
    update(camera) {
      dome.position.copy(camera.position)
      dome.scale.setScalar(10)
      dome.updateMatrixWorld()
    },
    dispose() {
      dome.geometry.dispose()
      domeMaterial.uniforms.map.value?.dispose()
      domeMaterial.dispose()
      scene.environment?.dispose()
    },
  }
}
