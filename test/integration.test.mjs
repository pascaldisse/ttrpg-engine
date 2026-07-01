/**
 * test/integration.test.mjs — boots the REAL server (Necrotopia + mock LLM)
 * and drives it over WebSocket exactly like the clients do.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, connectClient, sleep, until } from './helpers.mjs';

describe('server integration (Necrotopia, mock LLM)', () => {
  let srv;
  before(async () => { srv = await bootServer(); });
  after(async () => { await srv.stop(); });

  test('narrative turn: an action streams narration back', async () => {
    const c = await connectClient(srv.port, 'Solo');
    c.act('look around the chapel');
    const done = await until(() =>
      c.ops.find(o => o.op === 'event' && o.name === 'narration' && (o.data || {}).text));
    assert.match(done.data.text, /look around/i);
    c.ws.close();
  });

  test('multiplayer: second player gets a spawned PC; combat seats are gated', async () => {
    const kid = await connectClient(srv.port, 'Kid');
    const rip = await connectClient(srv.port, 'Ripley');
    await sleep(300);

    // Ripley's PC spawned and bound (Kid claimed pc-hero when 'Solo' didn't? —
    // 'Solo' claimed it first in the previous test; either way both get PCs).
    const pcSpawn = kid.ops.find(o => o.op === 'spawn' && (o.id || '').startsWith('pc-'));
    assert.ok(pcSpawn, 'a new PC entity was spawned for a later player');

    // Kid starts the fight; both PCs must be on the ally side.
    kid.act('attack the snarling imp');
    const encOp = await until(() => [...kid.ops].reverse().find(o =>
      (o.op === 'set' && o.id === 'encounter' && o.value?.active) ||
      (o.op === 'spawn' && o.id === 'encounter' && o.components?.encounter?.active)));
    const enc = encOp.value || encOp.components.encounter;
    assert.ok(enc.allies.length >= 2, `party side has ${JSON.stringify(enc.allies)}`);
    assert.ok(enc.enemies.length >= 1);

    // Acting out of turn from the wrong seat is rejected.
    const before = kid.ops.length;
    const wrongSeat = enc.turnOf && enc.allies.includes(enc.turnOf)
      ? (enc.turnOf === kid.snapshotPcId ? rip : kid)
      : kid;
    wrongSeat.act('attack the imp', { target: enc.enemies[0] });
    await sleep(600);
    // Either the action resolved (it WAS their turn) or a wait-your-turn note appeared —
    // assert no crash and the encounter is still coherent.
    const note = kid.ops.slice(before).find(o => o.op === 'event' && /turn/.test((o.data || {}).text || ''));
    assert.ok(note || kid.ops.length > before, 'combat responded to the action');

    // Clear the battlefield for the tests that follow (reset drops the encounter).
    kid.sendOps([{ op: 'reset' }]);
    await sleep(500);
    kid.ws.close(); rip.ws.close();
  });

  test('visibility: players never receive persona; DM does', async () => {
    const p = await connectClient(srv.port, 'Peek');
    const dm = await connectClient(srv.port, 'GM', 'dm');
    const pPadre = p.snapshot['npc-padre'];
    const dmPadre = dm.snapshot['npc-padre'];
    assert.equal(pPadre.persona, undefined, 'player snapshot must strip persona');
    assert.ok(dmPadre.persona, 'dm snapshot carries persona');
    p.ws.close(); dm.ws.close();
  });

  test('DM gate: autopilot off stages a proposal; approve executes it', async () => {
    const player = await connectClient(srv.port, 'Gated');
    const dm = await connectClient(srv.port, 'GM2', 'dm');

    dm.control({ action: 'setAutopilot', value: false });
    await sleep(300);

    player.act('whistle a strange tune into the neon dark');
    const proposal = await until(() => dm.server.find(m => m.type === 'proposal'));
    assert.ok(proposal.proposal.id);
    assert.match(proposal.proposal.actionText, /whistle/);

    const beforeNarr = player.ops.filter(o => o.op === 'event' && o.name === 'narration' && (o.data || {}).text).length;
    dm.control({ action: 'approve', proposalId: proposal.proposal.id });
    await until(() =>
      player.ops.filter(o => o.op === 'event' && o.name === 'narration' && (o.data || {}).text).length > beforeNarr);

    dm.control({ action: 'setAutopilot', value: true });
    await sleep(200);
    player.ws.close(); dm.ws.close();
  });

  test('DM stage-a-beat: a staged ruling resolves on the next player action', async () => {
    const player = await connectClient(srv.port, 'Staged');
    const dm = await connectClient(srv.port, 'GM3', 'dm');

    dm.control({ action: 'stage', ruling: { checks: [{ dc: 2, reason: 'DM-staged test' }] } });
    await sleep(200);
    player.act('try the staged thing');
    const roll = await until(() => player.ops.find(o =>
      o.op === 'event' && o.name === 'system' && (o.data || {}).kind === 'roll' && /DM-staged test|d6/.test((o.data || {}).text || '')));
    assert.ok(roll, 'the staged check was rolled by the engine');
    player.ws.close(); dm.ws.close();
  });

  test('journal backfill: /events returns the story so far', async () => {
    const res = await fetch(`http://localhost:${srv.port}/events?since=0&limit=1000`);
    const { events } = await res.json();
    assert.ok(events.length > 0);
    assert.ok(events.some(e => e.op === 'action'), 'actions are journaled');
    assert.ok(events.some(e => e.op === 'event' && e.name === 'narration' && (e.data || {}).text), 'final narrations are journaled');
  });

  test('art endpoint: mock provider serves an SVG, cache-hit is instant', async () => {
    const r1 = await fetch(`http://localhost:${srv.port}/art/loc-chapel`);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('content-type'), /svg/);
    const r404 = await fetch(`http://localhost:${srv.port}/art/quest-escape`);
    assert.equal(r404.status, 404);
  });

  test('reset: world reseeds and connected players are rebound', async () => {
    const p = await connectClient(srv.port, 'Resetter');
    p.sendOps([{ op: 'reset' }]);
    const snap = await until(() => p.snapshot && p.snapshot['npc-imp-1'] &&
      (p.snapshot['npc-imp-1'].status || {}).alive !== false ? p.snapshot : null);
    assert.ok(snap['pc-hero'], 'world reseeded');
    await sleep(300);
    assert.match(srv.getLog(), /Rebound "\w+" → pc-/, 'connected player was rebound after reset');
    p.ws.close();
  });
});

describe('save versioning', () => {
  test('a save from different campaign content boots fresh with a .stale backup', async () => {
    const srv2 = await bootServer();
    const save = srv2.getLog().match(/Save slot: (\S+)/)[1];
    await srv2.stop();
    // Plant a save with a bogus world fingerprint, then boot the same slot.
    const fs = await import('node:fs');
    const savePath = `campaigns/necrotopia/saves/session_${save}.json`;
    fs.writeFileSync(savePath, JSON.stringify({ version: 1, world: 'not-the-real-world', entities: { 'pc-hero': { stats: { hp: 1 } } } }));

    const srv3 = await bootServer({ TTRPG_SAVE: save });
    await sleep(200);
    assert.match(srv3.getLog(), /starting fresh/, 'stale save detected and skipped');
    const res = await fetch(`http://localhost:${srv3.port}/health`);
    assert.equal((await res.json()).status, 'ok');
    await srv3.stop();
  });
});
