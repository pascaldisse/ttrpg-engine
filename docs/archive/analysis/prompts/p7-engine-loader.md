# Pi task: P7 ruleset loader + registerChecks seam + srd5e bundle + test

FIRST read `analysis/prompts/p7-contracts.md` (binding spec), `world/ruleset/README.md`, `shared/checks.js`,
`shared/schema.js`, and skim `server/agents/dm-agent.js` (for the 5e prompt tone — DO NOT edit it).

## Do exactly this
1. `shared/checks.js`: add `export function registerChecks(defs)` that deep-merges `defs` into `CHECK_DEFS`
   (new kinds added; existing kinds field-merged), mirroring `registerComponents` in `shared/schema.js`. Pure,
   idempotent. Touch nothing else in checks.js.
2. `server/ruleset.js`: implement `export async function loadRuleset(id, worldDir)` exactly per the contracts
   (dynamic-import the bundle, call `registerComponents`/`registerChecks`, read `system.md`, return
   `{ meta, systemPrompt, components, checks }`; clear error if the bundle is missing). This is loader
   scaffolding only — do NOT wire it into index.js or dm-agent.js (Claude does the boot/integration).
3. `world/ruleset/srd5e/ruleset.js` + `world/ruleset/srd5e/system.md`: the 5e-as-data bundle per the contracts
   (meta, some `components`, `checks` that make a 5e check resolvable after load, and a 5e DM `system.md`).
4. `tools/test-p7.mjs` (mirror `tools/test-p6.mjs` style): `await loadRuleset('srd5e', <abs world dir>)`, then
   assert a 5e ability-check resolves correctly via `resolveCheck`, the returned `systemPrompt` is non-empty,
   and registration happened (e.g. a registered component/check is present).

## Constraints
- ONLY create/modify: `shared/checks.js`, `server/ruleset.js`, `world/ruleset/srd5e/ruleset.js`,
  `world/ruleset/srd5e/system.md`, `tools/test-p7.mjs`.
- Do NOT edit `server/index.js`, `server/agents/dm-agent.js`, or the core `resolveCheck`.
- `shared/` stays pure (no server/client imports). `server/ruleset.js` may use node `fs`/dynamic import.

## Verify before returning
`node --check shared/checks.js && node --check server/ruleset.js && node tools/test-p7.mjs && node tools/test-p6.mjs`
All must pass.

## Return (compact)
- Files created/changed; `loadRuleset` return shape; what srd5e registers.
- Pasted PASS lines from test-p7 and test-p6.
- Any assumption.
