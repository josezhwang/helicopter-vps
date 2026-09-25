import { Injectable } from '@nestjs/common'

export interface MatchState {
  id: string
  blueScore: number
  redScore: number
  createdAt: number
}

@Injectable()
export class GameService {
  private matches = new Map<string, MatchState>()
  private nextId = 1

  createMatch(): MatchState {
    const match: MatchState = {
      id: `match_${this.nextId++}`,
      blueScore: 0,
      redScore: 0,
      createdAt: Date.now(),
    }
    this.matches.set(match.id, match)
    return match
  }

  getMatch(id: string): MatchState | undefined {
    return this.matches.get(id)
  }

  scoreCapture(matchId: string, team: 'blue' | 'red'): MatchState | undefined {
    const match = this.matches.get(matchId)
    if (!match) return undefined
    if (team === 'blue') match.blueScore++
    else match.redScore++
    return match
  }
}
