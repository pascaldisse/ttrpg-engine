/**
 * tools/test-combat-c3.mjs — C3 enemy-agent logic (PURE, no server, no LLM).
 *
 * Definition-of-Done:
 *   - enemyInstinct fallback targets the lowest-HP opponent + picks a damage Move
 *   - morale flag is set below the threshold (and for the last one standing)
 *   - intent→ops mapping (flee/surrender/fight) produces the correct ops
 *   - determinism
 *
 * Run: node tools/test-combat-c3.mjs
 */

import assert from 'node:assert';
import { makeRng } from '../shared/rng.js';
import { enemyInstinct, moraleShaken, decisionToOps } from '../shared/combat.js';

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

const enc = {
  enemies: ['imp1', 'imp2'],
  allies: ['pc', 'ally'],
};

function ents(overrides = {}) {
  const base = new Map([
    ['imp1', { stats: { hp: 4, maxHp: 4, armor: 2 }, status: { alive: true }, moves: { list: [{ name: 'Claw', type: 'damage', damage: '1d3' }] } }],
    ['imp2', { stats: { hp: 4, maxHp: 4, armor: 2 }, status: { alive: true }, moves: { list: [] } }],
    ['pc', { stats: { hp: 10, maxHp: 28 }, status: { alive: true } }],
    ['ally', { stats: { hp: 3, maxHp: 12 }, status: { alive: true } }],
  ]);
  for (const [k, v] of Object.entries(overrides)) base.set(k, v);
  return base;
}

// ---- 1. enemyInstinct: lowest-HP opponent + a damage Move ----
{
  const e = ents();
  const { move, targetId } = enemyInstinct('imp1', enc, e, makeRng(1));
  assert.equal(targetId, 'ally', 'targets the lowest-HP opponent (ally hp 3 < pc hp 10)');
  assert.ok(move && move.name === 'Claw', 'uses its first damage Move');
  ok('enemyInstinct: targets lowest-HP opponent + picks a damage Move');
}

// ---- 2. enemyInstinct: no damage Move → null move (basic attack fallback) ----
{
  const e = ents();
  const { move, targetId } = enemyInstinct('imp2', enc, e, makeRng(1));
  assert.equal(move, null, 'imp2 has no Moves → null (engine falls back to basic attack)');
  assert.equal(targetId, 'ally', 'still targets the lowest-HP opponent');
  ok('enemyInstinct: no Move → null move, target still chosen');
}

// ---- 3. enemyInstinct: skips dead opponents ----
{
  const e = ents({ ally: { stats: { hp: 0, maxHp: 12 }, status: { alive: false } } });
  const { targetId } = enemyInstinct('imp1', enc, e, makeRng(1));
  assert.equal(targetId, 'pc', 'dead ally skipped → targets the PC');
  ok('enemyInstinct: skips dead opponents');
}

// ---- 4. weakness exploitation (optional rules.weaknesses) ----
{
  const e = ents({
    pc: { stats: { hp: 10, maxHp: 28 }, status: { alive: true }, flags: { tags: ['holy'] } },
  });
  const rules = { weaknesses: { holy: 2 } };
  const { targetId } = enemyInstinct('imp1', enc, e, makeRng(1), rules);
  assert.equal(targetId, 'pc', 'prioritizes the weakness-tagged opponent over lower HP');
  ok('enemyInstinct: exploits a weakness tag when present');
}

// ---- 5. moraleShaken ----
{
  assert.equal(moraleShaken({ stats: { hp: 1, maxHp: 4 } }, 0.34), true, 'hp 1/4 = 0.25 < 0.34 → shaken');
  assert.equal(moraleShaken({ stats: { hp: 3, maxHp: 4 } }, 0.34), false, 'hp 3/4 = 0.75 → steady');
  assert.equal(moraleShaken({ stats: { hp: 4, maxHp: 4 } }, 0.34, true), true, 'last one standing → shaken regardless of HP');
  ok('moraleShaken: threshold + last-standing');
}

// ---- 6. decisionToOps ----
{
  const fight = decisionToOps('imp1', 'fight');
  assert.deepEqual(fight, { ops: [], leaves: false }, 'fight → no ops, stays');

  for (const intent of ['flee', 'surrender', 'parley']) {
    const r = decisionToOps('imp1', intent);
    assert.equal(r.leaves, true, `${intent} → leaves the fight`);
    assert.ok(r.ops.some(o => o.op === 'setFlag' && o.key === 'hostile' && o.value === false), `${intent} → drops hostility`);
  }
  ok('decisionToOps: fight stays; flee/surrender/parley leave + drop hostility');
}

// ---- 7. determinism ----
{
  const a = enemyInstinct('imp1', enc, ents(), makeRng(7));
  const b = enemyInstinct('imp1', enc, ents(), makeRng(7));
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same inputs → identical instinct');
  ok('determinism: identical instinct for identical inputs');
}

console.log(`\n${passed} C3 enemy-agent checks passed.`);
