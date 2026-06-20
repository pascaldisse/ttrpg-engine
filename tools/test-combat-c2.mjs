/**
 * tools/test-combat-c2.mjs — C2 CTB timeline (PURE, no server).
 *
 * Definition-of-Done:
 *   - nextActor picks the min-time participant (tie: speed desc, id asc)
 *   - a cost-1 actor acts repeatedly before a cost-3 actor acts twice
 *   - haste (speed ×2) makes a participant appear more often / earlier in projectQueue
 *   - determinism: same config ⇒ identical timeline
 *
 * Run: node tools/test-combat-c2.mjs
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerStatuses } from '../shared/statuses.js';
import { buildTimeline, nextActor, advanceTimeline, projectQueue } from '../shared/combat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };
const count = (arr, x) => arr.filter(v => v === x).length;

const rs = await import(pathToFileURL(path.join(root, 'campaigns/necrotopia/ruleset/necrotopia/ruleset.js')).href);
registerStatuses(rs.statuses); // registers haste/slow modifySpeed

const alive = () => ({ status: { alive: true } });

// ---- 1. nextActor: min time, tie-break speed desc then id asc ----
{
  const enc = { participants: [
    { id: 'c', time: 5, speed: 1 },
    { id: 'a', time: 2, speed: 1 },
    { id: 'b', time: 2, speed: 3 },
  ] };
  assert.equal(nextActor(enc), 'b', 'min time tie → higher speed wins (b)');
  enc.participants[2].speed = 1; // now a and b tie on time+speed → id asc
  assert.equal(nextActor(enc), 'a', 'full tie → id ascending (a)');
  assert.equal(nextActor({ participants: [] }), null, 'empty → null');
  ok('nextActor: min-time with deterministic tie-break');
}

// ---- 2. buildTimeline: structure ----
{
  const ents = new Map([['pc', alive()], ['e1', alive()], ['e2', alive()]]);
  const enc = buildTimeline({ allies: ['pc'], enemies: ['e1', 'e2'] }, ents, rs.combat);
  assert.equal(enc.mode, 'timeline', 'mode timeline');
  assert.equal(enc.participants.length, 3, 'three participants');
  assert.ok(enc.participants.every(p => p.time === 0 && p.speed === 1), 'all start time 0, speed 1');
  assert.equal(enc.turnOf, nextActor(enc), 'turnOf is next actor');
  assert.equal(enc.queue.length, 8, 'projected queue of 8');
  ok('buildTimeline: timeline encounter structure');
}

// ---- 3. cost-1 acts repeatedly before cost-3 acts twice ----
{
  const ents = new Map([['a', alive()], ['b', alive()]]);
  let enc = buildTimeline({ allies: ['a'], enemies: ['b'] }, ents, { speedOf: () => 1 });
  const cost = (id) => (id === 'a' ? 1 : 3);
  let aCount = 0, bCount = 0;
  for (let i = 0; i < 20 && bCount < 2; i++) {
    const who = enc.turnOf;
    if (who === 'a') aCount++; else bCount++;
    enc = advanceTimeline(enc, who, cost(who), ents, {});
  }
  assert.equal(bCount, 2, 'b reached its 2nd action');
  assert.ok(aCount >= 3, `cost-1 actor acted ${aCount}× before cost-3 acted twice`);
  ok('action cost: a cheap Move comes up again sooner');
}

// ---- 4. haste (×2 speed) → more turns in projectQueue ----
{
  const ents = new Map([['a', alive()], ['b', alive()]]);
  const enc = buildTimeline({ allies: ['a'], enemies: ['b'] }, ents, { speedOf: () => 1 });

  const before = projectQueue(enc, ents, {}, 8);
  const baseB = count(before, 'b');

  ents.get('b').statuses = { list: [{ kind: 'haste', remaining: 9 }] };
  const after = projectQueue(enc, ents, {}, 8);
  const fastB = count(after, 'b');

  assert.ok(fastB > baseB, `haste gives b more turns (${baseB} → ${fastB})`);
  // and b should appear by the 2nd slot now (acts again before a's 2nd turn)
  assert.ok(after.indexOf('b') >= 0 && after.slice(0, 3).filter(x => x === 'b').length >= 2, 'hasted b appears earlier/more');
  ok('haste: ×2 speed reshuffles the projected queue earlier');
}

// ---- 5. slow (×0.5) → fewer turns ----
{
  const ents = new Map([['a', alive()], ['b', alive()]]);
  const enc = buildTimeline({ allies: ['a'], enemies: ['b'] }, ents, { speedOf: () => 1 });
  const before = count(projectQueue(enc, ents, {}, 8), 'b');
  ents.get('b').statuses = { list: [{ kind: 'slow', remaining: 9 }] };
  const after = count(projectQueue(enc, ents, {}, 8), 'b');
  assert.ok(after < before, `slow gives b fewer turns (${before} → ${after})`);
  ok('slow: ×0.5 speed pushes a participant later');
}

// ---- 6. dead participants are pruned on advance ----
{
  const ents = new Map([['a', alive()], ['b', alive()]]);
  let enc = buildTimeline({ allies: ['a'], enemies: ['b'] }, ents, { speedOf: () => 1 });
  ents.get('b').status.alive = false;
  enc = advanceTimeline(enc, enc.turnOf, 1, ents, {});
  assert.ok(!enc.participants.some(p => p.id === 'b'), 'dead b removed from participants');
  assert.ok(!enc.queue.includes('b'), 'dead b removed from queue');
  ok('advanceTimeline: prunes the dead');
}

// ---- 7. determinism ----
{
  const mk = () => new Map([['pc', alive()], ['e1', alive()], ['e2', alive()]]);
  const a = buildTimeline({ allies: ['pc'], enemies: ['e1', 'e2'] }, mk(), rs.combat);
  const b = buildTimeline({ allies: ['pc'], enemies: ['e1', 'e2'] }, mk(), rs.combat);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same config → identical timeline');
  ok('determinism: identical timeline for identical config');
}

console.log(`\n${passed} C2 timeline checks passed.`);
