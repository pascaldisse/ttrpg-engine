/**
 * tools/test-p4.mjs — P4 pure-logic tests (no server, no network).
 *
 * Verifies location-scoping, the place graph, exit resolution, and take/drop.
 * Run: node tools/test-p4.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLookFrame } from '../shared/context.js';
import { pcLocationId, entitiesAt, exitsFrom, isConnected, resolveExit, findPc } from '../shared/space.js';
import { expandOp } from '../shared/effects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worldPath = path.resolve(__dirname, '..', 'world', 'scenes', 'tavern.json');

/** Fresh entities Map from the seed world each test (no mutation bleed). */
function loadWorld() {
  const raw = JSON.parse(fs.readFileSync(worldPath, 'utf8'));
  return new Map(Object.entries(structuredClone(raw)));
}

let passed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }

// ---- 1. PC location + co-location queries ----
{
  const ents = loadWorld();
  assert.equal(pcLocationId(ents), 'loc-tavern', 'PC starts in the tavern');

  const npcsHere = entitiesAt(ents, 'loc-tavern', { kinds: ['npc'] }).map(([id]) => id);
  assert.deepEqual(npcsHere.sort(), ['npc-marta'], 'only Marta is in the tavern');

  const npcsDocks = entitiesAt(ents, 'loc-docks', { kinds: ['npc'] }).map(([id]) => id);
  assert.deepEqual(npcsDocks.sort(), ['npc-jonas'], 'only Jonas is at the docks');

  ok('location queries return only co-located entities');
}

// ---- 2. Scoped scene frame: only HERE is present ----
{
  const ents = loadWorld();
  const frame = buildLookFrame(ents);

  assert.match(frame, /The Salt & Sextant/, 'shows the current location');
  assert.match(frame, /Marta/, 'shows the NPC here');
  assert.match(frame, /Small Lockbox/, 'shows a ground item here');
  // Leakage checks — other rooms must NOT appear in the tavern frame.
  assert.ok(!/Jonas/.test(frame), 'does NOT show the docks NPC');
  assert.ok(!/Liesl/.test(frame), 'does NOT show the market NPC');
  assert.ok(!/Lashed Cargo Crate/.test(frame), 'does NOT show docks items');
  assert.match(frame, /Exits/, 'lists exits');
  assert.match(frame, /loc-docks/, 'exit references the docks');

  ok('scene frame is location-scoped (no cross-room leakage)');
}

// ---- 3. Exit graph + resolution ----
{
  const ents = loadWorld();
  const exits = exitsFrom(ents, 'loc-tavern');
  const targets = exits.map(e => e.targetId).sort();
  assert.deepEqual(targets, ['loc-backroom', 'loc-docks', 'loc-market'], 'tavern exits resolved');
  assert.ok(exits.every(e => e.exists), 'all tavern exits point to real entities (no dangling refs)');

  assert.ok(isConnected(ents, 'loc-tavern', 'loc-docks'), 'tavern connects to docks');
  assert.ok(!isConnected(ents, 'loc-backroom', 'loc-docks'), 'backroom does NOT connect to docks');

  // Phrase matching
  assert.equal(resolveExit(ents, 'loc-tavern', 'go to the docks'), 'loc-docks', 'matches "docks"');
  assert.equal(resolveExit(ents, 'loc-tavern', 'head through the market square'), 'loc-market', 'matches "market"');
  assert.equal(resolveExit(ents, 'loc-tavern', 'walk into the back room'), 'loc-backroom', 'matches "back room"');
  assert.equal(resolveExit(ents, 'loc-tavern', 'go to the dungeon'), null, 'no match → null');
  // A non-movement phrase that merely mentions a place must NOT be a confident hit
  // for the FAST PATH (the turn engine gates on movement intent before calling this);
  // resolveExit still matches the token, so the gate — not this — prevents teleporting.

  ok('exit graph + phrase resolution work');
}

// ---- 4. take leaves the ground + enters inventory ----
{
  const ents = loadWorld();
  // Pre: torch is on the ground in the tavern
  let groundItems = entitiesAt(ents, 'loc-tavern', { kinds: ['item'] }).map(([id]) => id);
  assert.ok(groundItems.includes('item-torch'), 'torch starts on the ground');

  // Expand + apply a take op
  const ops = expandOp(ents, { op: 'take', id: 'pc-hero', item: { id: 'item-torch', name: 'Wall Torch' } });
  for (const op of ops) {
    if (op.op === 'set') ents.get(op.id)[op.component] = op.value;
    if (op.op === 'merge') { const c = ents.get(op.id); c[op.component] = { ...(c[op.component] || {}), ...op.value }; }
  }

  // Post: torch no longer on the ground, now carried + in inventory
  groundItems = entitiesAt(ents, 'loc-tavern', { kinds: ['item'] }).map(([id]) => id);
  assert.ok(!groundItems.includes('item-torch'), 'torch left the ground after take');
  assert.equal(ents.get('item-torch').place.locationId, 'pc-hero', 'torch is now carried (place=pc)');
  const inv = ents.get('pc-hero').inventory.items.map(i => i.id);
  assert.ok(inv.includes('item-torch'), 'torch is in the PC inventory');

  // And it should NOT show in the scoped frame anymore (it left the ground)
  const frame = buildLookFrame(ents);
  const groundSection = frame.split('\nParty:')[0]; // everything before the party block
  assert.ok(!/Wall Torch/.test(groundSection), 'taken torch no longer listed as a ground item');
  assert.match(frame, /Carrying:.*Wall Torch/, 'torch shows under Carrying');

  ok('take: item leaves the ground, enters inventory, updates the frame');
}

// ---- 5. drop is the inverse ----
{
  const ents = loadWorld();
  // First take, then drop
  for (const op of expandOp(ents, { op: 'take', id: 'pc-hero', item: { id: 'item-torch' } })) {
    if (op.op === 'set') ents.get(op.id)[op.component] = op.value;
    if (op.op === 'merge') { const c = ents.get(op.id); c[op.component] = { ...(c[op.component] || {}), ...op.value }; }
  }
  for (const op of expandOp(ents, { op: 'drop', id: 'pc-hero', item: { id: 'item-torch' } })) {
    if (op.op === 'set') ents.get(op.id)[op.component] = op.value;
    if (op.op === 'merge') { const c = ents.get(op.id); c[op.component] = { ...(c[op.component] || {}), ...op.value }; }
  }
  assert.equal(ents.get('item-torch').place.locationId, 'loc-tavern', 'dropped back to current location');
  const inv = ents.get('pc-hero').inventory.items.map(i => i.id);
  assert.ok(!inv.includes('item-torch'), 'torch removed from inventory after drop');

  ok('drop: inverse of take');
}

// ---- 6. moving the PC re-scopes the frame ----
{
  const ents = loadWorld();
  // Apply move (semantic → merge)
  for (const op of expandOp(ents, { op: 'move', id: 'pc-hero', to: 'loc-docks' })) {
    if (op.op === 'merge') { const c = ents.get(op.id); c[op.component] = { ...(c[op.component] || {}), ...op.value }; }
  }
  assert.equal(pcLocationId(ents), 'loc-docks', 'PC moved to the docks');
  const frame = buildLookFrame(ents);
  assert.match(frame, /The Docks/, 'frame now shows the docks');
  assert.match(frame, /Jonas/, 'frame now shows Jonas');
  assert.ok(!/Marta/.test(frame), 'frame no longer shows Marta (left behind in tavern)');

  ok('move re-scopes the scene frame to the new location');
}

console.log(`\n${passed} P4 checks passed.`);
