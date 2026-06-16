/**
 * tools/test-visibility.mjs — Visibility module tests (DMView Slice 1).
 *
 * Assertions:
 *  1. seatSees gating
 *  2. Snapshot redaction for 'player' — persona/knowledge gone, agent reduced
 *  3. Snapshot for 'dm' deep-equals input
 *  4. Ops redaction — merge knowledge dropped, empty → null, set agent reduced,
 *     damage passes through
 *  5. Input not mutated — original snapshot/ops unchanged after redaction
 *  6. Uses real tavern.json data (npc-marta)
 *
 * Run: node tools/test-visibility.mjs
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seatSees,
  redactComponentsForSeat,
  redactForSeat,
  PRIVATE_COMPONENTS,
  AGENT_PUBLIC_FIELDS,
} from '../shared/visibility.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function ok(name) { console.log(`  ✅ ${name}`); passed++; }

// ---- 1. seatSees ----

// 'all' → anyone
assert.equal(seatSees('all', 'dm'), true, 'all → dm');
assert.equal(seatSees('all', 'player'), true, 'all → player');
assert.equal(seatSees('all', 'npc'), true, 'all → npc');
assert.equal(seatSees('all', 'spectator'), true, 'all → spectator');
ok('seatSees: all → everyone');

// 'dm' → only dm
assert.equal(seatSees('dm', 'dm'), true, 'dm → dm');
assert.equal(seatSees('dm', 'player'), false, 'dm → player');
assert.equal(seatSees('dm', 'npc'), false, 'dm → npc');
assert.equal(seatSees('dm', 'spectator'), false, 'dm → spectator');
ok('seatSees: dm → only dm');

// 'players' → everyone except dm
assert.equal(seatSees('players', 'dm'), false, 'players → dm');
assert.equal(seatSees('players', 'player'), true, 'players → player');
assert.equal(seatSees('players', 'npc'), true, 'players → npc');
assert.equal(seatSees('players', 'spectator'), true, 'players → spectator');
ok('seatSees: players → everyone except dm');

// ---- 2. Build snapshot input from tavern.json ----

const tavernPath = resolve(__dirname, '..', 'world', 'scenes', 'tavern.json');
const tavernEntities = JSON.parse(readFileSync(tavernPath, 'utf-8'));

const snapshotMsg = {
  type: 'snapshot',
  time: Date.now(),
  counter: 100,
  entities: structuredClone(tavernEntities),
  world: '/world',
  ruleset: 'srd5e',
};

// Clone before any redaction to validate non-mutation later
const snapshotOriginal = structuredClone(snapshotMsg);

// ---- 3. Snapshot redaction for 'player' ----

{
  const redacted = redactForSeat(snapshotMsg, 'player');
  assert.notEqual(redacted, null, 'player snapshot not null');
  assert.equal(redacted.type, 'snapshot', 'type preserved');

  // npc-marta: persona + knowledge removed, agent reduced
  const marta = redacted.entities['npc-marta'];
  assert.ok(marta, 'npc-marta present in redacted snapshot');
  assert.equal(marta.persona, undefined, 'persona removed');
  assert.equal(marta.knowledge, undefined, 'knowledge removed');
  assert.equal(marta.lifelog, undefined, 'lifelog removed (was absent anyway)');

  // agent reduced to {enabled, accent}
  assert.ok(marta.agent, 'agent component present');
  assert.equal('enabled' in marta.agent, true, 'agent.enabled present');
  assert.equal('accent' in marta.agent, true, 'agent.accent present');
  assert.equal(marta.agent.controller, undefined, 'agent.controller removed');
  assert.equal(marta.agent.systemPrompt, undefined, 'agent.systemPrompt removed');
  assert.equal(marta.agent.model, undefined, 'agent.model removed');
  assert.equal(Object.keys(marta.agent).length, 2,
    `agent has exactly 2 fields: ${JSON.stringify(Object.keys(marta.agent))}`);

  // Public components intact
  assert.ok(marta.identity, 'identity present');
  assert.ok(marta.status, 'status present');
  assert.ok(marta.place, 'place present');
  assert.ok(marta.inventory, 'inventory present');
  assert.ok(marta.flags, 'flags present');

  ok('snapshot player: persona/knowledge removed, agent reduced, public intact');

  // Also verify another NPC: npc-jonas (has persona, knowledge, agent)
  const jonas = redacted.entities['npc-jonas'];
  assert.ok(jonas, 'npc-jonas present');
  assert.equal(jonas.persona, undefined, 'jonas persona removed');
  assert.equal(jonas.knowledge, undefined, 'jonas knowledge removed');
  assert.ok(jonas.agent, 'jonas agent present');
  assert.equal(jonas.agent.enabled, true, 'jonas agent.enabled');
  assert.equal(jonas.agent.accent, '#5aa9a9', 'jonas agent.accent');

  ok('snapshot player: npc-jonas also redacted correctly');
}

// ---- 4. Snapshot for 'dm' deep-equals input ----

{
  const dmMsg = redactForSeat(snapshotMsg, 'dm');
  assert.deepStrictEqual(dmMsg, snapshotMsg,
    'dm snapshot deep-equals input');
  ok('snapshot dm: deep-equals input');
}

// ---- 5. Ops redaction for 'player' ----

{
  // merge knowledge → dropped
  const opsMsg = {
    type: 'ops',
    ops: [
      { op: 'merge', id: 'npc-marta', component: 'knowledge',
        value: { facts: ['new fact'] } },
    ],
  };

  const result = redactForSeat(opsMsg, 'player');
  assert.equal(result, null,
    'ops msg with only private op → null');

  ok('ops player: merge knowledge dropped; empty → null');
}

{
  // set agent → reduced
  const opsMsg = {
    type: 'ops',
    ops: [
      { op: 'set', id: 'npc-marta', component: 'agent',
        value: { enabled: false, accent: '#ff0000', controller: 'human', model: 'gpt4' } },
    ],
  };

  const result = redactForSeat(opsMsg, 'player');
  assert.notEqual(result, null, 'set agent not dropped');
  assert.equal(result.ops.length, 1, 'one op remains');
  assert.equal(result.ops[0].component, 'agent', 'component is agent');
  assert.equal(result.ops[0].value.enabled, false, 'agent.enabled reduced');
  assert.equal(result.ops[0].value.accent, '#ff0000', 'agent.accent reduced');
  assert.equal(result.ops[0].value.controller, undefined, 'agent.controller stripped');
  assert.equal(result.ops[0].value.model, undefined, 'agent.model stripped');

  ok('ops player: set agent reduced to public fields');
}

{
  // damage → passes through unchanged
  const opsMsg = {
    type: 'ops',
    ops: [
      { op: 'damage', id: 'pc-hero', amount: 5, type: 'slashing' },
    ],
  };

  const result = redactForSeat(opsMsg, 'player');
  assert.notEqual(result, null, 'damage op not dropped');
  assert.equal(result.ops.length, 1, 'one op remains');
  assert.deepStrictEqual(result.ops[0], opsMsg.ops[0],
    'damage op unchanged');

  ok('ops player: damage op passes through unchanged');
}

{
  // spawn → components redacted
  const opsMsg = {
    type: 'ops',
    ops: [
      { op: 'spawn', id: 'npc-new', components: {
        identity: { name: 'New NPC', kind: 'npc', description: 'Test' },
        persona: { personality: 'secret' },
        knowledge: { facts: ['secret fact'] },
        agent: { enabled: true, accent: '#123456', controller: 'ai', model: 'gpt4' },
        status: { alive: true, conditions: [] },
      }},
    ],
  };

  const result = redactForSeat(opsMsg, 'player');
  assert.notEqual(result, null, 'spawn op not dropped');
  assert.equal(result.ops.length, 1, 'one op remains');
  const spawnComps = result.ops[0].components;
  assert.ok(spawnComps.identity, 'spawn: identity kept');
  assert.equal(spawnComps.persona, undefined, 'spawn: persona removed');
  assert.equal(spawnComps.knowledge, undefined, 'spawn: knowledge removed');
  assert.ok(spawnComps.agent, 'spawn: agent kept (reduced)');
  assert.equal(spawnComps.agent.enabled, true, 'spawn: agent.enabled');
  assert.equal(spawnComps.agent.accent, '#123456', 'spawn: agent.accent');
  assert.equal(spawnComps.agent.controller, undefined, 'spawn: agent.controller stripped');

  ok('ops player: spawn redacts components');
}

{
  // Mixed ops: some dropped, some kept
  const opsMsg = {
    type: 'ops',
    ops: [
      { op: 'merge', id: 'npc-marta', component: 'knowledge', value: {} },
      { op: 'damage', id: 'pc-hero', amount: 3 },
      { op: 'merge', id: 'npc-marta', component: 'persona', value: {} },
      { op: 'move', id: 'pc-hero', to: 'loc-docks' },
    ],
  };

  const result = redactForSeat(opsMsg, 'player');
  assert.notEqual(result, null, 'mixed ops not null');
  assert.equal(result.ops.length, 2, 'only 2 ops remain (2 private dropped)');
  assert.equal(result.ops[0].op, 'damage', 'damage kept');
  assert.equal(result.ops[1].op, 'move', 'move kept');

  ok('ops player: mixed — private dropped, public kept');
}

// ---- 6. Input NOT MUTATED ----

{
  // Snapshot non-mutation
  const snap1 = structuredClone(snapshotOriginal);
  redactForSeat(snap1, 'player');
  assert.deepStrictEqual(snap1, snapshotOriginal,
    'snapshot original unchanged after player redaction');

  // Also check dm path
  const snap2 = structuredClone(snapshotOriginal);
  redactForSeat(snap2, 'dm');
  assert.deepStrictEqual(snap2, snapshotOriginal,
    'snapshot original unchanged after dm redaction');

  ok('non-mutation: snapshot unchanged after redactForSeat');
}

{
  // Ops non-mutation
  const opsOriginal = {
    type: 'ops',
    ops: [
      { op: 'merge', id: 'npc-marta', component: 'knowledge', value: { facts: ['x'] } },
      { op: 'damage', id: 'pc-hero', amount: 5 },
    ],
  };

  const clone = structuredClone(opsOriginal);
  redactForSeat(clone, 'player');
  assert.deepStrictEqual(clone, opsOriginal,
    'ops original unchanged after redaction');

  ok('non-mutation: ops unchanged after redactForSeat');
}

{
  // Components non-mutation
  const comps = {
    identity: { name: 'Test', kind: 'npc', description: '' },
    persona: { personality: 'secret' },
    agent: { enabled: true, accent: '#fff', controller: 'ai' },
  };
  const orig = structuredClone(comps);

  redactComponentsForSeat(comps, 'player');
  assert.deepStrictEqual(comps, orig,
    'components original unchanged after redactComponentsForSeat');

  ok('non-mutation: components unchanged after redactComponentsForSeat');
}

// ---- 7. Edge: non-snapshot/non-ops messages pass through ----

{
  const eventMsg = { type: 'event', name: 'narration', data: { text: 'hello' } };
  const result = redactForSeat(eventMsg, 'player');
  assert.deepStrictEqual(result, eventMsg,
    'event message passes through for player');
  ok('pass-through: event messages unchanged for non-dm');
}

{
  const errorMsg = { type: 'error', error: 'something went wrong' };
  const result = redactForSeat(errorMsg, 'player');
  assert.deepStrictEqual(result, errorMsg,
    'error message passes through for player');
  ok('pass-through: error messages unchanged for non-dm');
}

// ---- 8. Entity without private components is unchanged (deep clone) ----

{
  const redacted = redactForSeat(snapshotMsg, 'player');
  const pcHero = redacted.entities['pc-hero'];
  const origPc = snapshotMsg.entities['pc-hero'];

  // PC has no persona/knowledge/agent → should be deep-cloned but unchanged
  assert.deepStrictEqual(pcHero, origPc, 'pc-hero unchanged when no private comps');
  ok('pc-hero unchanged (no private components)');
}

console.log(`\n${passed} visibility checks passed.`);
