import { GameService } from './game.service';
export declare class GameController {
    private readonly gameService;
    constructor(gameService: GameService);
    createMatch(): import("./game.service").MatchState;
    getMatch(id: string): import("./game.service").MatchState;
    capture(id: string, body: {
        team: 'blue' | 'red';
    }): import("./game.service").MatchState;
}
