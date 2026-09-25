import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { DatabaseService } from './database.service'
import { GameModule } from './game/game.module'
import { RoomController } from './room.controller'
import { RoomService } from './room.service'

@Module({
  imports: [
    GameModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const secret = process.env.JWT_SECRET
        if (!secret) throw new Error('JWT_SECRET must be set in server/.env (see server/.env.example)')
        return { secret, signOptions: { expiresIn: '7d' } }
      },
    }),
  ],
  controllers: [AuthController, RoomController],
  providers: [DatabaseService, AuthService, RoomService],
})
export class AppModule {}
