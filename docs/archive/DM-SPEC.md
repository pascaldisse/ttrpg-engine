# DM Overhaul — "World-First Narration" — Implementation Spec (D1–D5)

> **Self-contained handoff.** A 5-phase refactor of the DM/narrator loop so that **everything the DM
> says actually exists in the world**. Read this whole document, then implement **D1 → D5 in order**,
> committing at each Definition-of-Done. Hold the invariants in **§2** — they are why the engine is
> valuable. The full test suite must stay green after every phase.

---

## 0. The problem & the vision

### What's broken
The DM loop is **"narrate first, canonize second"** (`server/turn.js` `executeRuling`):

1. `adjudicate` — LLM picks checks / who to talk to.
2. `narrateOutcome` — LLM streams prose **freely**.
3. `canonize` — a *second* LLM pass reads the prose and extracts world-changes as ops.

This is structurally lossy. `canonize`'s entire vocabulary is `take / giveItem / takeItem / damage /
heal / setFlag` — it **cannot spawn entities**. So when the narrator writes "a preacher levels a
shotgun and three groomsmen lunge," those actors can only ever be **prose**. The player's HUD shows a
vivid fight; the engine has zero combatants; combat never starts. (Observed: PC alone on `loc-strip`,
typed *"initiate fight"*, got a full combat narration, no encounter — because `detectInitiation`
correctly found zero present hostiles.)

### The principle (from the user)
> Everything the narrator/DM says must actually **happen in the world**. It is never a pure text
> invention. If the DM describes a new character, that character must be **spawned**. And the **DM is
> just another client** — the same system whether driven by an LLM, a human (DMView), or both at once.

### The vision: invert the loop — **STAGE → RESOLVE → RENDER**
The **world (entity store) is the single source of truth; narration is a *view* of it.** The DM seat
emits **staging ops** (world deltas) *first*; the engine applies them and rolls the dice; only **then**
is prose rendered, bound to entities that now actually exist.

| Step | Who | What |
|---|---|---|
| **STAGE** | DM seat (LLM now / human later) | Decide the world delta as semantic ops — incl. **`spawnActor`** and **`beginCombat`** — alongside existing `checks` / `speakTo` / `damage` / `setFlag`. The LLM names *what* (archetype + intent); never stats or dice. |
| **RESOLVE** | engine (deterministic) | Validate + apply staging ops (spawns become real entities at the PC's location); roll checks via `session.rng()`; if `beginCombat`, open the existing combat floor with the now-present hostiles. |
| **RENDER** | DM seat | Stream prose against the **post-resolve** scene frame, hard-bound to "only reference entities present here." |
| **VALIDATE** | engine + LLM backstop | Demoted `canonize`: capture incidental changes (loot/flags) **and** flag any *named, interactable actor* the prose introduced that isn't present → spawn it generically so the invariant holds even if RENDER disobeys. |

### Phase map
| Phase | Adds | Headline test |
|---|---|---|
| **D1** | `shared/staging.js` (PURE) + ruleset `actorTemplates` (necrotopia) | template → spawn op with ruleset stats, unique id |
| **D2** | STAGE step: `adjudicate` learns `spawns[]` + `beginCombat`; RESOLVE applies spawns pre-checks | trace shows staged ops; spawned hostile is a real entity |
| **D3** | RENDER grounding + demote `canonize` to the actor-validation backstop | prose can't conjure a non-present actor (it gets spawned or rejected) |
| **D4** | DM-initiated combat: `combat.beginEncounter` from spawned hostiles | **"initiate fight" spawns groomsmen + enters the timeline** ← fixes the screenshot |
| **D5** | Seat seam: STAGE/RENDER through the DM-seat `controller` indirection; each beat traced | a hand-fed op yields an identical beat (human-DM ready, no UI yet) |

Each phase is independently shippable and leaves the game working + tested.

---

## 1. Orientation (read-first, in order)
1. `server/turn.js` `executeRuling` — the loop being inverted (the heart of this refactor).
2. `server/agents/dm-agent.js` `adjudicate` / `narrateOutcome` / `canonize` — the three LLM passes.
3. `shared/effects.js` — semantic→canonical op expander (the `spawn` op is canonical).
4. `shared/ops.js` `handlerRegistry.spawn` — id auto-assignment + the `counterRef`.
5. `server/combat.js` — `detectInitiation` / `startAndResolve` / `presentHostiles` (reuse for `beginEncounter`).
6. `campaigns/necrotopia/ruleset/necrotopia/ruleset.js` — where `actorTemplates` data lives.
7. `campaigns/necrotopia/scenes/vegas.json` — the shape of a real hostile NPC entity (`npc-imp-1`).
8. `server/llm.js` `MockLlmClient` (`#mockAdjudicate` / `#mockCanonize`) — how smokes script the DM.
9. `server/ruleset.js` / `server/index.js` — loader return shape + engine wiring.

### Run / verify
- PURE tests: `node tools/test-<x>.mjs`. Smokes (boot server on Mock LLM, drive over WS): `node tools/smoke-<x>.mjs`.
- Boot: `npm run play:necrotopia`.
- **After every phase the full suite must stay green**: `test-p4 p5 p6 p7 dsa visibility client dm-client combat-c1..c5`
  and `smoke-p4 p5 p6 p7 necrotopia dmview-s1 s2 combat-c1..c5` + the new `test-dm-d*` / `smoke-dm-d*`.

---

## 2. Invariants (do not violate)
1. **Neutral core, rules-as-data.** No spawn/stat numbers in `shared/` or `server/`. Actor stat blocks
   come from the **ruleset bundle** export `actorTemplates`; the engine only *applies* them. A ruleset
   that exports **no** `actorTemplates` (5e, DSA) gets **no** DM-spawn capability → classic behavior,
   no regression. **Never** write `if (ruleset === 'necrotopia')`.
2. **The engine rolls dice; the LLM never does.** STAGE may *name* an archetype and *request* a check;
   stats and dice come from the ruleset/`session.rng()`. The LLM supplies no hp, no damage values.
3. **World-first.** Staging ops are applied **before** the narration that describes them. Prose is a
   view of committed state, not a source of truth. The VALIDATE backstop exists only to catch RENDER
   disobedience — it is not the primary grounding mechanism.
4. **DM is just another client.** STAGE and RENDER dispatch through the DM seat's `controller`
   indirection (DESIGN-NOTES #1). LLM-now and human-later (DMView) must emit the **same** ops. Build
   the seam; defer the UI.
5. **No build step.** Plain ESM, no bundler/TS/React. Everything is an op or an `event`. PURE files in
   `shared/` import nothing from `server/`.

---

## 3. Phase details

### D1 — `shared/staging.js` + ruleset `actorTemplates`
**New PURE module `shared/staging.js`:**
- `slugify(name)` → kebab id fragment.
- `uniqueActorId(slug, entities)` → `npc-<slug>`, else `npc-<slug>-2/3/…` (first free).
- `resolveActorSpawn(spec, templates, entities)` → a canonical `{op:'spawn', id, components}` (or
  `null` if no template + no explicit stats). `spec = {archetype?, name?, persona?, hostile?, ally?,
  place, zoneId?}`. Merges the chosen `templates[archetype]` (else `templates._default`) with `spec`
  overrides and assembles `identity / stats / status / place / moves / agent / persona / position? /
  flags`. Hostile ⇒ `flags.hostile=true` + `flags.damage` (from the template's first damage move);
  ally ⇒ `flags.ally=true`. `agent.controller='ai'` by default (seat indirection, D5).

**Ruleset data — `campaigns/necrotopia/ruleset/necrotopia/ruleset.js`:** add
`export const actorTemplates = { groomsman, imp, preacher, drifter, _default }`, each a d6 stat block
(`hp/maxHp/armor/level`) + a `moves.list` + `persona` + `accent` + `faction`.

**Loader/wiring:** `server/ruleset.js` returns `actorTemplates: mod.actorTemplates || null`.

**DoD:** `tools/test-dm-d1.mjs` — `resolveActorSpawn({archetype:'groomsman',hostile:true,place:'loc-strip'})`
yields a spawn op whose components carry necrotopia stats + `flags.hostile`; two in a row get distinct
ids; an unknown archetype falls to `_default`; a ruleset with `templates=null` returns `null`.

### D2 — STAGE step (spawns + beginCombat in the ruling)
- `createDmAgent` + `createTurnEngine` gain an `actorTemplates` param (threaded from `index.js`).
- `adjudicate` prompt rewritten to the **STAGE** contract: *"If your narration will introduce any NPC,
  creature, or threat not already in the scene, you MUST list it under `spawns` — it will be created
  before you narrate. To start a fight, set `beginCombat:true` and spawn the hostiles."* The prompt
  lists available archetypes from `actorTemplates` (when present). Schema/coercion gain
  `spawns: [{archetype, name?, hostile?, ally?, count?}]` and `beginCombat: boolean` (lenient coercion,
  drops malformed entries — never throws).
- `executeRuling` RESOLVE: after movement/speakTo, **before** checks, for each spawn spec (gated on
  `actorTemplates`) call `resolveActorSpawn` against the *current* entities and `applyAndBroadcast`
  **one at a time** (so ids stay unique); collect ids; `emitTrace({agent:'dm',phase:'stage',…})`; then
  refresh `session._lookCache = senseLook(session)`.
- Mock: `#mockAdjudicate` gains a branch returning `{spawns, beginCombat}` for fight-starting text.

**DoD:** `tools/smoke-dm-d2.mjs` — PC alone in a location; a staged action spawns a hostile NPC that
becomes a real, present, living entity; a DM trace records the staged spawn.

### D3 — RENDER grounding + demote `canonize`
- `narrateOutcome`: the scene frame is the **post-resolve** look; append a hard rule: *"You may ONLY
  reference NPCs/items/exits present in the scene frame above. Do NOT introduce any named character or
  creature that is not listed — if the fiction needed one, it has already been spawned and appears in
  the frame."* (Scoped to **named, interactable** actors; ambient scenery is free.)
- `canonize` → augmented backstop: its result schema gains `actors: [{name, hostile?, archetype?}]` —
  *interactable* actors the prose named that are **not** in the scene. `executeRuling` spawns each
  (generic/`_default`, gated on `actorTemplates`) and `emitTrace`s a grounding-violation warning;
  incidental `ops` (loot/flags) apply as before.

**DoD:** `tools/test-dm-d3.mjs` + a smoke — given narration that names an off-scene actor, the backstop
yields a spawn so the actor becomes real (no pure-text actor survives a turn).

### D4 — DM-initiated combat
- `server/combat.js`: add `beginEncounter(actionOp)` to the public API — `inCombat()? false :` build
  `{enemies: presentHostiles(), allies:[pc, …presentAllies()], targetId: enemies[0]}` and run the
  existing `startAndResolve`; returns `true` iff an encounter started.
- `executeRuling`: after spawns + checks, if `ruling.beginCombat` (and `combat`), `await
  combat.beginEncounter(actionOp)`; if it returns `true`, **return** (combat owns the start banner +
  flavor — skip generic RENDER/VALIDATE).

**DoD:** `tools/smoke-dm-d4.mjs` — PC alone on `loc-strip` types *"I draw my katana and start a fight"*;
the DM spawns groomsmen and the **timeline encounter is active** with those hostiles in the queue.

### D5 — Seat seam (human-DM-ready, no UI)
- Introduce a DM-seat `controller` lookup (default `'ai'` → LLM runner). STAGE (`adjudicate`) and RENDER
  (`narrateOutcome`) dispatch through it; each emits a `trace` beat (`emitTrace`) so a connected DMView
  can observe/override. The op output is byte-identical to what a future human DMView action emits.
- No DMView UI this pass (deferred per `dm-notes`). Prove the indirection: a hand-constructed STAGE
  ruling fed through the same RESOLVE path produces the identical ops as the LLM path.

**DoD:** `tools/smoke-dm-d5.mjs` — the responder indirection resolves the DM seat; a scripted (non-LLM)
ruling and the LLM ruling drive the same RESOLVE and emit equivalent ops + traces.

---

## 4. Sequencing & commits
One commit per phase (`D1: …` … `D5: …`), suite green at each. D4's smoke is the acceptance test for
the original bug. After D5, push is an outward action — leave it to the user.
