export interface MatchState {
    id: string;
    blueScore: number;
    redScore: number;
    createdAt: number;
}
export declare class GameService {
    private matches;
    private nextId;
    createMatch(): MatchState;
    getMatch(id: string): MatchState | undefined;
    scoreCapture(matchId: string, team: 'blue' | 'red'): MatchState | undefined;
}
