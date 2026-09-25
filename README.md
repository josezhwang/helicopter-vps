# Aerium: Flag Assault (three.js)

A 3D capture-the-flag battlefield with a PostgreSQL-backed account and battle-room site. Frontend: React + Vite. Backend: NestJS.

## Run

```bash
npm install
npm run dev:server   # Nest API on http://localhost:3002
npm run dev:client   # Game on http://localhost:5173
```

## PostgreSQL setup

Create a role that owns the database. The server creates its tables on startup, which needs CREATE on the `public` schema — on PostgreSQL 15+ only the database owner has that by default:

```sql
CREATE ROLE aerium LOGIN PASSWORD 'replace-this-password';
CREATE DATABASE aerium OWNER aerium;
```

Copy `server/.env.example` to `server/.env` and set `DATABASE_URL` and `JWT_SECRET` (the server refuses to start without a `JWT_SECRET`). On startup the server creates the `"user"`, `room`, and `room_member` tables. Changes to `.env` take effect after a server restart.

The primary site provides signup, login, forgot-password messaging, battle-room creation, attendance limits, joining, and creator-only start controls. Starting a full room opens the existing battlefield at `#/play` for every member.

## Deploying beyond localhost

The client bakes the API origin in at build time: copy `client/.env.example` to `client/.env` and set `VITE_API_URL` to the public API origin before `npm run build`. On the server, set `CORS_ORIGINS` to the site origin(s) (comma-separated; localhost origins are always allowed) and optionally `PORT` (default 3002).

## Controls

- **Mouse** — look, **Left click** — shoot, **R** — reload
- **WASD** — move, **Shift** — sprint, **Space** — jump
- **E** — enter / exit the Apache helicopter (near the helipad at your base)
- In helicopter: **W/S** forward/back, **A/D** turn, **Space** climb, **Shift/C** descend

## Goal

Steal the red flag from the enemy base and carry it back to your blue base to score.
