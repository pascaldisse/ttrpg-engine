# Pi task C: P8 tests — `tools/test-p8.mjs`

FIRST read `analysis/prompts/p8-contracts.md` (BINDING spec — Module C names every required
assertion). Read `tools/test-p7.mjs` and `tools/test-p6.mjs` to MATCH their test harness style
exactly (tiny `assert`, pass counter, `✅`/PASS lines, `process.exit`). Skim the Module A and Module
B contracts so you know the exact return shapes you are asserting against.

## Do exactly this
Create a NEW file `tools/test-p8.mjs` (plain Node ESM, no deps) importing:
`makeRng` from `../shared/rng.js`, `generateSkeleton` from `../shared/worldgen.js`,
`validateWorld` from `../shared/worldcheck.js`. Implement ALL assertions in Module C:
determinism (same seed ⇒ equal JSON), seed sensitivity (different seed ⇒ different JSON), small-world
structure (≥3 locations, one pc, world-state, one quest, ≥1 hostile, ≥1 item), connectivity (BFS from
the pc's location reaches every location), self-validation (`validateWorld(...).ok===true` for small
AND medium), validator-catches-breakage (3 mutations each → `ok===false` + a relevant error), and
bidirectional connections. Clone entities with `JSON.parse(JSON.stringify(...))` before mutating.

## Constraints
- ONLY create `tools/test-p8.mjs`. Touch nothing else.
- The two `shared/` modules are authored by parallel tasks against the same contract — code strictly
  to the contract's signatures/return shapes, not to any implementation you imagine.

## Verify before returning
`node tools/test-p8.mjs` must exit 0 with all checks passing (the parallel tasks will have created
`shared/worldgen.js` and `shared/worldcheck.js` by the time you run — if a module is briefly missing,
wait and re-run). Also run `node tools/test-p7.mjs` to confirm no regression.

## Return (compact)
- Pasted PASS/✅ lines from `node tools/test-p8.mjs`.
- The count of assertions.
- Any contract ambiguity you hit and how you resolved it.
