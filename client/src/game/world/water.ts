import * as THREE from 'three'
import { HEIGHT_GLSL, WORLD_SIZE } from './terrain'

/** Height of the water surface (lakes, rivers and the sea round the island). */
export const WATER_LEVEL = -6

/**
 * Water: a surface of travelling waves (six wave trains plus fine ripples, all computed in the shader), coloured
 * by how deep it is over the real ground — clear and green-blue in the shallows, dark far out — with foam where
 * it laps the shore. It reflects the sky and glints in the sun like the rest of the lit world.
 */
export function createWater(): { mesh: THREE.Mesh; update: (time: number) => void } {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE * 1.8, WORLD_SIZE * 1.8)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.035,
    metalness: 0,
    transparent: true,
    depthWrite: false,
  })
  const uniforms = { uTime: { value: 0 } }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(position, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform float uTime;
varying vec3 vWaterPos;
${HEIGHT_GLSL}
float wHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), u.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), u.x), u.y);
}
// Slope of the surface (d height / dx, d height / dz) from a sum of travelling waves
vec2 waveSlope(vec2 p, float t) {
  vec2 s = vec2(0.0);
  const int N = 6;
  vec2 dirs[N] = vec2[N](vec2(0.8, 0.6), vec2(-0.5, 0.86), vec2(0.97, -0.24), vec2(-0.9, -0.43), vec2(0.2, 0.98), vec2(0.6, -0.8));
  float lens[N] = float[N](11.0, 7.3, 4.6, 2.9, 1.7, 1.1);
  for (int i = 0; i < N; i++) {
    float k = 6.2831853 / lens[i];
    float speed = sqrt(9.8 / k);
    float amp = lens[i] * 0.012;
    float phase = k * dot(dirs[i], p) - speed * k * t * 0.35 + float(i) * 1.7;
    s += dirs[i] * (k * amp * cos(phase));
  }
  // Fine ripples: the gradient of drifting noise
  vec2 q = p * 2.3 + vec2(t * 0.35, -t * 0.27);
  float e = 0.05;
  float n0 = wNoise(q);
  s += vec2(wNoise(q + vec2(e, 0.0)) - n0, wNoise(q + vec2(0.0, e)) - n0) / e * 0.018;
  return s;
}`)
      .replace('#include <map_fragment>', /* glsl */ `
float waterDepth = max(${WATER_LEVEL.toFixed(2)} - terrainHeight(vWaterPos.xz), 0.0);
vec3 shallow = vec3(0.06, 0.27, 0.25);
vec3 deep = vec3(0.01, 0.055, 0.075);
diffuseColor.rgb = mix(shallow, deep, 1.0 - exp(-waterDepth * 0.22));
// Clear at the edge, opaque once it's a few metres deep
diffuseColor.a = mix(0.35, 0.93, smoothstep(0.0, 3.5, waterDepth));
// Foam where the water laps the shore, breaking up with the ripples
float foamLine = 1.0 - smoothstep(0.0, 0.55, waterDepth);
float foamNoise = wNoise(vWaterPos.xz * 1.6 + vec2(uTime * 0.2, uTime * 0.13)) * wNoise(vWaterPos.xz * 0.45 - uTime * 0.05);
float foam = foamLine * smoothstep(0.12, 0.42, foamNoise + foamLine * 0.25);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.92), foam);
diffuseColor.a = max(diffuseColor.a, foam * 0.9);`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.6, foam);')
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
{
  vec2 slope = waveSlope(vWaterPos.xz, uTime);
  // Waves flatten out with distance so the far water doesn't shimmer
  float fade = 1.0 / (1.0 + length(vWaterPos - cameraPosition) * 0.012);
  vec3 worldNormal = normalize(vec3(-slope.x * fade, 1.0, -slope.y * fade));
  normal = normalize((viewMatrix * vec4(worldNormal, 0.0)).xyz);
}`)
  }
  material.customProgramCacheKey = () => 'aerium-water-v2'
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = WATER_LEVEL
  mesh.receiveShadow = true
  mesh.renderOrder = 1
  mesh.name = 'water'
  return {
    mesh,
    update(time) {
      uniforms.uTime.value = time
    },
  }
}
