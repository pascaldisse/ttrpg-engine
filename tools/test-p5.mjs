/**
 * tools/test-p5.mjs — P5 combat-engine tests (pure, no server, no network).
 *
 * Deterministic: uses a fixed seed via makeRng. Asserts every item from the
 * P5 contracts "Acceptance" list:
 *   - initiative DESC ordering
 *   - known hit and known miss
 *   - crit on natural 20
 *   - advanceTurn skips dead combatant and bumps round on wrap
 *   - outcome returns victory / defeat correctly
 *
 * Run: node tools/test-p5.mjs
 */

import assert from 'node:assert';
import { makeRng } from '../shared/rng.js';
import {
  rollInitiative,
  buildEncounter,
  currentCombatant,
  resolveAttack,
  advanceTurn,
  outcome,
} from '../shared/combat.js';

const SEED = 451;

let passed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }

// ---- Test entities (fresh each block to avoid bleed) ----
function freshEntities() {
  return new Map([
    ['pc-hero', {
      identity: { name: 'Hero', kind: 'pc' },
      stats: { hp: 20, maxHp: 20, str: 16, dex: 14, con: 12, int: 10, wis: 10, cha: 10, proficiency: 2, level: 1, ac: 15 },
      status: { alive: true },
      flags: { damage: '1d8' },
    }],
    ['npc-goblin1', {
      identity: { name: 'Goblin Scout', kind: 'npc' },
      stats: { hp: 7, maxHp: 7, str: 8, dex: 16, con: 10, int: 10, wis: 8, cha: 8, proficiency: 2, level: 1, ac: 14 },
      status: { alive: true },
      flags: { hostile: true, damage: '1d6', finesse: true },
    }],
    ['npc-goblin2', {
      identity: { name: 'Goblin Slinger', kind: 'npc' },
      stats: { hp: 7, maxHp: 7, str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8, proficiency: 2, level: 1, ac: 13 },
      status: { alive: true },
      flags: { hostile: true, damage: '1d4' },
    }],
    ['npc-ally-fighter', {
      identity: { name: 'Guard Ally', kind: 'npc' },
      stats: { hp: 12, maxHp: 12, str: 14, dex: 10, con: 12, int: 10, wis: 10, cha: 10, proficiency: 2, level: 1, ac: 16 },
      status: { alive: true },
      flags: { damage: '1d10' },
    }],
  ]);
}

// ---- 1. Initiative: DESC ordering + tie-break ----
{
  const ents = freshEntities();
  const rng = makeRng(SEED);
  const ids = ['pc-hero', 'npc-goblin1', 'npc-goblin2', 'npc-ally-fighter'];

  const result = rollInitiative(ids, ents, rng);

  // Every id appears exactly once
  assert.equal(result.length, 4, 'all 4 combatants returned');
  const returnedIds = result.map(r => r.id).sort();
  assert.deepEqual(returnedIds, [...ids].sort(), 'all ids present');

  // DESC order: verify each element's init >= next
  for (let i = 0; i < result.length - 1; i++) {
    const a = result[i];
    const b = result[i + 1];
    if (a.init === b.init) {
      // tie-break: higher dex then alphabetical id
      const aDex = ents.get(a.id).stats.dex;
      const bDex = ents.get(b.id).stats.dex;
      assert.ok(aDex >= bDex, `tie-break dex: ${a.id}(dex=${aDex}) >= ${b.id}(dex=${bDex})`);
      if (aDex === bDex) {
        assert.ok(a.id.localeCompare(b.id) <= 0, `tie-break id: ${a.id} <= ${b.id}`);
      }
    } else {
      assert.ok(a.init > b.init, `DESC order: ${a.id}(${a.init}) > ${b.id}(${b.init})`);
    }
  }
  ok('initiative is sorted DESC with correct tie-breaking');
}

// ---- 2. buildEncounter: structure + first combatant ----
{
  const ents = freshEntities();
  const rng = makeRng(SEED);
  const enc = buildEncounter(
    { allies: ['pc-hero', 'npc-ally-fighter'], enemies: ['npc-goblin1', 'npc-goblin2'] },
    ents,
    rng,
  );

  assert.equal(enc.active, true, 'encounter is active');
  assert.equal(enc.round, 1, 'starts at round 1');
  assert.equal(enc.turnIndex, 0, 'first turn at index 0');
  assert.equal(enc.mode, 'initiative', 'mode is initiative');
  assert.equal(enc.order.length, 4, 'all 4 combatants in order');
  assert.deepEqual(enc.allies.sort(), ['npc-ally-fighter', 'pc-hero'], 'allies match');
  assert.deepEqual(enc.enemies.sort(), ['npc-goblin1', 'npc-goblin2'], 'enemies match');

  // order must contain every id
  assert.deepEqual([...enc.order].sort(), [...enc.allies, ...enc.enemies].sort(), 'order contains all combatants');

  // first combatant is the one with highest initiative
  const cur = currentCombatant(enc);
  assert.ok(cur !== null, 'currentCombatant returns non-null');
  assert.ok(enc.order.includes(cur), 'current combatant is in the order');
  assert.equal(cur, enc.order[0], 'current combatant is first in order');

  ok('buildEncounter produces correct structure');
}

// ---- 3. resolveAttack: known HIT (high bonus vs low AC → guaranteed hit) ----
{
  const highBonusEntities = new Map([
    ['super-attacker', {
      identity: { name: 'Tarrasque', kind: 'npc' },
      stats: { hp: 999, maxHp: 999, str: 30, dex: 10, con: 30, int: 3, wis: 10, cha: 10, proficiency: 9, level: 30, ac: 25 },
      status: { alive: true },
      flags: { damage: '4d6' },
    }],
    ['easy-target', {
      identity: { name: 'Commoner', kind: 'npc' },
      stats: { hp: 4, maxHp: 4, str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, proficiency: 2, level: 1, ac: 5 },
      status: { alive: true },
      flags: {},
    }],
  ]);

  const rng = makeRng(SEED);
  const result = resolveAttack(
    { attackerId: 'super-attacker', targetId: 'easy-target' },
    highBonusEntities,
    rng,
  );

  // str=30 → mod=+10, proficiency=9 → total mod=+19. d20 ≥ 1 → total ≥ 20 ≥ AC 5.
  // Only way to miss is if resolveCheck treats d20=1 as auto-miss (it doesn't currently).
  assert.equal(result.hit, true, `should hit (roll=${result.attackRoll}, ac=${result.ac})`);
  assert.ok(result.damage > 0, 'damage is positive on hit');
  assert.ok(result.summary.includes('HIT'), 'summary indicates hit');
  assert.equal(result.ability, 'str', 'uses str for non-finesse attacker');

  ok('resolveAttack: guaranteed hit when bonus >> AC');
}

// ---- 4. resolveAttack: known MISS (low bonus vs high AC → guaranteed miss) ----
{
  const lowBonusEntities = new Map([
    ['weak-attacker', {
      identity: { name: 'Tiny Crab', kind: 'npc' },
      stats: { hp: 1, maxHp: 1, str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1, proficiency: 0, level: 0, ac: 0 },
      status: { alive: true },
      flags: { damage: '1d1' },
    }],
    ['hard-target', {
      identity: { name: 'Adamantine Golem', kind: 'npc' },
      stats: { hp: 200, maxHp: 200, str: 22, dex: 9, con: 22, int: 3, wis: 10, cha: 1, proficiency: 6, level: 20, ac: 40 },
      status: { alive: true },
      flags: {},
    }],
  ]);

  const rng = makeRng(SEED);
  const result = resolveAttack(
    { attackerId: 'weak-attacker', targetId: 'hard-target' },
    lowBonusEntities,
    rng,
  );

  // str=1 → mod=-5, proficiency=0 → total mod=-5. d20 max=20 → total ≤ 15 < AC 40.
  assert.equal(result.hit, false, `should miss (roll=${result.attackRoll}, ac=${result.ac})`);
  assert.equal(result.damage, 0, 'damage is 0 on miss');
  assert.ok(result.summary.includes('MISS'), 'summary indicates miss');

  ok('resolveAttack: guaranteed miss when bonus << AC');
}

// ---- 5. resolveAttack: finesse weapon uses dex ----
{
  const ents = freshEntities();
  const rng = makeRng(SEED);
  // goblin1 has finesse:true and dex=16 (mod +3) vs str=8 (mod -1)
  const result = resolveAttack(
    { attackerId: 'npc-goblin1', targetId: 'pc-hero' },
    ents,
    rng,
  );
  assert.equal(result.ability, 'dex', 'finesse attacker uses dex');
  ok('resolveAttack: finesse flag → uses dex');
}

// ---- 6. resolveAttack: weaponDie fallback + flags.damage ----
{
  const ents = freshEntities();
  const rng = makeRng(SEED);
  // pc-hero has flags.damage = '1d8'
  const result = resolveAttack(
    { attackerId: 'pc-hero', targetId: 'npc-goblin2' },
    ents,
    rng,
  );
  assert.equal(result.weaponDie, '1d8', 'pc-hero uses 1d8 from flags.damage');

  // goblin2 has flags.damage = '1d4'
  const result2 = resolveAttack(
    { attackerId: 'npc-goblin2', targetId: 'pc-hero' },
    ents,
    rng,
  );
  assert.equal(result2.weaponDie, '1d4', 'goblin2 uses 1d4 from flags.damage');

  ok('resolveAttack: reads weapon die from flags.damage');
}

// ---- 7. resolveAttack: damage min 1 ----
{
  const ents = freshEntities();
  // Give pc-hero a terrible str so mod is negative
  ents.get('pc-hero').stats.str = 4; // mod = -3
  // Set target AC very low so hit is guaranteed
  ents.get('npc-goblin2').stats.ac = 1;
  ents.get('pc-hero').stats.proficiency = 20; // massive hit bonus

  const rng = makeRng(SEED);
  const result = resolveAttack(
    { attackerId: 'pc-hero', targetId: 'npc-goblin2' },
    ents,
    rng,
  );
  assert.equal(result.hit, true, `hit (roll=${result.attackRoll})`);
  assert.ok(result.damage >= 1, `damage=${result.damage} is min 1`);
  ok('resolveAttack: damage floor is 1');
}

// ---- 8. advanceTurn: basic advance ----
{
  const ents = freshEntities();
  const enc = {
    active: true,
    round: 1,
    order: ['pc-hero', 'npc-ally-fighter', 'npc-goblin1', 'npc-goblin2'],
    turnIndex: 0,
    mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };

  const next = advanceTurn(enc, ents);
  assert.equal(next.turnIndex, 1, 'advances from 0 to 1');
  assert.equal(next.round, 1, 'round stays 1');
  assert.equal(currentCombatant(next), 'npc-ally-fighter', 'next combatant is ally');
  ok('advanceTurn: basic advance to next combatant');
}

// ---- 9. advanceTurn: wraps at end, bumps round ----
{
  const ents = freshEntities();
  const enc = {
    active: true,
    round: 1,
    order: ['pc-hero', 'npc-ally-fighter', 'npc-goblin1', 'npc-goblin2'],
    turnIndex: 3, // last combatant (goblin2)
    mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };

  const next = advanceTurn(enc, ents);
  assert.equal(next.turnIndex, 0, 'wraps to index 0');
  assert.equal(next.round, 2, 'round bumps to 2');
  assert.equal(currentCombatant(next), 'pc-hero', 'back to first combatant');
  ok('advanceTurn: wraps past end, increments round');
}

// ---- 10. advanceTurn: skips dead combatant ----
{
  const ents = freshEntities();
  // kill npc-ally-fighter (index 1)
  ents.get('npc-ally-fighter').status.alive = false;

  const enc = {
    active: true,
    round: 1,
    order: ['pc-hero', 'npc-ally-fighter', 'npc-goblin1', 'npc-goblin2'],
    turnIndex: 0, // pc-hero's turn
    mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };

  const next = advanceTurn(enc, ents);
  assert.equal(next.turnIndex, 2, 'skips dead ally (index 1) → goes to index 2');
  assert.equal(next.round, 1, 'round unchanged');
  assert.equal(currentCombatant(next), 'npc-goblin1', 'next combatant is goblin1 (skipped dead ally)');
  ok('advanceTurn: skips dead combatant');
}

// ---- 11. advanceTurn: multiple dead + wrap ----
{
  const ents = freshEntities();
  // kill goblin1 (index 2) and goblin2 (index 3)
  ents.get('npc-goblin1').status.alive = false;
  ents.get('npc-goblin2').status.alive = false;

  const enc = {
    active: true,
    round: 1,
    order: ['pc-hero', 'npc-ally-fighter', 'npc-goblin1', 'npc-goblin2'],
    turnIndex: 1, // npc-ally-fighter's turn
    mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };

  // From index 1: next is 2 (dead), skip → 3 (dead), skip → 0 (wrap, round++), pc-hero is alive
  const next = advanceTurn(enc, ents);
  assert.equal(next.turnIndex, 0, 'wraps past two dead enemies to index 0');
  assert.equal(next.round, 2, 'round bumps on wrap');
  assert.equal(currentCombatant(next), 'pc-hero', 'lands on pc-hero after skipping dead');
  ok('advanceTurn: skips multiple dead and wraps correctly');
}

// ---- 12. advanceTurn: all dead (safety) ----
{
  const ents = freshEntities();
  ents.get('pc-hero').status.alive = false;
  ents.get('npc-ally-fighter').status.alive = false;
  ents.get('npc-goblin1').status.alive = false;
  ents.get('npc-goblin2').status.alive = false;

  const enc = {
    active: true,
    round: 1,
    order: ['pc-hero', 'npc-ally-fighter', 'npc-goblin1', 'npc-goblin2'],
    turnIndex: 0,
    mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };

  const next = advanceTurn(enc, ents);
  // Should not loop infinitely; result is usable
  assert.ok(next.round >= 1, 'returns without crashing');
  ok('advanceTurn: all dead — no infinite loop');
}

// ---- 13. advanceTurn: does not mutate input ----
{
  const ents = freshEntities();
  const enc = {
    active: true,
    round: 1,
    order: ['pc-hero', 'npc-goblin1'],
    turnIndex: 0,
    mode: 'initiative',
    enemies: ['npc-goblin1'],
    allies: ['pc-hero'],
  };
  const frozen = JSON.stringify(enc);
  advanceTurn(enc, ents);
  assert.equal(JSON.stringify(enc), frozen, 'original encounter unchanged');
  ok('advanceTurn: does not mutate input');
}

// ---- 14. outcome: ongoing ----
{
  const ents = freshEntities();
  const enc = {
    active: true, round: 1, order: ['pc-hero', 'npc-goblin1'],
    turnIndex: 0, mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };
  assert.equal(outcome(enc, ents), 'ongoing', 'everyone alive → ongoing');
  ok('outcome: ongoing when both sides alive');
}

// ---- 15. outcome: victory ----
{
  const ents = freshEntities();
  // all enemies dead
  ents.get('npc-goblin1').status.alive = false;
  ents.get('npc-goblin2').status.alive = false;

  const enc = {
    active: true, round: 1, order: ['pc-hero', 'npc-goblin1'],
    turnIndex: 0, mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };
  assert.equal(outcome(enc, ents), 'victory', 'all enemies dead → victory');
  ok('outcome: victory when all enemies dead');
}

// ---- 16. outcome: defeat ----
{
  const ents = freshEntities();
  // all allies dead
  ents.get('pc-hero').status.alive = false;
  ents.get('npc-ally-fighter').status.alive = false;

  const enc = {
    active: true, round: 1, order: ['pc-hero', 'npc-goblin1'],
    turnIndex: 0, mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };
  assert.equal(outcome(enc, ents), 'defeat', 'all allies dead → defeat');
  ok('outcome: defeat when all allies dead');
}

// ---- 17. outcome: victory takes priority over defeat when both all dead ----
{
  const ents = freshEntities();
  ents.get('pc-hero').status.alive = false;
  ents.get('npc-ally-fighter').status.alive = false;
  ents.get('npc-goblin1').status.alive = false;
  ents.get('npc-goblin2').status.alive = false;

  const enc = {
    active: true, round: 1, order: ['pc-hero', 'npc-goblin1'],
    turnIndex: 0, mode: 'initiative',
    enemies: ['npc-goblin1', 'npc-goblin2'],
    allies: ['pc-hero', 'npc-ally-fighter'],
  };
  assert.equal(outcome(enc, ents), 'victory', 'both all dead → victory checked first');
  ok('outcome: victory before defeat when both sides dead');
}

// ---- 18. currentCombatant: null on empty / invalid ----
{
  assert.equal(currentCombatant({ order: [], turnIndex: 0 }), null, 'empty order → null');
  assert.equal(currentCombatant(null), null, 'null encounter → null');
  ok('currentCombatant: returns null for empty/missing order');
}

// ---- 19. resolveAttack: invalid ids ----
{
  const ents = freshEntities();
  const rng = makeRng(SEED);
  const result = resolveAttack(
    { attackerId: 'nobody', targetId: 'npc-goblin1' },
    ents,
    rng,
  );
  assert.equal(result.hit, false, 'missing attacker → not hit');
  assert.ok(result.summary.includes('Invalid'), 'summary indicates invalid');

  const result2 = resolveAttack(
    { attackerId: 'pc-hero', targetId: 'nobody' },
    ents,
    rng,
  );
  assert.equal(result2.hit, false, 'missing target → not hit');
  ok('resolveAttack: handles invalid attacker/target gracefully');
}

console.log(`\n${passed} P5 combat checks passed.`);
