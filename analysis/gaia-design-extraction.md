# GAIA World Engine — Architecture & Convention Extraction

*Extracted 2026-06-16. Source: `~/projects/GAIA-World-Engine` (plan.md up to M20.1, server/index.js, server/world.js, server/sense.js, server/intents.js, server/triggers.js, shared/*, client/kernel/*, tools/*)*

---

## 1. Op/Patch Protocol

### Op shapes — every mutation is one of these

```jsonc
// Create entity (id optional — server assigns e1, e2… if omitted)
{"op": "spawn", "id": "my-box", "components": {"transform": {"position": [5,0,5]}, "mesh": {"parts": [{"shape": "box"}]}}}

// Replace entire component (value null = remove component)
{"op": "set", "id": "my-box", "component": "transform", "value": {"position": [8,0,5]}}

// Shallow-merge into a component (missing entity = auto-spawn with that component — "merge materializes")
{"op": "merge", "id": "world-state", "component": "state", "value": {"gate": "open"}}

// Delete entity
{"op": "despawn", "id": "my-box"}

// Transient message: never persisted in entities, only broadcast + journaled
{"op": "event", "name": "lightning", "data": {"intensity": 0.8}}

// Re-seed a scene (or world) from disk files; persist-tagged entities survive
{"op": "reset", "scene": "caves"}   // scene optional — omitted = world reset

// Press-E interaction from a presence
{"op": "use", "id": "lantern", "by": "player-c001"}

// Scene entry edit (bounds, load volumes, neighbors…) — merges into world.json
{"op": "scene", "name": "caves", "value": {"load": [{"center": [100,0], "radius": 50, "y": [-30,10]}]}}

// Material library entry edit
{"op": "material", "name": "obsidian", "value": {"color": "#333"}}
```

### The `dev` flag

Op batches over WS or HTTP carry an optional `dev: true`. When present, the server writes `spawn/set/despawn` ops through to the scene files on disk (the single source of truth). Gameplay traffic (presence moves, `use`, weather cycles) stays plain and never touches disk.

```
WS:  {"type": "ops", "ops": [...], "from": "c001", "dev": true}
HTTP: POST /op  {"ops": [...], "dev": true}
```

### WS lifecycle

1. Client connects → server sends `{"type": "snapshot", "time": <world clock>, "world": <world.json>, "game": <game.json|null>, "materials": {...}, "counter": <N>, "entities": {<id>: {<components>}}}`
2. Client sends `{"type": "hello", "presence": "player-c001"}`
3. Both sides send `{"type": "ops", "ops": [...], "from": "..."}` for mutations
4. Server broadcasts ops to all clients (including sender)
5. On disconnect: server despawns the presence entity, cleans up

### Op journal (`GET /events?since=<seq>&limit=<N>`)

```json
{
  "latest": 142,
  "events": [
    {"seq": 140, "t": 1718553600000, "from": "trigger:gate-1", "op": "event", "name": "gate-opened", "data": {"by": "player-c001"}},
    {"seq": 141, "t": 1718553600200, "from": "player-c001", "op": "merge", "id": "player-c001", "component": "transform", "value": {"position": [12.5, 1.8, 8.3]}}
  ]
}
```

Journal caps at 2000 entries. Events older than the cap are gone.

### The `use` op sequencing constraint

`use` expands against the world AS IT WAS BEFORE THE BATCH. Must be sent in its own request after ops that position the user — otherwise the range check reads stale data and silently rejects.

### $-token substitution in trigger/interact/level ops

```js
// shared/ops.js — substitute(structuredClone(op), {$id: "player-c001", $now: 87.3})
{"op": "merge", "id": "$id", "component": "light", "value": {"intensity": 30}}
// becomes:
{"op": "merge", "id": "player-c001", "component": "light", "value": {"intensity": 30}}
```

---

## 2. Schema Model

### Declaration (shared/schema.js)

One exported `SCHEMA` object. Each component key has:
- `doc`: what the component means
- `default`: (optional) the default when adding via inspector/add-component menu
- `fields`: map of LEAF field names to `{doc, range: [min, max], enum: [...]}`

```js
export const SCHEMA = {
  transform: {
    doc: 'where the entity sits in world space',
    default: { position: [0, 0, 0] },
    fields: {
      position: { doc: 'world [x, y, z] (meters)', range: [-400, 400] },
      rotation: { doc: 'euler radians [rx, ry, rz]', range: [-3.1416, 3.1416] },
      scale: { doc: 'uniform number or [x, y, z]', range: [0.05, 8] },
    },
  },
  mesh: {
    doc: 'visible body: one or more shape parts',
    default: { parts: [{ shape: 'box', size: [1, 1, 1], color: '#9aa0a6' }] },
    fields: {
      shape: { doc: 'primitive', enum: ['box', 'sphere', 'cylinder', 'cone', 'torus', 'octahedron', 'icosahedron', 'plane', 'tube'] },
      preset: { doc: 'shader instead of plain material', enum: ['glow', 'flame', 'water', 'hologram', 'beam', 'sky', 'overcast', 'clouds', 'abyss', 'stone'] },
      opacity: { doc: 'NOTE: < 0.15 is invisible in dark scenes', range: [0, 1] },
      // ... ~40 fields total
    },
  },
  // transform, ground, mesh, light, sound, sfx, behavior, terrain, collider,
  // water, trigger, interact, persist, spawn, scatter, particles, environment,
  // weather, scene, prefab, presence
};

// Fields the server simulates — dev write-back strips them so files stay authored:
export const RUNTIME_FIELDS = { weather: ['rain'] };
```

### Serving `/schema`

```js
// server/index.js
if (req.method === 'GET' && url.pathname === '/schema') {
  return json(res, SCHEMA);
}
```

Returns the raw `SCHEMA` object as JSON. No transformation.

### Consumption by Inspector

The client's `Panel` class reads `SCHEMA` to auto-generate:
- Doc lines as tooltips
- Dropdowns for `enum` fields
- Sliders for `range` fields
- The complete add-component menu (`componentDefaults()`)
- Color pickers for color fields

### Consumption by Agents

Agents `GET /schema` at startup to know the complete component vocabulary — field meanings, sane ranges, enums — without guessing. The schema is self-documenting.

---

## 3. Project Layout & Module Boundaries

```
GAIA-World-Engine/
├── server/           # Node server — canonical world store, WS+HTTP hub
│   ├── index.js      # Entry: HTTP routes, WS, op apply/broadcast/journal, scene I/O
│   ├── world.js      # World class: Map<id, components>, applyOp, save/load
│   ├── sense.js      # Sense class: look/map/describe/query/check
│   ├── intents.js    # Intents class: move_to/walk/face/grab/drop/say
│   └── triggers.js   # Triggers class: enter/exit volumes, use() expansion
│
├── shared/           # PURE FUNCTIONS — imported by both server and client
│   ├── schema.js     # SCHEMA object, componentDefaults, fieldInfo, RUNTIME_FIELDS
│   ├── ops.js        # substitute(), matchesWhen(), mergeIntoLibrary()
│   ├── scenes.js     # normalizeScenes(), sceneAt(), activeScenes(), inArea(), insideVolume()
│   ├── motion.js     # animatedPosition(), behaviorList(), hasMotion() — deterministic
│   ├── noise.js      # shared noise generator (same seed = same terrain everywhere)
│   ├── num.js        # r1(), r2() rounding helpers
│   └── terrainmap.js # routeHeight(), terrainEntries()
│
├── client/           # Vite-served browser code
│   ├── index.html    # Shell: canvas, overlay, menu, debug panel, viewbar
│   ├── main.js       # Bootstrap: connect WS → store.view → game loop
│   └── kernel/       # Framework-free modules — no React, no TS, plain JS
│       ├── world.js      # WorldStore: client-side mirror of server entities
│       ├── net.js        # WS connect: snapshot → ops stream, reconnect
│       ├── view.js       # View: reconcile store → three.js objects
│       ├── player.js     # First-person controller
│       ├── scenes.js     # Client-side scene streaming (setActiveScenes, hide/show)
│       ├── geometry.js   # Mesh builders with shared cache (recipe-keyed)
│       ├── terrain.js    # Procedural terrain meshes
│       ├── behaviors.js  # Per-frame behavior application (orbit/bob/path/pulse)
│       ├── effects.js    # Spawn/despawn tweens, bloom flashes
│       ├── interact.js   # E-prompt, use-range checks, client-side when gates
│       ├── editor.js     # Creator mode: select, gizmos, duplicate, delete
│       ├── history.js    # Per-client undo stack (inverse ops, sendDev)
│       ├── panel.js      # Auto-generated inspector from SCHEMA
│       ├── palette.js    # Prefab palette, ghost stamping
│       ├── outliner.js   # Entity list, scene groups, search
│       ├── gizmos.js     # X-ray overlays for invisible data
│       ├── audio.js      # Procedural synth + sample playback
│       ├── particles.js  # Instanced particle systems
│       ├── scatter.js    # Instanced object placement
│       ├── presets.js    # Shader preset materials
│       ├── environment.js# Fog, sky, exposure, bloom
│       ├── renderer.js   # three.js WebGPU setup
│       ├── shading.js    # Lit/unlit/wireframe draw modes
│       ├── viewfx.js     # Scene-view effect toggles
│       ├── dom.js        # DOM helpers
│       └── console.js    # Op stream log drawer
│
├── tools/            # CLI scripts — raw HTTP to the server
│   ├── patch.mjs     # spawn/set/merge/despawn/clear/reset/state/snapshot/prefab
│   ├── agent.mjs     # look/map/describe/query/check/events/move/walk/face/grab/drop/say/shot
│   ├── cdp.mjs       # Chrome DevTools Protocol automation (screenshot, eval)
│   └── profile-seam.mjs # CDP CPU profiling across scene transitions
│
├── world/            # The world AS DATA (separate repo for games)
│   ├── world.json    # SUPERSCENE: scene list, bounds, load volumes, voidY
│   ├── game.json     # (optional) Title screen + level select entries
│   ├── materials.json# (optional) Named material library
│   ├── scenes/       # One file per scene: pure entity docs, world-space
│   │   └── main.json
│   ├── prefabs/      # One file per prefab: reusable entity templates
│   │   └── torch.json
│   ├── assets/       # Static audio files served at /assets/
│   └── saves/        # Player save files (gitignored)
│       └── player_default_state.json
│
├── vite.config.js    # Vite root=client, injects __GAIA_PORT__
└── package.json      # three, ws, three-bvh-csg; dev: vite, concurrently
```

### Import rules

- `shared/` is pure JS with NO imports from `server/` or `client/` — zero dependencies beyond each other
- Server imports from `shared/` via relative paths: `'../shared/schema.js'`
- Client imports from `shared/` via relative paths: `'../../shared/scenes.js'`
- Client and server NEVER import each other
- `tools/` scripts speak HTTP/WS to the running server — no direct imports of server modules

---

## 4. Dev/Run Setup

### npm scripts

```json
{
  "scripts": {
    "dev": "concurrently -k \"node server/index.js\" \"vite\"",
    "server": "node server/index.js",
    "client": "vite"
  }
}
```

`npm run dev` starts both: the world server (Node, WS+HTTP) and Vite dev server (HMR for client code). `concurrently -k` kills both on Ctrl-C.

### Port model

```
GAIA_PORT        → world server port (default 8420)
GAIA_CLIENT_PORT → Vite dev server port (default 5173)
GAIA_WORLD       → path to world directory (default: engine's own world/)
GAIA_SAVE        → save slot name (default: "default")
```

`vite.config.js` injects `__GAIA_PORT__` into the client bundle:
```js
define: { __GAIA_PORT__: JSON.stringify(process.env.GAIA_PORT ?? '8420') }
```

Client connects WS to `ws://${location.hostname}:${__GAIA_PORT__}`.

Two games side-by-side: `GAIA_PORT=8421 GAIA_CLIENT_PORT=5174 npm run dev`.

### Dependencies

| Package | Role |
|---------|------|
| three ^0.180 | 3D rendering (WebGPU) |
| ws ^8.18 | WebSocket server |
| three-bvh-csg | CSG boolean ops for cave carving |
| vite ^6.1 | Dev server + HMR |
| concurrently ^9.1 | Run server+vite together |

---

## 5. State & Persistence

### Architecture: scenes are source of truth

```
world/scenes/<name>.json  ← THE authoritative world state (committed)
world/world.json          ← superscene: which scenes exist, how they compose
world/saves/player_<GAIA_SAVE>_state.json ← player layer ONLY (gitignored)
```

**Everything the developer edits writes back into scene files.** The editor, gizmos, inspector panel, palette stamps, undo/redo, debug-menu save — all send `dev: true` ops, and the server debounces (400ms per scene) writes to the matching `world/scenes/<name>.json`.

### Scene file shape (world/scenes/main.json)

```json
{
  "terra": {
    "terrain": { "seed": 11, "size": 420, "segments": 180, "amplitude": 7, "frequency": 0.013, "color": "#41682f" }
  },
  "crystal": {
    "transform": { "position": [0.62, 1.64, 1.57] },
    "ground": { "offset": 0 },
    "mesh": { "parts": [{ "shape": "octahedron", "radius": 1.4, "color": "#aef4ff", "emissive": "#7df9ff", "emissiveIntensity": 2.2 }] },
    "light": { "type": "point", "color": "#7df9ff", "intensity": 60, "distance": 60 }
  }
}
```

Key rules:
- Pure flat `{id: {components}}` — no nesting, no metadata
- All positions world-space
- `scene` component is NEVER stored — stamped at runtime by server
- `RUNTIME_FIELDS` are stripped on write-back (so sim values never overwrite authored)

### Prefab instances (deltas only)

```json
{
  "torch-1": {
    "prefab": "torch",
    "transform": { "position": [12, 1.5, 8] }
  }
}
```

The scene file stores only the `prefab` key + fields that differ from the prefab. On write-back, `sceneDoc()` diffs against the prefab — a moved torch stays three lines. Expanded entities get a `prefab: {name}` component at runtime so the link survives edits.

### World.json superscene

```json
{
  "voidY": -120,
  "scenes": {
    "crater": {
      "bounds": { "center": [0, 0], "radius": 120 },
      "neighbors": ["tunnels", "bridge"],
      "voidY": -200
    },
    "tunnels": {
      "bounds": { "center": [140, 0], "radius": 80 },
      "neighbors": ["crater"],
      "load": [{ "center": [60, 0], "radius": 40 }]
    },
    "ocean": {
      "always": true,
      "load": [{ "center": [0, -250], "radius": 80, "y": [-50, 50] }]
    }
  }
}
```

- `always: true` = backdrop scenery always loaded (never "current")
- `load: [...]` = explicit trigger volumes; scene streams only when observer stands inside
- No `load` = streams via neighbor rule (implicit from `current`)
- No `bounds` = can never be "current" (backdrop only)
- No `world.json` at all = one implicit scene `main`, always loaded

### Player save file (world/saves/player_default_state.json)

```json
{
  "counter": 47,
  "entities": {
    "player-c001": {
      "presence": { "kind": "player", "yaw": 1.2 },
      "transform": { "position": [12.5, 1.8, 8.3] },
      "light": { "type": "point", "intensity": 30, "distance": 20 }
    },
    "world-state": {
      "state": { "gate": "open", "bridge-raised": true }
    }
  }
}
```

- Contains ONLY the player layer: presences, `persist`-tagged entities, entities with no scene stamp
- Zoned scene entities NEVER enter the save
- On boot: scenes seed first, then save overlays on top (scene always wins)

### `persist` component

```json
{"op": "merge", "id": "quest-npc", "component": "persist", "value": {}}
```

Entities with `persist` survive `reset`. Their current truth is kept while the rest of the scene re-seeds from disk. The Braid rule as a primitive.

### `reset` semantics

```jsonc
{"op": "reset"}              // re-seed every scene
{"op": "reset", "scene": "caves"}  // re-seed one scene
```

What it does:
1. Re-reads `world/world.json` from disk (picks up external edits)
2. Re-reads `world/scenes/<name>.json` from disk
3. Broadcasts `reset` event
4. Despawns all non-persist, non-presence entities of the scene(s)
5. Re-spawns everything from the scene file(s)
6. Drops any pending write-back timers (disk is newer)

---

## 6. Reconciler Pattern

### Store mirror (client/kernel/world.js)

```js
// Client-side mirror — never the authority, only changes via server ops/snapshot
class WorldStore {
  entities = new Map();        // id → {components}
  listeners = new Set();       // onChange callbacks

  applySnapshot(entities) { ... }  // full replace → emit 'snapshot'
  applyOps(ops) { ... }            // incremental (spawn/set/despawn/clear) → emit per-op
  onChange(fn) { ... }             // subscribe, returns unsubscribe
}
```

`applyOps` dispatches granular events: `{kind: 'spawn', id}`, `{kind: 'set', id, component}`, `{kind: 'despawn', id}`, `{kind: 'snapshot'}`.

### View -> Document reconcile (client/kernel/view.js)

```
store.onChange(event) → view.handle(event)
  ├── 'snapshot' → rebuildAll()   // tear down all groups, rebuild from store
  ├── 'spawn'    → buildAnimated(id)  // new group + wisp-in tween
  ├── 'despawn'  → removeAnimated(id) // scale-out tween → remove group
  └── 'set'      → applyComponent(id, component)  // patch ONE subtree of the group
```

`applyComponent` is a switch on component name: `transform`→`group.position/rotation/scale`, `mesh`→rebuild mesh children, `light`→pool assignment, `sound`→audio attach, `environment`→mood update.

### The key pattern

1. **One-directional data flow**: server → WS snapshot/ops → store.applyOps → view.handle
2. **Granular reconciliation**: a `set` on `transform` calls `applyTransform(id)` — no full rebuild, just `group.position.set()`
3. **No diffing**: the server tells the client exactly what changed; the client applies surgically
4. **Events, not polling**: `store.onChange` is the single entry point; everything downstream subscribes

### Scene streaming in the view

```
scenes.setActiveScenes(set)
  ├── entities in set, no group → queueBuild(id)     // time-sliced build (~3ms/frame, 6 parts/frame)
  ├── entities in set, hidden group → showQueue       // visibility flip (meshes+shaders still resident)
  └── entities not in set → hideQueue                 // group.visible=false, release sound+light slot
```

The world builds ONCE at load (all scenes, unculled, 3 warm frames behind the overlay). After that, streaming is pure `group.visible` toggles — no geometry is built, compiled, or torn down mid-play.

---

## 7. AI/Agent Integration

### Sense API (HTTP GETs)

| Endpoint | Query params | Returns |
|----------|-------------|---------|
| `GET /sense/look` | `x,y,z,yaw,fov,range,as` | Text: pose header, ranked visible entities (top 12 by salience), hearing list |
| `GET /sense/map` | `x,z,radius,cells` | ASCII heightmap with entity markers, legend |
| `GET /sense/describe` | `id` | One-line text summary: shapes, color, light, sound, behaviors |
| `GET /sense/query` | `nearX,nearZ,radius,has,name` | JSON array: `[{id, position, distance, components}]` |
| `GET /sense/check` | — | Text: floating/buried entities, overlaps, unlit lights, unwalkable terrain % |

**Look frame example:**

```
pose (12.5, 3.0, 8.3) facing N · ground 1.8m, slope flat · 47 entities in world
ahead 5.2m: crystal — octahedron+cylinder #aef4ff, glowing · sheds #7df9ff light · orbit
left 42° 12.8m: oak — box+cone #3c5a40 · terrain seed 11 · scatter of ~80 across 40m
right 18° 3.1m: campfire — box+sphere+cone · sheds #ffaa00 light · flicker+spin
hearing: campfire (humming at 220Hz, 3.1m ahead) · wind-chime (chiming every 2.5s, 15.4m left 120°)
```

Salience formula: `(max_mesh_size * bonuses) / max(1, distance)` — bonuses: +0.8 light, +0.5 sound, +0.5 behavior, +0.6 emissive, +1 presence.

### Act API (POST /act)

```jsonc
POST /act  {"intent": "move_to", "x": 12, "z": 8, "speed": 4, "as": "agent-claude"}
// Response: {"ok": true, "result": {"status": "arrived", "position": [12.0, 1.8, 8.0]}, "frame": "<look text>"}
```

Intents: `move_to` (blocking until arrival/timeout/superseded), `walk` (direction * seconds), `face` (id or yaw), `grab` (id, within 4m), `drop`, `say` (text).

Avatar is auto-spawned on first use (`intents.ensureAvatar`) — a glowing sphere with bob behavior and a carried light. Movement is terrain-following at finite speed, streamed as ops every 100ms tick so every client watches the avatar travel.

### `check` (semantic lint)

What it inspects:
- **Floating entities**: mesh y − ground > 4m (unless orbiting)
- **Buried entities**: mesh y < ground − 0.5m
- **Overlapping entities**: bounding spheres intersecting (skips mega-structures >40m radius)
- **Unlit lights**: a light's reach covers zero meshes
- **Steep terrain**: >25% of terrain samples within 100m have slope > 0.9

### Agent CLI (`tools/agent.mjs`)

```bash
node tools/agent.mjs look                           # look from default agent pose
node tools/agent.mjs look x=10 y=5 z=0 yaw=1.5     # look from arbitrary pose
node tools/agent.mjs map 0 0 30                     # ASCII map 30m radius
node tools/agent.mjs describe crystal               # one-line summary
node tools/agent.mjs query --has light --radius 50  # find all lights
node tools/agent.mjs check                          # lint world
node tools/agent.mjs events 140                     # tail journal from seq 140
node tools/agent.mjs move 12 8                      # travel to (12,8), print look on arrival
node tools/agent.mjs walk 1 0 3                     # walk forward 3 seconds
node tools/agent.mjs face crystal                   # turn to face entity
node tools/agent.mjs grab firefly-1 | drop          # grab then drop
node tools/agent.mjs say "hello"                    # emit say event
```

---

## 8. Coding Conventions

### Philosophy

1. **The world is data.** Every entity is a document of components. Code lives in the kernel (small, stable) or in content (hot-swappable).
2. **Everything is a client.** Player, editor UI, AI — all send the same patch ops to the same world server. No privileged editor.
3. **No rebuilds, ever.** A change is a patch; a patch applies in milliseconds while you walk around.
4. **Agents sense without eyes.** Perception is queries, text frames, and event streams.

### Style

- **Plain JS `.js`/`.mjs`, no React, no TypeScript, no JSX** — the engine runs in the browser as-is, no transpilation needed
- **`shared/` is pure functions** — no side effects, no imports from client or server
- **Modules export classes (server) or plain functions (shared)** — one concern per file
- **No build step for server or shared** — Vite only bundles the client
- **Framework-free DOM** — `document.createElement`, `.addEventListener`, manual state updates
- **Data over code**: shader presets, component schemas, prefabs, materials — all JSON on disk, editable live

### Module patterns

- **Server**: ES modules, `import`/`export` with `.js` extensions (Node ESM)
- **Client**: ES modules, Vite resolves imports
- **Shared**: ES modules, imported by both sides via relative paths
- **Tools**: `.mjs` scripts with `#!/usr/bin/env node`, `import { } from '../shared/...'`

### Agent workflow conventions (from AGENTS.md)

- Verify visual changes with screenshots (`tools/agent.mjs shot`), not sense data
- Open work browser tabs with `&mute=1` — verification must not make noise
- Use `open -n -g -j -a "Brave Browser"` — hidden, backgrounded, with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`
- Never use `--headless` (hangs on WebGPU init)
- Always check rAF firing after launch: `eval 'window.__t=0; requestAnimationFrame(()=>__t=1)'`
- Tab discipline: target one session with `?from=<presence-id>` on `/screenshot`; every tab is a full player session

### Key conventions discovered from code

- **Components have no UI remove button** — click section head, ⌘⌫ removes it (op: set with null value)
- **`merge` materializes missing entities** — first write spawns the entity
- **Scene files are world-space** — no local coordinate systems, no origin transforms
- **`scene` stamp is runtime-only** — never stored in scene files, derived from position
- **Write-back diffs prefab instances** — only changed fields land in the scene file
- **`persist` + `presence` + unzoned = player layer** — `playerLayer()` predicate for save filter
- **`reset` re-reads disk first** — pending write-back timers must be dropped (disk is newer)
- **`use` ops expand server-side** — the interact component decides what happens
- **Trigger volumes evaluated on server** — enter/exit edges, when gates, cooldown, $now/$id substitution
- **Debug panel knobs drive with arrow keys** — ↑/↓ select, ←/→ nudge, Enter follow, Esc back
- **`r1()` / `r2()` from shared/num.js** for number rounding (1 or 2 decimal places) — used everywhere for stable floating-point across client/server

### Naming

- `id` always means entity id (string)
- `components` / `comps` always means the full document `{transform: {...}, mesh: {...}, ...}`
- `component` always means a single component name (string, e.g. `"transform"`)
- `value` always means the component's value (object or null)
- `op` always means one of the 7 op shapes
- `ops` always means an array of ops
- `scene` the concept (a named region with a file), never "zone" since M20 rename

---

## Summary of Design Decisions Most Worth Adopting

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Ops as the only mutation primitive** (spawn/set/merge/despawn/event/reset/use) | Single surface for every client type; undo is inverse ops; journal is just ops + seq + timestamp |
| 2 | **Component document model**: entity = `{id: {compA: {...}, compB: {...}}}` | Flat, merge-friendly, no inheritance trees, `merge` materializes on first write |
| 3 | **Schema as data** (shared/schema.js) → `/schema` endpoint → auto-generated inspector | One source of truth for docs, ranges, enums; agents + UI + server all read the same object |
| 4 | **`shared/` as pure functions, no dependencies** | Both client and server import the same modules; op semantics, motion math, scene composition never drift |
| 5 | **Scene files as single source of truth** + `dev` flag on ops for write-back | Editor edits = world files change; no separate "build" step; disk always reflects the live world |
| 6 | **Superscene (world.json) separates composition from content** | Scene files are pure entities; world.json owns which scenes exist, how they stream — composition changes are tiny, content files are stable |
| 7 | **Store mirror + granular reconcile** (no diffing) | Server sends `{op:'set', id:'x', component:'transform', value:{position:[...]}}` → client calls `view.applyTransform('x')` — surgical, zero-diff |
| 8 | **Op journal as the world's nervous system** | Every mutation gets a seq number; agents/triggers/UI tail `/events?since=` — the same stream for every consumer |
| 9 | **$-token substitution in trigger/interact/level ops** | `$id` = who entered/used, `$now` = world time — authored ops are templates, server expands them |
| 10 | **World clock as a shared value** | Server sends `time` in WS snapshot; client computes offset; `clock.now()` returns the same time everywhere — motion math is deterministic |
| 11 | **Scene streaming = visibility toggle** (Dark Souls model) | World builds ONCE at load (all scenes, 3 warm frames); after that, streaming is `group.visible` toggles — no geometry built/compiled/torn down mid-play |
| 12 | **Player layer via `saveFilter` predicate** | `persist` + `presence` + unzoned = what goes into the save file; scenes always win on boot |
