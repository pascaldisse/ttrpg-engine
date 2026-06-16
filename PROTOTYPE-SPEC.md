# AI-TTRPG Engine — Tech Overview & Prototype Spec

*Architecture faithfully adopted from GAIA World Engine (Fable), adapted from 3D world → 2D/text tabletop RPG,
plus the parts only our project needs: a turn loop, dice adjudication, rules-as-data, and the curation memory layer.*

Status: **proposal for sign-off — no code yet.** Grounded in `analysis/gaia-design-extraction.md`,
`INSTANTALE-INSPIRATION-REPORT.md`, and `ai_ttrpg_engine_concept.md`.

---

## 1. Guiding principles

Copied from GAIA verbatim (these are load-bearing):
1. **The world is data.** Every entity is a document of components. Code lives in a small, stable kernel;
   everything authored (worlds, rulesets, NPCs, art direction) is hot-swappable content.
2. **Everything is a client.** Players, the DM seat, CLI tools, and the AI-DM all speak the **same op protocol**
   to the same session server. No privileged editor, no special AI side-channel.
3. **No rebuilds, ever.** A change is an **op**; it applies in milliseconds and broadcasts to every client.
4. **The DM senses without eyes.** The AI-DM perceives through **text** queries + event streams over the
   canonical store — never by re-reading raw transcript.

Our additions (the moat GAIA has no reason to have):
5. **A turn loop** — player action → LLM narration + adjudicated state ops. GAIA is continuous/real-time; we
   are turn-based, but a turn is just "a client emits an `action`, the AI-DM client emits ops in response."
6. **Dice & rules are deterministic.** The engine rolls; the LLM narrates the result. Never the reverse.
7. **Rules-as-data.** A ruleset is a loadable bundle that *extends the schema* and the cached prompt prefix.

---

## 2. Stack (mirror GAIA exactly)

| Concern | Choice | Same as GAIA? |
|---|---|---|
| Language | **Plain JS** (`.js`/`.mjs`) — no React, no TypeScript, no JSX | ✅ identical |
| Client | **Vite** serving plain JS + a **framework-free reconciler** | ✅ identical |
| Server | **Node ESM**, `ws` for WebSocket + HTTP | ✅ identical |
| `shared/` | **pure functions**, imported by both sides via relative paths | ✅ identical |
| Run | `concurrently -k "node server/index.js" "vite"` | ✅ identical |
| Runtime types | **Zod** for validating LLM op-batches/output (our addition — GAIA trusts its ops; we don't trust an LLM) | ➕ added |
| LLM | `openai` SDK → DeepSeek base URL, behind an `LlmClient` interface | ➕ added |
| Image | cloud API behind an `ImageClient` interface (later phase) | ➕ added |
| Persistence | JSON files (GAIA's scene-file model) → session save overlay | ✅ identical model |

Deps stay tiny: `ws`, `vite`, `concurrently`, `zod`, `openai` (+ `sharp` later for image post-processing).
No bundler config beyond GAIA's thin `vite.config.js`; no transpile for server/shared.

---

## 3. Project layout (GAIA's, retitled for our domain)

```
ttrpg-engine/
├── server/                 Node ESM — canonical session store, WS+HTTP hub
│   ├── index.js            entry: HTTP routes, WS, op apply/broadcast/journal, save I/O
│   ├── session.js          Session class: Map<id, components>, applyOp, save/load   (≈ GAIA world.js)
│   ├── turn.js             TURN ENGINE: action → context → LLM → parse → op batch   (our addition)
│   ├── sense.js            look / describe / query / recall / check                 (≈ GAIA sense.js)
│   ├── dice.js             deterministic resolver: rolls, checks vs DC              (our addition)
│   ├── llm.js              LlmClient adapter (DeepSeek default, swappable)          (our addition)
│   └── image.js            ImageClient adapter (later phase)                        (our addition)
│
├── shared/                 PURE functions — imported by both server and client
│   ├── schema.js           SCHEMA object (+ ruleset-contributed components), defaults, field docs/ranges/enums
│   ├── ops.js              applyOp(), substitute($id/$now), op validators
│   ├── context.js          buildContext(session) → messages  (stable cached prefix + look frame + window)
│   ├── parse.js            parseModelOutput(raw) → {narration, ops, rolls}  (lenient → Zod-validated)
│   ├── summary.js          living-summary compaction (rolling window → state summary)
│   └── num.js              rounding helpers (stable floats across client/server)
│
├── client/                 Vite-served browser code — plain JS, no framework
│   ├── index.html          shell: scene image, narration log, action bar, DM panel
│   ├── main.js             bootstrap: connect WS → store → view
│   └── kernel/
│       ├── store.js        SessionStore: client mirror of server entities (applySnapshot/applyOps/onChange)
│       ├── net.js          WS: snapshot → ops stream, reconnect
│       ├── view.js         reconcile store → DOM (switch on component/event)
│       ├── inspector.js    schema-driven panel (auto-generated from /schema)   (≈ GAIA panel.js)
│       ├── seat.js         DM-seat controls: override, mood knob, canon-confirm
│       ├── audio.js        Web Audio mood music + crossfade
│       └── dom.js          DOM helpers
│
├── tools/                  CLI — raw HTTP/WS to the running server
│   ├── patch.mjs           spawn/set/merge/despawn/reset — author/debug state    (≈ GAIA patch.mjs)
│   └── dm.mjs              look/describe/query/recall/check + drive a turn       (≈ GAIA agent.mjs)
│
├── world/                  A CAMPAIGN AS DATA (a directory, not a fork — like GAIA_WORLD)
│   ├── campaign.json       superscene: acts/scenes, starting state, defaults     (≈ GAIA world.json)
│   ├── ruleset/            rules-as-data: schema extension + system prompt + cached prefix material
│   ├── scenes/             one file per scene: pure entity docs (locations, NPCs, items)
│   ├── art/                style-direction string + cached generated images
│   ├── audio/              curated mood tracks
│   └── saves/              session save = the LIVING CANON overlay (gitignored)   (≈ GAIA saves/)
│
├── vite.config.js          root=client, injects __TTRPG_PORT__
└── package.json            ws, vite, concurrently, zod, openai
```

Env model (GAIA's, renamed): `TTRPG_WORLD` (campaign dir), `TTRPG_PORT` (server, default 8420),
`TTRPG_CLIENT_PORT` (vite), `TTRPG_SAVE` (save slot). Two tables side-by-side = different ports.

`shared/` imports nothing from `server/` or `client/`; client and server never import each other; `tools/` speak
HTTP/WS only. (GAIA's import rules, unchanged.)

---

## 4. The op protocol (GAIA's ops, plus two)

Every mutation is one op. GAIA's set, kept as-is:

```jsonc
{"op":"spawn",   "id":"npc-varda", "components":{ "identity":{...}, "stats":{...} }}   // id optional → server assigns
{"op":"set",     "id":"npc-varda", "component":"status", "value":{"alive":false}}      // null value = remove component
{"op":"merge",   "id":"world-state","component":"flags", "value":{"bridge_burned":true}} // materializes if missing
{"op":"despawn", "id":"item-torch"}
{"op":"event",   "name":"narration","data":{"text":"...", "by":"dm"}}                   // transient: broadcast+journaled, never persisted
{"op":"reset",   "scene":"the-maw"}                                                    // re-seed from campaign files; persist-tagged survive
```

Two ops we add for the tabletop turn loop:

```jsonc
{"op":"action", "text":"I search the altar for traps", "by":"player-c001", "mode":"narration"}  // a client's intent → triggers the turn engine
{"op":"check",  "check":"skill-check", "params":{"skill":"perception","modifier":2}, "for":"player-c001"} // ruleset-resolved adjudication
{"op":"roll",   "expr":"2d6", "for":"player-c001", "reason":"damage"}                            // low-level raw-dice primitive (server resolves)
```

> **Refinement from the DSA representability check (`analysis/dsa-representability-check.md`):** adjudication must NOT
> be a 5e-shaped `roll(expr, dc)`. The ruleset-facing primitive is the generic **`check`** op, resolved by a
> **pluggable `resolveCheck(checkDef, entityState, params, rng)`** against **check definitions shipped as ruleset
> data** (`ruleset/checks.js`): each definition declares dice count, comparator (roll-under/over), multi-die target
> evaluation, compensation pool, crit/fumble pattern, and a Quality-Level result map. So 5e (d20 roll-high vs DC)
> and DSA5 (3d20 roll-under + QS) are the *same engine, different data*. `roll` remains only as a raw-dice helper.

**Canon vs ephemeral (our analog of GAIA's `dev` flag).** Entity-mutating ops (`spawn/set/merge/despawn`) are
**canon** → persisted to the session save (the living world). `event`/`roll`/`action` are **ephemeral** → broadcast
+ journaled but never persisted. When a *human* holds the DM seat, the AI-DM's canon ops arrive as **proposals**
that the DM approves/edits before they apply — that's the "canon pen."

**WS lifecycle (GAIA's, unchanged):** connect → server sends `{type:"snapshot", entities, time, counter, world, ruleset}`
→ client sends `{type:"hello", presence}` → both exchange `{type:"ops", ops, from}` → server applies, broadcasts to
all (including sender), journals.

**Journal (GAIA's, unchanged):** `GET /events?since=<seq>` returns `{latest, events:[{seq,t,from,op,...}]}`. This is
our turn history, the canon-commit log, and how the AI-DM/DM/players stay in sync — one stream for every consumer.
`$id`/`$now` substitution carries over for templated ops in scripted encounters.

---

## 5. Entities, components & schema-as-data

**Entity = `{id: {componentA:{...}, componentB:{...}}}`** — flat, merge-friendly, no inheritance (GAIA's model).

Entity kinds (by their components, not a class): `location`, `npc`, `item`, `quest`, `faction`, `pc` (party member),
`world-state` (flags), `presence` (a connected client — player or DM seat).

Base component vocabulary (illustrative; the **ruleset extends this**):

| Component | Holds |
|---|---|
| `identity` | name, kind, short description |
| `place` | a location's connections / an entity's current location |
| `stats` | HP/MP/attributes — **shape defined by the loaded ruleset** |
| `inventory` | item ids + quantities |
| `persona` | NPC personality, backstory, voice (drives dialogue) |
| `relationships` | affinities / who-knows-what (quantitative deltas, à la the affinity model) |
| `quest` | phase, steps[], current_step, rewards |
| `status` | alive/dead, conditions |
| `flags` | arbitrary canon key→value (the simple, infinitely-extensible gate store) |
| `art` | image prompt + cached image ref (atmosphere) |
| `lifelog` | compact per-character memory summary — **our living-summary primitive** |
| `persist` | survives `reset` (GAIA's Braid rule) |
| `presence` | a connected client: `{seat:"player"|"dm", who, mode}` |

**Schema-as-data (GAIA's single best idea for us).** One declarative `SCHEMA` object (`doc`/`default`/`fields` with
`range`/`enum`), served raw at `GET /schema`. It is the **one source of truth** for **four** consumers:
1. the **DM-seat inspector** auto-generates controls from it (GAIA's Panel);
2. the **AI-DM** fetches it to know the exact component/op vocabulary — no guessing;
3. the **LLM output contract** — the turn engine tells the model "emit ops in this schema," and
4. **runtime validation** — Zod validators derived from / aligned with the schema reject malformed LLM ops.

A loaded **ruleset contributes schema** (its stats, skills, conditions) → the same auto-generated UI + validation +
LLM contract instantly cover the new system. That's how "load any rulebook" becomes concrete and cheap.

---

## 6. The session server

`Session` (≈ GAIA's `world.js`): owns `Map<id, components>`, `applyOp`, save/load. One Node process can hold N
sessions (one per table). Flow per incoming op batch: **validate (Zod) → apply to store → persist canon ops →
broadcast to all clients → append to journal.** Save model is GAIA's exactly: authored campaign files are the seed
(read at boot/`reset`); the **session save is the living-canon overlay** (`saves/session_<TTRPG_SAVE>.json`,
gitignored); on boot scenes seed first, the save overlays, scenes-then-save (save wins for canon, like GAIA's
player layer). `persist` + `reset` semantics carry over unchanged.

---

## 7. The turn engine (our addition) — the one loop GAIA doesn't have

Triggered when a client emits an `action` op. The **AI-DM is just a client** that turns an action into ops:

```
action op ─▶ turn.run(session, action):
  1. context = buildContext(session)        [shared/context.js, PURE]
       ├─ CACHED PREFIX: ruleset system prompt + world bible + character sheets   (byte-stable → DeepSeek cache hit)
       ├─ LIVING SUMMARY: sense.look(session) — current scene, NPCs present, party state, quest, flags
       │                  (+ relevant lifelogs) — high-salience, near the END of context
       └─ ROLLING WINDOW: last N narration turns verbatim; older folded into summary
  2. stream  = llm.stream(context + action)  [DeepSeek via LlmClient]
       └─ emit {op:"event", name:"narration", data:{delta}} per token → broadcast live to every client
  3. {narration, ops, rolls} = parseModelOutput(full)   [lenient → Zod-validate against /schema]
  4. for each requested roll: dice.resolve(expr, dc)     [server RNG — NOT the LLM] → feed results back;
       if outcomes need narrating, a short 2nd LLM pass describes the *given* results
  5. validate ops → apply → persist canon → broadcast → journal
       └─ if a HUMAN holds the DM seat in review mode: ops emit as PROPOSALS; DM approves/edits → then apply
```

Key anti-patterns from the Instantale report, designed out here: **no LLM-invented dice/damage** (step 4 is
deterministic), **no silent history eviction** (step 1 folds old turns into the summary), **no provider hardcoding**
(step 2 is an interface), **no prompts baked in code** (the prefix is ruleset data).

---

## 8. The AI-DM's senses & the memory architecture (GAIA's text-senses = our memory layer)

The AI-DM perceives the campaign through **text senses over the canonical store**, exactly like GAIA's agents —
which is *also* the implementation of our concept's living-state-summary:

| Sense | Returns | Role for us |
|---|---|---|
| `look` | current scene frame: location, NPCs present (+status/affinity), party state, active quest, time | **the living state summary**, generated fresh from the store each turn |
| `describe <id>` | one-line entity summary | pull a specific NPC/item/quest into context on demand |
| `query --has <comp>` | entities matching (e.g. NPCs at this location) | structured retrieval without dumping the store |
| `recall <topic>` | semantic search over past events/lifelogs (embedding) | **the memory retrieval Instantale built infra for but never wired** |
| `check` | **canon consistency lint** | dead NPC referenced as alive, entity in two places, dangling quest/relationship refs — **consistency-on-write** |

`look` ranks what to include by **salience** (present-in-scene, plot-relevant, recently-touched), mirroring GAIA's
salience formula — so the summary stays compact and near the end of context where attention is strongest. The
**journal** is the rolling raw history; `summary.js` folds evicted turns into `lifelog`/`world-state`. The world DB
(the store) is the source of truth; context is a working window that can forget freely.

---

## 9. The DM seat = "everything is a client"

This is where GAIA's principle pays off hugest. The DM seat is **not a mode** — it's **whoever is connected as the
`presence` with `seat:"dm"`**, and they emit the same ops as anyone:

- **No one in the seat** → the AI-DM client auto-occupies and applies its ops directly = autonomous AI-RPG.
- **A human takes the seat** → the AI-DM's ops become **proposals**; the human approves/edits/overrides (the canon
  pen), tweaks the **mood knob** (an op on the `environment`/`art` of the scene → drives image + music), and can
  steer narration (emit a corrected `event:narration`).
- The **slider** between autonomous and assisted is just the DM presence's `mode` (auto / review / manual). Same
  engine, one knob — exactly the thing the concept said nobody else offers.

Multiplayer falls out for free: more players = more `presence` clients on the same session/journal.

---

## 10. The reconciler client (GAIA's, for text/2D)

One-directional: **server → WS snapshot/ops → `store` → `view.handle(event)`**, granular, no diffing (GAIA's
pattern). `view` switches on what changed: `event:narration`→append/stream into the log; `identity`/`status`→update
a panel line; `stats`→update an HP bar; `art`→swap the scene image; `presence`→update seat/he's-typing indicators;
`snapshot`→rebuild. No React: the server owns truth, so the client is a thin view + a `switch`. Vite gives HMR while
iterating.

---

## 11. Atmosphere (later phase, but designed in)

- **Image:** `ImageClient` adapter; per-scene prompt from the location's `art` component + a per-campaign
  **style-direction** string + **seed** for continuity; **cache-by-hash**; one server-side **post-processing pass**
  for a unified look (the highest-value trick from the Instantale report). Generated images are canon (`art.image`
  ref persisted).
- **Audio:** Web Audio in `client/kernel/audio.js`; curated mood tracks bucketed (location-type × mood) with
  crossfade; the **DM mood knob** biases selection. AI-generated music is a later swap behind the same selection.

---

## 12. What we copy / adapt / add / drop

| GAIA decision | For us |
|---|---|
| Ops as the only mutation primitive + journal | **Copy** (add `action`, `roll`) |
| Component-document entities, `merge` materializes | **Copy** |
| Schema-as-data → `/schema` → auto UI + agent vocab | **Copy** (also = LLM contract + Zod validation; ruleset extends it) |
| `shared/` pure functions, both sides import | **Copy** |
| Scene files = source of truth + save overlay + `persist`/`reset` | **Copy** (authored campaign = seed; session save = living canon) |
| Store-mirror + granular reconcile, no framework | **Copy** |
| Text senses (`look/map/describe/query/check`) | **Adapt**: `map`→drop (no terrain); add `recall` (semantic memory) |
| "Everything is a client" | **Copy** — it *is* our DM seat + multiplayer model |
| World = a directory, `GAIA_WORLD` env | **Copy** (`TTRPG_WORLD` = a campaign bundle) |
| Vite + plain JS + `concurrently` dev | **Copy** |
| 3D: terrain, colliders, meshes, shaders, zone streaming, world clock | **Drop** (no spatial sim; turn-based, not real-time) |
| — | **Add**: turn engine, deterministic dice, rules-as-data ingestion, cached-prefix memory layering, LLM/image adapters |

---

## 13. Phased build path & progress (reprioritized — "fully functional game FIRST"; multiplayer last)

**Status: P0–P6 DONE, committed** (git `3635b7e` P0–P2, `9600972` P3, `8865abf` P4, `cf0559a`+`f9df809` P5,
`ffa8ffd` P6; P0–P4 verified on real DeepSeek, P5 combat + P6 quests/progression are deterministic/no-LLM).
Progress is also tracked in agent memory (`ttrpg-engine-project.md`).

- **P0 — Skeleton (the GAIA spine) ✅** WS+HTTP hub, `Session` store, op apply/broadcast/journal, snapshot,
  framework-free reconciler client, `tools/patch.mjs`, sample world. No LLM.
- **P1 — The turn loop ✅** `action` → cache-ordered context → DeepSeek stream → live narration → structured
  op-extraction (Zod). `LlmClient` = stream/complete/structured; `deepseek-v4-flash` default, swappable; Mock adapter.
- **P2 — State, senses & the agent model ✅** `sense.js` (look/describe/query/check); **NPCs as independent
  agent-clients** (own system prompt + scoped `knowledge` + memory); DM = director/router; 4-lane transcript
  (DM narration / NPC dialogue / system / player). `@name` + single-NPC no-LLM routing.
- **P3 — Action→consequence loop + mechanics ✅** engine-rolled dice (`shared/rng.js` + pluggable
  `shared/checks.js`, 5e d20-vs-DC), semantic effects (`shared/effects.js`: damage/heal/giveItem/move/setFlag →
  canonical ops), PC with 5e stats, DM-as-referee `adjudicate()` + outcome-aware `narrateOutcome()` +
  **`canonize()`** (narrate-freely-then-canonize keeps state in sync with the story). System lane shows rolls.

- **P4 — Exploration ✅** location graph (`shared/space.js`), location-scoped scene frame (one canonical generator;
  `sense.look` delegates) + location-scoped routing, movement (deterministic intent-gate + `resolveExit`, with an
  LLM `move` backstop), `take`/`drop` (taken items leave the ground), multi-room world (docks + market with scoped
  NPCs). Also fixed a `view.js` SyntaxError that broke the browser client + made `adjudicate` parsing lenient.

- **P5 — Combat ✅** structured encounters (`shared/combat.js` pure engine + `server/combat.js` orchestrator):
  attacking a `flags.hostile` entity starts an encounter; **initiative drives the floor/turn system** (enemy
  AI turns auto-resolve, the player's turn pauses for input — DESIGN-NOTES #2); attacks via `resolveCheck('attack')`
  vs `stats.ac`, damage via the `damage` op; victory/defeat/flee. Deterministic (no LLM); attacking a
  non-hostile stays on the narrative path (the "swappable" seam). Combat HUD in the client.

- **P6 — Quests & progression ✅** trigger-driven quest state machine (`shared/quests.js`: flag/atLocation/
  hasItem/dead/allDead triggers) re-evaluated after every turn (`server/quests.js`); completion grants rewards
  (items + XP); `shared/progression.js` 5e XP/leveling (proficiency + maxHp on level-up). Combat victory awards
  kill-XP. Demo quest threads travel→combat→loot. `TTRPG_SEED` env for reproducible sessions. Quest/XP HUD.

**Remaining (game-functional-first):**
- **P7 — Rules-as-data, the moat (NEXT):** load a ruleset bundle (schema ext + check defs + system prompt) — SRD, then
  **DSA** (3d20 roll-under + QS via the pluggable check engine; `checks.js` already has the `comparator:'ge'|'le'` seam).
- **P8 — World generation:** procgen bones + LLM "charges it with meaning", generated once → fixed data.

**Deferred (explicitly later):** atmosphere (image/music — the old "P4"); the human **DM seat** (review/override/mood
knob/canon-confirm); **multiplayer** (last). The architecture keeps all three open — see DESIGN-NOTES #1
(human-playable agent seats via `agent.controller`/`presence.controller`) and §11 (atmosphere designed-in).

---

## 14. Decisions to confirm before P0

1. **Repo:** new repo at `~/projects/ttrpg-engine` (separate from this analysis dir), or build inside
   `~/projects/ttrpg`? (Recommend a fresh, clean repo.)
2. **Schema validation:** derive Zod from the declarative `SCHEMA` object (one source of truth, a little glue), vs
   maintain Zod as the schema and attach doc/range/enum metadata. (Recommend: declarative `SCHEMA` is canonical,
   small helper builds Zod from it — keeps GAIA's "schema is data" intact.)
3. **First ruleset content for P1:** pure 5e-from-memory (no files), confirmed — agreed in concept.
4. **Image/Audio providers** (only matters at P4): pick a provider then.
