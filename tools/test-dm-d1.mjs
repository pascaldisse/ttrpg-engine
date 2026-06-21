/**
 * tools/test-dm-d1.mjs — world-first actor spawning (PURE, no server).
 *
 * Asserts the Definition-of-Done for D1:
 *   - resolveActorSpawn turns an archetype intent into a canonical spawn op whose
 *     components carry the RULESET's stat block + flags.hostile (+ derived damage)
 *   - two spawns of the same archetype get distinct ids
 *   - an unknown archetype falls back to the ruleset's _default
 *   - a ruleset with NO actorTemplates grants no spawn power (returns null)
 *   - the spawn op actually applies into a real, living, placed entity
 *
 * Run: node tools/test-dm-d1.mjs
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveActorSpawn, slugify, uniqueActorId } from '../shared/staging.js';
import { expandOp } from '../shared/effects.js';
import { applyOp } from '../shared/ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

const rs = await import(pathToFileURL(path.join(root, 'campaigns/necrotopia/ruleset/necrotopia/ruleset.js')).href);
const templates = rs.actorTemplates;
assert.ok(templates && templates.groomsman, 'necrotopia exports actorTemplates with a groomsman');
ok('ruleset exports actorTemplates (groomsman/imp/preacher/_default)');

// --- slug + id helpers ---
assert.strictEqual(slugify('Tuxedoed Groomsman'), 'tuxedoed-groomsman');
assert.strictEqual(slugify('!!!'), 'actor');
ok('slugify kebabs names, falls back to "actor"');

// --- a hostile groomsman from the template ---
const entities = new Map();
const spawn = resolveActorSpawn({ archetype: 'groomsman', hostile: true, place: 'loc-strip', zoneId: 'the-aisle' }, templates, entities);
assert.strictEqual(spawn.op, 'spawn');
assert.strictEqual(spawn.components.identity.kind, 'npc');
assert.strictEqual(spawn.components.identity.name, 'Tuxedoed Groomsman');
assert.strictEqual(spawn.components.stats.hp, 6, 'stats come from the ruleset, not the LLM');
assert.strictEqual(spawn.components.stats.armor, 2);
assert.strictEqual(spawn.components.status.alive, true);
assert.strictEqual(spawn.components.place.locationId, 'loc-strip');
assert.strictEqual(spawn.components.position.zoneId, 'the-aisle');
assert.strictEqual(spawn.components.flags.hostile, true);
assert.strictEqual(spawn.components.flags.damage, '1d6', 'damage derived from the template move');
assert.strictEqual(spawn.components.agent.controller, 'ai', 'spawns are AI-seated by default (seat indirection)');
ok('resolveActorSpawn stamps the ruleset stat block + hostile flag + damage');

// --- apply it: a real, living, present entity appears ---
const ref = { value: 0 };
for (const c of expandOp(entities, spawn)) applyOp(entities, c, ref);
const ent = entities.get(spawn.id);
assert.ok(ent, 'the spawned entity exists in the store');
assert.strictEqual(ent.status.alive, true);
assert.strictEqual(ent.flags.hostile, true);
ok('the spawn op applies into a real, living, hostile entity');

// --- two of the same archetype get distinct ids ---
const spawn2 = resolveActorSpawn({ archetype: 'groomsman', hostile: true, place: 'loc-strip' }, templates, entities);
assert.notStrictEqual(spawn2.id, spawn.id, 'second groomsman gets a fresh id');
assert.strictEqual(spawn2.id, 'npc-groomsman-2', 'slug comes from the archetype; second is suffixed');
assert.strictEqual(uniqueActorId('groomsman', entities), spawn2.id);
ok('repeated archetype spawns get unique ids');

// --- unknown archetype → _default ---
const weird = resolveActorSpawn({ archetype: 'eldritch-accountant', place: 'loc-strip' }, templates, entities);
assert.strictEqual(weird.components.identity.name, templates._default.name, 'unknown archetype falls to _default');
assert.strictEqual(weird.components.stats.hp, templates._default.stats.hp);
ok('unknown archetype falls back to the ruleset _default');

// --- a ruleset with no templates grants no spawn power ---
const none = resolveActorSpawn({ archetype: 'groomsman', place: 'x' }, null, new Map());
assert.strictEqual(none, null, 'no templates + no explicit stats ⇒ null (no regression for 5e/DSA)');
ok('ruleset without actorTemplates yields no spawn (neutral-core invariant)');

console.log(`\n✅ test-dm-d1: ${passed} checks passed`);
