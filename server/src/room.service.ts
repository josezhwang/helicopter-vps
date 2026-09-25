import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { randomInt } from 'node:crypto'
import { DatabaseService } from './database.service'
import { PublicUser } from './auth.service'

export type Team = 'red' | 'blue'

const str = (value: unknown) => (typeof value === 'string' ? value : '')

function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

@Injectable()
export class RoomService {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<Record<string, unknown>[]> {
    const result = await this.database.query(`
      SELECT r.id, r.name, r.max_members, r.battle_type, r.status, r.creator_id,
        u.display_id AS creator_display_id, COUNT(m.user_id)::int AS member_count,
        COALESCE(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
      FROM room r
      JOIN "user" u ON u.id = r.creator_id
      LEFT JOIN room_member m ON m.room_id = r.id
      WHERE r.status <> 'finished'
      GROUP BY r.id, u.display_id
      ORDER BY r.created_at DESC
    `)
    return result.rows
  }

  async create(input: Record<string, unknown>, user: PublicUser) {
    const name = str(input.name).trim()
    const maxMembers = Number(input.maxMembers)
    if (!name || !Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 64) {
      throw new BadRequestException('Room name and attendance limit from 1 to 64 are required')
    }
    if (input.battleType !== 'flag steal') throw new BadRequestException('Only flag steal is available right now')

    return this.database.transaction(async (client) => {
      const room = await client.query(
        'INSERT INTO room (name, max_members, battle_type, creator_id) VALUES ($1, $2, $3, $4) RETURNING id, name, max_members, battle_type, status, creator_id',
        [name, maxMembers, 'flag steal', user.id],
      )
      await client.query('INSERT INTO room_member (room_id, user_id) VALUES ($1, $2)', [room.rows[0].id, user.id])
      return { ...room.rows[0], member_count: 1, member_ids: [user.id] }
    })
  }

  async join(roomId: string, user: PublicUser): Promise<Record<string, unknown>> {
    await this.database.transaction(async (client) => {
      // Row lock serializes concurrent joins so the capacity check cannot be bypassed
      const locked = await client.query<{ status: string; max_members: number }>('SELECT status, max_members FROM room WHERE id = $1 FOR UPDATE', [roomId])
      const room = locked.rows[0]
      if (!room) throw new NotFoundException('Room not found')
      if (room.status !== 'waiting') throw new BadRequestException('This room is no longer accepting pilots')
      const members = await client.query<{ count: number; is_member: boolean | null }>(
        'SELECT COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS is_member FROM room_member WHERE room_id = $1',
        [roomId, user.id],
      )
      if (!members.rows[0].is_member && members.rows[0].count >= room.max_members) throw new BadRequestException('This room is full')
      await client.query('INSERT INTO room_member (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roomId, user.id])
    })
    return this.getRoom(roomId)
  }

  async start(roomId: string, user: PublicUser): Promise<Record<string, unknown>> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<{ status: string; max_members: number; creator_id: string }>('SELECT status, max_members, creator_id FROM room WHERE id = $1 FOR UPDATE', [roomId])
      const room = locked.rows[0]
      if (!room) throw new NotFoundException('Room not found')
      if (room.creator_id !== user.id) throw new ForbiddenException('Only the room creator can start the game')
      if (room.status !== 'waiting') throw new BadRequestException('This room has already started')
      const members = await client.query<{ user_id: string }>('SELECT user_id FROM room_member WHERE room_id = $1', [roomId])
      if (members.rows.length < room.max_members) throw new BadRequestException('The room must be full before starting')

      const ids = shuffle(members.rows.map((row) => row.user_id))
      // With an odd count the extra pilot lands on a random side
      const redCount = ids.length % 2 === 0 || randomInt(2) === 0 ? Math.floor(ids.length / 2) : Math.ceil(ids.length / 2)
      await client.query(
        `UPDATE room_member SET team = CASE WHEN user_id = ANY($2::uuid[]) THEN 'red' ELSE 'blue' END WHERE room_id = $1`,
        [roomId, ids.slice(0, redCount)],
      )
      const result = await client.query("UPDATE room SET status = 'live' WHERE id = $1 RETURNING id, name, max_members, battle_type, status", [roomId])
      return result.rows[0]
    })
  }

  async matchRoster(roomId: string): Promise<{ status: string; players: Array<{ id: string; displayId: string; displayName: string; team: Team | null }> } | null> {
    const room = await this.database.query<{ status: string }>('SELECT status FROM room WHERE id = $1', [roomId])
    if (!room.rows[0]) return null
    const players = await this.database.query<{ id: string; display_id: string; display_name: string; team: Team | null }>(
      'SELECT u.id, u.display_id, u.display_name, m.team FROM room_member m JOIN "user" u ON u.id = m.user_id WHERE m.room_id = $1 ORDER BY m.joined_at',
      [roomId],
    )
    return { status: room.rows[0].status, players: players.rows.map((row) => ({ id: row.id, displayId: row.display_id, displayName: row.display_name, team: row.team })) }
  }

  async assignTeam(roomId: string, userId: string, team: Team) {
    await this.database.query('UPDATE room_member SET team = $3 WHERE room_id = $1 AND user_id = $2 AND team IS NULL', [roomId, userId, team])
  }

  async finish(roomId: string): Promise<boolean> {
    const result = await this.database.query("UPDATE room SET status = 'finished' WHERE id = $1 AND status = 'live' RETURNING id", [roomId])
    return result.rows.length > 0
  }

  private async getRoom(roomId: string): Promise<Record<string, any>> {
    const result = await this.database.query(`
      SELECT r.id, r.name, r.max_members, r.battle_type, r.status, r.creator_id, COUNT(m.user_id)::int AS member_count,
        COALESCE(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
      FROM room r LEFT JOIN room_member m ON m.room_id = r.id
      WHERE r.id = $1 GROUP BY r.id
    `, [roomId])
    if (!result.rows[0]) throw new NotFoundException('Room not found')
    return result.rows[0]
  }
}
