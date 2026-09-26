# Aerium: Flag Assault (three.js)

A 3D capture-the-flag battlefield with a PostgreSQL-backed account and battle-room site. Frontend: React + Vite. Backend: NestJS.

## Run

Requires Node.js 22.14.0 or newer (`.nvmrc` pins 22.14.0).

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

### Database on another machine

To run the API on one PC against PostgreSQL on another, on the **database** machine:

1. In `postgresql.conf` set `listen_addresses = '*'`.
2. In `pg_hba.conf` allow only the API machine, only over SSL: `hostssl aerium aerium <API_PC_IP>/32 scram-sha-256`
3. `sudo systemctl restart postgresql`, and open TCP 5432 in the firewall for `<API_PC_IP>` only.

Then on the **API** machine point `DATABASE_URL` at the database machine's IP with `?sslmode=no-verify` (see `server/.env.example`). Never expose the `postgres` superuser this way — use the database-owner role above. If the API can't reach the database, startup fails within 10 seconds with the host it tried.

## Deploying beyond localhost

Players open the site at `http://<server-ip>:5173`; the client calls the API on that same host at port 3002, so open TCP 5173 and 3002 in the firewall. To use a different API address, set `VITE_API_URL` in `client/.env` (inlined at build time). The API accepts any site origin unless `CORS_ORIGINS` (comma-separated) narrows it; `PORT` changes the API port (default 3002).

## Controls

- **Mouse** — look, **Left click** — shoot, **R** — reload
- **WASD** — move, **Shift** — sprint, **Space** — jump
- **E** — enter / exit the Apache helicopter (near the helipad at your base)
- In helicopter: **W/S** forward/back, **A/D** turn, **Space** climb, **Shift/C** descend

## Goal

Steal the red flag from the enemy base and carry it back to your blue base to score.
