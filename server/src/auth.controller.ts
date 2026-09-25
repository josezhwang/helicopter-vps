import { Body, Controller, Get, Headers, Post } from '@nestjs/common'
import { AuthService } from './auth.service'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  signup(@Body() body: Record<string, unknown>) {
    return this.auth.signup(body)
  }

  @Post('login')
  login(@Body() body: Record<string, unknown>) {
    return this.auth.login(body)
  }

  @Get('me')
  me(@Headers('authorization') authorization: string | undefined) {
    return this.auth.authenticate(authorization)
  }

  @Post('forgot-password')
  forgotPassword(@Body() body: Record<string, unknown>) {
    return this.auth.forgotPassword(body.email)
  }
}
