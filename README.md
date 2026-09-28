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
- **F** — switch weapon. Everyone starts with the Z-1V volt pistol (7 rounds, 3 magazines) and the AR-H470 pulse rifle (30 rounds, 3 magazines). You carry one sidearm, one long gun and one rocket launcher; each base's gun table has two of every long gun (SMG-M32, BR-9 battle rifle, HMG-379 heavy rifle, rotary cannon, plasma caster, M13 gauss sniper and Longbow rail rifle) with ammo boxes beside it — picking one up puts your current long gun down.
- **G** — pick up what is in reach (a weapon, rockets from a rocket crate, ammo from an ammo box), or drop the weapon in your hand. Weapons and ammo of either team can be used; players drop what they carried where they die.
- **V** — melee strike with your gun (on foot): a heavy blow to an enemy right in front of you, or an instant takedown from behind (an *Assassination*).
- **Energy shield**: the blue bar at the top of the screen soaks up damage before your health (the pips under it) does. Stay out of fire for 4 seconds and it recharges. Enemies' shields shimmer when you hit them.
- **Callouts**: kills in quick succession make a *Double Kill*, *Triple Kill*…; five, ten, fifteen kills without dying a *Killing Spree*, *Rampage*, *Unstoppable*.
- **Q** — throw a hand grenade (you start with 2 and can carry 4; the grenade boxes beside each base's gun table hold more). It bounces off the ground, walls and trees and goes off after about 3 seconds.
- **E** — get into / out of any vehicle (both teams' gunships, space fighters, assault buggies, tanks and combat mechs), or man / leave a machine gun outside a base. If **enemies are sitting in a vehicle standing on the ground**, **E** pulls them out and you take it (their pilot / driver seat first). They can't climb straight back in for 10 seconds. An aircraft in the air or a vehicle driving off has to be stopped or shot down first.
- In a **VTOL gunship** (four seats, on each base's landing row): the **pilot** flies and fights: **Space** spins the lift fans up (**Shift** down), then **W/S** forward/back, **A/D** turn, **↑/↓** altitude, **←/→** roll, **V** cockpit / chase view. The ball turret under the nose swings to the crosshair and **Left click** fires it; **Right click** fires a salvo of four missiles from the wing pods (fans spinning; they reload in 6 s). The **co-pilot** and two **door gunners** leaning out of the cabin sides shoot with their own weapons.
- In an **assault buggy**: **W/S** drive / reverse, **A/D** steer, **Space** brake, **V** chase / roof view; the **mouse** swings the roof gatling onto whatever the crosshair is on and **Left click** fires it (heavy rounds).
- In a **tank** (two outside each base's gate): **W/S** drive, **A/D** turn the hull on its tracks (on the spot too; the tread rollers really turn), **Space** brake. The turret swings round slowly to wherever you aim; a ring on screen shows where the gun really points. **Left click** fires a shell (3 s reload) that explodes where it lands. **V** switches between the chase view and the magnified gunner's sight. Bullets can't hurt a tank or its driver: use shells, rockets and grenades.
- In a **combat mech** (two outside each base's gate): **W/S** walk (**Shift** runs, **S** backs up), **A/D** turn, **Space** fires the jump-jets (a few seconds of fuel, it refills on the ground). The torso turns towards wherever you aim; **Left click** fires the arm autocannon, **Right click** a salvo of six rockets from the shoulder pods (then they reload), **V** cockpit / chase view. Bullets barely scratch its armour and can't reach its pilot.
- **Space fighters** (two on pads outside each base's side wall; blue and red fly different designs): hold **Space** to lift off on the lift jets, **W/S** throttle, **Shift** boost, the **mouse** steers (the fighter swings its nose to where you look), **A/D** roll. **Left click** fires the nose lasers, **Right click** a missile — hold the nose on an enemy aircraft for about a second to lock and it homes in. **V** cockpit / chase view. Climb above ~300 m and you leave the atmosphere: the sky turns to space, the two team **capital ships** hold station above the bases and fighters dogfight among the **asteroids**. Land (slow down and settle on the ground, or on a capital ship's flight deck) before getting out with **E**. Fighters and gunships leave engine and vapour trails.
- **Capital ships**: each team has a capital ship high over its base, and they can be shot down. Step onto the glowing **teleport pad** by your base's fighter pads to beam into your ship's **hangar bay** (armoured walls, cover, a pad back down). From there:
  - the **bridge console** at the back of the hangar: **E** takes command of the ship's **main cannon** — a heavy twin cannon on top of the hull. Aim with the mouse, **Left click** fires a huge plasma shell (2.4 s reload): pound the enemy ship, aircraft or anything below;
  - the **flight deck** outside: three heavy pulse cannons on its rail, room to land and take off in a fighter.
  Both ships' hull strength shows under the roster. Ship cannon shells, rockets, missiles, fighter lasers and pulse bolts all damage an enemy ship; when its hull reaches zero it blows up in a chain of explosions, killing everyone aboard, and burns dark for a minute until it's repaired. Enemies can beam or fly aboard your ship and fight you there.
- **Vehicles take damage** (fighters 380, gunships 450, buggies 700, mechs 1600, tanks 2000): rounds chip at aircraft and buggies, explosions tear into everything, and a vehicle trails smoke when it is badly hurt. At zero it blows up with everyone inside, and it's back at home 30 seconds later. The HUD shows your vehicle's hull.
- **Pulse cannons** (the guns outside the bases and on the ships' decks): slow, heavy balls of flaming plasma that burst where they hit — made for bringing down aircraft and cracking tanks.
- Rounds leave holes in the ground, rocks, walls and vehicles, and throw up dust, chips, splinters or sparks; guns eject their casings.
- **M236 rocket launcher** (10 on the rack in each base; rockets come from the 10 rocket crates, 4 each): hold the crosshair on an aircraft (gunship or fighter) with an enemy aboard for **2 seconds** to lock on (a beeping tone that turns steady), then fire — the missile homes in and destroys it with everyone inside. A shot-down aircraft is back on its pad 30 seconds later. Fire **without a lock** and it's an unguided rocket that flies straight: good against cars, tanks and people.
- **Explosive barrels** stand by each gate, by each base's fuel tanker and in every outpost: shoot one and it blows up (setting off any barrel next to it). They're back 45 seconds later.
- **Sandbag outposts**: six in the open between the bases, each with sandbag walls, concrete barriers and crates that stop rounds, an ammo box, jerrycans, a generator and a barrel.
- **HUD**: a radar (top left) turned to where you look shows the map, your teammates, the vehicles, the gems, and any enemy who gives himself away (fires, comes close, or carries your gem). There's also a kill feed under the roster and red arcs showing where damage comes from.
- **Loading**: a battle opens with a *Deploying* screen until every model, texture and sound is in, so nothing pops in once you're playing.
- **Graphics**: the buttons under the radar switch between **Ultra** (the default: cascaded sun shadows out to 600 m, ambient occlusion, bloom, god rays, 8K sky, 2K ground photos, 380k blades of wind-blown grass), **High**, **Medium** and **Low** (for older PCs). The choice is remembered.
- **Discord**: the room lobby's **Copy Discord invite** button copies a join link to paste into your Discord. To have the server post new battles (with the join link), battle starts, killing sprees and winners to a Discord channel, create a webhook in the channel (channel settings → Integrations → Webhooks) and put its URL in `server/.env` as `DISCORD_WEBHOOK_URL` (and the address players open the game at as `PUBLIC_SITE_URL`, for the links). See `server/.env.example`.
- **Sound** is made live in the browser (no sound files): every gun class, cannon, rockets, explosions that arrive late from far away, rotors, engines and tank tracks, bullet impacts, lock-on tones. It starts after your first click.

## Goal

Steal the enemy team's gem from their base and carry it back to your own gem to win (on foot for the last step: you can't capture from inside a vehicle).

## Credits

All models and textures are free assets used under their licences; none are taken from Halo or any other game or film. "Modified" means rescaled, split into parts, recoloured, simplified or cleaned up for the game.

Public-domain ([CC0](https://creativecommons.org/publicdomain/zero/1.0/)) assets:

- The iron ground: [Metal Plates 013](https://ambientcg.com/a/MetalPlates013), [Metal Plates 012](https://ambientcg.com/a/MetalPlates012), [Gravel 024](https://ambientcg.com/a/Gravel024), [Rock 035](https://ambientcg.com/a/Rock035) and [Ground 092A](https://ambientcg.com/a/Ground092A) (ambientCG) — regraded to gunmetal, rust and ash
- Rocks: [Moon Rock 02](https://polyhaven.com/a/moon_rock_02), [03](https://polyhaven.com/a/moon_rock_03) and [05](https://polyhaven.com/a/moon_rock_05) by Greg Zaal, Rico Cilliers and Jenelle van Heerden (Poly Haven)
- From Poly Haven: "Concrete Road Barrier 02" by Amal Kumar ([source](https://polyhaven.com/a/concrete_road_barrier_02))
- "Sack Trench" by Quaternius — [source](https://poly.pizza/m/LW3jwpPfiN) (the outposts' sandbag walls)
- The soldiers' animations: "Universal Animation Library" by Quaternius — [source](https://quaternius.com/packs/universalanimationlibrary.html)

3D models used under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) (all modified):

- Soldiers: "Security Cyborg" by [fletcherkinnear](https://sketchfab.com/fletcherkinnear) — [source](https://sketchfab.com/3d-models/94ea8c717c374e3fa8aaa7549235b323) (re-rigged, team-painted)
- Space fighters: "Space Fighter" ([source](https://sketchfab.com/3d-models/e766136d4871441289d37d44a4bbcd3b)) and "Space Ship" ([source](https://sketchfab.com/3d-models/63ce372c1aa843e98bf1548109e055d8)); capital ships: "D.S.S. Harbinger battle cruiser" ([source](https://sketchfab.com/3d-models/474f62d00ed54212b37f93ce91569c53)); the station: "Gangut space hub" ([source](https://sketchfab.com/3d-models/db9e338f04ae402c82f8ebdf12b55f9e)) — all by [Comrade1280](https://sketchfab.com/comrade1280)
- Gunship: "Heavy VTOL gunship" by [Kai Xiang](https://sketchfab.com/kirikom9000) — [source](https://sketchfab.com/3d-models/86d336e0fa6f40329de8cda4a71d8a17)
- Tank: "Electro Tank" by [Panther5](https://sketchfab.com/Panther5) — [source](https://sketchfab.com/3d-models/05613d002df542a1aac0d4b2b067682f)
- Assault buggy: "Hyena Recon Transport" by [Michael Wright](https://sketchfab.com/rawer) — [source](https://sketchfab.com/3d-models/749ff9cf09a74945b065240ff208f768)
- Combat mech: "Medium Mech Striker" by [MSGDI](https://sketchfab.com/MSGDI) — [source](https://sketchfab.com/3d-models/medium-mech-striker-27ba717c173a40b7841d2f2c6a89d823)
- Asteroids: "Asteroids Pack (metallic version)" and "(rocky version)" by [SebastianSosnowski](https://sketchfab.com/SebastianSosnowski)
- The buggy's gatling turret: from "Shadow - metal war online" by [Vyacheslav](https://sketchfab.com/Vedunov.s) — [source](https://sketchfab.com/3d-models/shadow-metal-war-online-63ec56441bed458e98fb74dc6bd08575)
- The bases: "Military Base #1 - Truck Masters India Simulator" by [Villanueva-Jonatan-32621](https://sketchfab.com/vj32621) — [source](https://sketchfab.com/3d-models/military-base-1-truck-masters-india-simulator-7c6372dfe0e84af587f8b12167d210ca) (repainted as gunmetal with light strips)
- Weapons:
  - "Z-1V High-Voltage Pistol" by valterjherson1 (after a design by 单 shan) — [source](https://sketchfab.com/3d-models/725d65cfd7b045f89ccf178127e16c05)
  - "AR-H470" ([source](https://sketchfab.com/3d-models/4b38c160243743d681d6fdaf3bd77ddb)), "SMG-M32" ([source](https://sketchfab.com/3d-models/3a5f98f75e804e5888379cbe640cc883)) and "HMG-379" ([source](https://sketchfab.com/3d-models/533204d3a9f240f78b65973b323cba7c)) by Frostoise
  - "Old Sci-fi gun" by sarychev.r — [source](https://sketchfab.com/3d-models/7c280b2889bf4e0aa05a8f91848e01ea) (the battle rifle)
  - "Sci-Fi Minigun" by Yojik3d — [source](https://sketchfab.com/3d-models/30601ddff831445bba3a2f9246baec9b) (the rotary cannon)
  - "Sci-Fi Gun" by vicky (@vineet) — [source](https://sketchfab.com/3d-models/d2d7c38188cb45fbac4c49eef447e028) (the plasma caster)
  - "Sci-fi rifle M13-Gaus" by DigitalTales — [source](https://sketchfab.com/3d-models/648847589fec4ecc9b91d7cdcc9c4d84)
  - "Bob's sniper-rifle" by denlark — [source](https://sketchfab.com/3d-models/b459c3df0c5d4f2ebbe9137e04d86e24) (the rail rifle)
  - "Rocket Launcher M236" by sobivan — [source](https://sketchfab.com/3d-models/dfd9c2d294d54ccfa5350b42de3e26ad) (the launcher and its rockets)
  - "Cyber frag grenade" by SHZ — [source](https://sketchfab.com/3d-models/5d38fc47b9e24a4f8084d7995dfceeea)
  - "Science Fiction Machine Gun" by [Suryxin](https://sketchfab.com/Suryxin) — [source](https://sketchfab.com/3d-models/science-fiction-machine-gun-the-expanse-115af5f738ca47fda420b9019c200b3c) (the bases' fixed guns)
- Supplies: "Sci-Fi Power Cell Prop" by pixelgrapher ([source](https://sketchfab.com/3d-models/e43322345d39429d82396a8642bb8d70)), "Sci-Fi crate / ammunition box" (1) and (2) by ul1tka ([source](https://sketchfab.com/3d-models/69fe3211493c4a4db26ad0c4e2e49a83), [source](https://sketchfab.com/3d-models/342efe4d70f94d37a4edd66a15c39502))
- Props: "Sci-fi barrel" by Igor_K. ([source](https://sketchfab.com/3d-models/sci-fi-barrel-481f7499eaf64b8792bffc59a8b4e05a), the explosive fuel cells), "Sci-fi cargo crate" by andreas9343 ([source](https://sketchfab.com/3d-models/sci-fi-cargo-crate-ac36898521304e51a8e305aa602f1f5b)), "Scifi Canister" by cmitche1 ([source](https://sketchfab.com/3d-models/scifi-canister-c48dff7e9c5848fa94cf2a02528ede08)), "Scifi Tank Doodad" by TooManyDemons ([source](https://sketchfab.com/3d-models/scifi-tank-doodad-0ef0619189de4a32b6972e63cb6adec0))
- Alien plants: "Mushroom tree" by mrrobot ([source](https://sketchfab.com/3d-models/mushroom-tree-a91dca72963242739dd3cc2e60637869)), "Coral piece" by Nik ([source](https://sketchfab.com/3d-models/coral-piece-8d241235784e4be8895c26f20dbf5610)), "Purple coral" by vapor_ ([source](https://sketchfab.com/3d-models/purple-coral-71ad959a42fb43fc9b819fdc4368f417)), "Glowing Plants" by bluewombat ([source](https://sketchfab.com/3d-models/glowing-plants-0b80514d84c04589b5897e86e4764080)), "Grass 02" by Digital screen official ([source](https://sketchfab.com/3d-models/grass-02-539d1c154c944e24a04478ee32f0a960), recoloured)
- Crystals: "Crystals" by PolyToots — [source](https://sketchfab.com/3d-models/crystals-0499073f160248adb451bf4135e5f50a)
- Bullet casings: "9mm Bullet" by [KING MUFFIN](https://sketchfab.com/KingMuffinGF) ([source](https://sketchfab.com/3d-models/9mm-bullet-63b5be22501a404e96dd3e8420821d0c)), "Bullet" by [RoutineStudio](https://sketchfab.com/TheRoutine) ([source](https://sketchfab.com/3d-models/bullet-8333d86fe2674aaf8888cc5fa4537d20)), "Uzi Bullet" by [rustic.orcullo13](https://sketchfab.com/rustic.orcullo13) ([source](https://sketchfab.com/3d-models/uzi-bullet-f04d2aa541c048209e9d282bd7855fa7))
- The red gem: "Stylized Gem" by [Frédéric Cambon](https://sketchfab.com/tribble42) — [source](https://sketchfab.com/3d-models/stylized-gem-f54bc908a3054c92aeb7d457415306a2)

Other licences:

- The blue gem: "Crystal stone (rock)" by [GenEugene](https://sketchfab.com/geneugene) — [source](https://sketchfab.com/3d-models/crystal-stone-rock-1ad829e2f464446fa4945562ab611255) (CC BY-NC 4.0: non-commercial use only — replace it before selling the game)

The sky, planets, clouds and space are painted by the game itself (no image files).
