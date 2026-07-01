/**
 * test/clock.test.mjs — the breathing world's deterministic half.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tick, clockOf, clockLine, phaseBanner, scheduleMoves, ambientLine, PHASES, TICKS_PER_PHASE } from '../shared/clock.js';

describe('world clock', () => {
  test('ticks accumulate; the phase turns after TICKS_PER_PHASE', () => {
    let ws = { clock: { day: 1, phase: 'morning', ticks: 0 } };
    for (let i = 0; i < TICKS_PER_PHASE - 1; i++) {
      const r = tick(ws);
      assert.equal(r.phaseChanged, false);
      ws = { clock: r.clock };
    }
    const r = tick(ws);
    assert.equal(r.phaseChanged, true);
    assert.equal(r.clock.phase, 'afternoon');
    assert.equal(r.clock.ticks, 0);
  });

  test('night rolls into the next morning and increments the day', () => {
    const r = tick({ clock: { day: 3, phase: 'night', ticks: TICKS_PER_PHASE - 1 } });
    assert.equal(r.phaseChanged, true);
    assert.equal(r.clock.phase, 'morning');
    assert.equal(r.clock.day, 4);
    assert.match(phaseBanner(r.clock), /Day 4/);
  });

  test('missing clock defaults sanely; clockLine reads well', () => {
    assert.deepEqual(clockOf({}), { day: 1, phase: 'morning', ticks: 0 });
    assert.equal(clockLine({ clock: { day: 2, phase: 'evening' } }), 'Day 2, evening');
  });

  test('scheduleMoves: due NPCs walk; the dead, the fighting, and the settled stay', () => {
    const entities = new Map([
      ['loc-a', { identity: { kind: 'location' } }],
      ['loc-b', { identity: { kind: 'location' } }],
      ['npc-walker', { identity: { kind: 'npc' }, status: { alive: true }, place: { locationId: 'loc-a' }, schedule: { evening: 'loc-b' } }],
      ['npc-settled', { identity: { kind: 'npc' }, status: { alive: true }, place: { locationId: 'loc-b' }, schedule: { evening: 'loc-b' } }],
      ['npc-dead', { identity: { kind: 'npc' }, status: { alive: false }, place: { locationId: 'loc-a' }, schedule: { evening: 'loc-b' } }],
      ['npc-fighting', { identity: { kind: 'npc' }, status: { alive: true }, place: { locationId: 'loc-a' }, schedule: { evening: 'loc-b' } }],
      ['encounter', { encounter: { active: true, enemies: ['npc-fighting'], allies: [] } }],
    ]);
    const moves = scheduleMoves(entities, 'evening');
    assert.deepEqual(moves, [{ op: 'move', id: 'npc-walker', to: 'loc-b' }]);
    // no schedule for morning → nobody moves
    assert.deepEqual(scheduleMoves(entities, 'morning'), []);
  });

  test('ambientLine: phase-keyed and flat pools both work; empty → null', () => {
    const keyed = { flags: { ambient: { evening: ['Candles.'], night: ['Dark.'] } } };
    assert.equal(ambientLine(keyed, 'evening'), 'Candles.');
    assert.equal(ambientLine(keyed, 'morning'), null);
    const flat = { flags: { ambient: ['One.', 'Two.'] } };
    assert.ok(['One.', 'Two.'].includes(ambientLine(flat, 'afternoon', 1)));
    assert.equal(ambientLine({}, 'evening'), null);
    // deterministic pick
    assert.equal(ambientLine(flat, 'evening', 2), ambientLine(flat, 'evening', 2));
  });

  test('phases cycle in canon order', () => {
    assert.deepEqual(PHASES, ['morning', 'afternoon', 'evening', 'night']);
  });
});
