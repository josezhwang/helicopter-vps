import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { DatabaseService } from './database.service'

export interface PublicUser {
  id: string
  email: string
  displayId: string
  displayName: string
}

type UserRow = { id: string; email: string; display_id: string; display_name: string }

const str = (value: unknown) => (typeof value === 'string' ? value : '')

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService, private readonly jwt: JwtService) {}

  async signup(input: Record<string, unknown>) {
    const email = str(input.email).trim().toLowerCase()
    const password = str(input.password)
    const displayId = str(input.displayId).trim().toLowerCase()
    const displayName = str(input.displayName).trim()
    if (!email || !displayId || !displayName || password.length < 8) {
      throw new BadRequestException('Email, display ID, display name, and an 8-character password are required')
    }
    if (password !== str(input.checkPassword)) throw new BadRequestException('Passwords do not match')

    const passwordHash = await bcrypt.hash(password, 12)
    try {
      const result = await this.database.query<UserRow>(
        'INSERT INTO "user" (email, password_hash, display_id, display_name) VALUES ($1, $2, $3, $4) RETURNING id, email, display_id, display_name',
        [email, passwordHash, displayId, displayName],
      )
      return this.session(result.rows[0])
    } catch (error) {
      const dbError = error as { code?: string; constraint?: string }
      if (dbError.code !== '23505') throw error
      throw new ConflictException(dbError.constraint === 'user_display_id_key' ? 'That display ID is already taken' : 'An account with this email already exists. Please log in.')
    }
  }

  async login(input: Record<string, unknown>) {
    const email = str(input.email).trim().toLowerCase()
    const password = str(input.password)
    const result = await this.database.query<UserRow & { password_hash: string }>(
      'SELECT id, email, password_hash, display_id, display_name FROM "user" WHERE email = $1',
      [email],
    )
    const user = result.rows[0]
    if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new UnauthorizedException('Invalid email or password')
    return this.session(user)
  }

  async authenticate(authorization: string | undefined): Promise<PublicUser> {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Authentication required')
    let payload: { sub: string }
    try {
      payload = await this.jwt.verifyAsync<{ sub: string }>(authorization.slice(7))
    } catch {
      throw new UnauthorizedException('Invalid or expired session')
    }
    const result = await this.database.query<UserRow>('SELECT id, email, display_id, display_name FROM "user" WHERE id = $1', [payload.sub])
    if (!result.rows[0]) throw new UnauthorizedException('User not found')
    return this.publicUser(result.rows[0])
  }

  async forgotPassword(email: unknown) {
    const normalizedEmail = str(email).trim().toLowerCase()
    await this.database.query('SELECT id FROM "user" WHERE email = $1', [normalizedEmail])
    return { message: 'If an account exists for that email, recovery instructions will be sent.' }
  }

  private session(user: UserRow) {
    const publicUser = this.publicUser(user)
    return { token: this.jwt.sign({ sub: publicUser.id, displayId: publicUser.displayId }), user: publicUser }
  }

  private publicUser(user: UserRow): PublicUser {
    return { id: user.id, email: user.email, displayId: user.display_id, displayName: user.display_name }
  }
}
