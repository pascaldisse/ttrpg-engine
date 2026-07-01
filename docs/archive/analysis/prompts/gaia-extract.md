Your working dir is `~/projects/GAIA-World-Engine`. It is an AI-native 3D world engine (plain JS `.js`/`.mjs`,
no React/TS/JSX, three.js + Node server + Vite client). We are building a separate project — a 2D/text AI-TTRPG
engine — and want to **faithfully adopt GAIA's architecture and conventions** where they fit. Your job: extract
GAIA's concrete DESIGN DECISIONS, CONVENTIONS, and DATA/PROTOCOL SHAPES so we can mirror them.

Read efficiently (summarize concretely; do NOT paste whole large files — pull short representative snippets only):
- `package.json` (deps + scripts), `vite.config.js`, `AGENTS.md`, `plan.md` (skim milestones only).
- `server/` — entry point, the op/patch hub (ws + http `/op`), the op journal (`/events?since=`), the sense API
  (`/sense/...`, `/act`), how an incoming op is validated → applied to the store → broadcast → journaled, and
  how scene files are read/written-back.
- `shared/` — especially `schema.js` (how the component vocabulary is declared: fields, docs, ranges, enums; how
  it's served at `/schema`), op semantics, and the list of pure functions that live here.
- `client/kernel/` — the reconciler: how it mirrors the server store, turns documents into view objects, and
  applies ops as they arrive; how it handles the WS snapshot + op stream. (We don't care about three.js rendering
  specifics — we care about the store-mirror + reconcile PATTERN, since ours renders text/2D.)
- `tools/patch.mjs` and `tools/agent.mjs` — the CLI patterns for sending raw ops and for sense+act.

Deliver a spec we can adapt, organized as:
1. **Op/patch protocol** — exact message shapes for each op (`spawn/set/merge/despawn/event/reset/use/scene/material`),
   the ws snapshot→ops flow, and the journal/events API shape. Short real examples.
2. **Schema model** — how `shared/schema.js` declares components/fields/ranges/enums/docs; how `/schema` serves it;
   how the inspector/UI consumes it to auto-generate controls.
3. **Project layout & module boundaries** — what lives in `server/ shared/ client/ tools/ world/` and the import rules
   between them (e.g. is `shared/` pure + imported by both sides?).
4. **Dev/run setup** — npm scripts, how Vite + the Node server run together, ports, and the `GAIA_WORLD/GAIA_PORT/
   GAIA_CLIENT_PORT/GAIA_SAVE` env model for loading a world as a directory.
5. **State & persistence** — scene files as source of truth + write-back, `world.json` superscene, the player-save
   overlay, the `persist` component, and `reset` semantics. The exact on-disk JSON shapes (short examples).
6. **Reconciler pattern** — concise description of the store-mirror + document→view reconcile loop, framework-free.
7. **AI/agent integration** — the sense API shapes (`look/map/describe/query/check`) and act/intent model; how the
   text senses are generated from the canonical store; what `check` (semantic lint) actually inspects.
8. **Coding conventions** — anything from `AGENTS.md` about style, naming, module patterns, the "no build / no
   rebuilds" philosophy, and how AI agents are expected to work in the repo.

Write the full extraction to `/Users/pascaldisse/projects/ttrpg/analysis/gaia-design-extraction.md`. Return only a
compact 8–12 bullet summary of the load-bearing design decisions.
