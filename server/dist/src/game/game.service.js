"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameService = void 0;
const common_1 = require("@nestjs/common");
let GameService = class GameService {
    constructor() {
        this.matches = new Map();
        this.nextId = 1;
    }
    createMatch() {
        const match = {
            id: `match_${this.nextId++}`,
            blueScore: 0,
            redScore: 0,
            createdAt: Date.now(),
        };
        this.matches.set(match.id, match);
        return match;
    }
    getMatch(id) {
        return this.matches.get(id);
    }
    scoreCapture(matchId, team) {
        const match = this.matches.get(matchId);
        if (!match)
            return undefined;
        if (team === 'blue')
            match.blueScore++;
        else
            match.redScore++;
        return match;
    }
};
exports.GameService = GameService;
exports.GameService = GameService = __decorate([
    (0, common_1.Injectable)()
], GameService);
//# sourceMappingURL=game.service.js.map