/**
 * tools/test-p8.mjs — P8 world generation + validation tests.
 *
 * Deterministic; mirrors test-p6.mjs / test-p7.mjs style.
 * Run: node tools/test-p8.mjs
 */

import assert from 'node:assert';
import { makeRng } from '../shared/rng.js';
import { generateSkeleton } from '../shared/worldgen.js';
import { validateWorld } from '../shared/worldcheck.js';

let passed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }

// ---- 1. Determinism: same seed ⇒ equal JSON ----
{
  const a = generateSkeleton({ size: 'small' }, makeRng(7));
  const b = generateSkeleton({ size: 'small' }, makeRng(7));

  assert.equal(JSON.stringify(a), JSON.stringify(b),
    'same seed + config produces identical JSON');
  ok('determinism: same seed ⇒ equal JSON');
}

// ---- 2. Seed sensitivity: different seed ⇒ different JSON ----
{
  const a = generateSkeleton({ size: 'small' }, makeRng(7));
  const b = generateSkeleton({ size: 'small' }, makeRng(99));

  assert.notEqual(JSON.stringify(a), JSON.stringify(b),
    'different seed produces different output');
  ok('seed sensitivity: seed 7 ≠ seed 99');
}

// ---- 3. Structure (small) ----
{
  const world = generateSkeleton({ size: 'small' }, makeRng(42));
  const ents = world.entities;

  assert.ok(ents, 'entities map exists');

  // Location count: ≥3
  const locIds = Object.keys(ents).filter(id => ents[id].identity?.kind === 'location');
  assert.ok(locIds.length >= 3,
    `locations ≥ 3 (got ${locIds.length})`);

  // Exactly one PC
  const pcIds = Object.keys(ents).filter(id => ents[id].identity?.kind === 'pc');
  assert.equal(pcIds.length, 1, `exactly one pc (got ${pcIds.length})`);

  // world-state present
  assert.ok(ents['world-state'], 'world-state entity present');

  // Exactly one quest
  const questIds = Object.keys(ents).filter(id => ents[id].identity?.kind === 'quest');
  assert.equal(questIds.length, 1, `exactly one quest (got ${questIds.length})`);

  // ≥1 hostile
  const hostiles = Object.keys(ents).filter(id => ents[id].flags?.hostile === true);
  assert.ok(hostiles.length >= 1,
    `≥1 hostile entity (got ${hostiles.length})`);

  // ≥1 item
  const items = Object.keys(ents).filter(id => ents[id].identity?.kind === 'item');
  assert.ok(items.length >= 1,
    `≥1 item entity (got ${items.length})`);

  ok('structure (small): locations, pc, world-state, quest, hostiles, items');
}

// ---- 4. Connectivity: BFS from PC's location reaches every location ----
{
  const world = generateSkeleton({ size: 'small' }, makeRng(13));
  const ents = world.entities;

  // Find PC
  const pcId = Object.keys(ents).find(id => ents[id].identity?.kind === 'pc');
  assert.ok(pcId, 'PC found');
  const pcLocId = ents[pcId].place?.locationId;
  assert.ok(pcLocId, 'PC has locationId');

  // Collect all location ids
  const allLocIds = new Set(
    Object.keys(ents).filter(id => ents[id].identity?.kind === 'location')
  );

  // BFS from pcLocId
  const visited = new Set();
  const queue = [pcLocId];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const locEntity = ents[cur];
    if (!locEntity?.place?.connections) continue;
    for (const conn of locEntity.place.connections) {
      if (!visited.has(conn.targetId) && allLocIds.has(conn.targetId)) {
        queue.push(conn.targetId);
      }
    }
  }

  // Every location must be reachable
  for (const lid of allLocIds) {
    assert.ok(visited.has(lid),
      `location ${lid} reachable from PC location ${pcLocId}`);
  }

  ok('connectivity: BFS from PC location reaches all locations');
}

// ---- 5. Self-validates: small world ----
{
  const world = generateSkeleton({ size: 'small' }, makeRng(1));
  const result = validateWorld(world.entities);

  assert.equal(result.ok, true,
    `small world self-validates: ${JSON.stringify(result.errors)}`);
  ok('self-validation: small world passes validateWorld');
}

// ---- 6. Self-validates: medium world ----
{
  const world = generateSkeleton({ size: 'medium' }, makeRng(1));
  const result = validateWorld(world.entities);

  assert.equal(result.ok, true,
    `medium world self-validates: ${JSON.stringify(result.errors)}`);
  ok('self-validation: medium world passes validateWorld');
}

// ---- 7. Validator catches breakage: broken connection target ----
{
  const world = generateSkeleton({ size: 'small' }, makeRng(42));
  const ents = JSON.parse(JSON.stringify(world.entities));

  // Find a location with at least one connection
  const locIds = Object.keys(ents).filter(id => ents[id].identity?.kind === 'location');
  let broken = false;
  for (const lid of locIds) {
    const conns = ents[lid].place?.connections;
    if (conns && conns.length > 0) {
      conns[0].targetId = 'loc-nope';
      broken = true;
      break;
    }
  }
  assert.ok(broken, 'found a connection to break');

  const result = validateWorld(ents);
  assert.equal(result.ok, false, 'broken connection target → ok === false');
  assert.ok(
    result.errors.some(e => e.includes('loc-nope')),
    `error mentions loc-nope: ${JSON.stringify(result.errors)}`
  );
  ok('validator catches breakage: connection target → missing id');
}

// ---- 8. Validator catches breakage: delete PC ----
{
  const world = generateSkeleton({ size: 'small' }, makeRng(42));
  const ents = JSON.parse(JSON.stringify(world.entities));
  delete ents['pc-hero'];

  const result = validateWorld(ents);
  assert.equal(result.ok, false, 'deleted PC → ok === false');
  assert.ok(
    result.errors.some(e => e.toLowerCase().includes('pc')),
    `error mentions PC: ${JSON.stringify(result.errors)}`
  );
  ok('validator catches breakage: delete PC entity');
}

// ---- 9. Validator catches breakage: quest atLocation → missing id ----
{
  const world = generateSkeleton({ size: 'small' }, makeRng(42));
  const ents = JSON.parse(JSON.stringify(world.entities));

  const questId = Object.keys(ents).find(id => ents[id].identity?.kind === 'quest');
  assert.ok(questId, 'quest found');
  const triggers = ents[questId].quest?.triggers;
  assert.ok(triggers, 'quest triggers exist');

  const atLocTrigger = triggers.find(t => t?.type === 'atLocation');
  assert.ok(atLocTrigger, 'atLocation trigger found');
  atLocTrigger.id = 'loc-nonexistent';

  const result = validateWorld(ents);
  assert.equal(result.ok, false, 'quest broken atLocation → ok === false');
  assert.ok(
    result.errors.some(e => e.includes('loc-nonexistent')),
    `error mentions loc-nonexistent: ${JSON.stringify(result.errors)}`
  );
  ok('validator catches breakage: quest atLocation → missing id');
}

// ---- 10. Bidirectional connections ----
{
  const world = generateSkeleton({ size: 'small' }, makeRng(5));
  const ents = world.entities;
  const locIds = Object.keys(ents).filter(id => ents[id].identity?.kind === 'location');

  let allBidi = true;
  for (const lid of locIds) {
    const conns = ents[lid].place?.connections || [];
    for (const conn of conns) {
      const targetId = conn.targetId;
      const targetConns = ents[targetId]?.place?.connections || [];
      const hasRev = targetConns.some(c => c.targetId === lid);
      if (!hasRev) {
        console.error(`  ❌ ${lid} → ${targetId} has no reciprocal`);
        allBidi = false;
      }
    }
  }
  assert.ok(allBidi, 'all connections are bidirectional');

  ok('bidirectional: every connection has a reciprocal');
}

console.log(`\n${passed} P8 checks passed.`);
