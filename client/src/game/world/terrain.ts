import * as THREE from 'three'
import { BASE_CENTER, PLATEAU_HALF, type Team } from './layout'
import { trackLoad } from './loading'

export const WORLD_SIZE = 1000
export const HALF_WORLD = WORLD_SIZE / 2

export const OUR_BASE: THREE.Vector3 = new THREE.Vector3(-380, 0, -380)
export const ENEMY_BASE: THREE.Vector3 = new THREE.Vector3(380, 0, 380)

function rawHeight(x: number, z: number): number {
  const hills = Math.sin(x * 0.008) * Math.cos(z * 0.009) * 14
  const dunes = Math.sin(x * 0.02 + z * 0.013) * Math.cos(z * 0.017 - x * 0.011) * 5
  const ridges = Math.cos((x - z) * 0.004) * 8
  const valleys = Math.sin((x + z) * 0.005) * Math.cos((x - z) * 0.007) * 3
  return hills + dunes + ridges + valleys
}

/** Each base stands on level ground: flat out to PLATEAU_HALF, easing back into the hills over PLATEAU_BLEND. */
const PLATEAU_BLEND = 30
const plateaus = (['blue', 'red'] as const).map((team) => ({ team, ...BASE_CENTER[team], h: rawHeight(BASE_CENTER[team].x, BASE_CENTER[team].z) }))

/** Height of the level ground a team's base stands on. */
export function baseGroundHeight(team: Team): number {
  return plateaus.find((p) => p.team === team)!.h
}

/** Analytic battlefield height — shared by terrain mesh, player, and vehicles. */
export function heightAt(x: number, z: number): number {
  let h = rawHeight(x, z)
  for (const p of plateaus) {
    const d = Math.max(Math.abs(x - p.x), Math.abs(z - p.z))
    if (d >= PLATEAU_HALF + PLATEAU_BLEND) continue
    const t = THREE.MathUtils.smoothstep(d, PLATEAU_HALF, PLATEAU_HALF + PLATEAU_BLEND)
    h = p.h + (h - p.h) * t
  }
  return h
}

/** The same height function in GLSL (grass blades and water use it to find the ground). */
export const HEIGHT_GLSL = /* glsl */ `
float terrainRawHeight(vec2 p) {
  float hills = sin(p.x * 0.008) * cos(p.y * 0.009) * 14.0;
  float dunes = sin(p.x * 0.02 + p.y * 0.013) * cos(p.y * 0.017 - p.x * 0.011) * 5.0;
  float ridges = cos((p.x - p.y) * 0.004) * 8.0;
  float valleys = sin((p.x + p.y) * 0.005) * cos((p.x - p.y) * 0.007) * 3.0;
  return hills + dunes + ridges + valleys;
}
float terrainHeight(vec2 p) {
  float h = terrainRawHeight(p);
${plateaus.map((q) => `  {
    float d = max(abs(p.x - (${q.x.toFixed(3)})), abs(p.y - (${q.z.toFixed(3)})));
    float t = smoothstep(${PLATEAU_HALF.toFixed(3)}, ${(PLATEAU_HALF + PLATEAU_BLEND).toFixed(3)}, d);
    h = mix(${q.h.toFixed(5)}, h, t);
  }`).join('\n')}
  return h;
}`

/** Ground layers, in texture-array order: photographed PBR sets (see README credits). */
const LAYERS = ['grass', 'meadow', 'dirt', 'rock', 'sand'] as const
/** Metres per texture repeat, how rough each surface is, and a colour grade per layer. */
const LAYER_SCALE = [3.2, 4.2, 3.6, 7.0, 9.0]
const LAYER_ROUGHNESS = [0.93, 0.94, 0.95, 0.84, 0.96]
// (the alien ground photos are graded in the images themselves; the shore is toned down a little so it doesn't glare)
const LAYER_TINT: THREE.Vector3Tuple[] = [[1, 1, 1], [0.78, 0.9, 0.8], [1, 1, 1], [1, 1, 1], [0.82, 0.82, 0.82]]
/** Average colours: shown until the photographs arrive. */
const LAYER_AVERAGE: THREE.Vector3Tuple[] = [[0.357, 0.521, 0.468], [0.373, 0.336, 0.42], [0.542, 0.414, 0.282], [0.29, 0.266, 0.315], [0.661, 0.616, 0.531]]

/** Decode images into one texture array (layer i = urls[i]). */
async function loadLayerArray(urls: string[], size: number, srgb: boolean, anisotropy: number): Promise<THREE.DataArrayTexture> {
  const data = new Uint8Array(size * size * 4 * urls.length)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const images = await Promise.all(urls.map(async (url) => {
    const blob = await trackLoad(url, fetch(url).then((r) => r.blob()))
    return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  }))
  images.forEach((image, i) => {
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(image, 0, 0, size, size)
    data.set(ctx.getImageData(0, 0, size, size).data, i * size * size * 4)
    image.close()
  })
  const texture = new THREE.DataArrayTexture(data, size, size, urls.length)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = anisotropy
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/** A 1x1 array per layer (average colours / flat normals) until the real layers have loaded. */
function placeholderArray(values: THREE.Vector3Tuple[], srgb: boolean): THREE.DataArrayTexture {
  const data = new Uint8Array(values.length * 4)
  values.forEach((v, i) => data.set([v[0] * 255, v[1] * 255, v[2] * 255, 255], i * 4))
  const texture = new THREE.DataArrayTexture(data, 1, 1, values.length)
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

export interface TerrainOptions {
  /** Ground photo resolution (2048 or 1024). */
  textureSize: number
  anisotropy: number
}

/**
 * The ground: five photographed PBR surfaces (grass, meadow, forest dirt, rock, beach sand) blended per pixel by
 * height, slope and noise. Where two meet, the taller parts of each (stones, tufts) win, like real ground. Each
 * surface is sampled twice with shifted tiles (so repeats don't show), cliffs get the rock projected from the
 * side, and a slow colour drift keeps big fields from looking uniform.
 */
export function createTerrain(options: TerrainOptions): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 400, 400)
  geometry.rotateX(-Math.PI / 2)
  const pos = geometry.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)))
  geometry.computeVertexNormals()
  geometry.deleteAttribute('uv')

  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 })
  const uniforms = {
    tAlbedo: { value: placeholderArray(LAYER_AVERAGE, true) },
    tNormalHeight: { value: placeholderArray(LAYERS.map(() => [0.5, 0.5, 0.5] as THREE.Vector3Tuple), false) },
    uScale: { value: LAYER_SCALE.map((s) => 1 / s) },
    uRough: { value: LAYER_ROUGHNESS },
    uTint: { value: LAYER_TINT.map((t) => new THREE.Vector3(...t)) },
    /** Each layer's average colour (linear), used far away where the photo's detail would only shimmer. */
    /** Light setting: photos only close by (distance where they start / finish fading), one lookup each. */
    uDetail: { value: new THREE.Vector2(45, 170) },
    uLite: { value: 0 },
    uAvg: { value: LAYER_AVERAGE.map((c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace)) },
    /** Dirt / meadow / grass map (see groundMap.ts); plain grass until it's set. */
    uGround: { value: new THREE.DataTexture(new Uint8Array([0, 0, 255, 255]), 1, 1) as THREE.Texture },
  }
  uniforms.uGround.value.needsUpdate = true
  const n = LAYERS.length
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;\nvarying vec3 vGroundNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvGroundNormal = normal;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tNormalHeight;
uniform float uScale[${n}];
uniform float uRough[${n}];
uniform vec3 uTint[${n}];
uniform sampler2D uGround;
uniform vec3 uAvg[${n}];
uniform vec2 uDetail;
uniform float uLite;
varying vec3 vGroundPos;
varying vec3 vGroundNormal;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
}
float gFbm(vec2 p) { return gNoise(p) * 0.55 + gNoise(p * 2.03 + 17.1) * 0.3 + gNoise(p * 4.07 + 31.7) * 0.15; }
// Two lookups with tile offsets chosen by a slow noise, cross-faded: the repeat pattern never lines up
void sampleLayer(float layer, vec2 uv, float k, out vec4 albedo, out vec4 nh) {
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float l = k * 7.0;
  float i = floor(l), f = fract(l);
  vec2 offA = sin(vec2(3.0, 7.0) * i) * 0.5 + 0.5;
  vec2 offB = sin(vec2(3.0, 7.0) * (i + 1.0)) * 0.5 + 0.5;
  if (uLite > 0.5) {
    albedo = texture(tAlbedo, vec3(uv, layer));
    nh = texture(tNormalHeight, vec3(uv, layer));
    return;
  }
  vec4 a1 = textureGrad(tAlbedo, vec3(uv + offA, layer), dx, dy);
  vec4 a2 = textureGrad(tAlbedo, vec3(uv + offB, layer), dx, dy);
  vec4 n1 = textureGrad(tNormalHeight, vec3(uv + offA, layer), dx, dy);
  vec4 n2 = textureGrad(tNormalHeight, vec3(uv + offB, layer), dx, dy);
  float t = smoothstep(0.25, 0.75, f - 0.1 * (a1.r + a1.g + a1.b - a2.r - a2.g - a2.b));
  albedo = mix(a1, a2, t);
  nh = mix(n1, n2, t);
}`)
      .replace('#include <map_fragment>', /* glsl */ `
vec3 gN = normalize(vGroundNormal);
float gSlope = sqrt(max(1.0 - gN.y * gN.y, 0.0)) / max(gN.y, 0.05);
vec2 gp = vGroundPos.xz;
float gh = vGroundPos.y;
float detail = gFbm(gp * 0.06);
vec4 gMap = texture2D(uGround, (gp + ${HALF_WORLD.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)});
// Where each surface is: rock high up and on steep slopes, sand at the water, dirt in patches, meadow between
float wRock = clamp((gh - 18.0) / 12.0, 0.0, 1.0) + smoothstep(0.3, 0.55, gSlope + (detail - 0.5) * 0.12);
float wSand = clamp((-1.0 - gh) / 2.0 + (detail - 0.5) * 0.8, 0.0, 1.0);
float wDirt = clamp(gMap.r + (detail - 0.5) * 0.35, 0.0, 1.0);
float wMeadow = gMap.g;
wRock = min(wRock, 1.0); wSand = min(wSand, 1.0);
wDirt *= (1.0 - wRock) * (1.0 - wSand);
wMeadow *= (1.0 - wRock) * (1.0 - wSand) * (1.0 - wDirt);
float wGrass = max(0.0, 1.0 - wRock - wSand - wDirt - wMeadow);
float gw[${n}];
gw[0] = wGrass; gw[1] = wMeadow; gw[2] = wDirt; gw[3] = wRock; gw[4] = wSand;
float tileNoise = gNoise(gp * 0.021);
// Far away the photos only shimmer and show their repeats: fade to each surface's own average colour
float gFar = smoothstep(uDetail.x, uDetail.y, length(vGroundPos - cameraPosition));
vec4 gAlb[${n}];
vec4 gNh[${n}];
float gTop = -1.0;
for (int i = 0; i < ${n}; i++) {
  gAlb[i] = vec4(0.0); gNh[i] = vec4(0.5, 0.5, 0.0, 1.0);
  if (gw[i] < 0.004) continue;
  if (gFar > 0.995) {
    gAlb[i] = vec4(uAvg[i], 1.0); gNh[i] = vec4(0.5, 0.5, 0.5, 1.0);
    gTop = max(gTop, 0.5 + gw[i]);
    continue;
  }
  sampleLayer(float(i), gp * uScale[i], tileNoise, gAlb[i], gNh[i]);
  gAlb[i].rgb = mix(gAlb[i].rgb, uAvg[i], gFar);
  gNh[i] = mix(gNh[i], vec4(0.5, 0.5, 0.5, 1.0), gFar);
  if (i == 3 && gN.y < 0.85 && uLite < 0.5) {
    // Cliffs: the rock photographed from the side, so its strata run across the slope
    vec4 sa, sn;
    vec2 side = abs(gN.x) > abs(gN.z) ? vGroundPos.zy : vGroundPos.xy;
    sampleLayer(3.0, vec2(side.x, -side.y) * uScale[3], tileNoise, sa, sn);
    float k = smoothstep(0.85, 0.6, gN.y);
    gAlb[i] = mix(gAlb[i], sa, k); gNh[i] = mix(gNh[i], sn, k);
  }
  gTop = max(gTop, gNh[i].b + gw[i]);
}
// Height blend: where layers meet, whichever is locally taller shows
float gSum = 0.0;
float gb[${n}];
for (int i = 0; i < ${n}; i++) { gb[i] = gw[i] < 0.004 ? 0.0 : max(gNh[i].b + gw[i] - gTop + 0.18, 0.0); gSum += gb[i]; }
vec3 gColor = vec3(0.0); vec2 gBump = vec2(0.0); float gRough = 0.0;
for (int i = 0; i < ${n}; i++) {
  float b = gb[i] / max(gSum, 1e-4);
  gColor += gAlb[i].rgb * uTint[i] * b;
  gBump += (gNh[i].rg * 2.0 - 1.0) * b;
  gRough += uRough[i] * b;
}
// Slow colour drift over the fields, and a little darker in the hollows
gColor *= mix(vec3(0.8, 0.88, 0.8), vec3(1.12, 1.07, 0.95), gFbm(gp * 0.0045)) * mix(0.9, 1.08, gFbm(gp * 0.017 + 5.3));
diffuseColor.rgb *= gColor;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
{
  // Ground photos are laid along world X (right) and -Z (up in the photo)
  vec3 tx = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  vec3 tz = normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  normal = normalize(normal + (tx * gBump.x - tz * gBump.y) * 0.9 * (1.0 - gFar));
}`)
  }
  // Tiling and anti-tiling differ per layer: keep a separate program from other standard materials
  material.customProgramCacheKey = () => 'aerium-terrain-v2'

  // The photographs load in the background (the average colours show meanwhile)
  const size = options.textureSize
  const suffix = size >= 2048 ? '2k' : '1k'
  void Promise.all([
    loadLayerArray(LAYERS.map((l) => `/textures/terrain_${l}_albedo_${suffix}.jpg`), size, true, options.anisotropy),
    loadLayerArray(LAYERS.map((l) => `/textures/terrain_${l}_nh_${suffix}.jpg`), size, false, options.anisotropy),
  ]).then(([albedo, normalHeight]) => {
    uniforms.tAlbedo.value.dispose()
    uniforms.tNormalHeight.value.dispose()
    uniforms.tAlbedo.value = albedo
    uniforms.tNormalHeight.value = normalHeight
  }).catch((error) => console.error('[terrain] ground textures failed to load:', error))

  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  mesh.name = 'terrain'
  mesh.userData.layers = uniforms
  return mesh
}
