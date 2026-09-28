import { BASE_CENTER, GEM_PEDESTAL, baseToWorld, type Team } from './game-layout'
import { heightAt } from './terrain'

/**
 * Computer-controlled players. Each bot runs on the server as a player of its own and plays like one: on foot it
 * pushes into the enemy base with its squad, steals the gem and carries it home; or it takes a vehicle — a tank
 * or mech to shell the enemy gate, a battle buggy to hose enemies with its gatling, a gunship or a fighter to
 * attack from the air (fighters also go after the enemy capital ship) — or it defends its base from a pulse
 * cannon. It fights whoever it can see, gets shot, dies and respawns like anyone, and chooses again.
 */
export type Vec3 = [number, number, number]
type Kind = 'heli' | 'car' | 'tank' | 'mech' | 'fighter'

const EYE = 1.7
/** On foot: running, and walking while shooting. */
const RUN = 7
const FIGHT_WALK = 3.2
const SIGHT = 70
/** How near the enemy gem a bot must get to grab it; a waypoint counts as reached closer than ARRIVE. */
const GRAB = 5
const ARRIVE = 3.5
/** Below this the ground is lake: vehicles steer round it. */
const DEEP_WATER = -6.5
/** A round's damage for each weapon a bot uses (the same as a player's). */
export const BOT_WEAPON_POWER: Record<string, number> = { primary: 11, 'car-gun': 9, 'mech-cannon': 22, 'heli-gun': 10, 'fighter-laser': 10 }

/** Each vehicle type: how fast it goes (m/s), turns (rad/s), how far it fights, its gun, how often it fires. */
const RIDE: Record<Kind, { speed: number; turn: number; range: number; gun: string | null; gap: number; air: boolean }> = {
  car: { speed: 16, turn: 1.2, range: 150, gun: 'car-gun', gap: 0.12, air: false },
  tank: { speed: 7, turn: 0.6, range: 260, gun: null, gap: 3.2, air: false },
  mech: { speed: 5.5, turn: 0.9, range: 200, gun: 'mech-cannon', gap: 0.22, air: false },
  heli: { speed: 26, turn: 0.9, range: 190, gun: 'heli-gun', gap: 0.1, air: true },
  fighter: { speed: 72, turn: 1.1, range: 320, gun: 'fighter-laser', gap: 0.09, air: true },
}
/** What each bot of a team prefers, by its number: foot attackers, a tank, a fighter, a defender, a buggy... */
const PREFERENCE: Array<'attack' | 'defend' | Kind> = ['attack', 'tank', 'fighter', 'defend', 'car', 'heli', 'attack', 'mech']

/** Everyone a bot might see. */
export interface BotSeen {
  id: string
  team: Team
  /** Eye position (or the vehicle's position). */
  p: Vec3
  alive: boolean
  /** Carrying an enemy gem. */
  flag: boolean
  /** The vehicle they're in, if any, and whether it's an aircraft off the ground. */
  vehicle: string | null
  airborne: boolean
  moving: boolean
}
export interface VehicleSeen { id: string; kind: Kind; team: Team; p: Vec3; driver: string | null; wrecked: boolean }
export interface GunSeen { id: string; team: Team; x: number; z: number; facing: number; occupant: string | null }

/** What the game lets a bot see and do. */
export interface BotWorld {
  everyone: BotSeen[]
  vehicles: VehicleSeen[]
  guns: GunSeen[]
  /** Is this team's gem off its pedestal? */
  gemTaken: (team: Team) => boolean
  /** Rounds at a player / a vehicle / a capital ship; `hit` whether they connect. */
  shootPlayer: (target: string, weapon: string, hit: boolean, to: Vec3) => void
  shootVehicle: (target: string, weapon: string, hit: boolean, to: Vec3) => void
  shootShip: (team: Team, weapon: string, hit: boolean, to: Vec3) => void
  /** A shell, rocket or pulse bolt flying from `from` to `to` (the blast there does the damage). */
  fire: (kind: 'shell' | 'rocket' | 'pulse', from: Vec3, to: Vec3) => void
  /** Take a vehicle's driver seat / a gun (false if someone else has it). */
  claimVehicle: (id: string) => boolean
  claimGun: (id: string) => boolean
  /** Deliver the gem we carry (at our pedestal). */
  capture: () => void
}

/** A bot's pose as a player state (what everyone else sees). */
export interface BotPose {
  p: Vec3
  yaw: number
  pitch: number
  flag: boolean
  vehicle: { id: string; seat: 0; p: Vec3; r: Vec3; spin: number; aim: [number, number] } | null
  gun: { id: string; yaw: number; pitch: number } | null
}

const other = (team: Team): Team => (team === 'blue' ? 'red' : 'blue')
const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2])
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
/** A point in a base's frame (gate towards +Z), on the ground plus `lift`. */
const at = (team: Team, x: number, z: number, lift = EYE): Vec3 => {
  const [wx, wz] = baseToWorld(team, x, z)
  return [wx, heightAt(wx, wz) + lift, wz]
}
/** Heading (the players' convention: forward is (-sin, -cos)) from `a` towards `b`. */
const headingTo = (a: Vec3, b: Vec3) => Math.atan2(-(b[0] - a[0]), -(b[2] - a[2]))
/** Heading in the vehicles' convention (forward is (+sin, +cos)). */
const courseTo = (a: Vec3, b: Vec3) => Math.atan2(b[0] - a[0], b[2] - a[2])
const inBase = (p: Vec3) => (['blue', 'red'] as Team[]).find((t) => Math.max(Math.abs(p[0] - BASE_CENTER[t].x), Math.abs(p[2] - BASE_CENTER[t].z)) < 53) ?? null

/** World XZ → a base's own frame (the inverse of baseToWorld). */
const BASE_ROT: Record<Team, number> = { blue: Math.PI / 2, red: -Math.PI / 2 }
function toBase(team: Team, p: Vec3): [number, number] {
  const dx = p[0] - BASE_CENTER[team].x, dz = p[2] - BASE_CENTER[team].z, a = BASE_ROT[team]
  return [dx * Math.cos(a) - dz * Math.sin(a), dx * Math.sin(a) + dz * Math.cos(a)]
}
/** Inside the walls (the gateway counts as inside until you're through it). */
const within = (l: [number, number], half = 53) => (Math.abs(l[0]) < half && Math.abs(l[1]) < half) || (half === 53 && Math.abs(l[0]) < 8 && l[1] > 30 && l[1] < 58)
/** Does the straight line a→b (base frame) cut through the walled square? */
function crosses(a: [number, number], b: [number, number]) {
  for (let i = 1; i < 24; i++) {
    const t = i / 24
    if (within([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], 53.5)) return true
  }
  return false
}
/** Round the outside of a base from a to b (base frame): via one corner, or two. */
function around(a: [number, number], b: [number, number]): Array<[number, number]> {
  if (!crosses(a, b)) return []
  const C = 62
  const corners: Array<[number, number]> = [[C, C], [-C, C], [-C, -C], [C, -C]]
  const len = (pts: Array<[number, number]>) => pts.reduce((sum, q, i) => (i ? sum + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) : 0), 0)
  let best: Array<[number, number]> = []
  let bestLen = Infinity
  for (const c of corners) {
    if (!crosses(a, c) && !crosses(c, b) && len([a, c, b]) < bestLen) { best = [c]; bestLen = len([a, c, b]) }
  }
  if (best.length) return best
  for (let i = 0; i < 4; i++) {
    for (const j of [(i + 1) % 4, (i + 3) % 4]) {
      const c1 = corners[i], c2 = corners[j]
      if (!crosses(a, c1) && !crosses(c2, b) && len([a, c1, c2, b]) < bestLen) { best = [c1, c2]; bestLen = len([a, c1, c2, b]) }
    }
  }
  return best
}
/**
 * The waypoints to walk (or drive) from `from` to `to` (ending with `to`) without going through a base's walls:
 * out through the gate of a base we're in, round the outside of any base in the way, in through the gate of the
 * base we're going into.
 */
function path(from: Vec3, to: Vec3, lift = EYE): Vec3[] {
  const out: Vec3[] = []
  let cur = from
  for (const team of ['blue', 'red'] as Team[]) {
    const lf = toBase(team, cur), lt = toBase(team, to)
    if (within(lf) && !within(lt)) {
      // In the gateway already (heading out)? Else first to the inside of the gate
      if (!(Math.abs(lf[0]) < 8 && lf[1] > 40)) out.push(at(team, 0, 44, lift))
      out.push((cur = at(team, 0, 62, lift)))
    }
  }
  const into = (['blue', 'red'] as Team[]).find((team) => within(toBase(team, to)) && !within(toBase(team, cur)))
  const entry = into ? at(into, 0, 62, lift) : to
  for (const team of ['blue', 'red'] as Team[]) {
    for (const [x, z] of around(toBase(team, cur), toBase(team, entry))) out.push(at(team, x, z, lift))
  }
  if (into) out.push(entry, at(into, 0, 44, lift))
  out.push(to)
  return out
}

/** Could someone at `from` see `to`? Hills get in the way, and so do base walls (except through the gate). */
export function canSee(from: Vec3, to: Vec3): boolean {
  for (let i = 1; i < 10; i++) {
    const t = i / 10
    const x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t
    if (heightAt(x, z) > from[1] + (to[1] - from[1]) * t - 0.3) return false
  }
  const a = inBase(from), b = inBase(to)
  if (a !== b) {
    // One inside a base's walls: only in sight through its gate (or from high above)
    const base = (a ?? b)!
    const outside = a ? to : from
    if (outside[1] - heightAt(outside[0], outside[2]) < 25 && flat(outside, at(base, 0, 55)) > 30) return false
  }
  return true
}

/** Squads: each team's attackers take the same side of the field for a while, so they push together. */
const squadSide: Record<Team, { side: number; until: number }> = { blue: { side: 0, until: 0 }, red: { side: 0, until: 0 } }
function squadLateral(team: Team) {
  const now = Date.now()
  if (now > squadSide[team].until) squadSide[team] = { side: (Math.random() - 0.5) * 220, until: now + 90_000 }
  return squadSide[team].side
}

interface Ride { id: string; kind: Kind; p: Vec3; yaw: number; pitch: number; roll: number; speed: number; aimYaw: number; aimPitch: number; phase: 'takeoff' | 'go' | 'hold'; spaceRun: boolean; orbit: number }

export class Bot {
  readonly id: string
  readonly team: Team
  private readonly index: number
  p: Vec3
  yaw = 0
  pitch = 0
  flag = false
  moving = false
  private plan: 'attack' | 'defend' | Kind = 'attack'
  private ride: Ride | null = null
  private gun: GunSeen | null = null
  private boarding: string | null = null
  private route: Vec3[] = []
  private shotTimer = Math.random() * 0.3
  private lateral = 0
  private wasDead = false
  private lives = 0

  constructor(id: string, team: Team, index: number) {
    this.id = id
    this.team = team
    this.index = index
    this.p = this.spawnPoint()
    this.choose()
  }

  private spawnPoint(): Vec3 {
    const i = this.index % 8
    return at(this.team, -7 + i * 2 + (Math.random() - 0.5), 37 + Math.random() * 3)
  }

  /** What to do this life: mostly what this bot likes, sometimes something else. */
  private choose() {
    this.lives++
    const liked = PREFERENCE[this.index % PREFERENCE.length]
    this.plan = Math.random() < 0.75 ? liked : PREFERENCE[Math.floor(Math.random() * PREFERENCE.length)]
    this.lateral = (Math.random() - 0.5) * 16
    this.route = []
    this.ride = null
    this.gun = null
    this.boarding = null
  }

  /** The pose everyone else sees. */
  pose(): BotPose {
    const r = this.ride
    if (r) {
      const eye: Vec3 = [r.p[0], r.p[1] + (r.kind === 'mech' ? 6.5 : r.kind === 'tank' ? 3 : 2.2), r.p[2]]
      return {
        p: eye, yaw: this.yaw, pitch: this.pitch, flag: false, gun: null,
        vehicle: { id: r.id, seat: 0, p: [...r.p] as Vec3, r: [r.pitch, r.yaw, r.roll], spin: r.kind === 'heli' ? 100 : r.speed, aim: [r.aimYaw, r.aimPitch] },
      }
    }
    return { p: [...this.p] as Vec3, yaw: this.yaw, pitch: this.pitch, flag: this.flag, vehicle: null, gun: this.gun ? { id: this.gun.id, yaw: wrap(this.yaw + Math.PI - this.gun.facing), pitch: -this.pitch } : null }
  }

  /** The vehicle this bot drives (its pose is the vehicle's while it does). */
  get vehicleId() { return this.ride?.id ?? null }
  get gunId() { return this.gun?.id ?? null }

  /** Pulled out of its vehicle / off its gun (hijacked): on foot where it was, and it fights on foot this life. */
  dismount() {
    if (this.ride) this.p = [this.ride.p[0] + 2.5, heightAt(this.ride.p[0] + 2.5, this.ride.p[2]) + EYE, this.ride.p[2]]
    this.ride = null
    this.gun = null
    this.plan = 'attack'
    this.route = []
  }

  /** One tick. Returns false while dead (nothing to show). */
  update(dt: number, alive: boolean, world: BotWorld): boolean {
    if (!alive) {
      this.wasDead = true
      this.moving = false
      return false
    }
    if (this.wasDead) {
      this.wasDead = false
      this.p = this.spawnPoint()
      this.flag = false
      this.choose()
    }
    if (this.ride) this.drive(dt, this.ride, world)
    else if (this.gun) this.manGun(dt, this.gun, world)
    else this.onFoot(dt, world)
    return true
  }

  // ------------------------------------------------------------------ targets

  /** The nearest enemy this bot can see within `range` (players on foot or in vehicles, and vehicles with enemies aboard). */
  private pickTarget(from: Vec3, range: number, world: BotWorld, opts: { air?: boolean; ground?: boolean } = { air: true, ground: true }): BotSeen | null {
    let best: BotSeen | null = null
    let bestD = range
    for (const e of world.everyone) {
      if (e.team === this.team || !e.alive) continue
      if (e.airborne ? !opts.air : !opts.ground) continue
      const d = dist(from, e.p)
      if (d < bestD && canSee(from, e.p)) { best = e; bestD = d }
    }
    return best
  }

  /** Fire a round at someone (at their vehicle if they're in one). */
  private shootAt(target: BotSeen, weapon: string, from: Vec3, world: BotWorld, accuracy: number) {
    const d = dist(from, target.p)
    const chance = Math.max(0.06, Math.min(0.6, accuracy - d / 160)) * (target.moving ? 0.75 : 1)
    const hit = Math.random() < chance
    const miss = hit ? 0 : 0.8 + Math.random() * 2.5
    const a = Math.random() * Math.PI * 2
    const to: Vec3 = [target.p[0] + Math.cos(a) * miss, target.p[1] - 0.4 + (Math.random() - 0.5) * miss, target.p[2] + Math.sin(a) * miss]
    if (target.vehicle) world.shootVehicle(target.vehicle, weapon, hit, to)
    if (!target.vehicle || !target.vehicle.includes('-tank-') && !target.vehicle.includes('-mech-')) world.shootPlayer(target.id, weapon, hit, to)
  }

  // ------------------------------------------------------------------ on foot

  private onFoot(dt: number, world: BotWorld) {
    const enemies = world.everyone.filter((e) => e.team !== this.team && e.alive)
    const thief = enemies.find((e) => e.flag && !e.vehicle)
    const enemyTeam = other(this.team)

    // Grab the enemy gem when we reach it; deliver it at home
    const enemyGem = GEM_PEDESTAL[enemyTeam]
    if (!this.flag && !world.gemTaken(enemyTeam) && Math.hypot(this.p[0] - enemyGem[0], this.p[2] - enemyGem[1]) < GRAB) {
      this.flag = true
      this.route = []
    }
    if (this.flag && Math.hypot(this.p[0] - GEM_PEDESTAL[this.team][0], this.p[2] - GEM_PEDESTAL[this.team][1]) < 10) world.capture()

    // A vehicle or a gun to take?
    if (!this.flag && !thief && this.plan !== 'attack') {
      if (this.plan === 'defend') {
        // Man a pulse cannon when enemy vehicles come near (or now and then anyway)
        const threat = enemies.find((e) => e.vehicle && flat(e.p, at(this.team, 0, 0)) < 320)
        if (!this.boarding && (threat || Math.random() < 0.004)) {
          const free = world.guns.filter((g) => g.team === this.team && !g.occupant)
          this.boarding = free.sort((a, b) => Math.hypot(a.x - this.p[0], a.z - this.p[2]) - Math.hypot(b.x - this.p[0], b.z - this.p[2]))[0]?.id ?? null
        }
        const gun = this.boarding ? world.guns.find((g) => g.id === this.boarding) : undefined
        if (this.boarding && (!gun || gun.occupant)) this.boarding = null
        else if (gun) {
          if (Math.hypot(gun.x - this.p[0], gun.z - this.p[2]) < 4.5 && world.claimGun(gun.id)) { this.gun = gun; this.boarding = null; return }
          this.route = this.via([gun.x, heightAt(gun.x, gun.z) + EYE, gun.z])
        }
      } else {
        const kind = this.plan
        const v = this.boarding ? world.vehicles.find((x) => x.id === this.boarding) : world.vehicles
          .filter((x) => x.kind === kind && x.team === this.team && !x.driver && !x.wrecked && flat(x.p, this.p) < 160 && x.p[1] - heightAt(x.p[0], x.p[2]) < 4)
          .sort((a, b) => flat(a.p, this.p) - flat(b.p, this.p))[0]
        if (!v || v.driver || v.wrecked) {
          this.boarding = null
          this.plan = 'attack'
        } else {
          this.boarding = v.id
          if (flat(v.p, this.p) < 5 && Math.abs(v.p[1] - (this.p[1] - EYE)) < 4 && world.claimVehicle(v.id)) {
            this.ride = { id: v.id, kind, p: [...v.p] as Vec3, yaw: 0, pitch: 0, roll: 0, speed: 0, aimYaw: 0, aimPitch: 0, phase: RIDE[kind].air ? 'takeoff' : 'go', spaceRun: kind === 'fighter' && this.lives % 3 === 0, orbit: Math.random() * Math.PI * 2 }
            this.ride.yaw = courseTo(v.p, at(this.team, 0, 90, 0))
            this.route = []
            return
          }
          this.route = this.via([v.p[0], heightAt(v.p[0], v.p[2]) + EYE, v.p[2]])
        }
      }
    }

    // The target in sight, and where to go
    const target = this.pickTarget(this.p, this.plan === 'defend' ? SIGHT + 15 : SIGHT, world, { air: false, ground: true })
    let goal: Vec3 | null = null
    if (thief && !this.flag) goal = thief.p
    else {
      if (!this.route.length) this.planRoute()
      // (bounded: a route is at most a handful of points)
      for (let i = 0; i < 8 && this.route.length && flat(this.p, this.route[0]) < ARRIVE; i++) this.route.shift()
      if (!this.route.length) this.planRoute()
      goal = this.route[0] ?? null
    }

    const d = target ? dist(this.p, target.p) : Infinity
    const speed = target && !this.flag ? FIGHT_WALK : RUN
    this.moving = false
    // Stand and fight someone close — unless we're pushing in on the enemy gem
    const pushing = Math.hypot(this.p[0] - enemyGem[0], this.p[2] - enemyGem[1]) < 45
    if (goal && !(target && d < 12 && !this.flag && !thief && !pushing)) {
      const dx = goal[0] - this.p[0], dz = goal[2] - this.p[2]
      const len = Math.hypot(dx, dz)
      if (len > 0.5) {
        const step = Math.min(len, speed * dt)
        this.p[0] = Math.max(-485, Math.min(485, this.p[0] + (dx / len) * step))
        this.p[2] = Math.max(-485, Math.min(485, this.p[2] + (dz / len) * step))
        this.moving = true
        if (!target) this.yaw = Math.atan2(-dx, -dz)
      }
    }
    this.p[1] = heightAt(this.p[0], this.p[2]) + EYE

    if (target) {
      this.yaw = headingTo(this.p, target.p)
      this.pitch = Math.atan2(target.p[1] - this.p[1], flat(this.p, target.p))
      this.shotTimer -= dt
      if (this.shotTimer <= 0) {
        this.shotTimer = 0.3 * (0.8 + Math.random() * 0.5)
        this.shootAt(target, 'primary', this.p, world, 0.62)
      }
    } else this.pitch *= 0.9
  }

  /** A route to `goal` that doesn't go through walls. */
  private via(goal: Vec3): Vec3[] {
    return path(this.p, goal)
  }

  /** The way to go on foot: to the enemy gem (with the squad), home with it, or round our gate. */
  private planRoute() {
    const enemy = other(this.team)
    const side = squadLateral(this.team) + this.lateral
    const mid: Vec3 = [side * 0.7, 0, -side * 0.7]
    mid[1] = heightAt(mid[0], mid[2]) + EYE
    const gem = (team: Team): Vec3 => [GEM_PEDESTAL[team][0], heightAt(GEM_PEDESTAL[team][0], GEM_PEDESTAL[team][1]) + EYE, GEM_PEDESTAL[team][1]]
    // Across the middle unless we're already past it
    const viaMid = (goal: Vec3) => (flat(this.p, goal) > flat(mid, goal) + 40 ? [...path(this.p, mid), ...path(mid, goal)] : path(this.p, goal))
    if (this.flag) this.route = viaMid(gem(this.team))
    else if (this.plan === 'defend') {
      const spots = [at(this.team, 0, 66), at(this.team, -14, 58), at(this.team, 14, 58), at(this.team, -8, 10)]
      this.route = path(this.p, spots[Math.floor(Math.random() * spots.length)])
    } else this.route = viaMid(gem(enemy))
  }

  // ------------------------------------------------------------------ guns

  /** On a base's pulse cannon: turn onto the nearest threat and fire burst after burst. */
  private manGun(dt: number, gun: GunSeen, world: BotWorld) {
    const ground = heightAt(gun.x, gun.z)
    this.moving = false
    const muzzle: Vec3 = [gun.x, ground + 2.3, gun.z]
    const target = this.pickTarget(muzzle, 420, world)
    // Standing behind the gun, looking along the barrel
    const stand = () => { this.p = [gun.x + Math.sin(this.yaw) * 2, ground + EYE, gun.z + Math.cos(this.yaw) * 2] }
    if (!target) {
      stand()
      // Nothing in range for a while: back on foot
      if (Math.random() < dt / 20) { this.gun = null; this.plan = 'defend' }
      return
    }
    this.yaw = headingTo(muzzle, target.p)
    stand()
    this.pitch = Math.atan2(target.p[1] - muzzle[1], flat(muzzle, target.p))
    this.shotTimer -= dt
    if (this.shotTimer > 0) return
    this.shotTimer = 0.62 + Math.random() * 0.2
    const d = dist(muzzle, target.p)
    const spread = target.airborne ? 2 + d / 60 : 1 + d / 90
    const to: Vec3 = [target.p[0] + (Math.random() - 0.5) * spread, target.p[1] - 0.8 + (Math.random() - 0.5) * spread, target.p[2] + (Math.random() - 0.5) * spread]
    world.fire('pulse', muzzle, to)
  }

  // ------------------------------------------------------------------ vehicles

  private drive(dt: number, r: Ride, world: BotWorld) {
    const spec = RIDE[r.kind]
    const enemy = other(this.team)
    const ground = heightAt(r.p[0], r.p[2])
    // Where to go: the enemy gate (ground), round the enemy base (air), or the enemy capital ship (space run)
    let goal: Vec3
    let cruiseAlt = 0
    if (r.kind === 'fighter') {
      if (r.spaceRun) {
        const c = enemy === 'blue' ? [-304, 760, -304] : [304, 760, 304]
        r.orbit += dt * 0.35
        goal = [c[0] + Math.cos(r.orbit) * 230, c[1], c[2] + Math.sin(r.orbit) * 230]
      } else {
        // Wide circles over the approaches to the enemy base
        r.orbit += dt * 0.4
        const c = [BASE_CENTER[enemy].x * 0.55, 0, BASE_CENTER[enemy].z * 0.55]
        goal = [c[0] + Math.cos(r.orbit) * 150, heightAt(c[0], c[2]) + 110, c[2] + Math.sin(r.orbit) * 150]
      }
      cruiseAlt = goal[1]
    } else if (r.kind === 'heli') {
      r.orbit += dt * 0.25
      const c = at(enemy, 0, 50, 0)
      goal = [c[0] + Math.cos(r.orbit) * 70, 0, c[2] + Math.sin(r.orbit) * 70]
      cruiseAlt = heightAt(goal[0], goal[2]) + 42
      goal[1] = cruiseAlt
    } else {
      if (!this.route.length) {
        const side = squadLateral(this.team) + this.lateral * 3
        const mid: Vec3 = [side * 0.7, 0, -side * 0.7]
        mid[1] = heightAt(mid[0], mid[2])
        const dest = at(enemy, 20 * Math.sign(this.lateral || 1), 110, 0)
        this.route = r.phase === 'hold'
          ? path(r.p, at(enemy, 40 * Math.sign(this.lateral || 1), 105, 0), 0).concat([at(enemy, -40 * Math.sign(this.lateral || 1), 115, 0)])
          : [...path(r.p, mid, 0), ...path(mid, dest, 0)]
      }
      for (let i = 0; i < 6 && this.route.length && flat(r.p, this.route[0]) < 8; i++) {
        this.route.shift()
        if (!this.route.length) { r.phase = 'hold'; break }
      }
      goal = this.route[0] ?? at(enemy, 0, 110, 0)
    }

    // Weapons first: they may pull the nose round
    const muzzle: Vec3 = [r.p[0], r.p[1] + (r.kind === 'tank' ? 2.8 : r.kind === 'mech' ? 5.5 : 1.5), r.p[2]]
    const target = this.pickTarget(muzzle, spec.range, world, { air: r.kind !== 'tank', ground: true })
    this.shotTimer -= dt
    if (target) {
      const course = courseTo(r.p, target.p)
      r.aimYaw = wrap(course - r.yaw)
      r.aimPitch = Math.atan2(target.p[1] - muzzle[1], flat(muzzle, target.p))
      // Aircraft bring their nose onto the target to strafe it
      if (spec.air && r.phase !== 'takeoff') goal = [target.p[0], Math.max(target.p[1] + 25, heightAt(target.p[0], target.p[2]) + 30), target.p[2]]
      if (this.shotTimer <= 0 && (!spec.air || Math.abs(r.aimYaw) < 0.7 || r.kind === 'heli')) {
        this.shotTimer = spec.gap * (0.8 + Math.random() * 0.4)
        if (r.kind === 'tank') {
          const miss = 1 + dist(muzzle, target.p) / 40
          world.fire('shell', [muzzle[0] + Math.sin(r.yaw + r.aimYaw) * 5, muzzle[1], muzzle[2] + Math.cos(r.yaw + r.aimYaw) * 5], [target.p[0] + (Math.random() - 0.5) * miss, target.p[1] - 1, target.p[2] + (Math.random() - 0.5) * miss])
        } else if (spec.gun) {
          this.shootAt(target, spec.gun, muzzle, world, r.kind === 'fighter' ? 0.5 : r.kind === 'mech' ? 0.6 : 0.55)
        }
        // A gunship lets a rocket go at vehicles now and then
        if (r.kind === 'heli' && target.vehicle && Math.random() < 0.02) world.fire('rocket', muzzle, target.p)
      }
    } else {
      r.aimYaw *= 0.95
      r.aimPitch *= 0.95
      // On a space run: rake the enemy capital ship
      if (r.kind === 'fighter' && r.spaceRun && this.shotTimer <= 0) {
        const c: Vec3 = enemy === 'blue' ? [-304, 700, -304] : [304, 700, 304]
        if (dist(r.p, c) < 330) {
          this.shotTimer = spec.gap * 2
          world.shootShip(enemy, 'fighter-laser', Math.random() < 0.5, [c[0] + (Math.random() - 0.5) * 60, c[1] + (Math.random() - 0.5) * 20, c[2] + (Math.random() - 0.5) * 40])
        }
      }
    }

    // Move: turn towards the goal (a turn rate), then go
    const want = courseTo(r.p, goal)
    const turn = wrap(want - r.yaw)
    const turnStep = Math.max(-spec.turn * dt, Math.min(spec.turn * dt, turn))
    r.yaw = wrap(r.yaw + turnStep)
    const yawRate = turnStep / Math.max(dt, 1e-3)
    if (spec.air) {
      if (r.phase === 'takeoff') {
        // Straight up off the pad, then away
        r.speed = Math.max(0, r.speed - dt * 10)
        r.p[1] += dt * 9
        if (r.p[1] - ground > (r.kind === 'fighter' ? 45 : 30)) r.phase = 'go'
      } else {
        r.speed += Math.max(-20 * dt, Math.min(20 * dt, spec.speed - r.speed))
        const alt = Math.max(cruiseAlt, heightAt(r.p[0], r.p[2]) + 20)
        r.p[1] += Math.max(-12 * dt, Math.min(12 * dt, alt - r.p[1]))
      }
      r.roll += (Math.max(-0.9, Math.min(0.9, -yawRate * (r.kind === 'fighter' ? 0.9 : 0.5))) - r.roll) * Math.min(1, dt * 2)
      r.pitch += ((r.kind === 'heli' ? 0.12 : 0) - r.pitch) * Math.min(1, dt * 2)
    } else {
      const d = flat(r.p, goal)
      const target_speed = r.phase === 'hold' && target ? spec.speed * 0.3 : Math.min(spec.speed, d)
      r.speed += Math.max(-8 * dt, Math.min(4 * dt, target_speed - r.speed))
      // Steer round deep water
      const ahead = heightAt(r.p[0] + Math.sin(r.yaw) * 12, r.p[2] + Math.cos(r.yaw) * 12)
      if (ahead < DEEP_WATER) { r.yaw = wrap(r.yaw + spec.turn * dt * 1.5); r.speed = Math.min(r.speed, 3) }
    }
    r.p[0] = Math.max(-480, Math.min(480, r.p[0] + Math.sin(r.yaw) * r.speed * dt))
    r.p[2] = Math.max(-480, Math.min(480, r.p[2] + Math.cos(r.yaw) * r.speed * dt))
    if (!spec.air) {
      r.p[1] = heightAt(r.p[0], r.p[2]) + 0.02
      // Pitch with the slope ahead (+ = nose down)
      const front = heightAt(r.p[0] + Math.sin(r.yaw) * 3, r.p[2] + Math.cos(r.yaw) * 3)
      r.pitch = Math.atan2(r.p[1] - front, 3) * 0.8
    } else if (r.p[1] < heightAt(r.p[0], r.p[2]) + 3 && r.phase !== 'takeoff') r.p[1] = heightAt(r.p[0], r.p[2]) + 3
    this.yaw = r.yaw + r.aimYaw + Math.PI
    this.pitch = r.aimPitch
    this.moving = r.speed > 1
  }
}
