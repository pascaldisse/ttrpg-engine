# Build task: P3 — the action→consequence loop + mechanics (THE KEYSTONE)

Working dir `/Users/pascaldisse/projects/ttrpg` (P0–P2 built + verified here). This phase turns the current
"chat window" into a GAME: player actions now produce **dice checks** (engine rolls) and **state changes** (canon)
with real consequences. Read `PROTOTYPE-SPEC.md` (§4 ops, §5 entities, §7 turn engine) and the existing code first:
`server/turn.js`, `server/agents/{dm-agent,npc-agent}.js`, `shared/ops.js`, `shared/context.js`, `shared/schema.js`,
`server/session.js`, `server/sense.js`, `server/llm.js`, `client/kernel/{view,store}.js`, `world/scenes/tavern.json`.

## The core problem to fix
Right now NO turn mutates game state — the DM only streams prose, NPCs only talk. P1's structured op-extraction was
dropped in the P2 refactor. P3 restores consequence + adds mechanics. **Engine rolls dice — the LLM NEVER supplies
dice values.** **The DM/engine holds the canon pen — NPCs stay talk-only in P3.**

## Philosophy (unchanged)
Plain JS, no React/TS/JSX/build. `shared/` pure. Server-authoritative. Provider swappable behind `LlmClient`.
SECURITY: key only from env, never logged/sent to client. Don't modify docs (`*.md`, `analysis/`). Comment seams.
Keep it MINIMAL but EXTENSIBLE: 5e (d20 vs DC) is the only ruleset; the check engine is pluggable for P7/DSA.

## What to build

### 1. shared/rng.js (PURE) — deterministic dice
- A small seeded PRNG (e.g. mulberry32). Export `makeRng(seed)` → `{ next() , int(min,max), d(sides) }`.
- Deterministic + reproducible (so tests + replay are stable). Do NOT use `Math.random` in shared.

### 2. shared/checks.js (PURE) — the pluggable check engine + 5e defaults
- `abilityMod(score)` → `Math.floor((score-10)/2)`.
- `resolveCheck(checkDef, ctx, rng)` → resolves ONE check. `checkDef` describes the system's rule; `ctx` carries the
  actor's stats + the requested params (ability/skill/dc/modifier). For the **5e default** definition: roll `d20`,
  add the relevant ability modifier (+ optional proficiency), compare to `dc` →
  `{ rolls:[d20], modifier, total, dc, success:bool, margin, crit: d20===20, fumble: d20===1, summary:"..." }`.
  The engine rolls — never the caller/LLM.
- Export `FIVE_E` check definitions (a small registry: `ability-check`, `attack`, `saving-throw` — all d20-vs-DC for
  P3). Keep `resolveCheck` generic enough that P7 can register DSA's 3d20 roll-under + QS as data (don't hardcode
  d20-roll-high assumptions outside the 5e def). Comment this as the rules-as-data seam.

### 3. shared/effects.js (PURE) — semantic ops → canonical ops expander
- LLMs are bad at absolute arithmetic (e.g. "new hp = 23−5"). So the DM emits **semantic ops** and the engine
  expands them into canonical component ops (`set`/`merge`) relative to current state.
- `expandOp(entities, op)` → returns an array of canonical ops. Implement a SMALL semantic set:
  - `{op:'damage', id, amount}` → merge `stats` with `hp = max(0, cur.hp - amount)` (+ set `status.alive=false` if hp 0).
  - `{op:'heal', id, amount}` → merge `stats` `hp = min(maxHp, cur.hp + amount)`.
  - `{op:'giveItem', id, item}` → merge `inventory.items` append `item`.
  - `{op:'takeItem', id, item}` → set `inventory.items` minus that item.
  - `{op:'move', id, to}` → set `place.locationId = to`.
  - `{op:'setFlag', key, value}` (+ optional `id`, default 'world-state') → merge `flags`.
  - Any raw canonical op (`spawn/set/merge/despawn`) passes through unchanged.
- These canonical ops are what get applied/journaled/broadcast — clients still only see spawn/set/merge/despawn, so
  `client/kernel/store.js` needs NO new cases. Add `damage/heal/giveItem/takeItem/move/setFlag` to the op Zod union
  in `shared/ops.js` (so they validate) but they are EXPANDED by `expandOp` before `applyOp` (they are not entity
  mutators themselves). Comment this clearly as an extension seam (rulesets may add semantic ops later).

### 4. shared/schema.js — 5e-ready PC stats
- Extend `stats` (or document via `registerComponents`) so a PC can hold the 6 abilities + hp/maxHp + proficiency:
  `{ str, dex, con, int, wis, cha, hp, maxHp, proficiency, level }`. Keep `hp/maxHp` from before. Field docs/ranges.

### 5. server: the adjudication + consequence flow
- **`server/agents/dm-agent.js` → add `adjudicate(actionOp, presentNpcs)`** (structured LLM call) returning,
  validated by a Zod schema:
  ```
  { speakTo: string|null,      // npcId if the player is conversing with an NPC, else null
    note: string,              // optional director note for that NPC
    checks: [ { ability, skill, dc, reason } ],   // dice checks to resolve BEFORE narrating
    ops: [ <semantic or canonical ops> ] }         // immediate, certain consequences (no check needed)
  ```
  The DM is told: the present NPCs (id+name), the PC's id + current stats, the `world-state` id, the available
  semantic ops, and that it must NOT invent dice — only REQUEST checks. Keep `narrate` but make a new
  **`narrateOutcome(actionOp, checkResults)`** that streams narration INCORPORATING the resolved check results
  (e.g. "your blade bites deep" on a success), then returns its text. (Reuse `streamBeat`.)
- **`server/turn.js` → new orchestration:**
  1. `@name` fast-path (no LLM) → route to that NPC (conversation), `npcAgent.respond(...)`, done. (Preserve.)
  2. Otherwise call `dmAgent.adjudicate(action, presentNpcs)`.
     - If `speakTo` set → `npcAgent.respond(speakTo, text, note)` (conversation; NPCs are talk-only in P3), done.
       (This subsumes the old single-NPC auto-route: the DM decides if it's conversation. Note: the pure "single NPC
       present → no LLM" shortcut is replaced by the DM adjudicator for non-@ input, because the DM must now referee
       whether an action needs a check. The `@name` no-LLM path is preserved.)
     - Else (world action): resolve each `checks[]` via `shared/checks.js` using the PC's stats + `session` RNG
       (give `Session` a persisted `seed` + `rollCount`; expose `session.rng()` advancing the count so rolls are
       reproducible and survive reload). For each result, `applyAndBroadcast` an `{op:'event', name:'system',
       data:{ kind:'roll', text:<summary>, detail:{...} }}` so the roll shows in the system lane.
     - Then `dmAgent.narrateOutcome(action, checkResults)` (stream narration grounded in the results).
     - Then expand + apply the consequence `ops`: for the no-check `ops` from adjudicate AND any post-outcome ops.
       For P3, keep it to ONE consequence source to stay simple: apply the adjudicate `ops` **conditioned on the
       check outcome** — i.e. tell the DM in `adjudicate` to provide `ops` for the success case, and on failure the
       DM may provide alternate consequences via a short follow-up OR the narration simply reflects failure with a
       failure op (your call; document it). Minimum bar: SUCCESSFUL checks and no-check actions produce applied ops.
     - Expand every proposed op via `expandOp`, validate (Zod), apply via `applyAndBroadcast` (canon → persisted +
       reconciled). Guard: ignore ops that would despawn a `pc`/`presence` entity.
  3. Wrap in try/catch with the existing graceful-failure narration.
- **`server/session.js`:** add `seed` (default a fixed constant or from save) + `rollCount`, persisted in save;
  `rng()` returns a fresh `makeRng(seed + rollCount)` and increments `rollCount` (so each roll is distinct +
  reproducible). Load/save them.
- Keep the agent instantiation wiring in `server/index.js`.

### 6. client — show the mechanics
- `client/kernel/view.js`: ensure the **system lane** renders `event:system` (kind:'roll') clearly (e.g. a centered,
  muted line: "🎲 Perception (WIS) — d20(13)+2 = 15 vs DC 12 → SUCCESS"). The PC's stats/HP already render in the
  inspector (generic). Optionally show party HP somewhere lightweight. No framework changes.

### 7. world — a PC + something to act on
- Add a **player character** entity `pc-hero` (identity kind:'pc', name e.g. "Rowan") with 5e `stats` (reasonable
  scores, hp/maxHp, level 1, proficiency 2), `inventory{items:[...]}`, `status{alive:true}`, `place{locationId:<the
  tavern>}`. Ensure a `world-state` entity exists.
- Add at least one **interactable** that demonstrates a check + consequence, e.g. a locked strongbox or a trapped
  altar in the tavern (an item/feature entity), so "I search/examine/force it" triggers a check whose success grants
  an item (giveItem) and whose failure deals damage (damage). You may add a small second location too if helpful.

### 8. server/llm.js — extend MockLlmClient for offline testing
- The mock must support the new `adjudicate` structured call branching on `opts.role==='adjudicate'`: return a
  DETERMINISTIC result driven by simple keyword heuristics on the player text, e.g.:
  - text contains "search"/"examine"/"force"/"pick"/"attack" → `{ speakTo:null, checks:[{ability:'wisdom',
    skill:'perception', dc:12, reason:'searching'}], ops:[{op:'giveItem', id:'pc-hero', item:{id:'item-key',
    name:'Brass Key'}}] }` (op applied on success);
  - text starting with a name/greeting or matching a present NPC → `{ speakTo:<first present npc>, checks:[], ops:[] }`;
  - "take"/"grab"/"pick up" the torch → `{ speakTo:null, checks:[], ops:[{op:'giveItem', id:'pc-hero',
    item:{id:'item-torch', name:'Torch'}}] }` (no-check op);
  - else → `{ speakTo:null, checks:[], ops:[] }` (pure narration).
  Keep the existing `role:'dm'|'npc'|'routing'` mock branches working.

## Acceptance criteria — verify with the MOCK provider (no key); delete throwaway scripts after
1. Server starts; `/sense/look` shows the party (pc-hero with HP). `/schema` includes the new semantic ops.
2. **Check + success consequence:** action "I search the altar for traps" → a `event:system` roll appears (engine-
   rolled, reproducible given the seed) → DM `narration` grounded in the result → on success a state op APPLIES
   (e.g. `pc-hero.inventory` gains the Brass Key) — verify via `/sense/describe?id=pc-hero` and `/events` (canonical
   set/merge with full payload), and that it PERSISTS across restart.
3. **No-check consequence:** "I pick up the torch" → no roll, but `pc-hero` inventory gains the torch (op applied).
4. **Damage path:** drive a failure (seed or mock) → `damage` semantic op expands to a `merge pc-hero stats {hp:...}`
   reducing HP (and `status.alive=false` at 0). Verify HP actually dropped.
5. **Conversation still pure:** "@Marta hello" (and a greeting the adjudicator routes to Marta) → dialogue only, NO
   roll, NO state mutation.
6. **No spurious mechanics:** an ambient/look action → narration only, no rolls, no ops.
7. Dice are ENGINE-rolled and reproducible; the LLM never supplies dice values (the roll detail comes from `checks.js`).
8. P0–P2 still pass (spawn/set reconcile, /schema, /events, restart-persist, NPC dialogue lane via @mention).
Do NOT spend real API calls — a human runs the real DeepSeek smoke test.

## Return
Compact report: files added/changed, the exact turn-flow you implemented (incl. how failure consequences are
handled), the adjudication Zod schema, how each acceptance criterion was verified (with real command output), and
deviations + why. Do NOT paste full files or the API key.
