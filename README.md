# AI-TTRPG Engine

A turn-based AI-powered tabletop RPG engine. JSON-native, op-protocol-driven, ruleset-extensible.

**Stack:** Node ESM server + Vite client + WebSocket + plain JS — no framework, no TypeScript, no React.

## Quick start

```bash
npm install
npm run dev
```

- Server: `http://localhost:8420` (WS + HTTP)
- Player client: `http://localhost:5173` (Vite dev server)
- **DMView** (DM control surface): `http://localhost:5173/dm.html`

The **DMView** joins as the `dm` seat and exposes: an **autopilot** toggle (when off, the DM reviews each LLM
beat via a propose→approve gate — approve / reject / regenerate), an **agent-activity** feed of LLM decisions
and tool calls, **combat turn-order** override, and a full entity inspector. Players never receive the DM-only
machinery or NPC secrets — the server filters every message per seat (`shared/visibility.js`).

## Configuration

By default the server loads the campaign from `./world/`.

| Variable | Default | Purpose |
|---|---|---|
| `TTRPG_WORLD` | `./world` | Campaign directory (scenes, ruleset, saves) |
| `TTRPG_PORT` | `8420` | Server HTTP + WS port |
| `TTRPG_CLIENT_PORT` | `5173` | Vite dev server port |
| `TTRPG_SAVE` | `default` | Session save slot name |
| `TTRPG_RULESET` | _(none)_ | Ruleset bundle to load at boot from `world/ruleset/<id>/` (e.g. `srd5e`, `dsa5`). Unset → built-in 5e. |
| `TTRPG_SEED` | `42` | PRNG seed for reproducible sessions (dice, etc.). A loaded save wins. |
| `LLM_PROVIDER` | `deepseek` | LLM backend: `deepseek` or `mock` (offline, no key). |
| `DEEPSEEK_API_KEY` | _(none)_ | DeepSeek key — read **only** from env (gitignored `.env`); never logged or sent to the client. |

## HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/schema` | Full declarative SCHEMA object |
| `GET` | `/events?since=<seq>&limit=<n>` | Journal entries |
| `POST` | `/op` | Apply op(s) — `{ops:[...], from?}` |
| `GET` | `/health` | Server stats |

## CLI tools

```bash
# Spawn an entity
node tools/patch.mjs spawn '{"identity":{"name":"Goblin","kind":"npc"},"status":{"alive":true}}' goblin-1

# Set a component
node tools/patch.mjs set goblin-1 status '{"alive":false}'

# View events
node tools/patch.mjs events 0

# Get schema
curl localhost:8420/schema
```

### Generate a world

Generate a brand-new world as data (procgen skeleton + an LLM pass that "charges it with meaning"),
written to a scene JSON in the exact shape the engine seeds from — run once, then commit/hand-edit/play it.

```bash
# Offline, deterministic (mock LLM):
npm run worldgen -- --provider mock --theme "haunted salt marsh" --size small --out world/scenes/marsh.json

# With DeepSeek (key loaded from .env):
npm run worldgen -- --theme "sunbaked frontier town" --size medium --seed 7
```

Flags: `--theme`, `--size small|medium|large`, `--locations <n>`, `--seed <n>`, `--provider mock|deepseek`, `--out <path>`.
Point `TTRPG_WORLD` at a directory containing the generated `scenes/` to play it.

## Play the Necrotopia campaign

A complete, playable campaign ships in `campaigns/necrotopia/` — *Necrotopia: Handbook to the
Apocalypse* (a d6, roll-OVER-Armor system with no attributes and custom Moves). It proves the
engine is rules-agnostic a **third** way (5e = d20-vs-DC, DSA5 = 3d20 roll-under, Necrotopia =
d6 > Armor), all on the same core.

```bash
npm run play:necrotopia          # server on campaigns/necrotopia + the Necrotopia ruleset
# equivalent to:
TTRPG_WORLD=campaigns/necrotopia TTRPG_RULESET=necrotopia npm run dev
```

Then open the player client (`http://localhost:5173`). You start as **the Apocalypse Kid** in a
Las Vegas wedding chapel as imps burst through the doors — `attack the snarling imp`, survive,
then escape to the Strip and steal the idling Cadillac. Smoke test: `npm run smoke:necrotopia`.

## How to extend

### Add a component

1. Add it to `shared/schema.js` — the `SCHEMA` object. Include `doc`, `default`, and `fields` with `range`/`enum` where useful.
2. Add rendering in `client/kernel/view.js` — the `_renderComponent()` switch. The client inspector auto-shows new components.
3. The server's op validation and the `GET /schema` endpoint pick it up automatically.

### Add an op handler

1. Add the handler function to `handlerRegistry` in `shared/ops.js`. The signature is `(entities /* Map */, op, counterRef)` → `{ok, ...}`.
2. For ephemeral ops (broadcast+journal only, no entity mutation), add the op kind to the list in `applyOp()` in `shared/ops.js`.

### Add a campaign / ruleset directory

1. Create a directory with `campaign.json` (superscene), `scenes/` (`.json` files with `{id: {components}}`), and optionally `ruleset/<id>/` (`ruleset.js` + `system.md`).
2. Point `TTRPG_WORLD` at it (and `TTRPG_RULESET=<id>` to load the bundle). `campaigns/necrotopia/` is a worked example.
3. Rulesets call `registerComponents(...)` from `shared/schema.js` to extend the schema — the DM inspector, LLM contract, and validation all pick it up.

### A ruleset bundle (`ruleset.js`) is pure data + optional hooks

The core stays rules-neutral; a bundle plugs in its own mechanics by exporting any of:

- `components` — schema extensions, registered via `registerComponents` (e.g. Necrotopia's `moves`).
- `checks` — pluggable check definitions, registered via `registerChecks` in `shared/checks.js`. A check supplies its own `dice`, `comparator`, and `resolve()` — this is how the SAME engine rolls d20-vs-DC, 3d20 roll-under, **and** d6 > Armor.
- `combat` — an optional combat override consumed by `shared/combat.js`:
  - `combat.resolveAttack(params, entities, rng)` fully replaces attack resolution.
  - `combat.initiativeMode: 'fixed'` skips the initiative roll and uses a declared turn order (party, then foes).
  - `combat.flavor` overrides the combat narration lines (begin/victory/defeat/flee).
- `system.md` — the DM narration voice/rules for the LLM.

See `campaigns/necrotopia/ruleset/necrotopia/` for all four in ~150 lines of pure, import-free data.
