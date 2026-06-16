# Pi task B: P8 world validator — `shared/worldcheck.js`

FIRST read `analysis/prompts/p8-contracts.md` (BINDING spec — Module B). Also read `shared/schema.js`
(component shapes: identity.kind values, place.connections, quest.triggers) and skim
`world/scenes/tavern.json` (a valid world your validator must pass) and `shared/space.js` (how the
engine actually reads connections/locationId — your checks should match that reality).

## Do exactly this
Implement `export function validateWorld(entities)` in a NEW file `shared/worldcheck.js`, exactly per
Module B of the contracts: a PURE referential-integrity checker returning `{ ok, errors }` (never
throws). Implement ALL eight checks listed in Module B (pc present + unique, ≥1 location, pc location
resolves, every location connection target exists and is a location, connections bidirectional,
non-location placements resolve to a location, quest triggers reference real entities of the right
kind). `inventory.items[].id` are inline refs — do NOT check them. Reward items — do NOT check them.
Each error message must name the offending id and be specific. `ok === (errors.length === 0)`.

## Constraints
- ONLY create `shared/worldcheck.js`. Touch nothing else.
- PURE: no `server/`/`client/` imports, no `fs`. Accept a plain object `{ id: components }`.
- Guard against missing components on any entity — never throw; report as an error instead.

## Verify before returning
`node --check shared/worldcheck.js`. Then inline-node sanity: build a tiny VALID world object by hand
(1 location + 1 pc placed there) → `ok === true`; then break it three ways (bad connection targetId;
remove the pc; quest atLocation → missing id) → each `ok === false` with a message naming the problem.
Also confirm `validateWorld(<parsed world/scenes/tavern.json>).ok === true` (read & JSON.parse the
file in your inline check). (test-p8.mjs is written by a parallel task — don't write it.)

## Return (compact)
- The exact list of error strings your three deliberately-broken cases produced.
- Confirmation tavern.json validates `ok:true` (paste the result).
- Any assumption (esp. how you treated tavern's quest hasItem=item-crate / allDead ids).
