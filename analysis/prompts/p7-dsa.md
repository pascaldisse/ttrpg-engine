# Pi task: P7 DSA5 ruleset bundle (3d20 roll-under) + test

FIRST read `analysis/prompts/p7-contracts.md` (binding spec — the DSA5 check formula is specified there in full),
`shared/checks.js` (CHECK_DEFS + how `resolveCheck` calls `def.resolve`), `shared/rng.js`, and
`shared/schema.js` (`registerComponents`).

## Goal
Prove the engine is rules-agnostic by shipping **Das Schwarze Auge 5** as a data bundle: a 3d20 **roll-under**
skill check with Quality Levels, plus DSA attributes — on the SAME engine, no core changes.

## Do exactly this
1. `world/ruleset/dsa5/ruleset.js` exporting:
   - `meta = { id:'dsa5', name:'Das Schwarze Auge 5', dice:'3d20', summary:'3d20 roll-under + Qualitätsstufen' }`.
   - `components = { attributes: {...} }` — register the 8 DSA attrs MU/KL/IN/CH/FF/GE/KO/KK with a doc + sane defaults.
   - `checks = { 'dsa-skill': { dice:{count:3,sides:20}, comparator:'le', modSource:()=>0, resolve(rolls,_mod,_dc,_def,ctx){...} } }`
     implementing the DSA5 skill check EXACTLY as the contracts specify (per-die roll-under vs `ctx.attrs[i]+ctx.mod`,
     `spent`/`remaining` against `ctx.fw`, `ql = clamp(ceil(remaining/3),1,6)` on success / 0 on fail, crit on ≥2 ones,
     fumble on ≥2 twenties, and the documented return shape incl. `summary`/`outcome`).
2. `world/ruleset/dsa5/system.md` — a DSA5-flavored DM system prompt (roll-under checks, Qualitätsstufen, grim
   German dark-fantasy tone). Plain text.
3. `tools/test-dsa.mjs` (standalone; mirror `tools/test-p6.mjs` style): import the dsa5 bundle, `registerChecks(bundle.checks)`,
   then assert via `resolveCheck`/direct `resolve()`:
   - a well-formed result shape;
   - an easy check (high attrs, fw 6) succeeds with `ql >= 1`;
   - a hard check (fw 0, low attrs, bad rolls) fails with `ql === 0`;
   - `crit === true` when ≥2 of the three dice are 1; `fumble === true` when ≥2 are 20
     (craft the rolls directly by calling `resolve([1,1,7], 0, 0, def, {attrs:[10,10,10], fw:0})` etc. — easier than seed-fishing).

## Constraints
- ONLY create: `world/ruleset/dsa5/ruleset.js`, `world/ruleset/dsa5/system.md`, `tools/test-dsa.mjs`.
- Do NOT modify `shared/checks.js` core, `server/`, or other tests. (You rely on `registerChecks`, which the
  parallel engine task adds; in your test, if `registerChecks` isn't importable yet, you may register by directly
  assigning into the imported `CHECK_DEFS` object as a fallback so your test is self-contained.)
- `shared/` purity rules apply to the bundle (no server/client imports).

## Verify before returning
`node --check world/ruleset/dsa5/ruleset.js && node tools/test-dsa.mjs`

## Return (compact)
- The DSA check return shape + a worked example (rolls, attrs, fw → success/QL).
- Pasted PASS line from test-dsa.
- Any assumption.
