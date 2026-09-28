import * as THREE from 'three'
import type { Surface } from './projectiles'

/**
 * All the game's sound, made on the fly with WebAudio (no sound files): gunshots per weapon class, cannon and
 * rocket fire, explosions that roll in late from far away, bullet impacts, grenade clinks, rotor thump and
 * engine growl for nearby vehicles, lock-on tones and the little clicks of reloading and picking things up.
 * Sounds out in the world are panned, quietened and muffled with distance (and arrive at the speed of sound).
 * Nothing plays until the first click (browsers only allow audio after the player does something).
 */
export type ShotSound = 'pistol' | 'rifle' | 'heavy' | 'sniper' | 'plasma' | 'mg' | 'gatling' | 'cannon' | 'launch'
export type UiSound = 'reload' | 'reloaded' | 'empty' | 'pickup' | 'pin' | 'hit' | 'kill' | 'hurt' | 'switch' | 'shield' | 'shieldDown' | 'recharge' | 'melee' | 'announce'

interface ShotRecipe {
  /** High crack, mid body, low thump and the echo tail: level, filter frequency (Hz), decay (s) of each. */
  crack: [number, number, number]
  body: [number, number, number]
  thump: [number, number, number]
  tail: [number, number]
  /** Distance (m) at which it is half as loud. */
  ref: number
}

const SHOTS: Record<Exclude<ShotSound, 'plasma' | 'launch'>, ShotRecipe> = {
  pistol: { crack: [0.45, 2600, 0.035], body: [0.55, 1800, 0.08], thump: [0.35, 150, 0.06], tail: [0.1, 0.35], ref: 18 },
  rifle: { crack: [0.55, 3000, 0.03], body: [0.65, 1400, 0.11], thump: [0.45, 115, 0.08], tail: [0.16, 0.55], ref: 25 },
  heavy: { crack: [0.55, 2200, 0.045], body: [0.85, 950, 0.15], thump: [0.7, 85, 0.12], tail: [0.22, 0.7], ref: 30 },
  sniper: { crack: [0.9, 3600, 0.05], body: [0.85, 1100, 0.2], thump: [0.75, 70, 0.16], tail: [0.4, 1.5], ref: 45 },
  mg: { crack: [0.65, 1800, 0.06], body: [1, 720, 0.24], thump: [1, 62, 0.2], tail: [0.42, 1.2], ref: 45 },
  gatling: { crack: [0.4, 2400, 0.028], body: [0.55, 1000, 0.065], thump: [0.4, 95, 0.05], tail: [0.07, 0.3], ref: 30 },
  cannon: { crack: [0.8, 1500, 0.08], body: [1.25, 480, 0.5], thump: [1.5, 42, 0.5], tail: [0.75, 2.4], ref: 75 },
}

/** The energy layer on each gun class: start and end pitch (Hz), level, decay (s). */
const ZAP: Partial<Record<ShotSound, [number, number, number, number]>> = {
  pistol: [2600, 700, 0.1, 0.07],
  rifle: [2200, 420, 0.12, 0.09],
  heavy: [1500, 260, 0.14, 0.12],
  sniper: [3400, 240, 0.2, 0.3],
  gatling: [1800, 500, 0.08, 0.05],
}

/** A looping sound following one vehicle (rotor thump, engine growl). */
interface Loop {
  id: string | null
  out: GainNode
  pan: StereoPannerNode
  air: BiquadFilterNode
  set: (rate: number, t: number) => void
}

export interface LoopSource {
  id: string
  kind: 'rotor' | 'car' | 'tank' | 'jet'
  position: THREE.Vector3
  /** Rotor 0..1 of full speed; engines: speed 0..1 of top speed. */
  rate: number
  /** Our own vehicle: always gets a voice, heard from inside. */
  own?: boolean
}

const SPEED_OF_SOUND = 343

export class GameAudio {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private noise!: AudioBuffer
  private listener = new THREE.Vector3()
  private right = new THREE.Vector3(1, 0, 0)
  private rotors: Loop[] = []
  private engines: Loop[] = []
  private jets: Loop[] = []
  private lockVoice: { osc: OscillatorNode; gain: GainNode } | null = null
  private lastImpactAt = 0

  /** Call from a click / key press: browsers only start audio after the player does something. */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.build(this.ctx)
      } catch (error) {
        console.warn('[audio] unavailable:', error)
        this.ctx = null
        return
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  private get live() {
    return this.ctx !== null && this.ctx.state === 'running'
  }

  private build(ctx: AudioContext) {
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -16
    compressor.knee.value = 12
    compressor.ratio.value = 4
    compressor.attack.value = 0.003
    compressor.release.value = 0.25
    compressor.connect(ctx.destination)
    this.master = ctx.createGain()
    this.master.gain.value = 0.6
    this.master.connect(compressor)
    // Two seconds of white noise: the raw material for shots, blasts, wind and rotors
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.rotors = [0, 1, 2].map(() => this.rotorLoop(ctx))
    this.engines = [0, 1, 2].map(() => this.engineLoop(ctx))
    this.jets = [0, 1].map(() => this.jetLoop(ctx))
    this.wind(ctx)
  }

  /** Where we hear from: the camera (call once a frame). */
  setListener(camera: THREE.Camera) {
    camera.getWorldPosition(this.listener)
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
  }

  // ------------------------------------------------------------ building blocks

  /** Looping white noise (seamless, so a long sound can start anywhere in the buffer); stop() it when done. */
  private noiseSource(ctx: AudioContext) {
    const source = ctx.createBufferSource()
    source.buffer = this.noise
    source.loop = true
    return source
  }

  /** A gain that jumps up and dies away: level, attack and decay in seconds from t. */
  private envelope(ctx: AudioContext, t: number, level: number, attack: number, decay: number) {
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(level, t + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    return gain
  }

  private filter(ctx: AudioContext, type: BiquadFilterType, frequency: number, q = 0.7) {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = frequency
    f.Q.value = q
    return f
  }

  /**
   * The way out for a sound: louder or quieter with distance, panned left / right, muffled far away, and late
   * by the time sound takes to get here. Null when it is too far to hear. `at` null = our own (right here).
   */
  private output(ctx: AudioContext, at: THREE.Vector3 | null, volume: number, ref: number): { input: AudioNode; t: number } | null {
    const t = ctx.currentTime + 0.005
    if (!at) {
      const gain = ctx.createGain()
      gain.gain.value = volume
      gain.connect(this.master)
      return { input: gain, t }
    }
    const offset = at.clone().sub(this.listener)
    const d = offset.length()
    const level = volume / (1 + Math.pow(d / ref, 1.25))
    if (level < 0.004) return null
    const gain = ctx.createGain()
    gain.gain.value = level
    const pan = ctx.createStereoPanner()
    pan.pan.value = d > 0.5 ? THREE.MathUtils.clamp(offset.dot(this.right) / d, -1, 1) * 0.8 : 0
    const air = this.filter(ctx, 'lowpass', THREE.MathUtils.clamp(22000 / (1 + d / 70), 700, 20000))
    gain.connect(pan).connect(air).connect(this.master)
    return { input: gain, t: t + (d > 30 ? d / SPEED_OF_SOUND : 0) }
  }

  /** A burst of filtered noise. */
  private burst(ctx: AudioContext, out: AudioNode, t: number, type: BiquadFilterType, frequency: number, level: number, attack: number, decay: number, q = 0.7) {
    const source = this.noiseSource(ctx)
    const env = this.envelope(ctx, t, level, attack, decay)
    source.connect(this.filter(ctx, type, frequency, q)).connect(env).connect(out)
    source.start(t, Math.random() * 1.5)
    source.stop(t + attack + decay + 0.05)
  }

  /** A tone sliding from one pitch to another as it dies away. */
  private tone(ctx: AudioContext, out: AudioNode, t: number, type: OscillatorType, from: number, to: number, level: number, attack: number, decay: number) {
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + attack + decay)
    const env = this.envelope(ctx, t, level, attack, decay)
    osc.connect(env).connect(out)
    osc.start(t)
    osc.stop(t + attack + decay + 0.05)
  }

  // ------------------------------------------------------------ one-shots

  /** A weapon going off; `at` null = ours. */
  shot(kind: ShotSound, at: THREE.Vector3 | null, volume = 1) {
    if (!this.live) return
    const ctx = this.ctx!
    if (kind === 'plasma') {
      const out = this.output(ctx, at, 0.7 * volume, 22)
      if (!out) return
      this.tone(ctx, out.input, out.t, 'sawtooth', 1400, 140, 0.35, 0.004, 0.28)
      this.tone(ctx, out.input, out.t, 'square', 700, 90, 0.18, 0.004, 0.22)
      this.burst(ctx, out.input, out.t, 'highpass', 5000, 0.2, 0.002, 0.15)
      return
    }
    if (kind === 'launch') {
      // Rocket motor: a whoosh rising then falling, with a pop at the start
      const out = this.output(ctx, at, 0.9 * volume, 35)
      if (!out) return
      const source = this.noiseSource(ctx)
      const band = this.filter(ctx, 'bandpass', 500, 1.1)
      band.frequency.setValueAtTime(400, out.t)
      band.frequency.exponentialRampToValueAtTime(2200, out.t + 0.25)
      band.frequency.exponentialRampToValueAtTime(700, out.t + 1.2)
      const env = this.envelope(ctx, out.t, 0.9, 0.03, 1.3)
      source.connect(band).connect(env).connect(out.input)
      source.start(out.t, Math.random())
      source.stop(out.t + 1.5)
      this.tone(ctx, out.input, out.t, 'sine', 130, 50, 0.7, 0.002, 0.18)
      return
    }
    const r = SHOTS[kind]
    const out = this.output(ctx, at, volume, r.ref)
    if (!out) return
    const vary = 0.9 + Math.random() * 0.2
    this.burst(ctx, out.input, out.t, 'highpass', r.crack[1] * vary, r.crack[0], 0.001, r.crack[2])
    this.burst(ctx, out.input, out.t, 'lowpass', r.body[1] * vary, r.body[0], 0.002, r.body[2])
    this.tone(ctx, out.input, out.t, 'sine', r.thump[1] * 1.8, r.thump[1] * 0.6, r.thump[0], 0.002, r.thump[2])
    // The report rolling back off the hills
    this.burst(ctx, out.input, out.t + 0.02, 'lowpass', 520, r.tail[0], 0.03, r.tail[1])
    // Sci-fi arms: a magnetic "zap" riding on each shot (rail-assisted rounds), deeper for the heavier guns
    const zap = ZAP[kind]
    if (zap) this.tone(ctx, out.input, out.t, 'sawtooth', zap[0] * vary, zap[1], zap[2], 0.001, zap[3])
  }

  /** Something blew up (size ~1 for a grenade, 2 for a vehicle). */
  explosion(at: THREE.Vector3 | null, size = 1) {
    if (!this.live) return
    const ctx = this.ctx!
    const out = this.output(ctx, at, 1.1 * Math.min(1.6, size), 70 * Math.sqrt(size))
    if (!out) return
    const { input, t } = out
    this.tone(ctx, input, t, 'sine', 70, 24, 1.3, 0.004, 0.9 + 0.2 * size)
    const source = this.noiseSource(ctx)
    const low = this.filter(ctx, 'lowpass', 2600)
    low.frequency.setValueAtTime(2600, t)
    low.frequency.exponentialRampToValueAtTime(110, t + 1.8)
    const env = this.envelope(ctx, t, 1.3, 0.006, 1.9 + 0.4 * size)
    source.connect(low).connect(env).connect(input)
    source.start(t, Math.random())
    source.stop(t + 2.6 + 0.4 * size)
    this.burst(ctx, input, t, 'highpass', 1800, 0.45, 0.002, 0.3)
    this.burst(ctx, input, t + 0.05, 'lowpass', 170, 0.6, 0.2, 2.8)
  }

  /** A round striking something near us: a ping off metal, a thud in dirt, a crack off stone. */
  impact(at: THREE.Vector3, surface: Surface) {
    if (!this.live || at.distanceTo(this.listener) > 45) return
    const ctx = this.ctx!
    // Automatic fire: not every round needs its own
    const now = ctx.currentTime
    if (now - this.lastImpactAt < 0.05) return
    this.lastImpactAt = now
    const out = this.output(ctx, at, 0.45, 8)
    if (!out) return
    if (surface === 'metal' || surface === 'robot') {
      this.tone(ctx, out.input, out.t, 'sine', 2600 + Math.random() * 1600, 1900, 0.25, 0.001, 0.14)
      this.burst(ctx, out.input, out.t, 'highpass', 4000, 0.3, 0.001, 0.03)
    } else if (surface === 'dirt' || surface === 'wood') {
      this.burst(ctx, out.input, out.t, 'lowpass', surface === 'wood' ? 900 : 550, 0.6, 0.001, 0.07)
    } else {
      this.burst(ctx, out.input, out.t, 'bandpass', 1700, 0.55, 0.001, 0.05, 1.4)
    }
  }

  /** A grenade knocking against something. */
  clink(at: THREE.Vector3, strength: number) {
    if (!this.live) return
    const ctx = this.ctx!
    const out = this.output(ctx, at, Math.min(0.4, strength * 0.06), 10)
    if (!out) return
    this.tone(ctx, out.input, out.t, 'triangle', 1850 + Math.random() * 400, 1500, 0.4, 0.001, 0.09)
    this.burst(ctx, out.input, out.t, 'lowpass', 700, 0.35, 0.001, 0.06)
  }

  /** Our own little sounds: reloading, pickups, hit markers. */
  ui(kind: UiSound) {
    if (!this.live) return
    const ctx = this.ctx!
    const out = this.output(ctx, null, 0.5, 1)!
    const { input, t } = out
    const click = (dt: number, hz: number, level: number) => this.burst(ctx, input, t + dt, 'bandpass', hz, level, 0.001, 0.025, 2)
    switch (kind) {
      case 'reload': click(0, 2600, 0.7); click(0.12, 1400, 0.5); break
      case 'reloaded': click(0, 1800, 0.8); click(0.09, 3200, 0.6); this.burst(ctx, input, t + 0.09, 'lowpass', 500, 0.35, 0.002, 0.05); break
      case 'empty': click(0, 4200, 0.6); break
      case 'switch': click(0, 2000, 0.45); click(0.07, 1300, 0.4); break
      case 'pickup': this.burst(ctx, input, t, 'lowpass', 700, 0.7, 0.005, 0.1); click(0.05, 2400, 0.35); break
      case 'pin':
        this.tone(ctx, input, t, 'sine', 3300, 3000, 0.12, 0.001, 0.25)
        this.tone(ctx, input, t, 'sine', 4900, 4500, 0.06, 0.001, 0.2)
        break
      case 'hit': this.tone(ctx, input, t, 'sine', 1500, 1400, 0.22, 0.001, 0.045); break
      case 'kill':
        this.tone(ctx, input, t, 'sine', 1500, 1450, 0.25, 0.001, 0.05)
        this.tone(ctx, input, t + 0.07, 'sine', 2100, 2050, 0.25, 0.001, 0.09)
        break
      case 'shield':
        this.tone(ctx, input, t, 'triangle', 900, 1400, 0.18, 0.002, 0.12)
        this.burst(ctx, input, t, 'highpass', 5000, 0.2, 0.001, 0.06)
        break
      case 'shieldDown':
        this.tone(ctx, input, t, 'square', 700, 350, 0.22, 0.002, 0.3)
        break
      case 'recharge':
        this.tone(ctx, input, t, 'sine', 400, 1600, 0.16, 0.05, 0.7)
        break
      case 'melee':
        this.burst(ctx, input, t, 'bandpass', 900, 0.5, 0.002, 0.12, 1)
        break
      case 'announce':
        this.tone(ctx, input, t, 'sawtooth', 220, 220, 0.12, 0.01, 0.35)
        this.tone(ctx, input, t + 0.12, 'sawtooth', 330, 330, 0.12, 0.01, 0.35)
        this.tone(ctx, input, t + 0.24, 'sawtooth', 440, 440, 0.14, 0.01, 0.5)
        break
      case 'hurt':
        this.tone(ctx, input, t, 'sine', 110, 55, 0.6, 0.002, 0.16)
        this.burst(ctx, input, t, 'lowpass', 400, 0.4, 0.002, 0.1)
        break
    }
  }

  /** Launcher lock-on: beeps while locking (faster as it builds), a steady tone once locked, silence at -1. */
  lockTone(progress: number, time: number) {
    if (!this.live) return
    const ctx = this.ctx!
    if (!this.lockVoice) {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      const gain = ctx.createGain()
      gain.gain.value = 0
      osc.connect(this.filter(ctx, 'lowpass', 2500)).connect(gain).connect(this.master)
      osc.start()
      this.lockVoice = { osc, gain }
    }
    const { osc, gain } = this.lockVoice
    let level = 0
    if (progress >= 1) {
      osc.frequency.setTargetAtTime(1250, ctx.currentTime, 0.01)
      level = 0.07
    } else if (progress >= 0) {
      osc.frequency.setTargetAtTime(900, ctx.currentTime, 0.01)
      const rate = 3 + progress * 9
      level = (time * rate) % 1 < 0.35 ? 0.06 : 0
    }
    gain.gain.setTargetAtTime(level, ctx.currentTime, 0.008)
  }

  // ------------------------------------------------------------ loops

  /** Soft wind, always there. */
  private wind(ctx: AudioContext) {
    const source = this.noiseSource(ctx)
    const low = this.filter(ctx, 'lowpass', 380)
    const gain = ctx.createGain()
    gain.gain.value = 0.035
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.09
    const depth = ctx.createGain()
    depth.gain.value = 0.02
    lfo.connect(depth).connect(gain.gain)
    source.connect(low).connect(gain).connect(this.master)
    source.start()
    lfo.start()
  }

  private loopOut(ctx: AudioContext) {
    const out = ctx.createGain()
    out.gain.value = 0
    const pan = ctx.createStereoPanner()
    const air = this.filter(ctx, 'lowpass', 20000)
    out.connect(pan).connect(air).connect(this.master)
    return { out, pan, air }
  }

  /** Blades chopping the air (a noise band pulsed at the blade rate) and the turbine's whine. */
  private rotorLoop(ctx: AudioContext): Loop {
    const { out, pan, air } = this.loopOut(ctx)
    const source = this.noiseSource(ctx)
    const band = this.filter(ctx, 'bandpass', 110, 1.1)
    const chop = ctx.createGain()
    chop.gain.value = 0.55
    const lfo = ctx.createOscillator()
    lfo.type = 'triangle'
    const depth = ctx.createGain()
    depth.gain.value = 0.5
    lfo.connect(depth).connect(chop.gain)
    source.connect(band).connect(chop).connect(out)
    const whine = ctx.createOscillator()
    whine.type = 'triangle'
    const whineGain = ctx.createGain()
    whineGain.gain.value = 0.05
    whine.connect(whineGain).connect(out)
    source.start()
    lfo.start()
    whine.start()
    return {
      id: null, out, pan, air,
      set: (rate, t) => {
        lfo.frequency.setTargetAtTime(4 + rate * 17, t, 0.2)
        band.frequency.setTargetAtTime(80 + rate * 60, t, 0.2)
        whine.frequency.setTargetAtTime(300 + rate * 900, t, 0.3)
        whineGain.gain.setTargetAtTime(0.04 * rate, t, 0.3)
      },
    }
  }

  /** A fighter's engines: a roar of air that deepens and swells with thrust, over a rising turbine whine. */
  private jetLoop(ctx: AudioContext): Loop {
    const { out, pan, air } = this.loopOut(ctx)
    const source = this.noiseSource(ctx)
    const roar = this.filter(ctx, 'lowpass', 500, 0.7)
    const body = this.filter(ctx, 'bandpass', 180, 0.8)
    const roarGain = ctx.createGain()
    roarGain.gain.value = 0.5
    source.connect(roar).connect(roarGain).connect(out)
    source.connect(body).connect(out)
    const whine = ctx.createOscillator(), whine2 = ctx.createOscillator()
    whine.type = 'sawtooth'
    whine2.type = 'sine'
    const whineFilter = this.filter(ctx, 'bandpass', 2000, 4)
    const whineGain = ctx.createGain()
    whineGain.gain.value = 0.03
    whine.connect(whineFilter).connect(whineGain).connect(out)
    whine2.connect(whineGain)
    source.start(); whine.start(); whine2.start()
    return {
      id: null, out, pan, air,
      set: (rate, t) => {
        roar.frequency.setTargetAtTime(350 + rate * 2600, t, 0.25)
        roarGain.gain.setTargetAtTime(0.25 + rate * 0.75, t, 0.25)
        whine.frequency.setTargetAtTime(900 + rate * 2400, t, 0.4)
        whine2.frequency.setTargetAtTime(1800 + rate * 3200, t, 0.4)
        whineFilter.frequency.setTargetAtTime(1500 + rate * 3000, t, 0.4)
        whineGain.gain.setTargetAtTime(0.02 + rate * 0.03, t, 0.3)
      },
    }
  }

  /** A combustion engine (two buzzing oscillators through a filter that opens with the revs) and, for tanks, track clatter. */
  private engineLoop(ctx: AudioContext): Loop {
    const { out, pan, air } = this.loopOut(ctx)
    const a = ctx.createOscillator(), b = ctx.createOscillator()
    a.type = b.type = 'sawtooth'
    const low = this.filter(ctx, 'lowpass', 400, 2)
    const mix = ctx.createGain()
    mix.gain.value = 0.35
    a.connect(low)
    b.connect(low)
    low.connect(mix).connect(out)
    // Tracks: a noise band pulsed with the speed
    const source = this.noiseSource(ctx)
    const band = this.filter(ctx, 'bandpass', 320, 1.5)
    const clatter = ctx.createGain()
    clatter.gain.value = 0
    const lfo = ctx.createOscillator()
    lfo.type = 'square'
    const depth = ctx.createGain()
    depth.gain.value = 0
    lfo.connect(depth).connect(clatter.gain)
    source.connect(band).connect(clatter).connect(out)
    a.start(); b.start(); source.start(); lfo.start()
    let tank = false
    const loop: Loop & { tank: (on: boolean) => void } = {
      id: null, out, pan, air,
      tank: (on) => { tank = on },
      set: (rate, t) => {
        const base = tank ? 30 : 42
        a.frequency.setTargetAtTime(base + rate * (tank ? 38 : 75), t, 0.15)
        b.frequency.setTargetAtTime((base + rate * (tank ? 38 : 75)) * 1.51, t, 0.15)
        low.frequency.setTargetAtTime(tank ? 260 + rate * 500 : 350 + rate * 1100, t, 0.15)
        clatter.gain.setTargetAtTime(tank ? 0.12 * Math.min(1, rate * 3) : 0, t, 0.2)
        depth.gain.setTargetAtTime(tank ? 0.1 * Math.min(1, rate * 3) : 0, t, 0.2)
        lfo.frequency.setTargetAtTime(3 + rate * 16, t, 0.2)
      },
    }
    return loop
  }

  /** Give the nearest running vehicles a voice each (ours first) and keep them following their vehicle. */
  updateLoops(sources: LoopSource[]) {
    if (!this.live) return
    const ctx = this.ctx!
    const t = ctx.currentTime
    const assign = (pool: Loop[], list: LoopSource[], ref: number, volume: (s: LoopSource) => number) => {
      const chosen = list
        .map((s) => ({ s, d: s.position.distanceTo(this.listener) }))
        .filter((c) => c.s.own || c.d < ref * 14)
        .sort((x, y) => (x.s.own ? -1 : y.s.own ? 1 : x.d - y.d))
        .slice(0, pool.length)
      // Keep voices on the vehicles they already follow so nothing jumps
      const free = pool.filter((v) => !chosen.some((c) => c.s.id === v.id))
      for (const c of chosen) {
        let voice = pool.find((v) => v.id === c.s.id)
        if (!voice) { voice = free.shift()!; voice.id = c.s.id }
        const kind = c.s.kind
        ;(voice as Loop & { tank?: (on: boolean) => void }).tank?.(kind === 'tank')
        voice.set(c.s.rate, t)
        const level = c.s.own ? volume(c.s) * 0.55 : volume(c.s) / (1 + Math.pow(c.d / ref, 1.3))
        voice.out.gain.setTargetAtTime(level, t, 0.12)
        const offset = c.s.position.clone().sub(this.listener)
        voice.pan.pan.setTargetAtTime(c.s.own || c.d < 1 ? 0 : THREE.MathUtils.clamp(offset.dot(this.right) / c.d, -1, 1) * 0.8, t, 0.1)
        voice.air.frequency.setTargetAtTime(c.s.own ? 20000 : THREE.MathUtils.clamp(22000 / (1 + c.d / 70), 600, 20000), t, 0.2)
      }
      for (const voice of free) {
        voice.id = null
        voice.out.gain.setTargetAtTime(0, t, 0.3)
      }
    }
    assign(this.rotors, sources.filter((s) => s.kind === 'rotor'), 40, (s) => 0.9 * Math.min(1, s.rate * 1.3))
    assign(this.engines, sources.filter((s) => s.kind === 'car' || s.kind === 'tank'), 15, (s) => (s.kind === 'tank' ? 0.55 : 0.4) * (0.45 + 0.55 * s.rate))
    assign(this.jets, sources.filter((s) => s.kind === 'jet'), 60, (s) => 0.35 + 0.55 * s.rate)
  }

  dispose() {
    void this.ctx?.close()
    this.ctx = null
  }
}
