/**
 * tools/test-p7.mjs — P7 ruleset loader + registerChecks seam + srd5e bundle tests.
 *
 * Deterministic; mirrors test-p6.mjs style.
 * Run: node tools/test-p7.mjs
 */

import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRuleset } from '../server/ruleset.js';
import { resolveCheck, CHECK_DEFS } from '../shared/checks.js';
import { SCHEMA } from '../shared/schema.js';
import { makeRng } from '../shared/rng.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldDir = resolve(__dirname, '..', 'world');

let passed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }

// ---- 1. loadRuleset returns correct shape ----
{
  const loaded = await loadRuleset('srd5e', worldDir);

  assert.ok(loaded.meta, 'meta is present');
  assert.equal(loaded.meta.id, 'srd5e', 'meta.id is srd5e');
  assert.equal(loaded.meta.dice, 'd20', 'meta.dice is d20');
  assert.ok(typeof loaded.meta.name === 'string', 'meta.name is string');
  assert.ok(typeof loaded.meta.summary === 'string', 'meta.summary is string');

  assert.ok(typeof loaded.systemPrompt === 'string' && loaded.systemPrompt.length > 0,
    'systemPrompt is non-empty string');
  assert.ok(loaded.systemPrompt.includes('Dungeon Master'),
    'systemPrompt contains 5e DM voice');

  assert.ok(typeof loaded.components === 'object', 'components is object');
  assert.ok(typeof loaded.checks === 'object', 'checks is object');

  ok('loadRuleset returns correct shape: meta, systemPrompt, components, checks');
}

// ---- 2. Schema registration: components landed ----
{
  // Reload to guarantee fresh registration
  await loadRuleset('srd5e', worldDir);

  assert.ok(SCHEMA.skills, 'SCHEMA.skills registered');
  assert.equal(SCHEMA.skills.doc, 'D&D 5e skill proficiencies. Boolean flags; the resolver looks for matching skill + proficiency bonus.',
    'skills doc matches');
  assert.ok(SCHEMA.skills.default.acrobatics === false, 'skills default has acrobatics');
  assert.ok(SCHEMA.skills.default.stealth === false, 'skills default has stealth');
  assert.ok(SCHEMA.skills.fields.perception, 'skills.fields.perception exists');

  assert.ok(SCHEMA.conditions, 'SCHEMA.conditions registered');
  assert.equal(SCHEMA.conditions.doc, 'D&D 5e conditions. Active conditions that affect gameplay.',
    'conditions doc matches');

  ok('registration: srd5e components (skills, conditions) in SCHEMA');
}

// ---- 3. Check resolution after srd5e load ----
{
  await loadRuleset('srd5e', worldDir);

  // ability-check should still work (built-in, not overridden by srd5e checks={})
  const rng = makeRng(42);
  const ctx = { stats: { wis: 14 }, proficiency: 2 };
  const result = resolveCheck(
    { check: 'ability-check', ability: 'wis', dc: 12 },
    ctx,
    rng,
  );

  assert.ok(result.rolls && result.rolls.length === 1, 'rolls has 1 d20');
  assert.ok(result.rolls[0] >= 1 && result.rolls[0] <= 20, 'd20 in range');
  assert.equal(result.dc, 12, 'dc is 12');
  assert.ok(typeof result.success === 'boolean', 'success is boolean');
  assert.ok(typeof result.margin === 'number', 'margin is number');
  assert.ok(typeof result.crit === 'boolean', 'crit is boolean');
  assert.ok(typeof result.fumble === 'boolean', 'fumble is boolean');
  assert.ok(typeof result.outcome === 'string', 'outcome is string');
  assert.ok(typeof result.summary === 'string', 'summary is string');
  // modifier: wis=14 → +2 mod; proficiency only added when skill is named
  assert.equal(result.modifier, 2, 'modifier = wisMod(14→+2) = 2 (no skill → no prof)');
  assert.equal(result.total, result.rolls[0] + 2, 'total = d20 + modifier');

  ok('5e ability-check resolves correctly after srd5e load');

  // With a named skill, proficiency IS added
  const rng2 = makeRng(99);
  const result2 = resolveCheck(
    { check: 'ability-check', ability: 'dex', skill: 'stealth', dc: 15 },
    { stats: { dex: 16 }, proficiency: 3 },
    rng2,
  );
  assert.equal(result2.modifier, 6, 'modifier = dexMod(16→+3) + prof(3) = 6');
  assert.equal(result2.total, result2.rolls[0] + 6, 'total = d20 + modifier');
  ok('5e ability-check: proficiency added when skill is named');
}

// ---- 4. CHECK_DEFS still has built-in kinds ----
{
  await loadRuleset('srd5e', worldDir);

  assert.ok(CHECK_DEFS['ability-check'], 'ability-check still defined');
  assert.ok(CHECK_DEFS['attack'], 'attack still defined');
  assert.ok(CHECK_DEFS['saving-throw'], 'saving-throw still defined');
  ok('built-in check kinds preserved after srd5e load');
}

// ---- 5. registerChecks: new kind added, existing kind merged ----
{
  // Test registerChecks directly for merge semantics
  // Must import fresh — but we're in same module. Use the imported function.
  const { registerChecks } = await import('../shared/checks.js');

  // Save original ability-check for restore
  const origAbilityCheck = { ...CHECK_DEFS['ability-check'] };

  // Add a new custom kind
  registerChecks({
    'custom-test': {
      doc: 'A test check.',
      dice: { count: 2, sides: 6 },
      comparator: 'ge',
      modSource: () => 0,
      resolve: () => ({ success: true }),
    },
  });
  assert.ok(CHECK_DEFS['custom-test'], 'new kind custom-test added');
  assert.equal(CHECK_DEFS['custom-test'].dice.count, 2, 'custom-test dice count = 2');

  // Merge into existing: override doc, keep other fields
  registerChecks({
    'ability-check': {
      doc: 'OVERRIDDEN doc',
    },
  });
  assert.equal(CHECK_DEFS['ability-check'].doc, 'OVERRIDDEN doc',
    'existing kind doc overridden');
  assert.equal(CHECK_DEFS['ability-check'].dice.count, 1,
    'existing kind dice.count preserved');

  // Restore original
  registerChecks({ 'ability-check': origAbilityCheck });
  // Clean up custom-test
  delete CHECK_DEFS['custom-test'];

  ok('registerChecks: new kinds added, existing kinds field-merged');
}

// ---- 6. loadRuleset throws on missing ruleset ----
{
  let threw = false;
  try {
    await loadRuleset('nonexistent-ruleset-999', worldDir);
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes('not found'),
      'error message says not found');
    assert.ok(err.message.includes('nonexistent-ruleset-999'),
      'error message includes ruleset id');
  }
  assert.ok(threw, 'loadRuleset throws on missing bundle');
  ok('loadRuleset throws clear error on missing ruleset');
}

console.log(`\n${passed} P7 checks passed.`);
