# AI-TTRPG Engine

A turn-based AI-powered tabletop RPG engine. JSON-native, op-protocol-driven, ruleset-extensible.

**Stack:** Node ESM server + Vite client + WebSocket + plain JS — no framework, no TypeScript, no React.

## Quick start

```bash
npm install
npm run dev
```

- Server: `http://localhost:8420` (WS + HTTP)
- Client: `http://localhost:5173` (Vite dev server)

## Configuration

By default the server loads the campaign from `./world/`.

| Variable | Default | Purpose |
|---|---|---|
| `TTRPG_WORLD` | `./world` | Campaign directory (scenes, ruleset, saves) |
| `TTRPG_PORT` | `8420` | Server HTTP + WS port |
| `TTRPG_CLIENT_PORT` | `5173` | Vite dev server port |
| `TTRPG_SAVE` | `default` | Session save slot name |

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

## How to extend

### Add a component

1. Add it to `shared/schema.js` — the `SCHEMA` object. Include `doc`, `default`, and `fields` with `range`/`enum` where useful.
2. Add rendering in `client/kernel/view.js` — the `_renderComponent()` switch. The client inspector auto-shows new components.
3. The server's op validation and the `GET /schema` endpoint pick it up automatically.

### Add an op handler

1. Add the handler function to `handlerRegistry` in `shared/ops.js`. The signature is `(entities /* Map */, op, counterRef)` → `{ok, ...}`.
2. For ephemeral ops (broadcast+journal only, no entity mutation), add the op kind to the list in `applyOp()` in `shared/ops.js`.

### Add a campaign / ruleset directory

1. Create a directory with `campaign.json` (superscene), `scenes/` (`.json` files with `{id: {components}}`), and optionally `ruleset/` (schema extensions + system prompt).
2. Point `TTRPG_WORLD` at it.
3. Rulesets call `registerComponents(...)` from `shared/schema.js` to extend the schema — the DM inspector, LLM contract, and validation all pick it up.
