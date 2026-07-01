# P8 — World Generation: binding contracts

> **The moat extension:** the engine can *generate a brand-new world as data* instead of being
> hand-authored. Two stages: (1) **procgen bones** — a PURE deterministic skeleton generator lays
> down a connected location graph, places a PC, NPCs, enemies, items, and one quest whose triggers
> reference real generated ids; (2) **charge with meaning** — an LLM pass (server, NOT covered by
> these Pi tasks) fills the placeholder names/descriptions/persona/knowledge. Output is written to a
> scene JSON in the **exact same shape** the session already seeds from (`world/scenes/*.json`), so a
> generated world is indistinguishable from a hand-authored one. **Generated once → fixed data.**

These contracts are BINDING. Implement signatures and return shapes exactly. Three independent Pi
tasks code against THIS file (not against each other), so they can run fully in parallel.

Reference reading: `shared/rng.js` (the rng you receive), `shared/schema.js` (component shapes:
identity/place/stats/inventory/persona/knowledge/agent/quest/status/flags/art), and
`world/scenes/tavern.json` (the canonical hand-authored shape your output must match).

---

## Module A — `shared/worldgen.js` (PURE: procgen bones)

PURE module: no imports from `server/` or `client/`; no `fs`; no `Date`; **no `Math.random`** — ALL
randomness comes from the passed-in `rng`. Same `config` + same-seeded `rng` ⇒ byte-identical output.

```js
/**
 * Generate the structural skeleton of a world: a connected location graph populated with a PC,
 * NPCs, hostile enemies, items, and one quest wired to real generated ids. Identity names and
 * descriptions are PLACEHOLDERS — the (separate) LLM charge pass fills them. Every structural
 * component (place/connections, stats, flags, quest.triggers) is fully and validly populated.
 *
 * @param {object} config
 *   @param {'small'|'medium'|'large'} [config.size='small']
 *   @param {number} [config.locations]   explicit location count (overrides size preset)
 * @param {{next:()=>number,int:(a,b)=>number,d:(s)=>number}} rng  — from makeRng(seed)
 * @returns {{ entities: Record<string, object>, meta: object }}
 */
export function generateSkeleton(config, rng) { ... }
```

### Size presets (location count, NPCs, enemies, items)
- `small`  : 3 locations, 2 friendly NPCs, 2 enemies, 3 items
- `medium` : 5 locations, 4 friendly NPCs, 3 enemies, 5 items
- `large`  : 8 locations, 6 friendly NPCs, 5 enemies, 8 items

`config.locations` (if a positive integer) overrides the location count; NPC/enemy/item counts scale
with the chosen size bucket. Treat any unknown `size` as `small`.

### IDs (stable, deterministic)
- locations: `loc-1` … `loc-N`
- PC: `pc-hero` (always exactly one)
- friendly NPCs: `npc-1` …
- enemies: `enemy-1` …  (these are `identity.kind === 'npc'` too — "enemy" is a role, not a kind)
- items: `item-1` …
- quest: `quest-1`  (exactly one)
- world flags singleton: `world-state`

### Location graph (MUST be connected + bidirectional)
1. Lay a **spanning path** `loc-1 — loc-2 — … — loc-N` so the graph is guaranteed connected.
2. Add a few extra edges using `rng` (e.g. ~`floor(N/3)` extra chords) for non-linearity — never a
   self-loop, never a duplicate edge.
3. Every edge is **bidirectional**: if `loc-A` lists `loc-B` in `place.connections`, then `loc-B`
   MUST list `loc-A`. Each connection object: `{ targetId, label }`. Use a generic placeholder
   `label` (e.g. `"To " + targetId`) — the charge pass rewrites labels from named targets.

### Per-entity components (match tavern.json shapes exactly)
- **location** (`loc-*`): `identity {name:'Location <n>', kind:'location', description:''}`,
  `place {connections:[…]}`, `status {alive:true, conditions:[]}`,
  `art {prompt:'', image:null}`.  (Locations have no `place.locationId`.)
- **pc** (`pc-hero`): `identity {name:'Hero', kind:'pc', description:''}`,
  full 5e `stats {str,dex,con,int,wis,cha, hp,maxHp, ac, proficiency:2, level:1, xp:0}`
  (reasonable level-1 numbers; hp 18–22, ac 12–14), `status`, `place {locationId:'loc-1', connections:[]}`,
  `inventory {items:[ {id:'item-startgear', name:'Traveler\'s Pack', qty:1} ]}`, `flags {}`.
  Place the PC at `loc-1`.
- **friendly NPC** (`npc-*`): `identity {name:'Townsperson <n>', kind:'npc', description:''}`,
  `persona {personality:'', backstory:'', voice:''}`, `knowledge {facts:[], secrets:[]}`,
  `agent {enabled:true, accent:'<hex>'}` (deterministic palette by index),
  `status`, `place {locationId:<some non-enemy location>, connections:[]}`,
  `inventory {items:[]}`, `flags {trust_player:0}`.
- **enemy** (`enemy-*`): `identity {name:'Foe <n>', kind:'npc', description:''}`,
  `persona {personality:''}`, combat `stats {str,dex,con,int,wis,cha, hp,maxHp, ac, xp}`
  (level-1 mook numbers: hp 7–13, ac 11–13, xp 25–50), `status`,
  `place {locationId:<the "lair" location>, connections:[]}`,
  `flags {hostile:true, damage:'1d6'}` (pick `1d4`/`1d6`/`1d8` via rng). **All enemies share ONE
  location** (the "lair") so combat + the quest's allDead trigger are coherent.
- **item** (`item-*`): `identity {name:'Object <n>', kind:'item', description:''}`,
  `status`, `place {locationId:<some location>}`, optionally `flags`. **One item MUST be placed at
  the lair location** and be the quest's hasItem target (the prize).
- **quest** (`quest-1`): `identity {name:'The Main Quest', kind:'quest', description:''}`,
  `quest {phase:'active', currentStep:0, steps:['…','…','…'] (3 placeholder strings),
    triggers:[
      { type:'atLocation', id:<the lair location id> },
      { type:'allDead', ids:[<all enemy ids>] },
      { type:'hasItem', id:<the prize item id at the lair> }
    ],
    rewards:{ xp:250, items:[{ id:'item-reward', name:'Reward' }] } }`.
  The reward item need NOT exist as an entity (granted fresh on completion).
- **world-state**: `{ flags:{} }`.

### `meta` (generation hints for the LLM charge pass)
```
meta = {
  size: <resolved size string>,
  pcId: 'pc-hero',
  questId: 'quest-1',
  lairId: <the enemy/prize location id>,
  locationIds: [ 'loc-1', … ],
  hints: {
    [entityId]: { kind, role }   // role ∈ 'entrance'|'location'|'lair'|'local'|'enemy'|'prize'|'item'|'pc'|'quest'
  }
}
```
`loc-1`'s hint role is `'entrance'`; the lair location's role is `'lair'`; other locations `'location'`.
Friendly NPCs `'local'`, enemies `'enemy'`, the prize item `'prize'`, other items `'item'`,
`pc-hero` `'pc'`, `quest-1` `'quest'`.

**Determinism rule:** never iterate object insertion nondeterministically, never use `Date`/`Math.random`;
derive every choice from `rng`. Two calls with `makeRng(SAME_SEED)` must `JSON.stringify`-equal.

---

## Module B — `shared/worldcheck.js` (PURE: referential-integrity validator)

PURE: no server/client imports, no fs. Never throws — always returns the result object.

```js
/**
 * Validate a world entity-map for referential integrity, the way the running engine needs it.
 * @param {Record<string, object>} entities  — { id: components } (scene-JSON shape)
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWorld(entities) { ... }
```

Each failed check pushes a clear, specific message (include the offending id) onto `errors`.
`ok === (errors.length === 0)`. Checks (ALL of these):

1. **PC present:** exactly one entity with `identity.kind === 'pc'`. (0 → error; >1 → error.)
2. **At least one location** (`identity.kind === 'location'`).
3. **PC location resolves:** the PC's `place.locationId` names an existing entity whose
   `identity.kind === 'location'`.
4. **Every location connection target exists and is a location:** for each location, each
   `place.connections[].targetId` must be an existing entity with `identity.kind === 'location'`.
5. **Connections are bidirectional:** if `A` connects to `B`, `B` must connect back to `A`.
6. **Non-location placement resolves:** for any entity with `place.locationId` set (npc/item/enemy),
   that id must be an existing `location` entity. (Locations themselves may omit `locationId`.)
7. **Quest triggers reference real entities:**
   - `atLocation.id` → existing `location` entity.
   - `dead.id` / `allDead.ids[]` → existing entities (any kind, but they must exist).
   - `hasItem.id` → existing entity with `identity.kind === 'item'`.
   (Quest `rewards.items[].id` are NOT required to exist — skip them.)
8. **No dangling `agent`/hostile inconsistency is NOT checked here** — keep scope to references above.

`inventory.items[].id` are inline references and are **NOT** required to be entities — do not check them.

Guard against missing components everywhere (an entity may legitimately lack `place`, `quest`, etc.) —
never throw on a malformed map; report it as an error instead.

---

## Module C — `tools/test-p8.mjs` (Node test, mirror `tools/test-p7.mjs` style)

Plain Node ESM, no deps. `import { makeRng } from '../shared/rng.js'`,
`import { generateSkeleton } from '../shared/worldgen.js'`,
`import { validateWorld } from '../shared/worldcheck.js'`. A tiny `assert(cond, msg)` helper, count
passes, print `✅`/PASS lines, `process.exit(0)` on success / non-zero on first failure.

Assertions (at least these):
1. **Determinism:** `JSON.stringify(generateSkeleton({size:'small'}, makeRng(7)))` ===
   `JSON.stringify(generateSkeleton({size:'small'}, makeRng(7)))`.
2. **Seed sensitivity:** seed 7 vs seed 99 produce different output (`JSON.stringify` differs).
3. **Structure (small):** ≥3 locations, exactly one `pc`, a `world-state`, exactly one `quest`,
   ≥1 entity with `flags.hostile === true`, ≥1 item.
4. **Connectivity:** BFS from the PC's `place.locationId` over `place.connections` reaches **every**
   location entity.
5. **Self-validates:** `validateWorld(generateSkeleton({size:'small'}, makeRng(1)).entities).ok === true`.
   Also test `'medium'` self-validates.
6. **Validator catches breakage** (clone the entities, then mutate, expect `ok === false` and a
   relevant error string):
   - point some location connection `targetId` at `'loc-nope'`;
   - delete the PC entity;
   - point the quest `atLocation` trigger at a missing id.
7. **Bidirectional:** assert every location connection has a reciprocal in the target location.

Verify before returning: `node --check shared/worldgen.js && node --check shared/worldcheck.js &&
node tools/test-p8.mjs` all pass. Also run `node tools/test-p7.mjs` to confirm no regression to the
shared modules you touched (you should touch none of P7's).

---

## Hard constraints (all three tasks)
- ONLY create the files named for your task. Do NOT edit `server/`, `client/`, `shared/schema.js`,
  `shared/checks.js`, `shared/ops.js`, or any existing test. Do NOT touch `world/scenes/tavern.json`.
- `shared/` stays pure. No new npm deps.
- Match existing code style (JSDoc headers, 2-space indent, `const`/arrow helpers).
