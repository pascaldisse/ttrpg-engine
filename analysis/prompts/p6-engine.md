# Pi task: P6 quest + progression engines (pure) + schema + unit test

FIRST read `analysis/prompts/p6-contracts.md` (binding spec) and skim `shared/space.js`,
`shared/checks.js`, `shared/schema.js`, and `tools/test-p5.mjs` to match style.

## Do exactly this
1. Edit `shared/schema.js`: add `quest.triggers`, `quest.rewards`, and `stats.xp` EXACTLY as the contracts
   specify. Touch nothing else.
2. Create `shared/quests.js` (PURE): `triggerMet(trigger, entities)` (the full trigger vocabulary) and
   `pendingAdvances(entities)`. Import `findPc`/`pcLocationId` from `./space.js`. No server/client imports;
   no mutation. Heavy JSDoc; note the extension seam (rulesets/campaigns add trigger types).
3. Create `shared/progression.js` (PURE): `XP_THRESHOLDS`, `levelForXp`, `proficiencyForLevel`, `applyXp` per
   the contracts. No mutation of inputs.
4. Create `tools/test-p6.mjs` (deterministic, mirrors `tools/test-p4.mjs`/`test-p5.mjs` structure) asserting
   every item in the contracts "Acceptance" list for the pure modules.

## Constraints
- ONLY create/modify: `shared/schema.js`, `shared/quests.js`, `shared/progression.js`, `tools/test-p6.mjs`.
- Do NOT touch `server/`, `client/`, `world/`, or other tests.

## Verify before returning
Run: `node --check shared/quests.js && node --check shared/progression.js && node tools/test-p6.mjs && node tools/test-p4.mjs && node tools/test-p5.mjs`
All must pass.

## Return (compact — no code dumps)
- Files changed/created.
- Exported function names + one-line behavior each.
- Pasted PASS lines from test-p6, test-p4, test-p5.
- Any assumption made.
