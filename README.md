# Aerium: Flag Assault (three.js)

A 3D capture-the-flag battlefield with a PostgreSQL-backed account and battle-room site. Frontend: React + Vite. Backend: NestJS.

## Run

```bash
npm install
npm run dev:server   # Nest API on http://localhost:3333
npm run dev:client   # Game on http://localhost:5173
```

## PostgreSQL setup

Create a database and user, then copy `server/.env.example` to `server/.env` and set `DATABASE_URL` and `JWT_SECRET`. The Nest server creates the `"user"`, `battle_room`, and `battle_room_member` tables on startup.

The primary site provides signup, login, forgot-password messaging, battle-room creation, attendance limits, joining, and creator-only start controls. Starting a full room opens the existing battlefield at `#/play`.

## Controls

- **Mouse** — look, **Left click** — shoot, **R** — reload
- **WASD** — move, **Shift** — sprint, **Space** — jump
- **E** — enter / exit the Apache helicopter (near the helipad at your base)
- In helicopter: **W/S** forward/back, **A/D** turn, **Space** climb, **Shift/C** descend

## Goal

Steal the red flag from the enemy base and carry it back to your blue base to score.
