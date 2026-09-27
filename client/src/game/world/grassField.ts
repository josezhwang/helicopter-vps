import * as THREE from 'three'
import { HEIGHT_GLSL, HALF_WORLD, WORLD_SIZE } from './terrain'

/**
 * Wind-blown grass: hundreds of thousands of single blades in a square that travels with the camera. Every blade
 * keeps its own spot on the ground (the square wraps around, it doesn't slide), stands on the exact ground height
 * computed in the shader, sways in rolling gusts, and thins out towards the edge of the square so there is no
 * visible border. A density map keeps it off bases, outposts, parking spots, rock, sand and water.
 */

/** Blade segments (a tapered strip of 3 quads and a tip). */
const BLADE_T = [0, 0, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1]
const BLADE_SIDE = [-1, 1, -1, 1, -1, 1, 0]

function bladeGeometry(count: number, radius: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry()
  const position = new Float32Array(BLADE_T.length * 3)
  const shape = new Float32Array(BLADE_T.length * 2)
  BLADE_T.forEach((t, i) => shape.set([t, BLADE_SIDE[i]], i * 2))
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(BLADE_T.length * 3).fill(0), 3))
  geometry.setAttribute('aShape', new THREE.BufferAttribute(shape, 2))
  geometry.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6])
  // Per blade: its spot in the square (x, z), and three random numbers (height, lean, colour/turn)
  const blades = new Float32Array(count * 4)
  let seed = 1234567
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const side = radius * 2
  for (let i = 0; i < count; i++) blades.set([(rand() - 0.5) * side, (rand() - 0.5) * side, rand(), rand()], i * 4)
  geometry.setAttribute('aBlade', new THREE.InstancedBufferAttribute(blades, 4))
  geometry.instanceCount = count
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
  return geometry
}

export interface GrassBlades {
  mesh: THREE.Mesh
  update: (camera: THREE.Vector3, time: number) => void
  dispose: () => void
}

/** `ground`: the shared ground map (its B channel says how thick the grass grows). */
export function createGrassBlades(count: number, radius: number, ground: THREE.Texture): GrassBlades {
  const geometry = bladeGeometry(count, radius)
  const uniforms = {
    uCenter: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uRadius: { value: radius },
    uMask: { value: ground },
  }
  const material = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0, side: THREE.DoubleSide, vertexColors: false })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
attribute vec2 aShape;
attribute vec4 aBlade;
uniform vec2 uCenter;
uniform float uTime;
uniform float uRadius;
uniform sampler2D uMask;
varying float vBladeT;
varying vec3 vBladeColor;
${HEIGHT_GLSL}
float bHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float bNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bHash(i), bHash(i + vec2(1, 0)), u.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), u.x), u.y);
}`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `
// Where this blade grows: its fixed spot in the world nearest the camera (the square wraps around)
float side = uRadius * 2.0;
vec2 root = uCenter + mod(aBlade.xy - uCenter + uRadius, side) - uRadius;
float dist = length(root - uCenter);
vec2 maskUv = (root + ${HALF_WORLD.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)};
float grow = texture2D(uMask, maskUv).b;
// Thinner towards the edge of the square, and only where the density map says so
float keep = step(aBlade.z * 0.999, grow) * (1.0 - smoothstep(uRadius * 0.62, uRadius * 0.97, dist));
float turn = aBlade.w * 6.2831853;
vec2 facing = vec2(cos(turn), sin(turn));
float height = (0.28 + aBlade.z * 0.5) * (0.7 + grow * 0.45) * keep;
float width = 0.036 * (0.8 + aBlade.w * 0.5) * step(0.001, keep);
// Wind: rolling gusts across the field plus a quick flutter; the tip bends most
float gust = bNoise(root * 0.045 + vec2(uTime * 0.35, uTime * 0.21));
float sway = (gust * 0.9 + 0.15) * 0.45 + sin(uTime * 2.3 + root.x * 0.7 + root.y * 0.5) * 0.06;
vec2 windDir = normalize(vec2(0.8, 0.45));
float t = aShape.x;
vec2 bend = (windDir * sway + facing.yx * vec2(-1.0, 1.0) * (aBlade.z - 0.5) * 0.35) * t * t * height;
vec3 bladePos = vec3(root.x, terrainHeight(root), root.y);
vec2 across = vec2(-facing.y, facing.x) * aShape.y * width * (1.0 - t * 0.85);
bladePos.xz += across + bend;
bladePos.y += t * height * (1.0 - 0.25 * length(bend) / max(height, 1e-3));
vBladeT = t;
// Colour per blade: dark roots, sunlit tips, some drier yellow-green ones
vec3 tipColor = mix(vec3(0.16, 0.27, 0.05), vec3(0.3, 0.3, 0.1), step(0.84, bHash(root * 3.1)) * 0.8);
vBladeColor = mix(vec3(0.028, 0.055, 0.012), tipColor * (0.8 + aBlade.w * 0.4), t);
// Lit mostly like the ground it grows from (soft, no harsh blade-edge shading)
vec3 objectNormal = normalize(vec3(facing.x * 0.35, 1.0, facing.y * 0.35));
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = bladePos;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBladeT;\nvarying vec3 vBladeColor;')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);\nnonPerturbedNormal = normal;')
      .replace('#include <map_fragment>', /* glsl */ `diffuseColor.rgb = vBladeColor;
// Light shining through the blade tips from behind
totalEmissiveRadiance += vBladeColor * vec3(0.18, 0.2, 0.06) * vBladeT;`)
  }
  material.customProgramCacheKey = () => 'aerium-grass-blades-v1'
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.name = 'grass-blades'
  mesh.raycast = () => {}

  return {
    mesh,
    update(camera, time) {
      uniforms.uCenter.value.set(camera.x, camera.z)
      uniforms.uTime.value = time
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
