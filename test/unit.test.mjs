/**
 * test/unit.test.mjs — pure shared-module tests (no server, no network).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseModelOutput } from '../shared/parse.js';
import { expandOp } from '../shared/effects.js';
import { validateOp } from '../shared/ops.js';
import { resolveCheck, registerChecks, CHECK_DEFS } from '../shared/checks.js';
import { findPc, findPcs, findPcFor, locationOf, pcLocationId, entitiesAt, resolveExit } from '../shared/space.js';
import { bindPlayerPc, resolveActorSpawn } from '../shared/staging.js';
import { redactForSeat, redactComponentsForSeat, seatSees } from '../shared/visibility.js';
import { triggerMet } from '../shared/quest-triggers.js';
import { buildTimeline, advanceTimeline, projectQueue } from '../shared/combat-rules.js';
import { buildLookFrame } from '../shared/context.js';

// ---- fixtures ----

function world() {
  return new Map(Object.entries({
    'loc-a': { identity: { name: 'The Yard', kind: 'location' }, place: { connections: [{ targetId: 'loc-b', label: 'through the gate' }] } },
    'loc-b': { identity: { name: 'The Keep', kind: 'location' }, place: { connections: [] } },
    'pc-hero': { identity: { name: 'Hero', kind: 'pc' }, place: { locationId: 'loc-a' }, stats: { hp: 10, maxHp: 10 }, status: { alive: true }, inventory: { items: [] } },
    'npc-guard': { identity: { name: 'Guard', kind: 'npc' }, place: { locationId: 'loc-a' }, status: { alive: true }, persona: { personality: 'gruff' }, agent: { enabled: true, controller: 'ai', systemPrompt: 'secret' } },
  }));
}

// ---- parse.js — B1 regression: the FULL object must survive ----

describe('parse.parseModelOutput', () => {
  test('returns the full parsed object (speakTo/move/spawns/beginCombat survive)', () => {
    const raw = JSON.stringify({ speakTo: 'npc-guard', move: { to: 'loc-b' }, spawns: [{ archetype: 'imp' }], beginCombat: true, ops: [], checks: [] });
    const r = parseModelOutput(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.speakTo, 'npc-guard');
    assert.deepEqual(r.value.move, { to: 'loc-b' });
    assert.equal(r.value.spawns.length, 1);
    assert.equal(r.value.beginCombat, true);
  });

  test('one malformed op does NOT nuke the parse', () => {
    const raw = JSON.stringify({ ops: [{ op: 'openDoor', id: 'x' }, { op: 'damage', id: 'pc-hero', amount: 3 }] });
    const r = parseModelOutput(raw);
    assert.equal(r.ok, true);
    assert.equal(r.value.ops.length, 2); // validation happens at application, not here
  });

  test('strips ```json fences and extracts balanced objects', () => {
    assert.equal(parseModelOutput('```json\n{"a":1}\n```').value.a, 1);
    assert.equal(parseModelOutput('Sure! Here: {"a":{"b":2}} hope that helps').value.a.b, 2);
    assert.equal(parseModelOutput('not json at all').ok, false);
    assert.equal(parseModelOutput('').ok, false);
  });
});

// ---- effects.js ----

describe('effects.expandOp', () => {
  test('damage clamps at 0 and marks dead', () => {
    const w = world();
    const ops = expandOp(w, { op: 'damage', id: 'pc-hero', amount: 99 });
    const hpOp = ops.find(o => o.component === 'stats');
    const deadOp = ops.find(o => o.component === 'status');
    assert.equal(hpOp.value.hp, 0);
    assert.equal(deadOp.value.alive, false);
  });

  test('giveItem stacks qty instead of silently dropping (B7 regression)', () => {
    const w = world();
    const first = expandOp(w, { op: 'giveItem', id: 'pc-hero', item: { id: 'potion', name: 'Potion' } });
    w.get('pc-hero').inventory = first[0].value; // apply
    const second = expandOp(w, { op: 'giveItem', id: 'pc-hero', item: { id: 'potion', name: 'Potion' } });
    assert.equal(second.length, 1, 'second grant must not be a no-op');
    const item = second[0].value.items.find(i => i.id === 'potion');
    assert.equal(item.qty, 2);
  });

  test('unknown op passes through for the validator to reject', () => {
    const ops = expandOp(world(), { op: 'openDoor', id: 'x' });
    assert.equal(ops.length, 1);
    assert.equal(validateOp(ops[0]).ok, false);
  });
});

// ---- checks.js ----

describe('checks.resolveCheck', () => {
  const rng = { d: () => 4, int: (a) => a, next: () => 0.5 };

  test('5e ability-check adds modifier vs DC', () => {
    const r = resolveCheck({ check: 'ability-check', ability: 'str', dc: 12 }, { stats: { str: 16 } }, rng);
    assert.equal(r.total, 7); // d20(4) + mod(3)
    assert.equal(r.success, false);
  });

  test('registered ruleset check overrides resolution (rules-as-data)', () => {
    registerChecks({
      'test-d6': {
        dice: { count: 1, sides: 6 }, comparator: 'ge', modSource: () => 0,
        resolve: (rolls, _m, dc) => ({ rolls, modifier: 0, total: rolls[0], dc, success: rolls[0] >= dc, margin: 0, crit: false, fumble: false, summary: 'x', outcome: 'y' }),
      },
    });
    const r = resolveCheck({ check: 'test-d6', dc: 4 }, {}, rng);
    assert.equal(r.total, 4);
    assert.equal(r.success, true);
    delete CHECK_DEFS['test-d6'];
  });
});

// ---- space.js (multiplayer primitives) ----

describe('space multiplayer', () => {
  test('findPcFor resolves controller binding, name, unbound, first', () => {
    const w = world();
    w.set('pc-two', { identity: { name: 'Ripley', kind: 'pc' }, place: { locationId: 'loc-b' }, agent: { controller: 'rip' } });
    assert.equal(findPcFor(w, 'rip')[0], 'pc-two');
    assert.equal(findPcFor(w, 'Ripley')[0], 'pc-two');       // name match
    assert.equal(findPcFor(w, 'somebody-new')[0], 'pc-hero'); // unbound fallback
    assert.equal(findPcFor(w, undefined)[0], 'pc-hero');      // first
    assert.equal(findPcs(w).length, 2);
    assert.equal(pcLocationId(w, 'pc-two'), 'loc-b');
    assert.equal(locationOf(w, 'npc-guard'), 'loc-a');
  });

  test('resolveExit matches phrases, rejects ambiguity', () => {
    const w = world();
    assert.equal(resolveExit(w, 'loc-a', 'go through the gate'), 'loc-b');
    assert.equal(resolveExit(w, 'loc-a', 'dance wildly'), null);
  });
});

// ---- staging.js (PC binding) ----

describe('staging.bindPlayerPc', () => {
  test('claims the unbound PC, then reconnects to it', () => {
    const w = world();
    const first = bindPlayerPc('Kid', w, null);
    assert.equal(first.pcId, 'pc-hero');
    assert.equal(first.ops[0].op, 'merge');
    w.get('pc-hero').agent = { controller: 'Kid' }; // apply
    const again = bindPlayerPc('Kid', w, null);
    assert.equal(again.pcId, 'pc-hero');
    assert.equal(again.ops.length, 0, 'reconnect must not re-claim');
  });

  test('spawns a party member from the first-PC chassis when all PCs are bound', () => {
    const w = world();
    w.get('pc-hero').agent = { controller: 'Kid' };
    w.get('pc-hero').stats = { hp: 3, maxHp: 12, level: 4, xp: 900 };
    const bind = bindPlayerPc('Ripley', w, null);
    assert.equal(bind.ops[0].op, 'spawn');
    const comps = bind.ops[0].components;
    assert.equal(comps.identity.name, 'Ripley');
    assert.equal(comps.stats.hp, 12, 'fresh character starts at full health');
    assert.equal(comps.stats.level, 1);
    assert.equal(comps.agent.controller, 'Ripley');
    assert.equal(comps.place.locationId, 'loc-a', 'joins at the party location');
  });

  test('ruleset player template wins over chassis-clone', () => {
    const w = world();
    w.get('pc-hero').agent = { controller: 'Kid' };
    const bind = bindPlayerPc('Zed', w, { player: { stats: { hp: 6, maxHp: 6 }, moves: { list: [{ name: 'Bite' }] } } });
    assert.equal(bind.ops[0].components.moves.list[0].name, 'Bite');
  });
});

// ---- staging.js (actor spawn) ----

describe('staging.resolveActorSpawn', () => {
  const templates = { imp: { name: 'Imp', stats: { hp: 4, maxHp: 4 }, faction: 'hostile', moves: { list: [{ name: 'Claw', damage: '1d3' }] } } };

  test('spawns from template with unique ids', () => {
    const w = world();
    const op1 = resolveActorSpawn({ archetype: 'imp', place: 'loc-a' }, templates, w);
    assert.equal(op1.components.flags.hostile, true);
    w.set(op1.id, op1.components);
    const op2 = resolveActorSpawn({ archetype: 'imp', place: 'loc-a' }, templates, w);
    assert.notEqual(op1.id, op2.id);
  });

  test('no template and no stats → no spawn power', () => {
    assert.equal(resolveActorSpawn({ archetype: 'dragon' }, null, world()), null);
  });
});

// ---- visibility.js ----

describe('visibility', () => {
  test('players never receive persona/knowledge; agent reduced but controller public', () => {
    const comps = world().get('npc-guard');
    const red = redactComponentsForSeat(comps, 'player');
    assert.equal(red.persona, undefined);
    assert.equal(red.agent.systemPrompt, undefined);
    assert.equal(red.agent.controller, 'ai', 'controller is public (multiplayer HUD)');
    const full = redactComponentsForSeat(comps, 'dm');
    assert.equal(full.persona.personality, 'gruff');
  });

  test('audience gating', () => {
    assert.equal(seatSees('dm', 'player'), false);
    assert.equal(seatSees('dm', 'dm'), true);
    assert.equal(seatSees('all', 'player'), true);
    assert.equal(seatSees('players', 'dm'), false);
  });

  test('ops messages drop private component ops entirely', () => {
    const msg = { type: 'ops', ops: [{ op: 'set', id: 'npc-guard', component: 'persona', value: { personality: 'x' } }] };
    assert.equal(redactForSeat(msg, 'player'), null);
    assert.notEqual(redactForSeat(msg, 'dm'), null);
  });
});

// ---- quest-triggers.js (party-aware) ----

describe('quest triggers (party-aware)', () => {
  test('atLocation satisfied by ANY living PC', () => {
    const w = world();
    w.set('pc-two', { identity: { kind: 'pc', name: 'Two' }, place: { locationId: 'loc-b' }, status: { alive: true } });
    assert.equal(triggerMet({ type: 'atLocation', id: 'loc-b' }, w), true);
    assert.equal(triggerMet({ type: 'atLocation', id: 'loc-a' }, w), true);
  });

  test('hasItem satisfied by ANY PC carrying it', () => {
    const w = world();
    w.set('pc-two', { identity: { kind: 'pc', name: 'Two' }, place: { locationId: 'loc-b' }, status: { alive: true }, inventory: { items: [{ id: 'keys' }] } });
    assert.equal(triggerMet({ type: 'hasItem', id: 'keys' }, w), true);
    assert.equal(triggerMet({ type: 'hasItem', id: 'sword' }, w), false);
  });
});

// ---- combat-rules.js (CTB timeline) ----

describe('combat timeline', () => {
  test('buildTimeline + advanceTimeline drive a speed-ordered queue', () => {
    const w = world();
    w.set('npc-imp', { identity: { name: 'Imp', kind: 'npc' }, stats: { hp: 4, maxHp: 4 }, status: { alive: true } });
    const enc = buildTimeline({ allies: ['pc-hero'], enemies: ['npc-imp'] }, w, {});
    assert.equal(enc.mode, 'timeline');
    assert.ok(enc.turnOf, 'someone acts first');
    const q = projectQueue(enc, w, {}, 4);
    assert.equal(q.length, 4);
    const next = advanceTimeline(enc, enc.turnOf, 1, w, {});
    assert.ok(next.turnOf, 'timeline advances to a next actor');
  });
});

// ---- context.js (party look frame) ----

describe('context.buildLookFrame', () => {
  test('scopes to the acting PC and marks it in the party list', () => {
    const w = world();
    w.set('pc-two', { identity: { name: 'Ripley', kind: 'pc' }, place: { locationId: 'loc-a' }, stats: { hp: 5, maxHp: 5 }, agent: { controller: 'rip' } });
    const frame = buildLookFrame(w, 'pc-two');
    assert.match(frame, /Ripley.*← ACTING/);
    assert.match(frame, /The Yard/);
    const frameB = buildLookFrame(w, 'pc-hero');
    assert.match(frameB, /Hero.*← ACTING/);
  });
});
