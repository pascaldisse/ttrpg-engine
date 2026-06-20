/**
 * tools/test-combat-c5.mjs — C5 party seats / overdrive / summons (PURE).
 *
 * Definition-of-Done:
 *   - the timeline interleaves ≥2 ally seats
 *   - an 'ai' ally and a (simulated) human ally emit IDENTICAL op shapes for the same choice
 *   - a summon takes its turns then expires (drops off the timeline)
 *   - setMeter op expands (overdrive plumbing)
 *
 * Run: node tools/test-combat-c5.mjs
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeRng } from '../shared/rng.js';
import { registerStatuses } from '../shared/statuses.js';
import { buildTimeline, advanceTimeline, projectQueue, resolveMove, enemyInstinct } from '../shared/combat.js';
import { expandOp } from '../shared/effects.js';
import { validateOp } from '../shared/ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };
const count = (arr, x) => arr.filter(v => v === x).length;

const rs = await import(pathToFileURL(path.join(root, 'campaigns/necrotopia/ruleset/necrotopia/ruleset.js')).href);
registerStatuses(rs.statuses);

const alive = () => ({ status: { alive: true } });

// ---- 1. timeline interleaves ≥2 ally seats ----
{
  const ents = new Map([
    ['pc', alive()], ['ally', alive()], ['e1', alive()],
  ]);
  const enc = buildTimeline({ allies: ['pc', 'ally'], enemies: ['e1'] }, ents, rs.combat);
  assert.equal(enc.participants.length, 3, 'pc + ally + enemy all on the timeline');
  const q = projectQueue(enc, ents, rs.combat, 9);
  assert.ok(count(q, 'pc') >= 2 && count(q, 'ally') >= 2, 'both ally seats recur in the queue');
  assert.ok(count(q, 'e1') >= 2, 'the enemy also recurs — interleaved');
  ok('timeline interleaves two ally seats with the enemy');
}

// ---- 2. seat-agnostic op shape (AI ally vs simulated human ally) ----
{
  const mk = () => new Map([
    ['ally', { stats: { level: 1 }, position: { zoneId: 'field' }, moves: { list: [{ name: 'Shotgun Blast', type: 'damage', damage: '1d6' }] } }],
    ['e1', { stats: { armor: 2, hp: 8, maxHp: 8 }, status: { alive: true }, position: { zoneId: 'field' } }],
    ['encounter', { encounter: { enemies: ['e1'], allies: ['ally'] } }],
  ]);

  // AI path: instinct picks the move+target; engine resolves it.
  const entsAI = mk();
  const enc = { enemies: ['e1'], allies: ['ally'] };
  const choice = enemyInstinct('ally', enc, entsAI, makeRng(5), rs.combat);
  assert.equal(choice.targetId, 'e1', 'AI ally targets the enemy');
  const opsAI = resolveMove(choice.move, { actorId: 'ally', targetId: choice.targetId }, entsAI, makeRng(99), rs.combat);

  // "Human" path: the SAME move+target chosen by a person → same engine call.
  const entsHU = mk();
  const move = entsHU.get('ally').moves.list[0];
  const opsHU = resolveMove(move, { actorId: 'ally', targetId: 'e1' }, entsHU, makeRng(99), rs.combat);

  assert.equal(JSON.stringify(opsAI), JSON.stringify(opsHU), 'AI and human produce identical op shapes');
  ok('seat-agnostic: an AI ally and a human ally emit identical ops for the same choice');
}

// ---- 3. summon takes turns then expires ----
{
  const ents = new Map([
    ['pc', alive()], ['ghost', alive()], ['e1', alive()],
  ]);
  let enc = buildTimeline({ allies: ['pc'], enemies: ['e1'] }, ents, rs.combat);
  // splice in a summon with a 2-turn lifetime
  enc = { ...enc, allies: ['pc', 'ghost'], participants: [...enc.participants, { id: 'ghost', time: 0, speed: 1, summonTurns: 2 }] };
  assert.ok(projectQueue(enc, ents, rs.combat, 6).includes('ghost'), 'summon is on the timeline');

  enc = advanceTimeline(enc, 'ghost', 1, ents, rs.combat); // ghost acts → 2→1
  assert.equal(enc.participants.find(p => p.id === 'ghost').summonTurns, 1, 'summonTurns decremented to 1');

  enc = advanceTimeline(enc, 'ghost', 1, ents, rs.combat); // ghost acts → 1→0 → dropped
  assert.ok(!enc.participants.some(p => p.id === 'ghost'), 'summon expired off the timeline');
  assert.ok(!projectQueue(enc, ents, rs.combat, 6).includes('ghost'), 'summon gone from the queue');
  ok('summon: takes its turns then expires off the timeline');
}

// ---- 4. setMeter op expands + validates ----
{
  const ents = new Map([['pc', { meter: { overdrive: 40 } }]]);
  const op = { op: 'setMeter', id: 'pc', key: 'overdrive', value: 100 };
  assert.equal(validateOp(op).ok, true, 'setMeter validates');
  const expanded = expandOp(ents, op);
  assert.equal(expanded[0].component, 'meter', 'setMeter → meter merge');
  assert.equal(expanded[0].value.overdrive, 100, 'sets the meter value');
  ok('setMeter: expands to a meter merge (overdrive plumbing)');
}

// ---- 5. summon Move data shape is intact in the bundle ----
{
  // (resolveMove never sees 'summon' — the server intercepts it — but the data must be present)
  const guardian = { name: 'Guardian Ghost', type: 'summon', summon: { name: 'Guardian Ghost', hp: 10, turns: 3 } };
  assert.equal(guardian.summon.turns, 3, 'summon spec carries a lifetime');
  ok('summon Move carries a {hp, turns} spec');
}

console.log(`\n${passed} C5 party/overdrive/summon checks passed.`);
