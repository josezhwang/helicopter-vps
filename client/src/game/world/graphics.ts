import * as THREE from 'three'
import {
  BloomEffect, BrightnessContrastEffect, EffectComposer, EffectPass, GodRaysEffect, HueSaturationEffect, KernelSize,
  RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing'
import { N8AOPostPass } from 'n8ao'
import { SUN_COLOR, SUN_INTENSITY } from './sky'

/**
 * How the game is drawn. Ultra is the full look: cascaded sun shadows out to 600 m, ambient occlusion, bloom on
 * flashes and fire, god rays through the trees, a filmic grade and dense wind-blown grass. The lower settings
 * drop the costliest parts first so older PCs stay smooth; the choice is remembered per browser.
 */
export type Quality = 'ultra' | 'high' | 'medium' | 'low'
export const QUALITIES: Quality[] = ['ultra', 'high', 'medium', 'low']
export const QUALITY_LABEL: Record<Quality, string> = { ultra: 'Ultra', high: 'High', medium: 'Medium', low: 'Low' }

export interface QualityProfile {
  /** Highest device pixel ratio rendered. */
  pixelRatio: number
  /** 'cascades': two sun shadow maps covering everything in view up to shadowDistance; 'box': one map around the player. */
  sun: 'cascades' | 'box'
  shadowMapSize: number
  shadowDistance: number
  /** Screen-space ambient occlusion (N8AO) and its quality preset. */
  ao: null | { mode: 'Low' | 'Medium' | 'High' | 'Ultra'; halfRes: boolean }
  bloom: boolean
  godRays: boolean
  /** Post-process anti-aliasing (the composer replaces the canvas' own MSAA). */
  smaa: boolean
  /** Wind-blown grass blades around the camera, and how far they reach. */
  grassBlades: number
  grassRadius: number
  /** Texture filtering at grazing angles. */
  anisotropy: number
  /** Ground photo resolution. */
  terrainTextures: 2048 | 1024
  /** Fraction of the screen resolution actually drawn (below 1 on weak PCs; the picture is scaled up). */
  renderScale: number
  /** Sun shadows at all. */
  shadows: boolean
  /** Ground photos only right around the player, plain colours beyond (much cheaper to draw). */
  terrainLite: boolean
  /** The lighter robot model for the soldiers. */
  robotLite: boolean
  /** The simple grass clumps (when there are no grass blades). */
  grassClumps: boolean
}

export const PROFILES: Record<Quality, QualityProfile> = {
  ultra: { pixelRatio: 2, sun: 'cascades', shadowMapSize: 4096, shadowDistance: 600, ao: { mode: 'High', halfRes: false }, bloom: true, godRays: true, smaa: true, grassBlades: 380_000, grassRadius: 64, anisotropy: 16, terrainTextures: 2048, renderScale: 1, shadows: true, terrainLite: false, robotLite: false, grassClumps: false },
  high: { pixelRatio: 1.5, sun: 'cascades', shadowMapSize: 2048, shadowDistance: 420, ao: { mode: 'Medium', halfRes: true }, bloom: true, godRays: false, smaa: true, grassBlades: 210_000, grassRadius: 50, anisotropy: 8, terrainTextures: 2048, renderScale: 1, shadows: true, terrainLite: false, robotLite: false, grassClumps: false },
  medium: { pixelRatio: 1.25, sun: 'box', shadowMapSize: 2048, shadowDistance: 160, ao: null, bloom: true, godRays: false, smaa: true, grassBlades: 90_000, grassRadius: 36, anisotropy: 4, terrainTextures: 1024, renderScale: 1, shadows: true, terrainLite: false, robotLite: true, grassClumps: false },
  low: { pixelRatio: 1, sun: 'box', shadowMapSize: 1024, shadowDistance: 160, ao: null, bloom: false, godRays: false, smaa: false, grassBlades: 0, grassRadius: 0, anisotropy: 2, terrainTextures: 1024, renderScale: 0.75, shadows: false, terrainLite: true, robotLite: true, grassClumps: false },
}

const STORAGE_KEY = 'aerium_quality'

/**
 * A first guess for this PC: Low on software rendering (no graphics card) and Intel graphics, Medium on other
 * built-in graphics or few CPU cores, Ultra on a real graphics card.
 */
export function detectQuality(): Quality {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return 'low'
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(gpu)) return 'low'
    if (/intel/i.test(gpu) && !/\barc\b/i.test(gpu)) return 'low'
    if (/radeon\(tm\) graphics|vega \d|mali|adreno|powervr/i.test(gpu)) return 'medium'
    if ((navigator.hardwareConcurrency || 8) <= 4) return 'medium'
  } catch {
    return 'medium'
  }
  return 'ultra'
}

export function loadQuality(): Quality {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && (QUALITIES as string[]).includes(saved)) return saved as Quality
  } catch {
    // Storage blocked: fall through to the guess
  }
  return detectQuality()
}

export function saveQuality(quality: Quality) {
  try {
    localStorage.setItem(STORAGE_KEY, quality)
  } catch {
    // Not remembered, still applied for this session
  }
}

/** Exposure before the filmic curve (the sky HDR and sun are tuned around it). */
const EXPOSURE = 1.0

/**
 * The frame pipeline: scene → ambient occlusion → bloom / god rays → filmic tone mapping and grade → SMAA.
 * On Low the scene is drawn straight to the screen with the renderer's own tone mapping.
 */
export class Graphics {
  /**
   * The first-person gun has a little scene of its own, drawn after the world (and after ambient occlusion) with
   * its own depth: it never pokes into walls, its parts hide each other properly, and it's lit like the world.
   */
  readonly viewmodelScene = new THREE.Scene()
  /** Follows the camera; the viewmodel hangs off it. */
  readonly viewmodelRig = new THREE.Group()
  /** 1 = the player stands in sunlight, lower in shadow (the gun is lit accordingly). */
  viewmodelSun = 1
  private vmSun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY)
  private vmLight = 1
  private composer: EffectComposer | null = null
  private sunDisc: THREE.Mesh
  private ao: N8AOPostPass | null = null
  private width = 1
  private height = 1
  profile: QualityProfile

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private sunDirection: THREE.Vector3,
    public quality: Quality,
  ) {
    this.profile = PROFILES[quality]
    // The light source the god rays stream from: a bright disc far out along the sun's direction
    this.sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, depthWrite: false, fog: false }),
    )
    this.sunDisc.frustumCulled = false
    this.viewmodelRig.matrixAutoUpdate = false
    this.viewmodelScene.add(this.viewmodelRig, this.vmSun, this.vmSun.target, new THREE.HemisphereLight(0xc4dcff, 0x4d5a36, 0.45))
    this.build()
  }

  private build() {
    this.composer?.dispose()
    this.composer = null
    this.ao = null
    const p = this.profile
    const renderer = this.renderer
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatio) * p.renderScale)
    renderer.toneMappingExposure = EXPOSURE
    if (this.quality === 'low') {
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      return
    }
    renderer.toneMapping = THREE.NoToneMapping
    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 })
    composer.addPass(new RenderPass(this.scene, this.camera))
    if (p.ao) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      const ao = new N8AOPostPass(this.scene, this.camera, size.x, size.y)
      ao.setQualityMode(p.ao.mode)
      ao.configuration.halfRes = p.ao.halfRes
      // Metres: contact shadows under vehicles, in doorways and between sandbags, not a dark halo round hills
      ao.configuration.aoRadius = 2.2
      ao.configuration.distanceFalloff = 1
      ao.configuration.intensity = 2.6
      ao.configuration.color = new THREE.Color(0x0c1420)
      ao.configuration.gammaCorrection = false
      composer.addPass(ao)
      this.ao = ao
    }
    // The first-person gun: over the world, with its own depth (the effects keep using the world's depth)
    const viewmodel = new RenderPass(this.viewmodelScene, this.camera)
    viewmodel.clearPass.color = false
    viewmodel.clearPass.depth = true
    viewmodel.needsDepthBlit = false
    viewmodel.ignoreBackground = true
    viewmodel.skipShadowMapUpdate = true
    composer.addPass(viewmodel)
    const effects = []
    if (p.bloom) {
      // Only real highlights glow: muzzle flashes, tracers, explosions, fire, the sun's glint on metal and water
      effects.push(new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.05, luminanceSmoothing: 0.25, intensity: 0.85, radius: 0.72 }))
    }
    if (p.godRays) {
      effects.push(new GodRaysEffect(this.camera, this.sunDisc, {
        samples: 60, density: 0.94, decay: 0.93, weight: 0.32, exposure: 0.42, clampMax: 1, resolutionScale: 0.5, kernelSize: KernelSize.SMALL, blur: true,
      }))
    }
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }))
    // A touch more punch than the plain filmic curve, and a soft lens vignette
    effects.push(new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.07 }))
    effects.push(new HueSaturationEffect({ saturation: 0.1 }))
    effects.push(new VignetteEffect({ offset: 0.32, darkness: 0.42 }))
    composer.addPass(new EffectPass(this.camera, ...effects))
    if (p.smaa) composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })))
    this.composer = composer
    this.setSize(this.width, this.height)
  }

  setQuality(quality: Quality) {
    if (quality === this.quality) return
    this.quality = quality
    this.profile = PROFILES[quality]
    this.build()
  }

  setSize(width: number, height: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.renderer.setSize(this.width, this.height)
    this.composer?.setSize(this.width, this.height)
    if (this.ao) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
      this.ao.setSize(size.x, size.y)
    }
  }

  /** Keep the gun's rig on the camera and its light like the world's. */
  private syncViewmodel(dt: number) {
    this.camera.updateMatrixWorld()
    this.viewmodelRig.matrix.copy(this.camera.matrixWorld)
    this.viewmodelRig.updateMatrixWorld(true)
    const vm = this.viewmodelScene
    vm.environment = this.scene.environment
    vm.environmentIntensity = this.scene.environmentIntensity
    vm.environmentRotation.copy(this.scene.environmentRotation)
    this.vmLight = THREE.MathUtils.lerp(this.vmLight, this.viewmodelSun, 1 - Math.exp(-dt * 6))
    this.vmSun.intensity = SUN_INTENSITY * this.vmLight
    this.vmSun.position.copy(this.camera.position).addScaledVector(this.sunDirection, 10)
    this.vmSun.target.position.copy(this.camera.position)
    this.vmSun.target.updateMatrixWorld()
  }

  render(dt: number) {
    this.syncViewmodel(dt)
    if (!this.composer) {
      const renderer = this.renderer
      renderer.render(this.scene, this.camera)
      renderer.autoClear = false
      renderer.clearDepth()
      renderer.render(this.viewmodelScene, this.camera)
      renderer.autoClear = true
      return
    }
    if (this.profile.godRays) {
      // Far out along the sun's direction, inside the camera's far plane, as big as the sun looks in the sky
      this.sunDisc.position.copy(this.camera.position).addScaledVector(this.sunDirection, this.camera.far * 0.8)
      this.sunDisc.scale.setScalar(this.camera.far * 0.8 * 0.035)
      this.sunDisc.updateMatrixWorld()
    }
    this.composer.render(dt)
  }

  dispose() {
    this.composer?.dispose()
    this.composer = null
    this.sunDisc.geometry.dispose()
    ;(this.sunDisc.material as THREE.Material).dispose()
  }
}
