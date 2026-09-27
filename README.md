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
- **F** — switch weapon. Everyone starts with a handgun (7 rounds, 3 magazines) and a primary gun (30 rounds, 3 magazines).
- **G** — pick up what is in reach (a weapon, AA missiles from a missile crate, ammo from an ammo box), or drop the weapon in your hand. Weapons and ammo of either team can be used; players drop what they carried where they die.
- **E** — get into / out of any vehicle (both teams' helicopters and battle cars), or man / leave a machine gun outside a base.
- In a helicopter: you open the door, climb in and sit down. The **pilot** can't shoot: **Space** spins the rotor up (**Shift** down), then **W/S** forward/back, **A/D** turn, **↑/↓** altitude, **←/→** roll, **V** cockpit / chase view. Up to three **passengers** ride along with their doors open and can shoot.
- In a battle car: **W/S** drive / reverse, **A/D** steer, **Space** brake, **mouse** look around, **V** chase / roof-gun view, **Left click** fires from the roof gun
- Machine guns: slow but heavy rounds; aim with the mouse.
- **AA launcher** (10 on the rack in each base; missiles come from the 10 missile crates, 4 each): hold the crosshair on a helicopter with an enemy aboard for **2 seconds** to lock on, then fire — the missile homes in and destroys it with everyone inside. A shot-down helicopter is back on its pad 30 seconds later.

## Goal

Steal the enemy team's gem from their base and carry it back to your own gem to win (on foot for the last step: you can't capture from inside a vehicle).

## Credits

3D models used under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) (simplified and re-textured for the game):

- "MD-500 Defender Helicopter" by [Duane's Mind](https://sketchfab.com/duanesmind) — [source](https://sketchfab.com/3d-models/md-500-defender-helicopter-da5daae0fe354269895b58c2ed72e2b8)
- "Shadow - metal war online" by [Vyacheslav](https://sketchfab.com/Vedunov.s) — [source](https://sketchfab.com/3d-models/shadow-metal-war-online-63ec56441bed458e98fb74dc6bd08575)
- "Military Base #1 - Truck Masters India Simulator" by [Villanueva-Jonatan-32621](https://sketchfab.com/vj32621) — [source](https://sketchfab.com/3d-models/military-base-1-truck-masters-india-simulator-7c6372dfe0e84af587f8b12167d210ca)
- "Tracer's Gun" by [Nazareno_rojas](https://sketchfab.com/Nazareno_rojas) — [source](https://sketchfab.com/3d-models/tracers-gun-ac72d8f55dfa4267af89f15822f6a786)
- "Panzerschreck" by [Tactical_Gamer](https://sketchfab.com/Tactical_Beard) — [source](https://sketchfab.com/3d-models/panzerschreck-33546ba8dab24ae695966602092b9b44)
- "Missile model (Murder Drones)" by [89120](https://sketchfab.com/89120) — [source](https://sketchfab.com/3d-models/missile-model-murder-drones-7803ebaeda034fda92c104b794d6bbc3)
- "Ammo Crate" by [drcrazzie](https://sketchfab.com/drcrazzie) — [source](https://sketchfab.com/3d-models/ammo-crate-35694b56bf44439aba1732ac198f7df2)
- "9mm Ammo Box" by [stfuaahil](https://sketchfab.com/stfuaahil) — [source](https://sketchfab.com/3d-models/9mm-ammo-box-c902c80557f849ba9c9fdd06d8510a68)
- "5.56x45mm ammo box" by [Poly-Arms](https://sketchfab.com/Poly-Arms) — [source](https://sketchfab.com/3d-models/556x45mm-ammo-box-dbd8e5f4d4554e85a42083ca78d4c586)
- "9mm Bullet" by [KING MUFFIN](https://sketchfab.com/KingMuffinGF) — [source](https://sketchfab.com/3d-models/9mm-bullet-63b5be22501a404e96dd3e8420821d0c)
- "Bullet" by [RoutineStudio](https://sketchfab.com/TheRoutine) — [source](https://sketchfab.com/3d-models/bullet-8333d86fe2674aaf8888cc5fa4537d20)
