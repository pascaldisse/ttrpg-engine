/**
 * test/dsa.test.mjs — the moat test: DSA-style 3d20 roll-under mechanics on the
 * same engine seams that run 5e (d20-over) and Necrotopia (d6-over).
 *
 * Unit: probe math (FW compensation, QS, Erschwernis, crit/botch), AT/PA/RS
 * combat resolution, dc-0 survival through resolveCheck (the ?? fix).
 * Integration: the finsterwald campaign booted for real over WebSocket.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, connectClient, sleep, until } from './helpers.mjs';
import { registerChecks, resolveCheck } from '../shared/checks.js';
import { expandOp } from '../shared/effects.js';
import * as dsa from '../campaigns/finsterwald/ruleset/dsa5/ruleset.js';

/** rng stub that replays a fixed queue of die results. */
const mkRng = (queue) => ({ d: () => queue.shift(), int: (a) => a });

const HERO_STATS = {
  hp: 30, maxHp: 30, mu: 13, kl: 11, in: 12, ch: 11, ff: 11, ge: 13, ko: 12, kk: 13,
  at: 12, pa: 9, rs: 1, ini: 12,
  talente: { 'Sinnesschärfe': 5, 'Schleichen': 5 },
};

describe('DSA talent-probe (3d20 roll-under + FW + QS)', () => {
  const probe = dsa.checks['talent-probe'];

  test('overage within FW succeeds; leftover FW sets QS', () => {
    // Sinnesschärfe = KL/IN/IN → effective [11, 12, 12]. Rolls 12/12/13 → overage 1+0+1=2.
    const r = probe.resolve([12, 12, 13], 5, 0, probe, { stats: HERO_STATS, skill: 'Sinnesschärfe' });
    assert.equal(r.success, true);
    assert.equal(r.total, 3); // FW 5 - 2 spent
    assert.equal(r.qs, 1);
    assert.match(r.summary, /Sinnesschärfe/);
    assert.match(r.summary, /GELUNGEN \(QS 1\)/);
  });

  test('overage beyond FW fails', () => {
    const r = probe.resolve([13, 9, 18], 5, 0, probe, { stats: HERO_STATS, skill: 'Sinnesschärfe' });
    assert.equal(r.success, false); // overage 2+0+6 = 8 > FW 5
    assert.match(r.summary, /MISSLUNGEN/);
  });

  test('all dice under their attributes → full FW left → high QS', () => {
    const r = probe.resolve([2, 3, 1], 5, 0, probe, { stats: HERO_STATS, skill: 'Sinnesschärfe' });
    assert.equal(r.success, true);
    assert.equal(r.qs, 2); // ceil(5/3) = 2
  });

  test('Erschwernis lowers the effective attributes; Erleichterung raises them', () => {
    // dc +2: effective [9, 10, 10]; rolls 11/10/10 → overage 2 ≤ FW 5 → success.
    const hard = probe.resolve([11, 10, 10], 5, 2, probe, { stats: HERO_STATS, skill: 'Sinnesschärfe' });
    assert.equal(hard.success, true);
    assert.equal(hard.total, 3);
    // Same rolls at +5: effective [6, 7, 7] → overage 5+3+3 = 11 > 5 → fail.
    const brutal = probe.resolve([11, 10, 10], 5, 5, probe, { stats: HERO_STATS, skill: 'Sinnesschärfe' });
    assert.equal(brutal.success, false);
  });

  test('double 1 is a critical success even when FW cannot cover', () => {
    const r = probe.resolve([1, 1, 20], 0, 0, probe, { stats: HERO_STATS, skill: 'Klettern' });
    assert.equal(r.success, true);
    assert.equal(r.crit, true);
    assert.match(r.summary, /MEISTERLICH/);
  });

  test('double 20 is a botch even when the probe would pass', () => {
    const r = probe.resolve([20, 20, 1], 12, 0, probe, { stats: HERO_STATS, skill: 'Sinnesschärfe' });
    assert.equal(r.success, false);
    assert.equal(r.fumble, true);
    assert.match(r.summary, /PATZER/);
  });

  test('unknown talent falls back to MU/KL/IN at FW 0; English aliases map to triples', () => {
    const unk = probe.resolve([10, 10, 10], 0, 0, probe, { stats: HERO_STATS, skill: 'Gondelfahren' });
    assert.match(unk.summary, /\[MU\/KL\/IN\]/);
    const en = probe.resolve([10, 10, 10], 0, 0, probe, { stats: HERO_STATS, skill: 'stealth' });
    assert.match(en.summary, /\[MU\/IN\/GE\]/);
  });

  test('registered through the engine, dc 0 survives (?? not ||)', () => {
    registerChecks(dsa.checks);
    const rng = mkRng([12, 12, 13]);
    const r = resolveCheck({ check: 'talent-probe', skill: 'Sinnesschärfe', dc: 0 }, { stats: HERO_STATS }, rng);
    assert.equal(r.dc, 0, 'dc 0 must not decay to the d20 fallback of 10');
    assert.equal(r.success, true);
  });

  test('eigenschafts-probe: 1d20 roll-under a single attribute', () => {
    registerChecks(dsa.checks);
    const ok = resolveCheck({ check: 'eigenschafts-probe', ability: 'MU', dc: 0 }, { stats: HERO_STATS }, mkRng([13]));
    assert.equal(ok.success, true, 'W20(13) ≤ MU 13');
    const bad = resolveCheck({ check: 'eigenschafts-probe', ability: 'MU', dc: 2 }, { stats: HERO_STATS }, mkRng([12]));
    assert.equal(bad.success, false, 'W20(12) > MU 13-2');
  });
});

describe('DSA combat (Attacke / Parade / TP−RS)', () => {
  const entities = () => new Map([
    ['pc-a', { identity: { name: 'Alrik' }, stats: { ...HERO_STATS }, status: { alive: true }, flags: { damage: '1d6+2' }, position: { zoneId: 'hof' } }],
    ['npc-g', { identity: { name: 'Goblin' }, stats: { hp: 8, maxHp: 8, at: 10, pa: 6, rs: 1, ini: 11 }, status: { alive: true }, flags: { damage: '1d6' }, position: { zoneId: 'hof' } }],
  ]);

  test('hit through a failed parry: damage = TP − RS', () => {
    // AT d20=8 (≤12 hit) → parry d20=13 (>6 broken) → TP 1d6=4 (+2) = 6 − RS 1 = 5.
    const r = dsa.combat.resolveAttack({ attackerId: 'pc-a', targetId: 'npc-g' }, entities(), mkRng([8, 13, 4]));
    assert.equal(r.hit, true);
    assert.equal(r.damage, 5);
    assert.match(r.summary, /Treffer/);
    assert.match(r.summary, /durchbrochen/);
  });

  test('a successful Parade negates the hit', () => {
    const r = dsa.combat.resolveAttack({ attackerId: 'pc-a', targetId: 'npc-g' }, entities(), mkRng([8, 3]));
    assert.equal(r.hit, false);
    assert.match(r.summary, /pariert/);
  });

  test('AT roll of 1 crits: unparryable, TP doubled', () => {
    // AT d20=1 → no parry roll consumed → TP 1d6=5 (+2) = 7 ×2 = 14 − RS 1 = 13.
    const r = dsa.combat.resolveAttack({ attackerId: 'pc-a', targetId: 'npc-g' }, entities(), mkRng([1, 5]));
    assert.equal(r.hit, true);
    assert.equal(r.crit, true);
    assert.equal(r.damage, 13);
  });

  test('AT roll of 20 botches', () => {
    const r = dsa.combat.resolveAttack({ attackerId: 'pc-a', targetId: 'npc-g' }, entities(), mkRng([20]));
    assert.equal(r.hit, false);
    assert.equal(r.fumble, true);
  });

  test('speedOf reads INI (CTB order)', () => {
    assert.equal(dsa.combat.speedOf({ stats: { ini: 14 } }), 14);
    assert.equal(dsa.combat.speedOf({}), 8);
  });

  test('moving locations clears a stale combat zone', () => {
    const ents = entities();
    const ops = expandOp(ents, { op: 'move', id: 'pc-a', to: 'loc-elsewhere' });
    const zoneClear = ops.find((o) => o.component === 'position');
    assert.ok(zoneClear, 'move must clear position.zoneId');
    assert.equal(zoneClear.value.zoneId, null);
  });
});

describe('finsterwald campaign integration (real server, mock LLM)', () => {
  let srv;
  before(async () => {
    srv = await bootServer({ TTRPG_WORLD: 'campaigns/finsterwald', TTRPG_RULESET: 'dsa5' });
  });
  after(async () => { await srv.stop(); });

  test('boots the DSA ruleset and seeds Weyhersbrunn', async () => {
    assert.match(srv.getLog(), /Das Schwarze Auge/);
    const res = await fetch(`http://localhost:${srv.port}/health`);
    const health = await res.json();
    assert.ok(health.entities >= 15);
  });

  test('a narrative action rolls a 3W20 Talentprobe (not a d20 check)', async () => {
    const c = await connectClient(srv.port, 'Alrik');
    c.act('I examine the strange one-legged griffin carving above the bar');
    const roll = await until(() => c.ops.find((o) =>
      o.op === 'event' && o.name === 'system' && (o.data || {}).kind === 'roll'));
    assert.match(roll.data.text, /3W20/, `expected a Talentprobe, got: ${roll.data.text}`);
    assert.equal(roll.data.detail.rolls.length, 3, 'three dice, not one');
    c.ws.close();
  });

  test('walking to the mill and attacking starts AT/PA combat; enemies close zones', async () => {
    const c = await connectClient(srv.port, 'Alrik');
    c.act('go out onto the village square');
    await sleep(700);
    c.act('go east onto the forest path');
    await sleep(700);
    c.act('go down the track to the old mill');
    await sleep(900);
    c.act('attack Goblin Fetz');
    const start = await until(() => c.ops.find((o) =>
      o.op === 'event' && o.name === 'system' && /Combat begins/.test((o.data || {}).text || '')));
    assert.match(start.data.text, /Goblin/);

    // The engine's own AT/PA line proves DSA resolution ran inside combat.
    const atLine = await until(() => c.ops.find((o) =>
      o.op === 'event' && o.name === 'system' && /AT W20\(\d+\)/.test((o.data || {}).text || '')));
    assert.ok(atLine);
    c.sendOps([{ op: 'reset' }]);
    await sleep(400);
    c.ws.close();
  });

  test('multiplayer: a roaming second player starts combat at THEIR location', async () => {
    // Regression: hostiles/zones used to be scoped to the FIRST PC's location, so a
    // party member who walked to the mill alone could never start the fight there.
    const stay = await connectClient(srv.port, 'Homebody');   // claims pc-hero, stays at the inn
    const roam = await connectClient(srv.port, 'Wanderer');   // spawned party member
    await sleep(400);
    roam.act('go out onto the village square');
    await sleep(700);
    roam.act('go east onto the forest path');
    await sleep(700);
    roam.act('go down the track to the old mill');
    await sleep(900);
    roam.act('attack Goblin Fetz');
    const start = await until(() => roam.ops.find((o) =>
      o.op === 'event' && o.name === 'system' && /Combat begins/.test((o.data || {}).text || '')));
    assert.ok(start, 'the roaming player\'s attack must open the mill encounter');
    // The battlefield is the MILL: its authored zones must be attached.
    const encOp = await until(() => [...roam.ops].reverse().find((o) =>
      (o.op === 'set' && o.id === 'encounter' && o.value) ||
      (o.op === 'spawn' && o.id === 'encounter')));
    const enc = encOp.value || (encOp.components || {}).encounter;
    assert.ok((enc.zones || []).some((z) => z.id === 'muehlenhof'), 'mill zones attached, not the inn\'s');
    roam.sendOps([{ op: 'reset' }]);
    await sleep(400);
    stay.ws.close(); roam.ws.close();
  });
});
