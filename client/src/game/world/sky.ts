import * as THREE from 'three'
import { SunLight } from 'three/addons/lights/SunLight.js'
import type { QualityProfile } from './graphics'

/**
 * Sky, sun and air of an alien world, all painted by one shader (nothing to download, cheap on any GPU): a teal
 * sky over a warm hazy horizon, a huge ringed gas giant and two moons, faint stars even by day — and as you climb
 * out of the atmosphere the sky turns to space, with the stars and a nebula coming out. The same sky, rendered once
 * into an environment map, lights and reflects in everything. The air thickens towards the ground (height fog).
 */

/** Direction from the ground towards the sun (43° up). */
export const SUN_OFFSET = new THREE.Vector3(-260, 286, 160)
export const SUN_DIRECTION = SUN_OFFSET.clone().normalize()
/** Beyond this the air is solid sky colour, so nothing further needs drawing. */
export const FOG_FAR = 1500
/** Half-size of the shadow box around the player on the lower settings. */
export const SHADOW_RANGE = 160
/** The haze at the horizon, as it should look on screen (sRGB): distant land fades into it. */
const HORIZON_SRGB = new THREE.Color().setRGB(0.74, 0.73, 0.66, THREE.SRGBColorSpace)
/** Space starts here: above ORBIT_START the sky darkens, above ORBIT_FULL it is black and full of stars. */
export const ORBIT_START = 300
export const ORBIT_FULL = 620
/** A deck of cloud this high: seen from above it hides the ground (and the edge of the world) as you climb to space. */
export const CLOUD_DECK = 260
/** Where the gas giant hangs: well round from the sun, so it shows a big lit face with a shadowed edge. */
const PLANET_DIRECTION = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 27), THREE.MathUtils.degToRad(64))
/** Its angular radius (radians). */
const PLANET_RADIUS = 0.2
/** Its pole: the rings are seen from 24° above their plane, leaning over to one side. */
const PLANET_AXIS = (() => {
  const c = PLANET_DIRECTION
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(c, -c.y).normalize().applyAxisAngle(c, 0.42)
  return c.clone().multiplyScalar(Math.sin(0.42)).addScaledVector(up, Math.cos(0.42)).normalize()
})()
const MOONS = [
  { direction: new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(40)), radius: 0.032, color: [0.78, 0.7, 0.62] },
  { direction: new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 57), THREE.MathUtils.degToRad(-95)), radius: 0.018, color: [0.62, 0.7, 0.74] },
]
export const SUN_COLOR = 0xfff0d6
export const SUN_INTENSITY = 2.6
/** Height fog: how thick the air is at the water line, and how fast it thins with height (per metre). */
const FOG_DENSITY = 0.00125
const FOG_FALLOFF = 0.016
const FOG_BASE = -6

/** Inverse of three's ACES filmic curve (sRGB-linear in → scene-linear out), so painted colours show as painted after tone mapping. */
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
  /** 0 on the ground … 1 out in space (from the camera's height). */
  space: number
  dispose: () => void
}

const v3 = (v: THREE.Vector3) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`

/** The whole sky, in screen colours; `space` blends from the atmosphere to open space. */
const SKY_GLSL = /* glsl */ `
float skyHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skyNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skyHash(i), skyHash(i + vec3(1, 0, 0)), f.x), mix(skyHash(i + vec3(0, 1, 0)), skyHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(skyHash(i + vec3(0, 0, 1)), skyHash(i + vec3(1, 0, 1)), f.x), mix(skyHash(i + vec3(0, 1, 1)), skyHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float skyFbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * skyNoise(p); p *= 2.03; a *= 0.5; } return s; }

float starField(vec3 d, float scale) {
  vec3 p = d * scale;
  vec3 c = floor(p);
  float h = skyHash(c);
  if (h < 0.9965) return 0.0;
  vec3 f = fract(p) - 0.5 - (vec3(skyHash(c + 3.1), skyHash(c + 7.7), skyHash(c + 1.3)) - 0.5) * 0.5;
  return smoothstep(0.28, 0.0, length(f)) * (0.35 + 1.4 * fract(h * 131.7));
}

// A lit, banded ball in the sky (unit distance), returning colour + coverage; hitT is the ray distance to it
vec4 skyBall(vec3 d, vec3 centre, float radius, vec3 axis, vec3 sun, vec3 tintA, vec3 tintB, float bands, out float hitT) {
  hitT = 1e9;
  float b = dot(d, centre);
  float disc = b * b - (1.0 - radius * radius);
  if (disc <= 0.0) return vec4(0.0);
  float t = b - sqrt(disc);
  hitT = t;
  vec3 n = normalize(d * t - centre);
  float lat = dot(n, axis);
  float swirl = skyFbm(n * 5.0 + vec3(0.0, lat * 9.0, 0.0));
  float band = sin(lat * bands + swirl * 3.2) * 0.5 + 0.5;
  vec3 surface = mix(tintA, tintB, band) * (0.82 + 0.3 * swirl);
  float light = smoothstep(-0.12, 0.45, dot(n, sun));
  float rim = pow(1.0 - max(dot(n, -d), 0.0), 3.0);
  vec3 colour = surface * (0.035 + light) + vec3(0.55, 0.75, 0.85) * rim * light * 0.35;
  float edge = smoothstep(0.0, radius * 0.02, sqrt(disc));
  return vec4(colour, edge);
}

vec3 paintSky(vec3 d, vec3 sun, float space) {
  float up = d.y;
  // The atmosphere: teal overhead, a paler band, warm haze on the horizon; the ground below in haze
  vec3 zenith = vec3(0.16, 0.36, 0.46);
  vec3 middle = vec3(0.45, 0.6, 0.62);
  vec3 horizon = HORIZON;
  vec3 air = up > 0.0 ? mix(mix(horizon, middle, smoothstep(0.0, 0.25, up)), zenith, smoothstep(0.18, 0.9, up)) : horizon * (1.0 - 0.25 * smoothstep(0.0, -0.4, up));
  float toSun = max(dot(d, sun), 0.0);
  air += vec3(1.0, 0.78, 0.5) * (pow(toSun, 6.0) * 0.28 + pow(toSun, 60.0) * 0.25);
  // Space: black, a thin glowing limb of atmosphere at the horizon, a violet-teal nebula across the sky
  float neb = skyFbm(d * 2.6 + vec3(4.0));
  float lane = exp(-pow(dot(d, normalize(vec3(0.3, 0.55, -0.78))) * 3.2, 2.0));
  vec3 nebula = (vec3(0.28, 0.12, 0.42) * neb + vec3(0.05, 0.3, 0.32) * pow(neb, 3.0) * 2.0) * lane * 0.55;
  vec3 limb = vec3(0.3, 0.62, 0.68) * exp(-abs(up + 0.04) * 28.0) * 0.8;
  vec3 dark = vec3(0.004, 0.006, 0.014) + nebula + limb;
  if (up < -0.04) dark = mix(dark, horizon * 0.55, smoothstep(-0.04, -0.3, up));
  vec3 colour = mix(air, dark, space);
  // Stars: a few even by day overhead, all of them in space
  float starsSeen = mix(0.1 * smoothstep(0.25, 0.9, up), 1.0, space) * smoothstep(-0.05, 0.08, up + space * 0.2);
  colour += vec3(0.9, 0.95, 1.0) * (starField(d, 230.0) + starField(d.zxy, 480.0) * 0.6) * starsSeen;
  // How much air lies between us and the sky objects (less near the zenith, none in space)
  float haze = mix(mix(0.45, 0.12, smoothstep(0.0, 0.6, up)), 0.0, space);
  // The gas giant and its rings
  float tPlanet;
  vec4 planet = skyBall(d, PLANET_DIRECTION, PLANET_RADIUS, PLANET_AXIS, sun, vec3(0.62, 0.42, 0.62), vec3(0.95, 0.72, 0.46), 26.0, tPlanet);
  float ringDen = dot(d, PLANET_AXIS);
  float tRing = abs(ringDen) > 1e-4 ? dot(PLANET_DIRECTION, PLANET_AXIS) / ringDen : -1.0;
  vec4 ring = vec4(0.0);
  if (tRing > 0.0) {
    vec3 hit = d * tRing;
    float r = length(hit - PLANET_DIRECTION) / PLANET_RADIUS;
    float inRing = smoothstep(1.32, 1.4, r) * smoothstep(2.35, 2.2, r);
    if (inRing > 0.0) {
      float grain = 0.55 + 0.45 * sin(r * 61.0) * sin(r * 23.0 + 1.3) + 0.25 * sin(r * 170.0);
      float gap = smoothstep(0.02, 0.05, abs(r - 1.86));
      // The planet's shadow falls across the rings
      vec3 w = PLANET_DIRECTION - hit;
      float along = dot(w, sun);
      float shade = along > 0.0 && length(w - sun * along) < PLANET_RADIUS ? 0.12 : 1.0;
      vec3 ringColour = mix(vec3(0.78, 0.66, 0.52), vec3(0.95, 0.9, 0.8), grain) * (0.25 + 0.75 * abs(dot(PLANET_AXIS, sun))) * shade;
      ring = vec4(ringColour, inRing * gap * clamp(grain, 0.15, 1.0) * 0.85);
    }
  }
  if (planet.a > 0.0) colour = mix(colour, mix(planet.rgb, colour, haze), planet.a);
  if (ring.a > 0.0 && (planet.a <= 0.0 || tRing < tPlanet)) colour = mix(colour, mix(ring.rgb, colour, haze), ring.a);
  // Two moons
  float tMoon;
  vec4 moon = skyBall(d, MOON0_DIRECTION, MOON0_RADIUS, vec3(0.0, 1.0, 0.0), sun, MOON0_COLOUR * 0.8, MOON0_COLOUR, 7.0, tMoon);
  if (moon.a > 0.0) colour = mix(colour, mix(moon.rgb, colour, haze), moon.a);
  moon = skyBall(d, MOON1_DIRECTION, MOON1_RADIUS, vec3(0.0, 1.0, 0.0), sun, MOON1_COLOUR * 0.8, MOON1_COLOUR, 5.0, tMoon);
  if (moon.a > 0.0) colour = mix(colour, mix(moon.rgb, colour, haze), moon.a);
  return colour;
}`

export function createSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer, profile: QualityProfile): SkyRig {
  installHeightFog()
  const horizon = inverseACES(HORIZON_SRGB.clone())
  scene.background = horizon.clone()
  scene.fog = new THREE.FogExp2(horizon.getHex(THREE.LinearSRGBColorSpace), FOG_DENSITY)
  scene.fog.color.copy(horizon)

  const c = (rgb: number[]) => `vec3(${rgb.map((x) => x.toFixed(4)).join(', ')})`
  const defines = {
    HORIZON: c([HORIZON_SRGB.r, HORIZON_SRGB.g, HORIZON_SRGB.b]),
    PLANET_DIRECTION: v3(PLANET_DIRECTION),
    PLANET_RADIUS: Math.sin(PLANET_RADIUS).toFixed(5),
    PLANET_AXIS: v3(PLANET_AXIS),
    MOON0_DIRECTION: v3(MOONS[0].direction), MOON0_RADIUS: Math.sin(MOONS[0].radius).toFixed(5), MOON0_COLOUR: c(MOONS[0].color),
    MOON1_DIRECTION: v3(MOONS[1].direction), MOON1_RADIUS: Math.sin(MOONS[1].radius).toFixed(5), MOON1_COLOUR: c(MOONS[1].color),
  }
  const makeDomeMaterial = () => new THREE.ShaderMaterial({
    defines,
    uniforms: { exposure: { value: 1 }, sunDirection: { value: SUN_DIRECTION.clone() }, space: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = clip.xyww;
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      uniform float exposure;
      uniform vec3 sunDirection;
      uniform float space;
      varying vec3 vDirection;
      ${INVERSE_ACES_GLSL}
      ${SKY_GLSL}
      void main() {
        vec3 d = normalize(vDirection);
        vec3 colour = inverseACESFilmic(paintSky(d, sunDirection, space), exposure);
        // The sun itself, brighter than the screen can show (it blooms)
        float toSun = max(dot(d, sunDirection), 0.0);
        colour += vec3(1.0, 0.9, 0.72) * (smoothstep(0.99955, 0.9997, toSun) * 22.0 + pow(toSun, 900.0) * 3.0);
        gl_FragColor = vec4(colour, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })

  // The sky dome: drawn first, at the far plane, never writing depth (post effects see it as open sky)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), makeDomeMaterial())
  dome.name = 'sky'
  dome.renderOrder = -1000
  dome.frustumCulled = false
  dome.raycast = () => {}
  scene.add(dome)
  const domeMaterial = dome.material as THREE.ShaderMaterial

  // The same sky once into an environment map: the light and reflections of this world
  {
    const skyScene = new THREE.Scene()
    const copy = new THREE.Mesh(dome.geometry, makeDomeMaterial())
    copy.scale.setScalar(10)
    skyScene.add(copy)
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(skyScene, 0, 0.1, 100).texture
    scene.environmentIntensity = 0.7
    ;(copy.material as THREE.Material).dispose()
    pmrem.dispose()
  }

  const hemi = new THREE.HemisphereLight(0xbfe6e2, 0x4a3f4f, 0.5)
  scene.add(hemi)

  // The cloud deck: one big sheet that follows the camera, drawn only from above; broken cloud near you, solid
  // towards the distance, thickening as you climb
  const clouds = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, above: { value: 0 }, sunDirection: { value: SUN_DIRECTION.clone() } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        uniform float time;
        uniform float above;
        uniform vec3 sunDirection;
        varying vec3 vWorld;
        ${INVERSE_ACES_GLSL}
        float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float cNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(cHash(i), cHash(i + vec2(1, 0)), f.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), f.x), f.y); }
        float cFbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * cNoise(p); p = p * 2.07 + 11.3; a *= 0.5; } return s; }
        void main() {
          vec2 p = vWorld.xz / 420.0 + vec2(time * 0.004, time * 0.0015);
          float n = cFbm(p);
          float far = smoothstep(220.0, 620.0, length(vWorld.xz - cameraPosition.xz));
          float cover = smoothstep(0.62 - 0.35 * above, 0.78 - 0.3 * above, n);
          float alpha = clamp(max(cover, far) * above, 0.0, 1.0);
          if (alpha < 0.01) discard;
          float shade = 0.72 + 0.28 * smoothstep(0.4, 0.85, n + 0.1 * dot(sunDirection.xz, normalize(vWorld.xz - cameraPosition.xz + 1e-3)));
          vec3 colour = mix(vec3(0.3, 0.36, 0.4), vec3(0.66, 0.69, 0.66), shade) * (1.0 - 0.25 * cover * (1.0 - far));
          gl_FragColor = vec4(inverseACESFilmic(colour, 1.0), alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  )
  clouds.name = 'cloud deck'
  clouds.frustumCulled = false
  clouds.raycast = () => {}
  clouds.renderOrder = 5
  clouds.visible = false
  scene.add(clouds)
  const cloudMaterial = clouds.material as THREE.ShaderMaterial
  let sun: THREE.DirectionalLight | SunLight
  let mode: QualityProfile['sun'] | null = null
  const makeSun = (p: QualityProfile) => {
    if (mode === p.sun && sun) {
      sun.castShadow = p.shadows
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
      light.castShadow = p.shadows
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
      light.castShadow = p.shadows
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

  let space = 0
  return {
    get sun() { return sun },
    horizon,
    get space() { return space },
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
    setProfile(p) {
      makeSun(p)
    },
    update(camera) {
      dome.position.copy(camera.position)
      dome.scale.setScalar(10)
      dome.updateMatrixWorld()
      space = THREE.MathUtils.smoothstep(camera.position.y, ORBIT_START, ORBIT_FULL)
      domeMaterial.uniforms.space.value = space
      const above = THREE.MathUtils.smoothstep(camera.position.y, CLOUD_DECK + 8, CLOUD_DECK + 150)
      clouds.visible = above > 0
      if (clouds.visible) {
        clouds.position.set(camera.position.x, CLOUD_DECK, camera.position.z)
        clouds.scale.setScalar(2600)
        clouds.updateMatrixWorld()
        cloudMaterial.uniforms.above.value = above
        cloudMaterial.uniforms.time.value = performance.now() / 1000
      }
    },
    dispose() {
      dome.geometry.dispose()
      domeMaterial.dispose()
      clouds.geometry.dispose()
      cloudMaterial.dispose()
      scene.environment?.dispose()
    },
  }
}
