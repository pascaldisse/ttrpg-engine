/**
 * tools/test-dsa.mjs — DSA5 3d20 roll-under check tests.
 *
 * Proves the engine is rules-agnostic: DSA5 on the same CHECK_DEFS engine.
 * Mirrors tools/test-p6.mjs structure.
 *
 * Run: node tools/test-dsa.mjs
 */

import assert from 'node:assert';
import { CHECK_DEFS, resolveCheck } from '../shared/checks.js';
import { makeRng } from '../shared/rng.js';
import * as dsa5 from '../world/ruleset/dsa5/ruleset.js';

// ---- Register DSA5 checks into existing CHECK_DEFS (fallback for missing registerChecks) ----
Object.assign(CHECK_DEFS, dsa5.checks);

let passed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }

const def = CHECK_DEFS['dsa-skill'];

// =============================================================================
//  1. Well-formed result shape (via resolveCheck)
// =============================================================================
{
  const rng = makeRng(42);
  const result = resolveCheck(
    { check: 'dsa-skill', attrs: [14, 13, 12], fw: 6, mod: 0 },
    {},
    rng,
  );

  // All expected fields present with correct types
  assert.ok(Array.isArray(result.rolls), 'rolls is an array');
  assert.equal(result.rolls.length, 3, 'rolls has length 3');
  for (const r of result.rolls) {
    assert.ok(r >= 1 && r <= 20, `roll ${r} in 1–20`);
  }
  assert.equal(typeof result.success, 'boolean', 'success is boolean');
  assert.equal(typeof result.ql, 'number', 'ql is number');
  assert.ok(result.ql >= 0 && result.ql <= 6, `ql ${result.ql} in 0–6`);
  assert.equal(typeof result.crit, 'boolean', 'crit is boolean');
  assert.equal(typeof result.fumble, 'boolean', 'fumble is boolean');
  assert.equal(typeof result.spent, 'number', 'spent is number');
  assert.equal(typeof result.remaining, 'number', 'remaining is number');
  assert.equal(result.dc, undefined, 'dc is undefined');
  assert.equal(result.total, undefined, 'total is undefined');
  assert.equal(typeof result.summary, 'string', 'summary is string');
  assert.ok(result.summary.includes('3d20'), 'summary mentions 3d20');
  assert.equal(typeof result.outcome, 'string', 'outcome is string');

  ok('well-formed result shape');
}

// =============================================================================
//  2. Easy check succeeds with ql >= 1 (direct resolve)
// =============================================================================
{
  // High attributes (16,16,16), fw 6, low rolls (3,4,5) — all under target 16
  const r = def.resolve(
    [3, 4, 5], 0, 0, def,
    { attrs: [16, 16, 16], fw: 6, mod: 0 },
  );

  assert.equal(r.success, true, 'easy check succeeds');
  assert.ok(r.ql >= 1, `ql ${r.ql} >= 1`);
  // Shortfalls all 0 → spent=0, remaining=6 → ql = ceil(6/3) = 2
  assert.equal(r.spent, 0, 'spent is 0');
  assert.equal(r.remaining, 6, 'remaining is 6');
  assert.equal(r.ql, 2, 'ql is 2 (ceil(6/3))');
  assert.equal(r.crit, false, 'not a crit');
  assert.equal(r.fumble, false, 'not a fumble');
  assert.ok(r.outcome.startsWith('SUCCESS'), 'outcome starts with SUCCESS');

  ok('easy check (high attrs, fw 6, low rolls) succeeds with ql 2');
}

// =============================================================================
//  3. Hard check fails with ql === 0 (direct resolve)
// =============================================================================
{
  // Low attributes (8,8,8), fw 0, high rolls (19,18,17) — massive shortfalls
  const r = def.resolve(
    [19, 18, 17], 0, 0, def,
    { attrs: [8, 8, 8], fw: 0, mod: 0 },
  );

  assert.equal(r.success, false, 'hard check fails');
  assert.equal(r.ql, 0, 'ql is 0 on failure');
  // Shortfalls: 11,10,9 → spent=30, remaining = -30
  assert.equal(r.spent, 30, 'spent is 30');
  assert.equal(r.remaining, -30, 'remaining is -30');
  assert.equal(r.crit, false, 'not a crit');
  assert.equal(r.fumble, false, 'not a fumble');
  assert.equal(r.outcome, 'FAILURE', 'outcome is FAILURE');

  ok('hard check (fw 0, low attrs, high rolls) fails with ql 0');
}

// =============================================================================
//  4. crit === true when ≥2 ones (direct resolve)
// =============================================================================
{
  const r = def.resolve(
    [1, 1, 7], 0, 0, def,
    { attrs: [10, 10, 10], fw: 0, mod: 0 },
  );

  assert.equal(r.success, true, 'crit auto-succeeds');
  assert.ok(r.ql >= 1, 'crit has ql >= 1');
  assert.equal(r.crit, true, 'crit flag is true');
  assert.equal(r.fumble, false, 'not a fumble');
  assert.ok(r.outcome.startsWith('SUCCESS'), 'outcome is SUCCESS');

  ok('crit: >=2 ones → auto-success, crit=true');
}

// =============================================================================
//  5. fumble === true when ≥2 twenties → auto-fail, ql 0 (direct resolve)
// =============================================================================
{
  const r = def.resolve(
    [20, 20, 3], 0, 0, def,
    { attrs: [18, 18, 18], fw: 10, mod: 0 },
  );

  assert.equal(r.success, false, 'fumble auto-fails');
  assert.equal(r.ql, 0, 'fumble ql is 0');
  assert.equal(r.crit, false, 'not a crit');
  assert.equal(r.fumble, true, 'fumble flag is true');
  assert.equal(r.outcome, 'FAILURE', 'outcome is FAILURE');

  // Even with fw=10 and remaining would have been positive, fumble overrides
  ok('fumble: >=2 twenties → auto-fail, fumble=true, ql=0');
}

// =============================================================================
//  6. QL clamping: remaining 0 → QL 1 (boundary)
// =============================================================================
{
  // attrs 12,12,12; rolls [13,12,12] → shortfalls [1,0,0] = spent 1
  // fw=1 → remaining=0 → ql = ceil(0/3)=0 → clamped to 1
  const r = def.resolve(
    [13, 12, 12], 0, 0, def,
    { attrs: [12, 12, 12], fw: 1, mod: 0 },
  );

  assert.equal(r.success, true, 'barely succeeds');
  assert.equal(r.ql, 1, 'remaining 0 → QL 1');
  assert.equal(r.spent, 1, 'spent is 1');
  assert.equal(r.remaining, 0, 'remaining is 0');

  ok('QL clamping: remaining 0 → QL 1 (not 0)');
}

// =============================================================================
//  7. QL clamping: high remaining capped at 6
// =============================================================================
{
  // fw=21, all rolls under → remaining=21 → ceil(21/3)=7 → clamped to 6
  const r = def.resolve(
    [5, 5, 5], 0, 0, def,
    { attrs: [10, 10, 10], fw: 21, mod: 0 },
  );

  assert.equal(r.success, true);
  assert.equal(r.ql, 6, 'high remaining capped at QL 6');
  assert.equal(r.remaining, 21);

  ok('QL cap: very high remaining capped at QL 6');
}

// =============================================================================
//  8. mod (bonus) increases effective attribute targets
// =============================================================================
{
  // attrs 8,8,8 + mod 4 = effective targets 12,12,12
  // rolls [11,12,13] → shortfalls [0,0,1]=1, fw=2 → remaining=1 → ql=1
  const r = def.resolve(
    [11, 12, 13], 0, 0, def,
    { attrs: [8, 8, 8], fw: 2, mod: 4 },
  );

  assert.equal(r.success, true, 'mod makes check possible');
  assert.equal(r.ql, 1, 'ql 1 with mod help');
  assert.equal(r.spent, 1, 'spent is 1');
  assert.equal(r.remaining, 1, 'remaining is 1');

  ok('mod (bonus): +4 effective target turns near-failure into success');
}

// =============================================================================
//  9. meta is well-formed
// =============================================================================
{
  assert.equal(dsa5.meta.id, 'dsa5');
  assert.equal(dsa5.meta.name, 'Das Schwarze Auge 5');
  assert.equal(dsa5.meta.dice, '3d20');
  assert.ok(dsa5.meta.summary.includes('3d20'));
  ok('meta: correct id, name, dice, summary');
}

// =============================================================================
// 10. components.attributes registers 8 DSA attributes with defaults
// =============================================================================
{
  const attrs = dsa5.components.attributes;
  assert.ok(attrs.doc.includes('Eigenschaften'));
  assert.equal(Object.keys(attrs.default).length, 8, '8 attribute defaults');
  assert.equal(attrs.default.MU, 12);
  assert.equal(attrs.default.KK, 12);
  assert.ok(attrs.fields.MU.doc.includes('Mut'));
  assert.ok(attrs.fields.IN.doc.includes('Intuition'));
  assert.equal(attrs.fields.MU.range[0], 0);
  assert.equal(attrs.fields.MU.range[1], 20);
  ok('components.attributes: 8 DSA attrs with doc, defaults, and ranges');
}

console.log(`\n${passed} DSA5 checks passed.`);
