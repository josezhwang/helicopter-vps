import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common'
import { AuthService } from './auth.service'
import { RoomService } from './room.service'

@Controller('rooms')
export class RoomController {
  constructor(private readonly rooms: RoomService, private readonly auth: AuthService) {}

  @Get()
  list(): Promise<Record<string, unknown>[]> {
    return this.rooms.list()
  }

  @Post()
  async create(@Headers('authorization') authorization: string | undefined, @Body() body: { name: string; maxMembers: number; battleType: string }) {
    return this.rooms.create(body, await this.auth.authenticate(authorization))
  }

  @Post(':id/join')
  async join(@Headers('authorization') authorization: string | undefined, @Param('id') roomId: string): Promise<Record<string, unknown>> {
    return this.rooms.join(roomId, await this.auth.authenticate(authorization))
  }

  @Post(':id/start')
  async start(@Headers('authorization') authorization: string | undefined, @Param('id') roomId: string): Promise<Record<string, unknown>> {
    return this.rooms.start(roomId, await this.auth.authenticate(authorization))
  }
}
