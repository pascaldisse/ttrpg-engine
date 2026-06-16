/**
 * tools/test-p6.mjs — P6 quests & progression pure-logic tests.
 *
 * Deterministic; mirrors test-p4.mjs / test-p5.mjs structure.
 * Asserts every item from the P6 contracts "Acceptance" list.
 *
 * Run: node tools/test-p6.mjs
 */

import assert from 'node:assert';
import { triggerMet, pendingAdvances } from '../shared/quests.js';
import {
  XP_THRESHOLDS,
  levelForXp,
  proficiencyForLevel,
  applyXp,
} from '../shared/progression.js';

let passed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }

// ---- Helpers ----

/** Fresh test world with PC + NPCs + flags. */
function freshWorld() {
  return new Map([
    ['world-state', {
      identity: { name: 'World State', kind: 'world-state' },
      flags: { metKing: true, ancientGateOpen: 'yes', goblinsRouted: false },
    }],
    ['pc-hero', {
      identity: { name: 'Hero', kind: 'pc' },
      place: { locationId: 'loc-tavern' },
      inventory: { items: [
        { id: 'item-torch', name: 'Wall Torch' },
        { id: 'item-key', name: 'Rusty Key' },
      ] },
      stats: { hp: 20, maxHp: 20, str: 16, dex: 14, con: 12, int: 10, wis: 10, cha: 10, proficiency: 2, level: 1, xp: 0 },
      status: { alive: true },
    }],
    ['npc-marta', {
      identity: { name: 'Marta', kind: 'npc' },
      place: { locationId: 'loc-tavern' },
      status: { alive: true },
    }],
    ['npc-goblin1', {
      identity: { name: 'Goblin Scout', kind: 'npc' },
      place: { locationId: 'loc-docks' },
      status: { alive: true },
    }],
    ['npc-goblin2', {
      identity: { name: 'Goblin Slinger', kind: 'npc' },
      place: { locationId: 'loc-docks' },
      status: { alive: false },
    }],
    ['loc-tavern', {
      identity: { name: 'Tavern', kind: 'location' },
      place: { connections: [] },
    }],
    ['loc-docks', {
      identity: { name: 'Docks', kind: 'location' },
      place: { connections: [] },
    }],
    ['loc-market', {
      identity: { name: 'Market', kind: 'location' },
      place: { connections: [] },
    }],
  ]);
}

// =============================================================================
//  TRIGGER VOCABULARY
// =============================================================================

// ---- 1. flag trigger: world-state flag deep-equals ----
{
  const ents = freshWorld();

  assert.equal(triggerMet(
    { type: 'flag', key: 'metKing', value: true },
    ents,
  ), true, 'flag: metKing is true');

  assert.equal(triggerMet(
    { type: 'flag', key: 'metKing', value: false },
    ents,
  ), false, 'flag: metKing is not false');

  assert.equal(triggerMet(
    { type: 'flag', key: 'ancientGateOpen', value: 'yes' },
    ents,
  ), true, 'flag: ancientGateOpen is "yes"');

  assert.equal(triggerMet(
    { type: 'flag', key: 'goblinsRouted', value: true },
    ents,
  ), false, 'flag: goblinsRouted is false, not true');

  // flag on a specific entity id
  assert.equal(triggerMet(
    { type: 'flag', id: 'npc-marta', key: 'nope', value: 1 },
    ents,
  ), false, 'flag: entity has no flags component');

  // missing key
  assert.equal(triggerMet(
    { type: 'flag', key: 'nonexistent', value: true },
    ents,
  ), false, 'flag: missing key → false');

  ok('flag trigger: deep-equals on world-state flags (true/false matches)');
}

// ---- 2. atLocation trigger ----
{
  const ents = freshWorld();

  assert.equal(triggerMet(
    { type: 'atLocation', id: 'loc-tavern' },
    ents,
  ), true, 'atLocation: PC is at loc-tavern');

  assert.equal(triggerMet(
    { type: 'atLocation', id: 'loc-docks' },
    ents,
  ), false, 'atLocation: PC is NOT at docks');

  assert.equal(triggerMet(
    { type: 'atLocation', id: 'loc-market' },
    ents,
  ), false, 'atLocation: PC is NOT at market');

  ok('atLocation trigger: true when PC location matches');
}

// ---- 3. hasItem trigger ----
{
  const ents = freshWorld();

  assert.equal(triggerMet(
    { type: 'hasItem', id: 'item-torch' },
    ents,
  ), true, 'hasItem: PC has torch');

  assert.equal(triggerMet(
    { type: 'hasItem', id: 'item-key' },
    ents,
  ), true, 'hasItem: PC has rusty key');

  assert.equal(triggerMet(
    { type: 'hasItem', id: 'item-sword' },
    ents,
  ), false, 'hasItem: PC does NOT have sword');

  // No PC at all
  {
    const noPc = new Map([['world-state', { identity: { kind: 'world-state' }, flags: {} }]]);
    assert.equal(triggerMet(
      { type: 'hasItem', id: 'item-torch' },
      noPc,
    ), false, 'hasItem: no PC → false');
  }

  ok('hasItem trigger: checks PC inventory by item id');
}

// ---- 4. dead trigger ----
{
  const ents = freshWorld();

  assert.equal(triggerMet(
    { type: 'dead', id: 'npc-goblin2' },
    ents,
  ), true, 'dead: goblin2 is dead (alive=false)');

  assert.equal(triggerMet(
    { type: 'dead', id: 'npc-goblin1' },
    ents,
  ), false, 'dead: goblin1 is alive');

  assert.equal(triggerMet(
    { type: 'dead', id: 'nonexistent' },
    ents,
  ), true, 'dead: absent entity is dead');

  ok('dead trigger: alive=false or absent → true; alive → false');
}

// ---- 5. allDead trigger ----
{
  const ents = freshWorld();

  assert.equal(triggerMet(
    { type: 'allDead', ids: ['npc-goblin2'] },
    ents,
  ), true, 'allDead: single dead goblin');

  assert.equal(triggerMet(
    { type: 'allDead', ids: ['npc-goblin1', 'npc-goblin2'] },
    ents,
  ), false, 'allDead: goblin1 still alive');

  // Kill goblin1
  ents.get('npc-goblin1').status.alive = false;
  assert.equal(triggerMet(
    { type: 'allDead', ids: ['npc-goblin1', 'npc-goblin2'] },
    ents,
  ), true, 'allDead: both goblins now dead');

  // Empty ids array
  assert.equal(triggerMet(
    { type: 'allDead', ids: [] },
    ents,
  ), false, 'allDead: empty ids → false');

  ok('allDead trigger: all ids dead → true, any alive → false');
}

// ---- 6. unknown trigger type → false ----
{
  const ents = freshWorld();
  assert.equal(triggerMet(null, ents), false, 'null trigger → false');
  assert.equal(triggerMet({}, ents), false, 'empty trigger → false');
  assert.equal(triggerMet({ type: 'nonexistent' }, ents), false, 'unknown type → false');
  assert.equal(triggerMet({ type: 'atLocation', id: 'loc-tavern' }, null), false, 'null entities → false (atLocation)');
  ok('unknown/missing trigger type → false');
}

// =============================================================================
//  pendingAdvances
// =============================================================================

// ---- 7. pendingAdvances: simple advance ----
{
  const ents = freshWorld();
  // Add an active quest: reach the docks → step 0 trigger is atLocation loc-docks
  ents.set('quest-1', {
    identity: { name: 'Find the Docks', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Reach the docks', 'Talk to Jonas'],
      currentStep: 0,
      triggers: [
        { type: 'atLocation', id: 'loc-docks' },   // step 0 → 1
        null,                                       // step 1 → manual
      ],
      rewards: { xp: 50, items: [{ id: 'item-medal', name: 'Medal' }] },
    },
  });

  // PC is at tavern, not docks → no advance
  let adv = pendingAdvances(ents);
  assert.equal(adv.length, 0, 'no advance when trigger not met');

  // Move PC to docks
  ents.get('pc-hero').place.locationId = 'loc-docks';
  adv = pendingAdvances(ents);
  assert.equal(adv.length, 1, 'one advance pending');
  assert.equal(adv[0].questId, 'quest-1');
  assert.equal(adv[0].fromStep, 0);
  assert.equal(adv[0].toStep, 1);
  assert.equal(adv[0].completes, false);
  assert.equal(adv[0].rewards, undefined);

  ok('pendingAdvances: detects advance when trigger is met');
}

// ---- 8. pendingAdvances: completion ----
{
  const ents = freshWorld();
  ents.get('pc-hero').place.locationId = 'loc-docks';

  ents.set('quest-2', {
    identity: { name: 'Short Quest', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Only step'],
      currentStep: 0,
      triggers: [
        { type: 'atLocation', id: 'loc-docks' },
      ],
      rewards: { xp: 100, items: [{ id: 'item-ring', name: 'Ring' }] },
    },
  });

  const adv = pendingAdvances(ents);
  assert.equal(adv.length, 1);
  assert.equal(adv[0].questId, 'quest-2');
  assert.equal(adv[0].fromStep, 0);
  assert.equal(adv[0].toStep, 1);
  assert.equal(adv[0].completes, true);
  assert.deepEqual(adv[0].rewards, { xp: 100, items: [{ id: 'item-ring', name: 'Ring' }] });

  ok('pendingAdvances: completes when toStep >= steps.length, includes rewards');
}

// ---- 9. pendingAdvances: ignores non-active quests ----
{
  const ents = freshWorld();
  ents.set('quest-available', {
    identity: { name: 'Available Quest', kind: 'quest' },
    quest: {
      phase: 'available',
      steps: ['Step 1'],
      currentStep: 0,
      triggers: [{ type: 'atLocation', id: 'loc-tavern' }],
      rewards: { xp: 10, items: [] },
    },
  });
  ents.set('quest-completed', {
    identity: { name: 'Completed Quest', kind: 'quest' },
    quest: {
      phase: 'completed',
      steps: ['Step 1'],
      currentStep: 0,
      triggers: [{ type: 'atLocation', id: 'loc-tavern' }],
      rewards: { xp: 10, items: [] },
    },
  });
  ents.set('quest-failed', {
    identity: { name: 'Failed Quest', kind: 'quest' },
    quest: {
      phase: 'failed',
      steps: ['Step 1'],
      currentStep: 0,
      triggers: [{ type: 'atLocation', id: 'loc-tavern' }],
      rewards: { xp: 10, items: [] },
    },
  });

  const adv = pendingAdvances(ents);
  assert.equal(adv.length, 0, 'only active quests produce advances');
  ok('pendingAdvances: only considers active quests');
}

// ---- 10. pendingAdvances: null trigger → skip ----
{
  const ents = freshWorld();
  ents.set('quest-null-trigger', {
    identity: { name: 'Manual Quest', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Step 1', 'Step 2'],
      currentStep: 0,
      triggers: [null],  // null = manual/never
      rewards: { xp: 0, items: [] },
    },
  });

  const adv = pendingAdvances(ents);
  assert.equal(adv.length, 0, 'null trigger at current step → no advance');
  ok('pendingAdvances: null trigger → no advance (manual/never quests)');
}

// ---- 11. pendingAdvances: missing triggers array → no advance ----
{
  const ents = freshWorld();
  ents.set('quest-no-triggers', {
    identity: { name: 'No Triggers', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Step 1'],
      currentStep: 0,
      // no triggers field
      rewards: { xp: 0, items: [] },
    },
  });

  const adv = pendingAdvances(ents);
  assert.equal(adv.length, 0, 'missing triggers → no advance');
  ok('pendingAdvances: missing triggers field → no advance');
}

// ---- 12. pendingAdvances: flag-based advance ----
{
  const ents = freshWorld();
  ents.set('quest-flag', {
    identity: { name: 'Flag Quest', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Meet the king', 'Do something'],
      currentStep: 0,
      triggers: [
        { type: 'flag', key: 'metKing', value: true },
        null,
      ],
      rewards: { xp: 75, items: [] },
    },
  });

  const adv = pendingAdvances(ents);
  assert.equal(adv.length, 1, 'flag trigger met → advance');
  assert.equal(adv[0].questId, 'quest-flag');
  assert.equal(adv[0].fromStep, 0);
  assert.equal(adv[0].toStep, 1);
  ok('pendingAdvances: flag-based step advance');
}

// ---- 13. pendingAdvances: dead trigger advance ----
{
  const ents = freshWorld();
  ents.set('quest-kill', {
    identity: { name: 'Kill Quest', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Kill goblin2'],
      currentStep: 0,
      triggers: [
        { type: 'dead', id: 'npc-goblin2' },
      ],
      rewards: { xp: 200, items: [] },
    },
  });

  const adv = pendingAdvances(ents);
  assert.equal(adv.length, 1, 'dead trigger: goblin2 already dead → advances');
  assert.equal(adv[0].completes, true);
  ok('pendingAdvances: dead trigger detects already-dead enemy');
}

// ---- 14. pendingAdvances: multiple quests, mixed state ----
{
  const ents = freshWorld();
  ents.get('pc-hero').place.locationId = 'loc-docks'; // satisfy atLocation for docks

  ents.set('quest-a', {
    identity: { name: 'Quest A', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Reach docks'],
      currentStep: 0,
      triggers: [{ type: 'atLocation', id: 'loc-docks' }],
      rewards: { xp: 30, items: [] },
    },
  });
  ents.set('quest-b', {
    identity: { name: 'Quest B', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Reach market'],
      currentStep: 0,
      triggers: [{ type: 'atLocation', id: 'loc-market' }],
      rewards: { xp: 40, items: [] },
    },
  });
  ents.set('quest-c', {
    identity: { name: 'Quest C', kind: 'quest' },
    quest: {
      phase: 'completed',
      steps: ['Done'],
      currentStep: 1,
      triggers: [null],
      rewards: { xp: 0, items: [] },
    },
  });

  const adv = pendingAdvances(ents);
  assert.equal(adv.length, 1, 'only quest-a trigger met');
  assert.equal(adv[0].questId, 'quest-a');
  ok('pendingAdvances: multiple quests, only matching ones advance');
}

// =============================================================================
//  PROGRESSION: XP_THRESHOLDS
// =============================================================================

// ---- 15. XP_THRESHOLDS shape ----
{
  assert.equal(XP_THRESHOLDS.length, 10, '10 thresholds for levels 1-10');
  assert.deepEqual(XP_THRESHOLDS[0], 0, 'L1 starts at 0');
  assert.deepEqual(XP_THRESHOLDS[1], 300, 'L2 starts at 300');
  assert.deepEqual(XP_THRESHOLDS[2], 900, 'L3 starts at 900');
  assert.deepEqual(XP_THRESHOLDS[3], 2700, 'L4 starts at 2700');
  assert.deepEqual(XP_THRESHOLDS[4], 6500, 'L5 starts at 6500');
  assert.deepEqual(XP_THRESHOLDS[9], 64000, 'L10 starts at 64000');
  ok('XP_THRESHOLDS: correct 5e values for levels 1-10');
}

// =============================================================================
//  levelForXp
// =============================================================================

// ---- 16. levelForXp boundaries ----
{
  assert.equal(levelForXp(0), 1, '0 xp → L1');
  assert.equal(levelForXp(299), 1, '299 xp → L1 (below L2 threshold)');
  assert.equal(levelForXp(300), 2, '300 xp → L2');
  assert.equal(levelForXp(899), 2, '899 xp → L2');
  assert.equal(levelForXp(900), 3, '900 xp → L3');
  assert.equal(levelForXp(2699), 3, '2699 xp → L3');
  assert.equal(levelForXp(2700), 4, '2700 xp → L4');
  assert.equal(levelForXp(64000), 10, '64000 xp → L10');
  assert.equal(levelForXp(999999), 10, 'way above threshold → L10 (clamped)');
  ok('levelForXp: correct level boundaries');
}

// =============================================================================
//  proficiencyForLevel
// =============================================================================

// ---- 17. proficiencyForLevel ----
{
  assert.equal(proficiencyForLevel(1), 2);
  assert.equal(proficiencyForLevel(4), 2);
  assert.equal(proficiencyForLevel(5), 3);
  assert.equal(proficiencyForLevel(8), 3);
  assert.equal(proficiencyForLevel(9), 4);
  assert.equal(proficiencyForLevel(20), 6); // L17-20 → +6
  ok('proficiencyForLevel: 5e formula: 2 + floor((lvl-1)/4)');
}

// =============================================================================
//  applyXp
// =============================================================================

// ---- 18. applyXp: simple xp gain, no level-up ----
{
  const stats = { hp: 20, maxHp: 20, con: 12, proficiency: 2, level: 1, xp: 0 };
  const result = applyXp(stats, 100);

  assert.equal(result.gained, 100);
  assert.equal(result.leveledUp, false);
  assert.equal(result.fromLevel, 1);
  assert.equal(result.toLevel, 1);
  assert.equal(result.stats.xp, 100);
  assert.equal(result.stats.level, 1);
  assert.equal(result.stats.hp, 20);       // unchanged
  assert.equal(result.stats.maxHp, 20);     // unchanged
  assert.equal(result.stats.proficiency, 2); // unchanged
  // Original not mutated
  assert.equal(stats.xp, 0, 'original stats not mutated');
  ok('applyXp: xp goes up, no level change below threshold');
}

// ---- 19. applyXp: level up (L1 → L2 at 300 xp) ----
{
  const stats = { hp: 10, maxHp: 10, con: 14, proficiency: 2, level: 1, xp: 200 };
  // con=14 → conMod = +2. hp gain per level = 5+2 = 7.
  const result = applyXp(stats, 100); // 200+100=300 → L2

  assert.equal(result.leveledUp, true);
  assert.equal(result.fromLevel, 1);
  assert.equal(result.toLevel, 2);
  assert.equal(result.stats.xp, 300);
  assert.equal(result.stats.level, 2);
  assert.equal(result.stats.proficiency, 2); // L2 proficiency is still 2
  assert.equal(result.stats.maxHp, 17);      // 10 + 7*1 = 17
  assert.equal(result.stats.hp, 17);          // full heal to maxHp
  ok('applyXp: L1→L2: proficiency stays 2, maxHp +7, full heal');
}

// ---- 20. applyXp: multi-level jump ----
{
  const stats = { hp: 8, maxHp: 8, con: 10, proficiency: 2, level: 1, xp: 0 };
  // con=10 → conMod = 0. hp gain per level = 5+0 = 5.
  const result = applyXp(stats, 1000); // 0+1000=1000 → L3 threshold is 900

  assert.equal(result.leveledUp, true);
  assert.equal(result.fromLevel, 1);
  assert.equal(result.toLevel, 3);
  assert.equal(result.stats.level, 3);
  assert.equal(result.stats.proficiency, 2); // L3 proficiency still 2
  assert.equal(result.stats.maxHp, 18);      // 8 + 5*2 = 18
  assert.equal(result.stats.hp, 18);          // full heal
  ok('applyXp: multi-level jump L1→L3: maxHp +10, full heal');
}

// ---- 21. applyXp: proficiency bumps at L5 ----
{
  const stats = { hp: 40, maxHp: 40, con: 16, proficiency: 2, level: 4, xp: 2700 };
  // con=16 → conMod = +3. hp gain per level = 5+3 = 8.
  const result = applyXp(stats, 10000); // 2700+10000=12700 → L6 (threshold 14000? no, 12700 >= 6500 → L5, 12700 < 14000 → L5)

  // Actually: 2700+10000=12700. Level thresholds: L4=2700, L5=6500, L6=14000.
  // 12700 >= 6500 → at least L5. 12700 < 14000 → L5.
  assert.equal(result.toLevel, 5);
  assert.equal(result.stats.proficiency, 3); // L5 proficiency is 3
  assert.equal(result.stats.maxHp, 48);      // 40 + 8*1 = 48
  assert.equal(result.stats.hp, 48);         // full heal
  ok('applyXp: L4→L5: proficiency bumps to 3, maxHp +8');
}

// ---- 22. applyXp: does not mutate input stats ----
{
  const stats = { hp: 15, maxHp: 15, con: 10, proficiency: 2, level: 1, xp: 100 };
  const frozen = JSON.stringify(stats);
  applyXp(stats, 500);
  assert.equal(JSON.stringify(stats), frozen, 'input stats unchanged');
  ok('applyXp: does not mutate input');
}

// ---- 23. applyXp: missing xp defaults to 0 ----
{
  const stats = { hp: 20, maxHp: 20, con: 12, proficiency: 2, level: 1 };
  // xp is missing
  const result = applyXp(stats, 50);
  assert.equal(result.stats.xp, 50, 'xp defaults to 0 when missing');
  ok('applyXp: missing xp field treated as 0');
}

// ---- 24. applyXp: con below 10 gives negative mod, hp gain min ----
{
  const stats = { hp: 5, maxHp: 5, con: 4, proficiency: 2, level: 1, xp: 0 };
  // con=4 → conMod = (4-10)/2 = -3. hpGain = 5 + (-3) = 2.
  const result = applyXp(stats, 1000); // → L3
  assert.equal(result.toLevel, 3);
  assert.equal(result.stats.maxHp, 9); // 5 + 2*2 = 9
  assert.equal(result.stats.hp, 9);
  ok('applyXp: negative con mod still produces hp gain (min 2 per level)');
}

// =============================================================================
//  PROGRESSION: applyXp edge cases
// =============================================================================

// ---- 25. applyXp: zero xp gain ----
{
  const stats = { hp: 20, maxHp: 20, con: 14, proficiency: 2, level: 1, xp: 0 };
  const result = applyXp(stats, 0);
  assert.equal(result.gained, 0);
  assert.equal(result.leveledUp, false);
  assert.deepEqual(result.stats, { ...stats, xp: 0 });
  ok('applyXp: zero xp gain is a no-op');
}

// ---- 26. applyXp: level 10 cap ----
{
  const stats = { hp: 100, maxHp: 100, con: 14, proficiency: 4, level: 10, xp: 64000 };
  const result = applyXp(stats, 100000);
  assert.equal(result.toLevel, 10);
  assert.equal(result.stats.level, 10);
  assert.equal(result.stats.proficiency, 4); // L10 proficiency is 4
  ok('applyXp: stays at level 10 cap');
}

// ---- 27. pendingAdvances does not mutate entities ----
{
  const ents = freshWorld();
  ents.set('quest-mut-check', {
    identity: { name: 'Mutation Check', kind: 'quest' },
    quest: {
      phase: 'active',
      steps: ['Reach docks'],
      currentStep: 0,
      triggers: [{ type: 'atLocation', id: 'loc-docks' }],
      rewards: { xp: 0, items: [] },
    },
  });
  
  const frozenStep = ents.get('quest-mut-check').quest.currentStep;
  pendingAdvances(ents);
  assert.equal(ents.get('quest-mut-check').quest.currentStep, frozenStep, 'currentStep not mutated');
  ok('pendingAdvances: does not mutate quest state');
}

console.log(`\n${passed} P6 checks passed.`);
