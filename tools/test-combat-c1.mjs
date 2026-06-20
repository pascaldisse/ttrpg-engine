/**
 * tools/test-combat-c1.mjs — C1 status engine + Move resolution (PURE, no server).
 *
 * Asserts the Definition-of-Done for C1:
 *   - status apply/tick/expire; bleed deals magnitude/turn then expires
 *   - stun sets skip
 *   - rage adds +2 dmg via aggregateModifiers
 *   - armor-aura raises the hit threshold (a 3 hits Armor 2 but misses Armor 2+aura)
 *   - resolveMove routes each type (damage/heal/buff/stun/utility) correctly
 *   - same seed ⇒ identical results
 *
 * Run: node tools/test-combat-c1.mjs
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeRng } from '../shared/rng.js';
import {
  registerStatuses, tickStatuses, aggregateModifiers, speedMultiplier, upsertStatus,
} from '../shared/statuses.js';
import { resolveMove } from '../shared/combat.js';
import { expandOp } from '../shared/effects.js';
import { applyOp } from '../shared/ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const SEED = 451;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

// Apply a (possibly semantic) op batch to an entities Map.
function applyAll(entities, ops) {
  const ref = { value: 0 };
  for (const op of ops) for (const c of expandOp(entities, op)) applyOp(entities, c, ref);
}

const rs = await import(pathToFileURL(path.join(root, 'campaigns/necrotopia/ruleset/necrotopia/ruleset.js')).href);
registerStatuses(rs.statuses);

// ---- 1. upsertStatus: add + refresh (no stacking of same kind+source) ----
{
  let list = upsertStatus([], { kind: 'bleed', magnitude: 2, remaining: 2, source: 'pc' });
  assert.equal(list.length, 1, 'one status added');
  list = upsertStatus(list, { kind: 'bleed', magnitude: 3, remaining: 5, source: 'pc' });
  assert.equal(list.length, 1, 'same kind+source refreshes, not stacks');
  assert.equal(list[0].magnitude, 3, 'refreshed magnitude');
  list = upsertStatus(list, { kind: 'rage', remaining: 2, source: 'pc' });
  assert.equal(list.length, 2, 'different kind appends');
  ok('upsertStatus: refresh same kind+source, append distinct');
}

// ---- 2. bleed ticks magnitude/turn then expires ----
{
  const ents = new Map([['imp', {
    stats: { hp: 10, maxHp: 10, armor: 2 }, status: { alive: true },
    statuses: { list: [{ kind: 'bleed', magnitude: 2, remaining: 2 }] },
  }]]);

  // turn 1: deals 2, remaining → 1
  let r = tickStatuses(ents, 'imp', makeRng(SEED));
  const dmg1 = r.ops.find(o => o.op === 'damage');
  assert.ok(dmg1 && dmg1.amount === 2, 'bleed deals magnitude (2) on tick');
  assert.equal(r.skip, false, 'bleed does not skip the turn');
  applyAll(ents, r.ops);
  assert.equal(ents.get('imp').stats.hp, 8, 'hp 10 → 8');
  assert.equal(ents.get('imp').statuses.list[0].remaining, 1, 'remaining decremented to 1');

  // turn 2: deals 2 again, then expires (list empty)
  r = tickStatuses(ents, 'imp', makeRng(SEED));
  applyAll(ents, r.ops);
  assert.equal(ents.get('imp').stats.hp, 6, 'hp 8 → 6');
  assert.equal(ents.get('imp').statuses.list.length, 0, 'bleed expired and dropped');

  // turn 3: nothing left → no ops, no roll consumed
  r = tickStatuses(ents, 'imp', makeRng(SEED));
  assert.equal(r.ops.length, 0, 'no statuses → no ops');
  ok('bleed: deals magnitude each turn then expires');
}

// ---- 3. stun sets skip ----
{
  const ents = new Map([['imp', {
    status: { alive: true }, statuses: { list: [{ kind: 'stun', remaining: 1 }] },
  }]]);
  const r = tickStatuses(ents, 'imp', makeRng(SEED));
  assert.equal(r.skip, true, 'stun reports skip=true');
  applyAll(ents, r.ops);
  assert.equal(ents.get('imp').statuses.list.length, 0, 'stun (remaining 1) expires after the skipped turn');
  ok('stun: sets skip and then expires');
}

// ---- 4. rage adds +2 dmg via aggregateModifiers ----
{
  const ents = new Map([
    ['pc', { stats: { level: 1 }, statuses: { list: [{ kind: 'rage', remaining: 2 }] } }],
    ['imp', { stats: { armor: 0 }, status: { alive: true } }],
  ]);
  const mods = aggregateModifiers(ents, 'pc', 'imp');
  assert.equal(mods.dmgDelta, 2, 'rage → dmgDelta +2');

  const move = { name: 'Slash', type: 'damage', damage: '1d6' };
  const withRage = resolveMove(move, { actorId: 'pc', targetId: 'imp' }, ents, { d: () => 3 }, rs.combat);
  const dmg = withRage.ops.find(o => o.op === 'damage');
  assert.equal(dmg.amount, 5, 'd6(3) + rage(+2) = 5 damage');

  // remove rage → 3 damage
  ents.get('pc').statuses.list = [];
  const noRage = resolveMove(move, { actorId: 'pc', targetId: 'imp' }, ents, { d: () => 3 }, rs.combat);
  assert.equal(noRage.ops.find(o => o.op === 'damage').amount, 3, 'no rage → 3 damage');
  ok('rage: aggregateModifiers adds +2 to Move damage');
}

// ---- 5. armor-aura raises the hit threshold ----
{
  const ents = new Map([
    ['pc', { stats: { level: 1 } }],
    ['imp', { stats: { armor: 2 }, status: { alive: true } }],
  ]);
  const move = { name: 'Slash', type: 'damage', damage: '1d6' };

  // d6 = 3 vs Armor 2 → HIT (3 > 2)
  const hit = resolveMove(move, { actorId: 'pc', targetId: 'imp' }, ents, { d: () => 3 }, rs.combat);
  assert.ok(hit.ops.some(o => o.op === 'damage'), 'roll 3 hits Armor 2');

  // apply armor-aura → effective Armor 3 → d6 = 3 now MISSES (3 > 3 is false)
  ents.get('imp').statuses = { list: [{ kind: 'armor-aura', remaining: 2 }] };
  assert.equal(aggregateModifiers(ents, 'pc', 'imp').armorDelta, 1, 'armor-aura → armorDelta +1');
  const miss = resolveMove(move, { actorId: 'pc', targetId: 'imp' }, ents, { d: () => 3 }, rs.combat);
  assert.equal(miss.ops.length, 0, 'roll 3 now misses Armor 2 + aura(1)');
  ok('armor-aura: raises the effective hit threshold');
}

// ---- 6. flawless-aim → autoHit ----
{
  const ents = new Map([
    ['pc', { stats: { level: 1 }, statuses: { list: [{ kind: 'flawless-aim', remaining: 2 }] } }],
    ['imp', { stats: { armor: 6 }, status: { alive: true } }],
  ]);
  assert.equal(aggregateModifiers(ents, 'pc', 'imp').autoHit, true, 'flawless-aim → autoHit');
  // Armor 6 is normally unhittable by a d6, but autoHit forces the hit.
  const r = resolveMove({ name: 'Slash', type: 'damage', damage: '1d6' }, { actorId: 'pc', targetId: 'imp' }, ents, { d: () => 1 }, rs.combat);
  assert.ok(r.ops.some(o => o.op === 'damage'), 'autoHit lands even vs Armor 6 on a low roll');
  ok('flawless-aim: autoHit bypasses the hit roll');
}

// ---- 7. resolveMove routes each type ----
{
  const ents = new Map([
    ['pc', { stats: { level: 1, hp: 5, maxHp: 28 } }],
    ['imp', { stats: { armor: 0 }, status: { alive: true } }],
  ]);
  const stub = { d: () => 3 };

  const dmg = resolveMove({ name: 'Slash', type: 'damage', damage: '1d6' }, { actorId: 'pc', targetId: 'imp' }, ents, stub, rs.combat);
  assert.ok(dmg.ops.some(o => o.op === 'damage') && dmg.statusOps.length === 0, 'damage → damage op');

  const heal = resolveMove({ name: 'Chi', type: 'heal', damage: '1d6' }, { actorId: 'pc', targetId: 'pc' }, ents, stub, rs.combat);
  assert.ok(heal.ops.some(o => o.op === 'heal' && o.id === 'pc'), 'heal → heal op on self');

  const buff = resolveMove({ name: 'Rage Roar', type: 'buff', status: 'rage', magnitude: 2, duration: 2 }, { actorId: 'pc', targetId: 'pc' }, ents, stub, rs.combat);
  assert.ok(buff.ops.length === 0 && buff.statusOps.some(o => o.op === 'applyStatus' && o.kind === 'rage'), 'buff → applyStatus(rage), no hit roll');

  const stun = resolveMove({ name: 'Choke', type: 'stun', duration: 2 }, { actorId: 'pc', targetId: 'imp' }, ents, stub, rs.combat);
  assert.ok(stun.statusOps.some(o => o.op === 'applyStatus' && o.kind === 'stun'), 'stun → applyStatus(stun) on hit');

  const bleed = resolveMove({ name: 'Fang', type: 'bleed', magnitude: 2, duration: 2 }, { actorId: 'pc', targetId: 'imp' }, ents, stub, rs.combat);
  assert.ok(bleed.statusOps.some(o => o.op === 'applyStatus' && o.kind === 'bleed' && o.magnitude === 2), 'bleed → applyStatus(bleed)');

  const util = resolveMove({ name: 'Hotwire', type: 'utility' }, { actorId: 'pc', targetId: 'imp' }, ents, stub, rs.combat);
  assert.ok(util.ops.length === 0 && util.statusOps.length === 0, 'utility → no mechanical ops');
  ok('resolveMove: routes damage/heal/buff/stun/bleed/utility');
}

// ---- 8. determinism: same seed ⇒ identical ----
{
  const mk = () => new Map([
    ['pc', { stats: { level: 2 } }],
    ['imp', { stats: { armor: 2 }, status: { alive: true } }],
  ]);
  const move = { name: 'Slash', type: 'damage', damage: '2d6' };
  const a = resolveMove(move, { actorId: 'pc', targetId: 'imp' }, mk(), makeRng(SEED), rs.combat);
  const b = resolveMove(move, { actorId: 'pc', targetId: 'imp' }, mk(), makeRng(SEED), rs.combat);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same seed → identical resolveMove result');
  ok('determinism: same seed ⇒ identical resolveMove');
}

// ---- 9. speedMultiplier neutral default (no haste/slow registered yet) ----
{
  const ents = new Map([['pc', { statuses: { list: [{ kind: 'rage', remaining: 2 }] } }]]);
  assert.equal(speedMultiplier(ents, 'pc'), 1, 'no modifySpeed status → ×1');
  ok('speedMultiplier: defaults to 1 (C2 will add haste/slow)');
}

console.log(`\n${passed} C1 combat checks passed.`);
