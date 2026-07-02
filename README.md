# AI-TTRPG Engine

A turn-based AI-powered tabletop RPG engine. JSON-native, op-protocol-driven,
rules-agnostic, **multiplayer**. An LLM runs the table — narration, NPCs,
adjudication — while the engine rolls every die deterministically.

**Stack:** Node ESM server + Vite client + WebSocket + plain JS — no framework,
no TypeScript, no React. LLM: DeepSeek by default (any OpenAI-compatible API),
full offline mode with a deterministic mock. Scene art: free keyless generation
(Pollinations) with disk caching.

## Quick start

```bash
npm install
npm run play:necrotopia    # the shipped campaign (or `npm run dev` for the 5e demo world)
npm run play:dsa           # Der Finsterwald — DSA-style 3W20 roll-under campaign
```

- Player client: `http://localhost:5173` — every browser (or friend on your LAN)
  that opens it becomes a **party member** with their own character.
- **DMView**: `http://localhost:5173/dm.html` — the DM control surface.
- Server API + WS: `http://localhost:8420`

You start as **the Apocalypse Kid** in a Las Vegas wedding chapel as imps burst
through the doors. `attack the snarling imp`, survive the CTB-timeline fight with
Padre Salt at your side, then escape to the Strip and steal the idling Cadillac.

No API key? It runs fully offline: `LLM_PROVIDER=mock npm run play:necrotopia`
(canned narration, real combat/quests/dice).

**Three rulesets, one engine** — the same seams run D&D 5e (d20 roll-over-DC),
Necrotopia (d6 roll-over-Armor), and DSA (3W20 roll-UNDER with skill-point
compensation, quality levels, and Attacke/Parade combat). In `play:dsa` you are
Alrik in the rain-soaked village of Weyhersbrunn: goblins hold the old mill, and
the reason they left the deep woods is worse than they are.

## What's in the box

- **The loop** — type anything; the LLM DM adjudicates (speak / move / check /
  consequence), the engine rolls, narration streams token-by-token, and a
  canonizer records what became true. The story survives refreshes (journal
  backfill) and Ctrl-C (flush-on-exit saves).
- **Multiplayer** — first player claims the campaign protagonist; every further
  player gets a party member auto-built from the ruleset. Per-seat combat turns,
  party-wide XP, per-seat information hiding (players never see NPC secrets).
- **Combat** — deterministic encounters: FFX-style CTB timeline or classic
  initiative, Moves with statuses (bleed/stun/rage), zones + hazards, overdrive
  finishers, summons, enemy morale (the LLM wakes only for the interesting
  beats: broken morale, mid-fight talk, improvised actions like "throw sand in
  its eyes").
- **DMView** — the full story transcript, autopilot toggle (off = every LLM beat
  needs your approve/reject/regenerate), stage-a-beat authoring (spawn actors,
  request checks, put words in an NPC's mouth, begin combat), turn-order
  override for both combat models, agent-activity traces, god-mode inspector.
- **The walkable world** — every location renders as a tile map you point-click
  through (Diablo-style): exits travel, clicking an NPC talks, clicking an enemy
  walks up and starts the turn-based fight. Tiles are semantic tags skinned by
  swappable tilesets — the default is AI-painted and cached; a flat offline skin
  ships too. Press 🗺 for the world map (visited-locations graph with fog).
- **The breathing world** — a 4-phase day ticks with your actions: NPCs walk
  their scheduled rounds ("Bodo heads for the inn"), locations surface authored
  ambient lines, and the DM narrates by the clock. Deterministic — no LLM
  required for the world to feel inhabited.
- **Memory** — the journal writes itself into the people it happened to:
  clock-stamped lifelogs for PCs and NPCs, folded into ≤80-word living
  summaries by the LLM (never silently evicted). The DM sees every party
  member's story-so-far; NPCs remember what they told you. `GET /sense/recall?q=`.
- **Atmosphere** — procedural mood music (Web Audio, zero assets, 🔊 toggle)
  that follows map style × time of day, flips for combat, and obeys the
  DMView mood knob. Scene paintings + NPC portraits from `art.prompt`s, all
  anchored by a per-world style string. `ART_PROVIDER=mock` for offline play.
- **Rules-as-data** — 5e (d20-vs-DC), DSA (3d20 roll-under + Attacke/Parade),
  and Necrotopia (d6-over-Armor) run on the same core. A ruleset is one
  pure-data file. See [docs/RULESET-AUTHORING.md](docs/RULESET-AUTHORING.md).
- **Worldgen** — generate a region-structured campaign as data (up to 36
  locations: settlements, wilds, dungeon chains, a boss lair, side quests):
  procgen skeleton + an LLM pass that charges it with meaning, written in the
  exact shape the engine seeds from. `campaigns/lanternfall/` was made this way.
- **Addons/plugins** — a whole game can live OUTSIDE this repo: an addon
  directory ships a campaign + ruleset, a server hook, a client UI plugin, and
  DM-prompt extensions, all declared in one `addon.json`. Install from the ⚙
  settings panel (or `addons.json` / `TTRPG_ADDONS`); UI + server hooks load
  live, worlds seed on the next boot. See *Addons* below.

## Addons

An **addon** is a directory with an `addon.json` manifest — a full game as a
plugin, no fork needed:

```json
{ "id": "my-game", "name": "My Game", "version": "0.1.0",
  "description": "…",
  "world": "world",              // ships a campaign (scenes + ruleset, same layout as campaigns/*)
  "ruleset": "my-rules",         // default TTRPG_RULESET when its world runs
  "client": "client/index.js",   // UI plugin — mount({store, net, view, who, root, serverBase})
  "server": "server/index.js",   // register(ctx) after boot: routes, journal listeners, applyEffects
  "systemAppend": ["prompts/style.md"] }  // appended to the DM system prompt
```

Three ways to install: the **⚙ settings panel** in the player client (install
by path, enable/disable per browser and per server), the `addons.json` file at
the repo root (see `addons.example.json`; gitignored), or
`TTRPG_ADDONS=/path/to/addon npm run dev`. When `TTRPG_WORLD` is unset, the
first enabled addon that ships a world **becomes the campaign** — one env var
boots a whole out-of-tree game. Client plugins and server hooks load live at
runtime; an addon's world/ruleset seeds on the next boot.

Rulesets (in-repo or addon-shipped) may also export `effects` — new semantic
ops with engine-side clamping (`registerEffects`), accepted on every wire path.
The server serves addon files at `/addons/<id>/…` and lists installs at
`GET /addons`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TTRPG_WORLD` | `./world` | Campaign directory (scenes, ruleset, saves) |
| `TTRPG_PORT` | `8420` | Server HTTP + WS port |
| `TTRPG_CLIENT_PORT` | `5173` | Vite dev server port |
| `TTRPG_SAVE` | `default` | Session save slot name |
| `TTRPG_RULESET` | _(none)_ | Ruleset bundle from `<world>/ruleset/<id>/`. Unset → built-in 5e |
| `TTRPG_SEED` | `42` | PRNG seed (reproducible dice); a loaded save wins |
| `LLM_PROVIDER` | `deepseek` | `deepseek` or `mock` (offline, no key) |
| `DEEPSEEK_API_KEY` | _(none)_ | Read only from env / gitignored `.env`; never logged or sent to clients |
| `ART_PROVIDER` | `pollinations` | `pollinations` (free, keyless) · `mock` (offline SVG) · `openai` (needs `OPENAI_API_KEY`) |

## Scripts

```bash
npm run play:necrotopia   # the shipped campaign (d6 apocalypse)
npm run play:dsa          # Der Finsterwald (3W20 roll-under)
npm run play:lanternfall  # the GENERATED campaign (24 locations, 6 regions, 5 quests)
npm run dev               # server + client on ./world (5e demo)
npm test                  # unit + integration suite (boots real servers, offline)
npm run smoke:necrotopia  # ruleset smoke checks
npm run worldgen -- --theme "haunted salt marsh" --size large --out world/scenes/marsh.json
```

**Worldgen v2** builds region-structured worlds: a chain of settlement → wilds →
dungeon regions linked by roads, enemy packs distributed across the map, a boss
lair at the far end, and a side quest per pack/relic beside the main quest.
Procgen owns structure (connectivity, placement, triggers); the LLM charges the
skeleton with meaning (region names first, then every location with region
context). Sizes: `small` 4 locations · `medium` 10 · `large` 24 · `epic` 36, or
`--locations N --regions K`. Generated once → fixed data you can hand-edit.

## HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/schema` | Full declarative SCHEMA object |
| `GET` | `/events?since=<seq>&limit=<n>` | Journal (the story so far) |
| `POST` | `/op` | Apply op(s) — `{ops:[...], from?}` |
| `GET` | `/art/<entityId>` | The entity's `art.prompt`, rendered + cached |
| `GET` | `/health` | Server stats |
| `GET` | `/sense/look` · `/sense/describe?id=` · `/sense/query` · `/sense/check` | Text senses |

## Extending

- **Architecture** (op protocol, turn pipeline, seams): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Write a ruleset / campaign**: [docs/RULESET-AUTHORING.md](docs/RULESET-AUTHORING.md)
- Original build-phase specs are preserved in [docs/archive/](docs/archive/).
