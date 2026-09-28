import { BASE_CENTER, GEM_PEDESTAL, baseToWorld, type Team } from './game-layout'
import { heightAt } from './terrain'

/**
 * Computer-controlled players. Each bot runs on the server as a player of its own: it walks the map, fights the
 * enemies it can see, steals the enemy gem and carries it home — and gets shot, dies and respawns like anyone.
 *
 * Roles: most bots attack (out through their gate, across the field, in through the enemy gate to the gem and
 * back); a few defend (they hold round their own gate and gem). Everyone drops what they're doing to hunt down an
 * enemy carrying their gem.
 */
type Vec3 = [number, number, number]
const EYE = 1.7
/** Metres per second: running, and slower while shooting. */
const RUN = 7
const FIGHT_WALK = 3.2
/** How far a bot sees and fights; defenders reach a bit further round their base. */
const SIGHT = 65
/** Time between shots, damage per hit, and how the chance of hitting falls off with distance. */
const SHOT_GAP = 0.3
export const BOT_DAMAGE = 11
const hitChance = (distance: number, targetMoving: boolean) => Math.max(0.08, Math.min(0.55, 0.62 - distance / 110)) * (targetMoving ? 0.75 : 1)
/** How near the enemy gem to grab it, and a waypoint to count as reached. */
const GRAB = 2.8
const ARRIVE = 3.5

/** What a bot needs to know about the others each tick. */
export interface BotSeen {
  id: string
  team: Team
  /** Eye position. */
  p: Vec3
  alive: boolean
  /** Carrying an enemy gem. */
  flag: boolean
  /** On foot (a target a bot can shoot). */
  onFoot: boolean
  moving: boolean
}

/** What the game lets a bot do. */
export interface BotActions {
  /** Fire at `target`; `hit` whether the round connects; `to` where the round goes. */
  shoot: (target: string, hit: boolean, to: Vec3) => void
  /** Is this team's gem off its pedestal (someone carrying it)? */
  gemTaken: (team: Team) => boolean
  /** Try to deliver the gem we carry (at our pedestal). */
  capture: () => void
}

/** A point in a base's own frame (gate towards +Z) in the world, at eye height on the ground. */
const at = (team: Team, x: number, z: number): Vec3 => {
  const [wx, wz] = baseToWorld(team, x, z)
  return [wx, heightAt(wx, wz) + EYE, wz]
}
const other = (team: Team): Team => (team === 'blue' ? 'red' : 'blue')
const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2])

/** Could a bot at `from` see `to`? The hills get in the way, and so do a base's walls (except through its gate). */
function canSee(from: Vec3, to: Vec3): boolean {
  for (let i = 1; i < 10; i++) {
    const t = i / 10
    const x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t
    const y = from[1] + (to[1] - from[1]) * t
    if (heightAt(x, z) > y - 0.3) return false
  }
  for (const team of ['blue', 'red'] as Team[]) {
    const c = BASE_CENTER[team]
    const inside = (p: Vec3) => Math.max(Math.abs(p[0] - c.x), Math.abs(p[2] - c.z)) < 53
    // One inside the walls and one outside: only in sight through the gate
    if (inside(from) !== inside(to)) {
      const gate = at(team, 0, 55)
      const outside = inside(from) ? to : from
      if (flat(outside, gate) > 30) return false
    }
  }
  return true
}

export class Bot {
  readonly id: string
  readonly team: Team
  readonly role: 'attack' | 'defend'
  p: Vec3
  yaw = 0
  pitch = 0
  flag = false
  moving = false
  private route: Vec3[] = []
  private shotTimer = Math.random() * SHOT_GAP
  private lateral = (Math.random() - 0.5) * 160
  private patrol = 0
  private wasDead = false

  constructor(id: string, team: Team, index: number) {
    this.id = id
    this.team = team
    // Every third bot (from the second) holds back to defend
    this.role = index % 3 === 1 ? 'defend' : 'attack'
    this.p = this.spawnPoint(index)
  }

  private spawnPoint(index = Math.floor(Math.random() * 8)): Vec3 {
    return at(this.team, -7 + (index % 8) * 2, 37 + Math.floor(index / 8) * 3)
  }

  /** Back at the spawn after dying (the respawn is the server's), with a fresh plan. */
  respawn() {
    this.p = this.spawnPoint()
    this.flag = false
    this.route = []
    this.lateral = (Math.random() - 0.5) * 160
  }

  /** The way to the enemy gem, or (carrying it) back to ours: gate to gate, crossing the field off to one side. */
  private plan() {
    const enemy = other(this.team)
    const mid: Vec3 = [this.lateral * 0.7, 0, -this.lateral * 0.7]
    mid[1] = heightAt(mid[0], mid[2]) + EYE
    if (this.flag) {
      this.route = [at(enemy, 0, 44), at(enemy, 0, 64), mid, at(this.team, 0, 64), at(this.team, 0, 44), at(this.team, -8, 4)]
    } else if (this.role === 'defend') {
      // Round the gate and the gem
      const spots = [at(this.team, 0, 66), at(this.team, -14, 58), at(this.team, 14, 58), at(this.team, -8, 10)]
      this.route = [spots[this.patrol++ % spots.length]]
    } else {
      this.route = [at(this.team, 0, 44), at(this.team, 0, 64), mid, at(enemy, 0, 64), at(enemy, 0, 44), at(enemy, -8, 2)]
      // Skip the legs already behind us
      while (this.route.length > 1 && flat(this.p, this.route[1]) < flat(this.p, this.route[0]) && flat(this.route[0], this.route[1]) > 1) this.route.shift()
    }
  }

  /** One tick: pick a target, move, shoot, grab or deliver the gem. Returns false while dead. */
  update(dt: number, alive: boolean, everyone: BotSeen[], act: BotActions): boolean {
    if (!alive) {
      this.wasDead = true
      this.moving = false
      return false
    }
    if (this.wasDead) {
      this.wasDead = false
      this.respawn()
    }
    const enemies = everyone.filter((e) => e.team !== this.team && e.alive && e.onFoot)
    // An enemy running off with our gem: after them, whoever we are
    const thief = enemies.find((e) => e.flag)
    const sight = this.role === 'defend' ? SIGHT + 15 : SIGHT
    let target: BotSeen | null = null
    let best = Infinity
    for (const e of enemies) {
      const d = Math.hypot(e.p[0] - this.p[0], e.p[1] - this.p[1], e.p[2] - this.p[2])
      if (d < sight && d < best && canSee(this.p, e.p)) { target = e; best = d }
    }

    // Where to go
    const enemyGem = GEM_PEDESTAL[other(this.team)]
    if (!this.flag && !act.gemTaken(other(this.team)) && Math.hypot(this.p[0] - enemyGem[0], this.p[2] - enemyGem[1]) < GRAB) {
      this.flag = true
      this.route = []
    }
    if (this.flag && Math.hypot(this.p[0] - GEM_PEDESTAL[this.team][0], this.p[2] - GEM_PEDESTAL[this.team][1]) < 10) act.capture()
    let goal: Vec3 | null = null
    if (thief && !this.flag) goal = thief.p
    else {
      if (!this.route.length) this.plan()
      while (this.route.length && flat(this.p, this.route[0]) < ARRIVE) {
        this.route.shift()
        if (!this.route.length) this.plan()
      }
      goal = this.route[0] ?? null
    }

    // Move (slower while fighting; a carrier doesn't stop)
    const speed = target && !this.flag ? FIGHT_WALK : RUN
    this.moving = false
    if (goal) {
      const dx = goal[0] - this.p[0], dz = goal[2] - this.p[2]
      const d = Math.hypot(dx, dz)
      if (d > 0.5 && !(target && best < 12 && !this.flag && !thief)) {
        const step = Math.min(d, speed * dt)
        this.p[0] += (dx / d) * step
        this.p[2] += (dz / d) * step
        this.p[0] = Math.max(-485, Math.min(485, this.p[0]))
        this.p[2] = Math.max(-485, Math.min(485, this.p[2]))
        this.moving = true
        if (!target) this.yaw = Math.atan2(-dx, -dz)
      }
    }
    this.p[1] = heightAt(this.p[0], this.p[2]) + EYE

    // Fight
    if (target) {
      const dx = target.p[0] - this.p[0], dy = target.p[1] - this.p[1], dz = target.p[2] - this.p[2]
      this.yaw = Math.atan2(-dx, -dz)
      this.pitch = Math.atan2(dy, Math.hypot(dx, dz))
      this.shotTimer -= dt
      if (this.shotTimer <= 0) {
        this.shotTimer = SHOT_GAP * (0.8 + Math.random() * 0.5)
        const hit = Math.random() < hitChance(best, target.moving)
        const miss = hit ? 0 : 0.6 + Math.random() * 1.8
        const angle = Math.random() * Math.PI * 2
        act.shoot(target.id, hit, [target.p[0] + Math.cos(angle) * miss, target.p[1] - 0.4 + (Math.random() - 0.5) * miss, target.p[2] + Math.sin(angle) * miss])
      }
    } else {
      this.pitch *= 0.9
    }
    return true
  }
}
