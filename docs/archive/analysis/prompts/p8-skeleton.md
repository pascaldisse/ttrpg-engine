# Pi task A: P8 procgen skeleton — `shared/worldgen.js`

FIRST read `analysis/prompts/p8-contracts.md` (BINDING spec — Module A). Also read `shared/rng.js`
(the rng you receive), `shared/schema.js` (component shapes), and `world/scenes/tavern.json` (the
exact output shape to match).

## Do exactly this
Implement `export function generateSkeleton(config, rng)` in a NEW file `shared/worldgen.js`, exactly
per Module A of the contracts: a PURE, deterministic procgen generator that returns
`{ entities, meta }` — a connected, bidirectional location graph populated with one PC, friendly
NPCs, enemies (all in one "lair" location), items (one prize item in the lair), and one quest whose
`triggers` reference the REAL generated ids (atLocation=lair, allDead=all enemy ids, hasItem=prize).
Identity `name`s are placeholders (`"Location 1"`, `"Townsperson 1"`, `"Foe 1"`, `"Object 1"`);
descriptions are `''`. Every structural component must be valid and complete.

## Constraints
- ONLY create `shared/worldgen.js`. Touch nothing else.
- PURE: no `server/`/`client/` imports, no `fs`, no `Date`, **no `Math.random`** — all randomness via
  the passed-in `rng` (`rng.int(min,max)`, `rng.d(sides)`, `rng.next()`). It need NOT import anything
  (rng is a parameter). Same config + `makeRng(sameSeed)` ⇒ `JSON.stringify`-identical output.
- Match tavern.json component shapes (identity/place/stats/status/inventory/persona/knowledge/agent/
  quest/flags/art) precisely. Bidirectional connections are mandatory; graph must be connected.

## Verify before returning
`node --check shared/worldgen.js`, then in a quick inline node check confirm: small world has ≥3
locations + exactly one pc + one quest + ≥1 `flags.hostile` enemy, the graph is connected (BFS from
pc location reaches all locations), connections are bidirectional, and two `makeRng(7)` runs are
`JSON.stringify`-equal. (test-p8.mjs is built by a parallel task — don't write it.)

## Return (compact)
- The `meta` shape you produced (keys + an example `hints` entry).
- The id scheme and size→counts you used.
- Pasted output of your inline determinism + connectivity check.
- Any assumption.
