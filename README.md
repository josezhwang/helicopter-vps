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

- **Mouse** — look, **Left click** — shoot, **Right click** — aim down the sights (snipers: scope), **R** — reload
- **WASD** — move, **Shift** — sprint, **Space** — jump
- **F** — switch weapon. Everyone starts with a handgun (7 rounds, 3 magazines) and a primary gun (30 rounds, 3 magazines). You carry one sidearm, one long gun and one AA launcher; each base's gun table has two of every long gun (M4A1, M254 rifle, heavy pulse MG, M240B, plasma gun, M170 and SVD sniper rifles) with ammo boxes beside it — picking one up puts your current long gun down.
- **G** — pick up what is in reach (a weapon, AA missiles from a missile crate, ammo from an ammo box), or drop the weapon in your hand. Weapons and ammo of either team can be used; players drop what they carried where they die.
- **Q** — throw a hand grenade (you start with 2 and can carry 4; the grenade boxes beside each base's gun table hold more). It bounces off the ground, walls and trees and goes off after about 3 seconds.
- **E** — get into / out of any vehicle (both teams' helicopters, battle cars, tanks and combat mechs), or man / leave a machine gun outside a base. If **enemies are sitting in a vehicle standing on the ground**, **E** pulls them out and you take it (their pilot / driver seat first). They can't climb straight back in for 10 seconds. A helicopter in the air or a vehicle driving off has to be stopped or shot down first.
- In a helicopter (an attack helicopter with four seats): the **pilot** (raised rear cockpit) can't shoot: **Space** spins the rotor up (**Shift** down), then **W/S** forward/back, **A/D** turn, **↑/↓** altitude, **←/→** roll, **V** cockpit / chase view. The **gunner** in the nose works the nose gun (it swings to the crosshair, **Left click** fires). Two **door gunners** lean out of the cabin doors and shoot with their own weapons.
- In a battle car: **W/S** drive / reverse, **A/D** steer, **Space** brake, **V** chase / roof view; the **mouse** swings the roof gatling onto whatever the crosshair is on and **Left click** fires it (heavy rounds).
- In a **tank** (two outside each base's gate): **W/S** drive, **A/D** turn the hull on its tracks (on the spot too), **Space** brake. The turret swings round slowly to wherever you aim; a ring on screen shows where the gun really points. **Left click** fires a shell (3 s reload) that explodes where it lands. **V** switches between the chase view and the magnified gunner's sight. Bullets can't hurt a tank or its driver: use shells, rockets and grenades.
- In a **combat mech** (two outside each base's gate): **W/S** walk (**Shift** runs, **S** backs up), **A/D** turn, **Space** fires the jump-jets (a few seconds of fuel, it refills on the ground). The torso turns towards wherever you aim; **Left click** fires the arm autocannon, **Right click** a salvo of six rockets from the shoulder pods (then they reload), **V** cockpit / chase view. Bullets barely scratch its armour and can't reach its pilot.
- **Vehicles take damage** (helicopters 450, battle cars 700, mechs 1600, tanks 2000): rounds chip at helicopters and cars, explosions tear into everything, and a vehicle trails smoke when it is badly hurt. At zero it blows up with everyone inside, and it's back at home 30 seconds later. The HUD shows your vehicle's hull.
- Machine guns: slow but heavy rounds, with real recoil; aim with the mouse.
- Rounds leave holes in the ground, rocks, walls and vehicles, and throw up dust, chips, splinters or sparks; guns eject their casings.
- **AA launcher** (10 on the rack in each base; missiles come from the 10 missile crates, 4 each): hold the crosshair on a helicopter with an enemy aboard for **2 seconds** to lock on (a beeping tone that turns steady), then fire — the missile homes in and destroys it with everyone inside. A shot-down helicopter is back on its pad 30 seconds later. Fire **without a lock** and it's an unguided rocket that flies straight: good against cars, tanks and people.
- **Explosive barrels** stand by each gate, by each base's fuel tanker and in every outpost: shoot one and it blows up (setting off any barrel next to it). They're back 45 seconds later.
- **Sandbag outposts**: six in the open between the bases, each with sandbag walls, concrete barriers and crates that stop rounds, an ammo box, jerrycans, a generator and a barrel.
- **HUD**: a radar (top left) turned to where you look shows the map, your teammates, the vehicles, the gems, and any enemy who gives himself away (fires, comes close, or carries your gem). There's also a kill feed under the roster and red arcs showing where damage comes from.
- **Graphics**: the buttons under the radar switch between **Ultra** (the default: cascaded sun shadows out to 600 m, ambient occlusion, bloom, god rays, 8K sky, 2K ground photos, 380k blades of wind-blown grass), **High**, **Medium** and **Low** (for older PCs). The choice is remembered.
- **Sound** is made live in the browser (no sound files): every gun class, cannon, rockets, explosions that arrive late from far away, rotors, engines and tank tracks, bullet impacts, lock-on tones. It starts after your first click.

## Goal

Steal the enemy team's gem from their base and carry it back to your own gem to win (on foot for the last step: you can't capture from inside a vehicle).

## Credits

Public-domain ([CC0](https://creativecommons.org/publicdomain/zero/1.0/)) assets:

- Sky: "Sunflowers (Pure Sky)" by Greg Zaal and Jarod Guest — [Poly Haven](https://polyhaven.com/a/sunflowers_puresky)
- Ground: [Grass 004](https://ambientcg.com/view?id=Grass004) and [Ground 037](https://ambientcg.com/view?id=Ground037) from ambientCG; [Forest Ground 04](https://polyhaven.com/a/forest_ground_04), [Rock Face 03](https://polyhaven.com/a/rock_face_03), [Coast Sand 01](https://polyhaven.com/a/coast_sand_01) from Poly Haven
- From Poly Haven: "Service Pistol" by Mateusz Sadek ([source](https://polyhaven.com/a/service_pistol), the handgun), "Concrete Road Barrier 02" by Amal Kumar ([source](https://polyhaven.com/a/concrete_road_barrier_02)), "Old Military Crate" by Jack Mava ([source](https://polyhaven.com/a/old_military_crate)), "Metal Jerrycan Green" by Ulan Cabanilla ([source](https://polyhaven.com/a/metal_jerrycan_green)), "Portable Generator" by James Ray Cock ([source](https://polyhaven.com/a/portable_generator)), "Barrel 01" by Jorge Camacho ([source](https://polyhaven.com/a/Barrel_01), the explosive barrels)
- "Hand Grenade" by CreativeTrio — [source](https://poly.pizza/m/YWhHlmKOtx)
- "Sack Trench" by Quaternius — [source](https://poly.pizza/m/LW3jwpPfiN) (the outposts' sandbag walls)

3D models used under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/):

- "Hind Attack Helicopter" by [Ashley Aslett](https://sketchfab.com/AshleyAslett) — [source](https://sketchfab.com/3d-models/bb65bdfde2c54007a52dfbe1d91d930d) (markings removed, split into parts, canopy glass added, scaled; its missile is the AA missile)
- "Challenger 2 – Shooting Range" by [Tom Zimmermann](https://sketchfab.com/tomm8) — [source](https://sketchfab.com/3d-models/e70234f6d695467499abc56646ab3e66) (the tank, taken out of the diorama and split into hull, turret and gun)
- "Medium Mech Striker" by [MSGDI](https://sketchfab.com/MSGDI) — [source](https://sketchfab.com/3d-models/medium-mech-striker-27ba717c173a40b7841d2f2c6a89d823) (the combat mech)
- "Shadow - metal war online" by [Vyacheslav](https://sketchfab.com/Vedunov.s) — [source](https://sketchfab.com/3d-models/shadow-metal-war-online-63ec56441bed458e98fb74dc6bd08575)
- "Military Base #1 - Truck Masters India Simulator" by [Villanueva-Jonatan-32621](https://sketchfab.com/vj32621) — [source](https://sketchfab.com/3d-models/military-base-1-truck-masters-india-simulator-7c6372dfe0e84af587f8b12167d210ca)
- "Panzerschreck" by [Tactical_Gamer](https://sketchfab.com/Tactical_Beard) — [source](https://sketchfab.com/3d-models/panzerschreck-33546ba8dab24ae695966602092b9b44)
- "Ammo Crate" by [drcrazzie](https://sketchfab.com/drcrazzie) — [source](https://sketchfab.com/3d-models/ammo-crate-35694b56bf44439aba1732ac198f7df2)
- "9mm Ammo Box" by [stfuaahil](https://sketchfab.com/stfuaahil) — [source](https://sketchfab.com/3d-models/9mm-ammo-box-c902c80557f849ba9c9fdd06d8510a68)
- "5.56x45mm ammo box" by [Poly-Arms](https://sketchfab.com/Poly-Arms) — [source](https://sketchfab.com/3d-models/556x45mm-ammo-box-dbd8e5f4d4554e85a42083ca78d4c586)
- "9mm Bullet" by [KING MUFFIN](https://sketchfab.com/KingMuffinGF) — [source](https://sketchfab.com/3d-models/9mm-bullet-63b5be22501a404e96dd3e8420821d0c)
- "Bullet" by [RoutineStudio](https://sketchfab.com/TheRoutine) — [source](https://sketchfab.com/3d-models/bullet-8333d86fe2674aaf8888cc5fa4537d20)
- "Uzi Bullet" by [rustic.orcullo13](https://sketchfab.com/rustic.orcullo13) — [source](https://sketchfab.com/3d-models/uzi-bullet-f04d2aa541c048209e9d282bd7855fa7)
- "Gun M4A1" by [Ivan008](https://sketchfab.com/hukan008) — [source](https://sketchfab.com/3d-models/gun-m4a1-d41a80aa5bc14742be249d2e8e7369b9)
- "Sci Fi M254 Gun - High Poly" by [Karan Sahu](https://sketchfab.com/cgkaran) — [source](https://sketchfab.com/3d-models/sci-fi-m254-gun-high-poly-f372ff61e3ed4fbda1e2cde75bf98a8d)
- "Heavy Pulse Machine Gun" by [Polly Hermiston](https://sketchfab.com/Polly_Hermiston) — [source](https://sketchfab.com/3d-models/heavy-pulse-machine-gun-f955e6ebcbae4868abe837dcee45e42d)
- "M240B Machine gun" by [unleasharun](https://sketchfab.com/unleasharun) — [source](https://sketchfab.com/3d-models/m240b-machine-gun-3d0d13cb1c694164b78b279e1d6da0e3)
- "Quad Barrel Plasma Gun" by [curichenkow](https://sketchfab.com/curichenkow) — [source](https://sketchfab.com/3d-models/quad-barrel-plasma-gun-11d18396863242a19e29e0259755bfa9)
- "M170 Sniper Rifle" by [Bl4ckGh0st](https://sketchfab.com/Bl4ckGh0st) — [source](https://sketchfab.com/3d-models/m170-sniper-rifle-fcb26d1ed0384360bd42f3e584bdfaab)
- "SVD (Dragunov sniper rifle)" by [LeroyCake](https://sketchfab.com/leroycake) — [source](https://sketchfab.com/3d-models/svd-dragunov-sniper-rifle-2ac78fb5a0eb40f5a02a5b0a9f566abf)
- "Weapon - Gun" by [aswin.baskaran](https://sketchfab.com/aswin4550) — [source](https://sketchfab.com/3d-models/weapon-gun-537b135ab3c2444fae2feaefcc89e621) (the primary gun)
- "Science Fiction Machine Gun" by [Suryxin](https://sketchfab.com/Suryxin) — [source](https://sketchfab.com/3d-models/science-fiction-machine-gun-the-expanse-115af5f738ca47fda420b9019c200b3c) (the bases' machine guns)
- "Grass 02" by [Digital screen official](https://sketchfab.com/ck212575) — [source](https://sketchfab.com/3d-models/grass-02-539d1c154c944e24a04478ee32f0a960) (grass clumps on Low)
- "A Simple Rock" by [Ozonek](https://sketchfab.com/ozonek) — [source](https://sketchfab.com/3d-models/a-simple-rock-bcfc084c997f4c019d404bb92dcc4d2c)
- "Rock 17 (Free) Rock Pack Vol.3" by [Kless Gyzen](https://sketchfab.com/klessgyzen) — [source](https://sketchfab.com/3d-models/rock-17-free-rock-pack-vol3-112533f65f3d4848ae14d18ed59f0db2)
- "fantasy rock" by [duckcracker02](https://sketchfab.com/duckcracker02) — [source](https://sketchfab.com/3d-models/fantasy-rock-8c076ad2faa84bc4af95b96e67480383)
- "Pine tree" by [Andriy Shekh](https://sketchfab.com/sheh5262) — [source](https://sketchfab.com/3d-models/pine-tree-e52769d653cd4e52a4acff3041961e65)
- "Realistic Tree" by [Daniel](https://sketchfab.com/danielpetrov) — [source](https://sketchfab.com/3d-models/realistic-tree-d989c0f801d847b9a74992ec4ddcfdfc)
- "Stylized Gem" by [Frédéric Cambon](https://sketchfab.com/tribble42) — [source](https://sketchfab.com/3d-models/stylized-gem-f54bc908a3054c92aeb7d457415306a2)

Other licences:

- "Stylized Rock" by [Agustín Hönnun](https://sketchfab.com/Agustin_Honnun) — [source](https://sketchfab.com/3d-models/stylized-rock-93965a5869ed4e9f8dd8902ea8836852) (Sketchfab Standard licence)
- "Crystal stone (rock)" by [GenEugene](https://sketchfab.com/geneugene) — [source](https://sketchfab.com/3d-models/crystal-stone-rock-1ad829e2f464446fa4945562ab611255) (CC BY-NC 4.0: non-commercial use only — replace it before selling the game)
