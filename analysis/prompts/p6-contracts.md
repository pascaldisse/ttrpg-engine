# P6 Quests & progression — shared contracts (READ FIRST)

Part of the AI-TTRPG engine. Read `PROTOTYPE-SPEC.md` §13 and the existing `shared/` code to match
conventions. **Do not break existing tests:** `node tools/test-p4.mjs`, `node tools/test-p5.mjs`,
`node tools/smoke-p4.mjs`, `node tools/smoke-p5.mjs` must all still pass.

## Hard conventions (same as the rest of the engine)
- **No build step.** Plain ES modules. No TypeScript/JSX/bundler.
- **`shared/` modules are PURE** — no imports from `server/` or `client/`; take plain data + (where needed)
  an `rng`; return plain data; NEVER mutate inputs; NEVER emit/apply ops (the server turns results into ops).
- Entities are component documents `{ id → { component: value } }`. The PC is `identity.kind==='pc'`.
  Use `shared/space.js` (`findPc`, `pcLocationId`) for PC/location lookups. World flags live on entity id
  `"world-state"` in its `flags` component.
- Data-driven + extensible. The quest machine advances off **declarative triggers** evaluated against state.

## The idea
A quest is a state machine on the `quest` component. After every player turn the server re-evaluates active
quests: if the current step's **trigger** is satisfied by the world state, the quest advances a step (or
completes). Completion grants **rewards** (xp + items). XP can also come from combat kills. Crossing an XP
threshold **levels up** the PC. This ties the earlier phases together — triggers fire off exploration
(reach a location), items (pick something up), story (a flag), and combat (an enemy is dead).

## Schema additions (single owner: the engine brief edits `shared/schema.js`)
1. Extend the existing `quest` component (keep `phase`/`steps`/`currentStep`):
   - add to `default`: `triggers: []`, `rewards: { xp: 0, items: [] }`
   - add `fields.triggers`: `{ doc: 'Per-step trigger descriptors; triggers[i] gates advancing FROM step i. null = manual/never.' }`
   - add `fields.rewards`: `{ doc: 'Granted when the quest completes: { xp:number, items:[{id,name}] }.' }`
2. Extend the `stats` component: add `fields.xp`: `{ doc: 'Experience points.', range: [0, 9999999] }`. Do NOT change `stats.default`.

## Trigger vocabulary (single owner: the engine brief, in `shared/quests.js`)
`triggerMet(trigger, entities) -> boolean`. Support exactly these shapes (unknown type → false):
- `{ type:'flag', key, value, id? }` — `entities.get(id||'world-state').flags[key]` deep-equals `value`.
- `{ type:'atLocation', id }` — `pcLocationId(entities) === id`.
- `{ type:'hasItem', id }` — the PC's `inventory.items` contains an item whose id === `id`.
- `{ type:'dead', id }` — `entities.get(id)` is absent OR its `status.alive === false`.
- `{ type:'allDead', ids:[] }` — every id in `ids` is dead (per the `dead` rule).

## `shared/quests.js` API (PURE)
- `triggerMet(trigger, entities)` → boolean (above).
- `pendingAdvances(entities)` → array of `{ questId, fromStep, toStep, completes:boolean, rewards }` — ONE pending
  advance per active quest whose current-step trigger is met. For an `active` quest at `currentStep`, read
  `quest.triggers[currentStep]`; if met: if `currentStep+1 >= steps.length` → `completes:true` (phase→completed),
  else `toStep = currentStep+1`. Pure: returns intent only; the server applies ops + loops until stable.

## `shared/progression.js` API (PURE)
- `XP_THRESHOLDS` — 5e cumulative xp at the START of each level, index = level-1:
  `[0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000]` (levels 1–10; clamp above).
- `levelForXp(xp)` → integer level (1-based) for a total xp.
- `proficiencyForLevel(level)` → `2 + floor((level-1)/4)` (5e).
- `applyXp(stats, amount)` → `{ stats: newStats, gained, leveledUp, fromLevel, toLevel }`. Adds xp; recomputes
  level; on level-up sets `level`, `proficiency` (from `proficiencyForLevel`), raises `maxHp` by `5 + conMod`
  per level gained (conMod = floor((con-10)/2)), and sets `hp = maxHp` (full heal). Never mutates the input stats.

## Events (produced by the server later; the client renders them)
- `{ op:'event', name:'system', data:{ kind:'quest', phase:'advance'|'complete', questId, text, step? } }`
- level-up: `{ op:'event', name:'system', data:{ kind:'levelup', text, level } }`
- Completion also emits a DM-voice `event:narration` line (server, deterministic).

## Acceptance
- `node tools/test-p6.mjs` (engine brief creates it) passes: each trigger type true/false; `pendingAdvances`
  advances and completes correctly; `levelForXp` boundaries (299→L1, 300→L2, 900→L3); `applyXp` raises level +
  proficiency + maxHp and full-heals on level-up, and is a no-op below threshold.
- All existing P4/P5 tests + smokes still pass.
