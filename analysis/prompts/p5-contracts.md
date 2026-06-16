# P5 Combat — shared contracts (READ FIRST)

You are building part of an AI-TTRPG engine. Read `PROTOTYPE-SPEC.md` §13 and the existing
`shared/` + `server/` code to match conventions. **Do not break existing tests**
(`node tools/test-p4.mjs` must still pass; `node tools/smoke-p4.mjs` must still pass).

## Hard conventions (non-negotiable)
- **No build step.** Plain ES modules (`import`/`export`), Node + browser native. No TypeScript, no JSX, no bundler.
- **`shared/` modules are PURE** — no imports from `server/` or `client/`. They take plain data + an `rng` and return plain data. They must NEVER mutate the entities store or emit/apply ops — the server layer turns results into ops.
- **Dice come from the engine, never the LLM.** Use `shared/rng.js` (`makeRng(seed)` → `{next, int, d}`); the server passes `session.rng()`.
- **Reuse, don't reinvent.** Checks resolve through `shared/checks.js` `resolveCheck()` + `CHECK_DEFS` (there is already an `'attack'` def: d20 + ability mod (+prof) vs a DC). `abilityMod(score) = floor((score-10)/2)`.
- Entities are component documents: `{ id → { componentName: value } }`. Mutations are ops (`spawn/set/merge/despawn` + semantic ops expanded by `shared/effects.js`). Semantic `damage`/`heal` already exist.
- Keep modules small, data-driven, and extensible ("Es lebt von seiner community"). A ruleset must be able to swap combat later.

## Schema additions (single owner: the combat-engine brief edits `shared/schema.js`)
1. Add field `ac` to the `stats` component: `ac: { doc: 'Armor Class — DC for incoming attacks.', range: [1, 40] }`. Do NOT change `stats.default` (don't retro-add ac to existing entities).
2. Add a new component `encounter`:
   ```
   encounter: {
     doc: 'Active combat encounter (the floor/turn system). Lives on the singleton entity id "encounter".',
     default: { active: false, round: 0, order: [], turnIndex: 0, mode: 'initiative', enemies: [], allies: [] },
     fields: {
       active:    { doc: 'Is a combat encounter in progress?' },
       round:     { doc: 'Current round number (1-based once started).' },
       order:     { doc: 'Initiative order: array of combatant entity ids, highest initiative first.' },
       turnIndex: { doc: 'Index into order whose turn it is.' },
       mode:      { doc: 'Turn mode.', enum: ['initiative', 'free', 'round-robin'] },
       enemies:   { doc: 'Entity ids hostile to the party.' },
       allies:    { doc: 'Entity ids on the party side (incl. the PC).' },
     },
   }
   ```
3. Hostility marker: an NPC is a potential enemy when `flags.hostile === true`. (No schema change needed — `flags` is an open map.)

## `shared/combat.js` API (single owner: the combat-engine brief)
Pure. Signatures (return plain objects; never mutate; never emit ops):
- `rollInitiative(ids, entities, rng)` → `[{ id, init }]` sorted by `init` DESC (tie-break: higher dex, then id). `init = d20 + abilityMod(dex)`.
- `buildEncounter({ allies, enemies }, entities, rng)` → an `encounter` component object: `{ active:true, round:1, order:[...all combatant ids in initiative order], turnIndex:0, mode:'initiative', enemies, allies }`.
- `currentCombatant(encounter)` → the id at `order[turnIndex]` (or null).
- `resolveAttack({ attackerId, targetId }, entities, rng)` → `{ hit:boolean, crit:boolean, fumble:boolean, attackRoll:number, ac:number, damage:number, summary:string }`. Use `resolveCheck({ check:'attack', ability:<str unless the attacker's weapon is finesse then dex>, dc: target.stats.ac }, { stats: attacker.stats, proficiency: attacker.stats.proficiency }, rng)`. On hit, roll damage = weapon die + ability mod (min 1); crit doubles the dice. Default weapon die `1d6` when no weapon info; read an optional `flags.damage` (e.g. `"1d8"`) or weapon item if present. `summary` is a one-line human string.
- `advanceTurn(encounter, entities)` → a NEW encounter object advanced to the next LIVING combatant (skip `status.alive === false`); when wrapping past the end, increment `round` and reset to the first living combatant.
- `outcome(encounter, entities)` → `'ongoing' | 'victory' | 'defeat'`. `victory` = every enemy id has `status.alive === false`. `defeat` = every ally id has `status.alive === false`.

## Events (for the client to render — produced later by the server)
- Combat banners: `{ op:'event', name:'system', data:{ kind:'combat', phase:'start'|'turn'|'end', text, round?, currentId?, order?, outcome? } }`.
- Attack results reuse the existing roll lane: `{ op:'event', name:'system', data:{ kind:'roll', text, detail:{...} } }`.
- DM color uses `event:narration` (unchanged).

## Acceptance
- `node tools/test-p5.mjs` (you create it for the engine brief) passes with a FIXED seed: asserts initiative DESC ordering, a known hit and a known miss, crit on natural 20, `advanceTurn` skips a dead combatant and bumps `round` on wrap, and `outcome` returns victory/defeat correctly.
- Existing `node tools/test-p4.mjs` and `node tools/smoke-p4.mjs` still pass.
