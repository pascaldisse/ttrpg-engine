# Pi task: P5 combat engine (pure) + schema + unit test

FIRST read `analysis/prompts/p5-contracts.md` (the binding spec) and skim `shared/checks.js`,
`shared/rng.js`, `shared/effects.js`, `shared/schema.js` to match style.

## Do exactly this
1. Edit `shared/schema.js`: add the `stats.ac` field and the new `encounter` component, EXACTLY as
   specified in the contracts file. Touch nothing else in that file.
2. Create `shared/combat.js`: a PURE module implementing the full combat API from the contracts
   (`rollInitiative`, `buildEncounter`, `currentCombatant`, `resolveAttack`, `advanceTurn`,
   `outcome`). Import `resolveCheck`/`abilityMod` from `./checks.js` and `makeRng` from `./rng.js`.
   No server/client imports. Do not mutate inputs. Heavy JSDoc; note the extension seam (rulesets
   can swap the damage/initiative rules).
3. Create `tools/test-p5.mjs`: deterministic, seeded (use `makeRng(<fixed seed>)`), asserting every
   item in the contracts "Acceptance" list. Mirror the structure/style of `tools/test-p4.mjs`.

## Constraints
- ONLY create/modify: `shared/schema.js`, `shared/combat.js`, `tools/test-p5.mjs`.
- Do NOT touch `server/`, `client/`, `world/`, or any other test.
- Must keep `node tools/test-p4.mjs` green.

## Verify before returning
Run: `node --check shared/combat.js && node tools/test-p5.mjs && node tools/test-p4.mjs`.
Both test suites must pass.

## Return (compact — no code dumps)
- The list of files changed/created.
- The combat.js exported function names + one-line behavior each.
- The pasted final PASS lines from both test runs.
- Any assumption you had to make (e.g. weapon/damage handling).
