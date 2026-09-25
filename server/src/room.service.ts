import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { DatabaseService } from './database.service'
import { PublicUser } from './auth.service'

const str = (value: unknown) => (typeof value === 'string' ? value : '')

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
    const room = await this.getRoom(roomId)
    if (room.creator_id !== user.id) throw new ForbiddenException('Only the room creator can start the game')
    if (room.status !== 'waiting') throw new BadRequestException('This room has already started')
    if (Number(room.member_count) < room.max_members) throw new BadRequestException('The room must be full before starting')
    const result = await this.database.query(
      "UPDATE room SET status = 'live' WHERE id = $1 AND status = 'waiting' RETURNING id, name, max_members, battle_type, status",
      [roomId],
    )
    if (!result.rows[0]) throw new BadRequestException('This room has already started')
    return result.rows[0]
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
