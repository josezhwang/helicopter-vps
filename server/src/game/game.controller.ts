import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common'
import { GameService } from './game.service'

@Controller('game')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  @Post('match')
  createMatch() {
    return this.gameService.createMatch()
  }

  @Get('match/:id')
  getMatch(@Param('id') id: string) {
    const match = this.gameService.getMatch(id)
    if (!match) throw new NotFoundException(`Match ${id} not found`)
    return match
  }

  @Post('match/:id/capture')
  capture(@Param('id') id: string, @Body() body: { team: 'blue' | 'red' }) {
    const match = this.gameService.scoreCapture(id, body.team)
    if (!match) throw new NotFoundException(`Match ${id} not found`)
    return match
  }
}
