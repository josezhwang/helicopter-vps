import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { DatabaseService } from './database.service'

export interface PublicUser {
  id: string
  email: string
  displayId: string
  displayName: string
}

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService, private readonly jwt: JwtService) {}

  async signup(input: { email: string; password: string; checkPassword: string; displayId: string; displayName: string }) {
    const email = input.email.trim().toLowerCase()
    const displayId = input.displayId.trim().toLowerCase()
    const displayName = input.displayName.trim()
    if (!email || !displayId || !displayName || input.password.length < 8) {
      throw new BadRequestException('Email, display ID, display name, and an 8-character password are required')
    }
    if (input.password !== input.checkPassword) throw new BadRequestException('Passwords do not match')

    const existing = await this.database.query<{ email: string; display_id: string }>(
      'SELECT email, display_id FROM "user" WHERE email = $1 OR display_id = $2',
      [email, displayId],
    )
    if (existing.rows.some((row) => row.email === email)) throw new BadRequestException('An account with this email already exists. Please log in.')
    if (existing.rows.some((row) => row.display_id === displayId)) throw new BadRequestException('That display ID is already taken')

    const passwordHash = await bcrypt.hash(input.password, 12)
    const result = await this.database.query<{ id: string; email: string; display_id: string; display_name: string }>(
      'INSERT INTO "user" (email, password_hash, display_id, display_name) VALUES ($1, $2, $3, $4) RETURNING id, email, display_id, display_name',
      [email, passwordHash, displayId, displayName],
    )
    return this.session(result.rows[0])
  }

  async login(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase()
    const result = await this.database.query<{ id: string; email: string; password_hash: string; display_id: string; display_name: string }>(
      'SELECT id, email, password_hash, display_id, display_name FROM "user" WHERE email = $1',
      [email],
    )
    const user = result.rows[0]
    if (!user || !(await bcrypt.compare(input.password, user.password_hash))) throw new UnauthorizedException('Invalid email or password')
    return this.session(user)
  }

  async authenticate(authorization: string | undefined): Promise<PublicUser> {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException('Authentication required')
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(authorization.slice(7))
      const result = await this.database.query<{ id: string; email: string; display_id: string; display_name: string }>(
        'SELECT id, email, display_id, display_name FROM "user" WHERE id = $1',
        [payload.sub],
      )
      if (!result.rows[0]) throw new UnauthorizedException('User not found')
      return this.publicUser(result.rows[0])
    } catch {
      throw new UnauthorizedException('Invalid or expired session')
    }
  }

  async forgotPassword(email: string) {
    const normalizedEmail = email.trim().toLowerCase()
    await this.database.query('SELECT id FROM "user" WHERE email = $1', [normalizedEmail])
    return { message: 'If an account exists for that email, recovery instructions will be sent.' }
  }

  private session(user: { id: string; email: string; display_id: string; display_name: string }) {
    const publicUser = this.publicUser(user)
    return { token: this.jwt.sign({ sub: publicUser.id, displayId: publicUser.displayId }), user: publicUser }
  }

  private publicUser(user: { id: string; email: string; display_id: string; display_name: string }): PublicUser {
    return { id: user.id, email: user.email, displayId: user.display_id, displayName: user.display_name }
  }
}
