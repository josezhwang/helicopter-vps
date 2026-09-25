import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { DatabaseService } from './database.service'
import { GameModule } from './game/game.module'
import { RoomController } from './room.controller'
import { RoomService } from './room.service'

@Module({
  imports: [GameModule, JwtModule.register({ secret: process.env.JWT_SECRET ?? 'change-this-development-secret', signOptions: { expiresIn: '7d' } })],
  controllers: [AuthController, RoomController],
  providers: [DatabaseService, AuthService, RoomService],
})
export class AppModule {}
