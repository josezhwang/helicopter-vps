// N8AO ships without type declarations; this covers the part the game uses.
declare module 'n8ao' {
  import type { Camera, Color, Scene } from 'three'
  import type { Pass } from 'postprocessing'

  export interface N8AOConfiguration {
    aoRadius: number
    distanceFalloff: number
    intensity: number
    color: Color
    halfRes: boolean
    gammaCorrection: boolean
    screenSpaceRadius: boolean
    depthAwareUpsampling: boolean
    aoSamples: number
    denoiseSamples: number
    denoiseRadius: number
  }

  export type N8AOQualityMode = 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra' | 'Neural-Low' | 'Neural-Medium' | 'Neural-High'

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number)
    configuration: N8AOConfiguration
    setQualityMode(mode: N8AOQualityMode): void
    setSize(width: number, height: number): void
  }
}
