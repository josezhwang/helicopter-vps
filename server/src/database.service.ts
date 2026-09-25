import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

function describe(connectionString: string) {
  try {
    const url = new URL(connectionString)
    return `${url.hostname}:${url.port || 5432}${url.pathname} as ${decodeURIComponent(url.username)}`
  } catch {
    return 'DATABASE_URL (unparseable)'
  }
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  })

  constructor() {
    // A remote server dropping an idle connection must not crash the API
    this.pool.on('error', (error) => console.error('PostgreSQL idle connection error:', error.message))
  }

  async onModuleInit() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set in server/.env (see server/.env.example)')
    try {
      await this.pool.query('SELECT 1')
    } catch (error) {
      throw new Error(`Could not connect to PostgreSQL at ${describe(process.env.DATABASE_URL)}: ${(error as Error).message}`)
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "user" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS room (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        max_members INTEGER NOT NULL CHECK (max_members BETWEEN 1 AND 64),
        battle_type TEXT NOT NULL DEFAULT 'flag steal',
        status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'live', 'finished')),
        creator_id UUID NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS room_member (
        room_id UUID NOT NULL REFERENCES room (id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (room_id, user_id)
      )
    `)
    await this.pool.query(`ALTER TABLE room_member ADD COLUMN IF NOT EXISTS team TEXT CHECK (team IN ('red', 'blue'))`)
    console.log('PostgreSQL connected')
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values)
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async onModuleDestroy() {
    await this.pool.end()
  }
}
