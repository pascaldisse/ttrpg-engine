/**
 * test/memory.test.mjs — lifelogs, living summaries, recall (P6).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryEngine, recall } from '../server/memory.js';
import { bootServer, connectClient, sleep, until } from './helpers.mjs';

/** Minimal session stub: entity map + journal + listener fan-out. */
function fakeSession() {
  const listeners = new Set();
  const session = {
    entities: new Map([
      ['world-state', { flags: {}, clock: { day: 2, phase: 'evening', ticks: 0 } }],
      ['pc-hero', { identity: { name: 'Alrik', kind: 'pc' }, place: { locationId: 'loc-a' }, agent: { controller: 'me' } }],
      ['npc-wirtin', { identity: { name: 'Travine', kind: 'npc' }, place: { locationId: 'loc-a' } }],
    ]),
    journal: [],
    onChange(fn) { listeners.add(fn); },
  };
  const applyAndBroadcast = (ops) => {
    for (const op of ops) {
      if (op.op === 'merge') {
        const comps = session.entities.get(op.id) || {};
        comps[op.component] = { ...(comps[op.component] || {}), ...op.value };
        session.entities.set(op.id, comps);
      }
      if (op.op === 'event' || op.op === 'action') {
        const entry = { ...op, seq: session.journal.length + 1 };
        session.journal.push(entry);
        for (const fn of listeners) fn(entry);
      }
    }
  };
  return { session, applyAndBroadcast };
}

describe('memory engine (unit)', () => {
  test('quest/combat events land in party lifelogs, clock-stamped', () => {
    const { session, applyAndBroadcast } = fakeSession();
    createMemoryEngine({ session, applyAndBroadcast, llm: null });

    applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'quest', phase: 'step', text: 'Reached the old mill.' } }]);
    applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'combat', phase: 'end', outcome: 'victory', text: 'The fight is over — you stand victorious.' } }]);

    const log = session.entities.get('pc-hero').lifelog;
    assert.equal(log.entries.length, 2);
    assert.match(log.entries[0], /^Day 2, evening: Reached the old mill\./);
    assert.match(log.entries[1], /victorious/);
  });

  test('NPCs remember their own words; consecutive duplicates dedupe', () => {
    const { session, applyAndBroadcast } = fakeSession();
    createMemoryEngine({ session, applyAndBroadcast, llm: null });

    applyAndBroadcast([{ op: 'event', name: 'dialogue', data: { by: 'npc-wirtin', done: true, text: 'Twenty silver, Held.' } }]);
    applyAndBroadcast([{ op: 'event', name: 'dialogue', data: { by: 'npc-wirtin', done: true, text: 'Twenty silver, Held.' } }]);

    const log = session.entities.get('npc-wirtin').lifelog;
    assert.equal(log.entries.length, 1, 'repeated line remembered once');
    assert.match(log.entries[0], /said to the party: "Twenty silver, Held\."/);
    // stream deltas (done:false) are ignored
    applyAndBroadcast([{ op: 'event', name: 'dialogue', data: { by: 'npc-wirtin', done: false, text: 'partial' } }]);
    assert.equal(session.entities.get('npc-wirtin').lifelog.entries.length, 1);
  });

  test('recall scores lifelogs and journal lines by keyword overlap', () => {
    const { session, applyAndBroadcast } = fakeSession();
    createMemoryEngine({ session, applyAndBroadcast, llm: null });
    applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'quest', phase: 'step', text: 'Drove the goblins from the mill.' } }]);
    applyAndBroadcast([{ op: 'event', name: 'dialogue', data: { by: 'npc-wirtin', done: true, text: 'The goblins fear something deeper in the woods.' } }]);

    const hits = recall(session, 'goblins mill');
    assert.ok(hits.length >= 2);
    assert.equal(hits[0].score >= hits[hits.length - 1].score, true, 'sorted by score');
    assert.ok(hits.some(h => /mill/i.test(h.line)));
    assert.deepEqual(recall(session, ''), []);
  });
});

describe('memory engine (integration, real server)', () => {
  let srv;
  before(async () => { srv = await bootServer({ TTRPG_WORLD: 'campaigns/finsterwald', TTRPG_RULESET: 'dsa5' }); });
  after(async () => { await srv.stop(); });

  test('reaching the mill writes the quest step into the PC lifelog; recall finds it', async () => {
    const c = await connectClient(srv.port, 'Alrik');
    c.act('go out onto the village square');
    await sleep(700);
    c.act('go east onto the forest path');
    await sleep(700);
    c.act('go down the track to the old mill');
    await sleep(1200);

    let hits = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const res = await fetch(`http://localhost:${srv.port}/sense/recall?q=mill`);
      hits = (await res.json()).hits || [];
      if (hits.length) break;
      await sleep(300);
    }
    assert.ok(hits.some(h => /mill/i.test(h.line)), 'recall surfaces the mill');
    c.ws.close();
  });
});
