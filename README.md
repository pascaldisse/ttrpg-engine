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
- **Scene art** — locations carry an `art.prompt`; the engine renders it once
  (free, keyless) and caches it. `ART_PROVIDER=mock` for offline SVG moods.
- **Rules-as-data** — 5e (d20-vs-DC), DSA (3d20 roll-under), and Necrotopia
  (d6-over-Armor) run on the same core. A ruleset is one pure-data file. See
  [docs/RULESET-AUTHORING.md](docs/RULESET-AUTHORING.md).
- **Worldgen** — generate a new campaign as data: procgen skeleton + an LLM pass
  that charges it with meaning, written in the exact shape the engine seeds from.

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
