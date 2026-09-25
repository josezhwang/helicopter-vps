import { Body, Controller, Post } from '@nestjs/common'
import { AuthService } from './auth.service'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  signup(@Body() body: { email: string; password: string; checkPassword: string; displayId: string; displayName: string }) {
    return this.auth.signup(body)
  }

  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body)
  }

  @Post('forgot-password')
  forgotPassword(@Body() body: { email: string }) {
    return this.auth.forgotPassword(body.email)
  }
}
