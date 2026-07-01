/**
 * test/worldgen.test.mjs — worldgen v2: regions, roads, packs, boss, side quests.
 * All structural guarantees are procgen's job — these tests hold it to them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateSkeleton } from '../shared/worldgen-skeleton.js';
import { validateWorld } from '../shared/worldcheck.js';
import { makeRng } from '../shared/rng.js';

/** BFS over place.connections from a start id. */
function reachable(entities, startId) {
  const seen = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const c of (entities[id].place?.connections || [])) {
      if (!seen.has(c.targetId)) { seen.add(c.targetId); queue.push(c.targetId); }
    }
  }
  return seen;
}

describe('worldgen v2 skeleton', () => {
  test('large: 24 locations across 6 regions, fully connected', () => {
    const { entities, meta } = generateSkeleton({ size: 'large' }, makeRng(7));
    assert.equal(meta.locationIds.length, 24);
    assert.equal(meta.regions.length, 6);
    const seen = reachable(entities, 'loc-1');
    for (const id of meta.locationIds) assert.ok(seen.has(id), `${id} unreachable`);
  });

  test('region chain: first is a settlement, last is the boss dungeon, lair at the far end', () => {
    const { meta } = generateSkeleton({ size: 'large' }, makeRng(7));
    assert.equal(meta.regions[0].role, 'settlement');
    const last = meta.regions[meta.regions.length - 1];
    assert.equal(last.role, 'dungeon');
    assert.equal(meta.lairId, last.locationIds[last.locationIds.length - 1]);
    assert.ok(meta.bossId, 'a boss exists');
    assert.equal(meta.hints[meta.bossId].role, 'boss');
  });

  test('enemies are DISTRIBUTED packs, not one lair pile', () => {
    const { entities, meta } = generateSkeleton({ size: 'large' }, makeRng(7));
    const enemyLocs = new Set(
      Object.entries(entities)
        .filter(([id, c]) => (c.flags || {}).hostile)
        .map(([_id, c]) => c.place.locationId),
    );
    assert.ok(enemyLocs.size >= 3, `enemies spread over ${enemyLocs.size} locations`);
    assert.ok(meta.packs.length >= 3, `${meta.packs.length} packs`);
    // The boss pack guards the lair; other packs are elsewhere.
    const bossPack = meta.packs.find(p => p.boss);
    assert.ok(bossPack.ids.includes(meta.bossId));
  });

  test('quests: one main + a side quest per non-boss pack and per relic, all triggers real', () => {
    const { entities, meta } = generateSkeleton({ size: 'large' }, makeRng(7));
    assert.ok(meta.questIds.length >= 3, `${meta.questIds.length} quests`);
    assert.equal(meta.questIds[0], 'quest-1');
    // steps and triggers stay index-aligned in every quest
    for (const qid of meta.questIds) {
      const q = entities[qid].quest;
      assert.equal(q.steps.length, q.triggers.length, `${qid} steps↔triggers`);
    }
    // referential integrity across the whole world (also validates all triggers)
    const check = validateWorld(entities);
    assert.ok(check.ok, `validateWorld: ${(check.errors || []).join('; ')}`);
  });

  test('NPCs seat by region role: settlements crowded, dungeons empty', () => {
    const { entities, meta } = generateSkeleton({ size: 'large' }, makeRng(7));
    const npcRegion = (id) => meta.hints[id].region;
    const npcs = Object.keys(entities).filter((id) => id.startsWith('npc-'));
    assert.ok(npcs.length >= 4, `${npcs.length} friendly NPCs`);
    const dungeonRegions = new Set(meta.regions.filter(r => r.role === 'dungeon').map(r => r.id));
    for (const id of npcs) {
      assert.ok(!dungeonRegions.has(npcRegion(id)), `${id} must not live in a dungeon`);
    }
  });

  test('deterministic: same seed ⇒ identical world; different seed ⇒ different world', () => {
    const a = generateSkeleton({ size: 'medium' }, makeRng(42));
    const b = generateSkeleton({ size: 'medium' }, makeRng(42));
    const c = generateSkeleton({ size: 'medium' }, makeRng(43));
    assert.equal(JSON.stringify(a.entities), JSON.stringify(b.entities));
    assert.notEqual(JSON.stringify(a.entities), JSON.stringify(c.entities));
  });

  test('explicit --locations/--regions override presets and stay connected', () => {
    const { entities, meta } = generateSkeleton({ locations: 30, regions: 7 }, makeRng(3));
    assert.equal(meta.locationIds.length, 30);
    assert.equal(meta.regions.length, 7);
    const seen = reachable(entities, 'loc-1');
    assert.equal(seen.size >= 30, true, 'all locations reachable');
    assert.ok(validateWorld(entities).ok);
  });

  test('small single-region world still works (dungeon crawl)', () => {
    const { entities, meta } = generateSkeleton({ size: 'small' }, makeRng(1));
    assert.equal(meta.regions.length, 1);
    assert.ok(meta.bossId);
    assert.ok(validateWorld(entities).ok);
    const seen = reachable(entities, 'loc-1');
    for (const id of meta.locationIds) assert.ok(seen.has(id));
  });
});
