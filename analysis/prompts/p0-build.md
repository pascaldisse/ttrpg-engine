# Build task: P0 — the engine spine (no LLM)

Your working dir is `/Users/pascaldisse/projects/ttrpg` (this IS the repo). Build **Phase 0** of an AI-TTRPG engine.

## READ FIRST (in the repo)
- `PROTOTYPE-SPEC.md` — the full architecture & decisions (authoritative).
- `analysis/gaia-design-extraction.md` — the GAIA engine conventions we are faithfully mirroring (op shapes, schema
  model, reconciler pattern, journal, persistence). Follow these conventions closely.

## Philosophy (non-negotiable)
- **Plain JS only** (`.js`/`.mjs`). **No React, no TypeScript, no JSX, no build for server/shared.** Vite serves the
  client. Node ESM (`"type":"module"`).
- **Small, stable kernel; everything domain-specific is replaceable content/plugins.** This engine's whole value is
  being easy to modify and extend by a community. Build the **extension seams** now, fill them with a *minimal*
  default. Comment the seams clearly.
- **Ops are the only mutation primitive.** `shared/` is pure (no imports from server/client). Server-authoritative;
  the client is a thin reconciler (no diffing — apply exactly what the server says changed).
- Do **NOT** modify or delete existing files: `ai_ttrpg_engine_concept.md`, `PROTOTYPE-SPEC.md`,
  `INSTANTALE-INSPIRATION-REPORT.md`, anything in `analysis/`. Only ADD the engine files below.

## Scope of P0 (and NOTHING more)
The GAIA spine end-to-end, with **no LLM**: WS+HTTP server owning a session store, the op apply/broadcast/journal
loop, snapshot on connect, a framework-free reconciler client that renders entities + a narration log + an action
input, `tools/patch.mjs` to mutate state from the CLI, and a tiny sample campaign as data. An `action` op from the
client is, in P0, echoed by the server as a placeholder `event:narration` ("(P0 stub) You: …") so the full
action→op→broadcast→render path is provably working — this echo is explicitly a stub the P1 turn engine replaces.

## Files to create

### Root
- `package.json` — `"type":"module"`; scripts: `"dev":"concurrently -k \"node server/index.js\" \"vite\""`,
  `"server":"node server/index.js"`, `"client":"vite"`. deps: `ws`, `vite`, `concurrently`, `zod`.
- `vite.config.js` — `root: 'client'`, `define: { __TTRPG_PORT__: JSON.stringify(process.env.TTRPG_PORT ?? '8420') }`,
  `server: { port: Number(process.env.TTRPG_CLIENT_PORT ?? 5173) }`.
- `.gitignore` — `node_modules/`, `world/saves/`, `*.log`.
- `README.md` — short: what it is, `npm install && npm run dev`, the env vars (`TTRPG_WORLD/TTRPG_PORT/
  TTRPG_CLIENT_PORT/TTRPG_SAVE`), and a **"How to extend"** section (how to add a component to the schema, add an op
  handler, and add a campaign/ruleset directory). Keep it tight.

### shared/ (pure, importable by both server and client via relative paths)
- `schema.js` — export a declarative `SCHEMA` object. Each component: `{ doc, default?, fields: { <leaf>: { doc,
  range?:[min,max], enum?:[...] } } }`. Base components (minimal but representative): `identity` (name, kind,
  description), `place` (locationId / connections[]), `stats` (hp, maxHp — note ruleset will extend), `inventory`
  (items[]), `persona` (personality, backstory), `relationships` (map), `quest` (phase, steps, currentStep), `status`
  (alive, conditions[]), `flags` (open object), `art` (prompt, image), `lifelog` (summary), `persist` (no fields),
  `presence` (seat, who, mode). Export helpers: `componentDefaults(name)`, `fieldInfo(component, field)`, and
  **`registerComponents(extra)`** that deep-merges additional component defs into `SCHEMA` (the ruleset/system
  extension seam — comment it). Also export **`opSchemas`/`validateOpBatch`** OR a `buildZod()` helper that derives
  a Zod validator for an op batch from this declarative schema (declarative SCHEMA stays the source of truth; Zod is
  derived). Keep the validator lenient on unknown components (warn, don't crash) so the engine is forgiving/extensible.
- `ops.js` — the op vocabulary + `applyOp(entities /* Map */, op)` implementing `spawn` (assign id if missing via a
  passed-in counter or return needed id to caller), `set` (replace component; null removes), `merge` (shallow-merge;
  materialize entity if missing), `despawn`. `event`/`action`/`roll` do not mutate entities (return a flag so the
  server knows to broadcast+journal only). `reset` is handled server-side (file I/O). Include `substitute(op, vars)`
  for `$id`/`$now`. Use a small **handler registry** (`{ spawn, set, merge, despawn }`) so new op kinds are easy to
  add — comment this as an extension seam. Validate ops via the schema helpers; reject invalid, never throw on the
  hot path (return `{ok:false, error}`).
- `num.js` — `r1`, `r2` rounding helpers.

### server/ (Node ESM)
- `session.js` — `class Session`: `entities` (Map id→components), `counter`, `journal` (array, cap 2000),
  `listeners` (Set). Methods: `applyOps(ops, from)` → for each op: validate → `applyOp` → mark canon vs ephemeral →
  push to journal (`{seq, t, from, ...op}`) → notify listeners; `snapshot()` → `{type:'snapshot', time, counter,
  entities:{...}, world, ruleset}`; `eventsSince(seq, limit)`; `seedFromWorld(dir)` (load `campaign.json` +
  `scenes/*.json` into entities); `reset(scene?)` (re-read files, despawn non-persist/non-presence, re-seed);
  `save()`/`load()` (canon overlay → `world/saves/session_<TTRPG_SAVE>.json`, debounced). `t`/`time`: pass a clock
  value in (no `Date.now()` in shared; server may use it). Keep ids stable.
- `index.js` — entry. Create `http` server + `ws` `WebSocketServer`. Load `TTRPG_WORLD` (default `./world`) →
  `session.seedFromWorld` → `session.load()` overlay. HTTP routes: `GET /schema` (SCHEMA json), `GET /events?since=&limit=`
  (journal), `POST /op` (`{ops, from?}` → applyOps → 200 `{ok, applied}`), `GET /health`. WS: on connect → send
  `snapshot`; on `{type:'hello', presence}` → register; on `{type:'ops', ops, from}` → `session.applyOps` (the
  listener broadcasts resulting ops to ALL sockets); on close → despawn that presence. When an `action` op is
  applied, the server emits a placeholder `{op:'event', name:'narration', data:{text:'(P0 stub) You: '+text,
  by:'engine'}}` (clearly marked stub for P1). Listen on `TTRPG_PORT` (default 8420). CORS-allow localhost for the
  tools.

### client/ (plain JS, Vite-served; no framework)
- `index.html` — shell with: a scene image area (placeholder box), a **narration log** (scrolling), an **entity/
  inspector** panel (lists entities, click to see components), and an **action input bar** (text + send). Include
  Tailwind Play CDN (`<script src="https://cdn.tailwindcss.com"></script>`) for styling — dark, moody palette is
  fine. Keep markup minimal and labelled with ids/classes the kernel hooks.
- `main.js` — bootstrap: create store, connect net, wire view to store, wire the action input to send
  `{op:'action', text, by:<presence>, mode:'narration'}` ops.
- `kernel/store.js` — `class SessionStore`: `entities` Map, `applySnapshot(entities)` (full replace → emit
  `{kind:'snapshot'}`), `applyOps(ops)` (granular: spawn/set/merge/despawn → emit per-op `{kind, id, component}`;
  `event` → emit `{kind:'event', name, data}`), `onChange(fn)` → unsubscribe.
- `kernel/net.js` — connect WS to `ws://${location.hostname}:${__TTRPG_PORT__}`; send `hello`; route `snapshot`/`ops`
  messages into the store; expose `sendOps(ops)`; auto-reconnect with backoff.
- `kernel/view.js` — subscribe to store; reconcile to DOM granularly (no full rebuild except on snapshot): render
  the entity list/inspector from `identity`/`status`/etc., and **append narration** on `event:narration`. Switch on
  component name for entity rendering (extension-friendly).
- `kernel/dom.js` — tiny helpers (`el(tag, props, children)`, `clear(node)`).

### tools/
- `patch.mjs` — `#!/usr/bin/env node`. CLI POSTing to `http://localhost:${TTRPG_PORT||8420}/op`:
  `spawn '<json-components>' [id]`, `set <id> <component> '<json>'`, `merge <id> <component> '<json>'`,
  `despawn <id>`, `reset [scene]`, plus `snapshot` (GET) and `events [since]` (GET /events). Print the server reply.

### world/ (sample campaign AS DATA)
- `campaign.json` — superscene: `{ "start": {"scene":"tavern"}, "scenes": {"tavern": {"name":"The Salt & Sextant"}} }`
  (keep simple; this is the composition layer).
- `scenes/tavern.json` — flat `{id:{components}}`: a `location` entity (identity kind:"location" + place with a
  couple connections), one `npc` (identity + persona + status alive:true), one `item`. World-space, no nesting.
- `ruleset/README.md` — one paragraph: this is the rules-as-data extension seam; a ruleset may ship a `schema.js`
  that calls `registerComponents(...)` and a `system.md` (cached prefix / system prompt). (No actual ruleset in P0.)
- `saves/.gitkeep`

## Acceptance criteria (verify before returning)
1. `npm install` succeeds; `npm run dev` starts the Node server (8420) and Vite (5173) with no errors.
2. Opening the Vite URL connects over WS and shows the seeded tavern entities + an empty narration log + an action bar.
3. `node tools/patch.mjs spawn '{"identity":{"name":"Goblin","kind":"npc"},"status":{"alive":true}}' goblin-1`
   makes the goblin appear in the browser **live** (broadcast→reconcile), and `node tools/patch.mjs set goblin-1
   status '{"alive":false}'` updates it live.
4. `curl localhost:8420/schema` returns the SCHEMA JSON; `curl 'localhost:8420/events?since=0'` returns the journal.
5. Typing in the client action bar and sending shows the `(P0 stub) You: …` narration line (proving the
   action→op→broadcast→render path), and the action + echo appear in `/events`.
6. Restarting the server preserves canon spawned via patch (saved to `world/saves/`), while the `action` echoes
   (ephemeral) are not persisted.

Run the dev server, exercise criteria 1–6 (use curl + the patch tool; for the browser path, at minimum confirm the
WS snapshot + broadcast wiring is correct in code and that the HTTP/op flow works end-to-end via curl). Fix anything
that fails. Keep the code small, well-commented at the extension seams, and faithful to the GAIA conventions.

## Return
A compact report: the file tree you created, how you verified each acceptance criterion (with the actual command
output you saw), and any deviations from this brief + why. Do NOT paste full file contents.
