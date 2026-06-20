/**
 * tools/test-combat-c4.mjs — C4 zones & hazards (PURE, no server).
 *
 * Definition-of-Done:
 *   - range enforcement: a melee Move is blocked across zones, allowed in-zone
 *   - hazard tick damages only same-zone combatants
 *   - spawnHazard op expands + validates
 *   - ledge-shove resolves (zoneHasTag + ranged reach)
 *
 * Run: node tools/test-combat-c4.mjs
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerStatuses } from '../shared/statuses.js';
import { resolveMove, hazardOps, zoneHasTag, inRange, zoneOf } from '../shared/combat.js';
import { expandOp } from '../shared/effects.js';
import { validateOp } from '../shared/ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

const rs = await import(pathToFileURL(path.join(root, 'campaigns/necrotopia/ruleset/necrotopia/ruleset.js')).href);
registerStatuses(rs.statuses); // registers fire/oil

const stub = { d: () => 3 };

// ---- 1. melee range enforcement ----
{
  const ents = new Map([
    ['pc', { stats: { level: 1 }, position: { zoneId: 'aisle' } }],
    ['imp', { stats: { armor: 0 }, status: { alive: true }, position: { zoneId: 'altar' } }],
  ]);
  const melee = { name: 'Slash', type: 'damage', damage: '1d6' };

  const blocked = resolveMove(melee, { actorId: 'pc', targetId: 'imp' }, ents, stub, rs.combat);
  assert.equal(blocked.ops.length, 0, 'melee across zones deals no damage');
  assert.ok(/out of range/i.test(blocked.summary), 'summary reports out of range');

  // same zone → it lands
  ents.get('imp').position.zoneId = 'aisle';
  const lands = resolveMove(melee, { actorId: 'pc', targetId: 'imp' }, ents, stub, rs.combat);
  assert.ok(lands.ops.some(o => o.op === 'damage'), 'melee in the same zone lands');
  ok('range: melee blocked across zones, allowed in-zone');
}

// ---- 2. ranged Move reaches across zones ----
{
  const ents = new Map([
    ['pc', { stats: { level: 1 }, position: { zoneId: 'aisle' } }],
    ['imp', { stats: { armor: 0 }, status: { alive: true }, position: { zoneId: 'altar' } }],
  ]);
  const ranged = { name: 'Pistol', type: 'damage', range: 'ranged', damage: '1d6' };
  const r = resolveMove(ranged, { actorId: 'pc', targetId: 'imp' }, ents, stub, rs.combat);
  assert.ok(r.ops.some(o => o.op === 'damage'), 'ranged Move reaches another zone');
  assert.equal(inRange(ranged, 'pc', 'imp', ents), true, 'inRange: ranged true across zones');
  assert.equal(inRange({ type: 'damage' }, 'pc', 'imp', ents), false, 'inRange: melee false across zones');
  ok('range: ranged Moves reach across zones');
}

// ---- 3. hazard ticks only same-zone combatants ----
{
  const ents = new Map([
    ['a', { position: { zoneId: 'aisle' } }],
    ['b', { position: { zoneId: 'altar' } }],
  ]);
  const enc = { hazards: [{ zoneId: 'aisle', kind: 'fire', magnitude: 3, remaining: 2 }] };

  const ra = hazardOps(enc, 'a', ents);
  assert.ok(ra.ops.some(o => o.op === 'damage' && o.amount === 3), 'fire damages a combatant in its zone');
  assert.equal(ra.hits[0].kind, 'fire', 'reports the fire hit');

  const rb = hazardOps(enc, 'b', ents);
  assert.equal(rb.ops.length, 0, 'a combatant in another zone is untouched');

  // oil is inert (no onTick)
  const oilEnc = { hazards: [{ zoneId: 'aisle', kind: 'oil', magnitude: 0, remaining: 5 }] };
  assert.equal(hazardOps(oilEnc, 'a', ents).ops.length, 0, 'oil is inert until ignited');
  ok('hazard: fire ticks only same-zone combatants; oil is inert');
}

// ---- 4. spawnHazard op expands + validates ----
{
  const ents = new Map([['encounter', { encounter: { active: true, hazards: [] } }]]);
  const op = { op: 'spawnHazard', zoneId: 'aisle', kind: 'fire', magnitude: 3, remaining: 3 };
  assert.equal(validateOp(op).ok, true, 'spawnHazard validates');
  const expanded = expandOp(ents, op);
  assert.equal(expanded.length, 1, 'expands to one merge op');
  assert.equal(expanded[0].op, 'merge', 'merge op');
  assert.equal(expanded[0].value.hazards[0].kind, 'fire', 'hazard added to encounter.hazards');

  // clearHazard removes it
  const ents2 = new Map([['encounter', { encounter: { hazards: [{ zoneId: 'aisle', kind: 'fire', magnitude: 3, remaining: 3 }] } }]]);
  const cleared = expandOp(ents2, { op: 'clearHazard', zoneId: 'aisle', kind: 'fire' });
  assert.equal(cleared[0].value.hazards.length, 0, 'clearHazard removes the surface');
  ok('spawnHazard/clearHazard: expand + validate');
}

// ---- 5. ledge-shove resolves ----
{
  const enc = { zones: [{ id: 'edge', label: 'Edge', tags: ['ledge'] }, { id: 'aisle', label: 'Aisle', tags: [] }] };
  assert.equal(zoneHasTag(enc, 'edge', 'ledge'), true, 'edge is a ledge');
  assert.equal(zoneHasTag(enc, 'aisle', 'ledge'), false, 'aisle is not a ledge');

  const ents = new Map([['imp', { position: { zoneId: 'edge' } }]]);
  assert.equal(zoneOf(ents, 'imp'), 'edge', 'zoneOf reads position');
  // The lethal boost itself lives in the server improv path; the pure rule is the tag check.
  ok('ledge: zoneHasTag identifies a shove-off-the-edge opportunity');
}

// ---- 6. moveZone op ----
{
  const ents = new Map([['pc', { position: { zoneId: 'aisle' } }]]);
  const expanded = expandOp(ents, { op: 'moveZone', id: 'pc', zoneId: 'altar' });
  assert.equal(expanded[0].component, 'position', 'moveZone → position merge');
  assert.equal(expanded[0].value.zoneId, 'altar', 'sets the new zone');
  ok('moveZone: sets a combatant\'s zone');
}

console.log(`\n${passed} C4 zone/hazard checks passed.`);
