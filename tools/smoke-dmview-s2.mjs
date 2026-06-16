/**
 * tools/smoke-dmview-s2.mjs — DMView Slices 2+3: pause/propose gate + agent traces.
 *
 * Boots the real server (mock LLM), connects a DM seat and a player seat, and proves:
 *   - DM toggles autopilot OFF (pause).
 *   - A player action that goes through LLM adjudication is HELD: the DM receives a
 *     {type:'proposal'}, the player receives NO consequence yet (gate works).
 *   - Agent traces ({type:'trace'}) reach the DM but never the player (Slice 3).
 *   - DM approves → the ruling executes and the consequence reaches the player.
 *
 * Run: node tools/smoke-dmview-s2.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

const PORT = 8494;
const SAVE = 'dmview_s2_smoke';
const savePath = path.join(root, 'world', 'saves', `session_${SAVE}.json`);

function openSeat(seat) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  ws.on('open', () => ws.send(JSON.stringify({
    type: 'hello', presence: { seat, who: seat, mode: 'play' }, presenceId: `presence-${seat}`,
  })));
  return { ws, msgs };
}
const has = (msgs, type) => msgs.some(m => m.type === type);
const pcOps = (msgs) => msgs.filter(m => m.type === 'ops')
  .flatMap(m => m.ops || []).filter(o => o.id === 'pc-hero' || o.id === 'item-key').length;

(async () => {
  fs.rmSync(savePath, { force: true });
  const server = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(PORT), TTRPG_SAVE: SAVE, TTRPG_SEED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { up = true; break; } } catch {}
      await sleep(100);
    }
    if (!up) throw new Error('server did not boot:\n' + log);

    // DM connects + pauses (autopilot off).
    const dm = openSeat('dm');
    await sleep(350);
    dm.ws.send(JSON.stringify({ type: 'dm-control', action: 'setAutopilot', value: false }));
    await sleep(250);

    // Player connects + acts (an LLM-adjudicated world action, not a fast-path).
    const player = openSeat('player');
    await sleep(350);
    player.ws.send(JSON.stringify({ type: 'ops', from: 'player', ops: [{ op: 'action', text: 'search the lockbox', by: 'player' }] }));
    await sleep(900);

    // Gate held: DM got a proposal; player got none and no consequence yet.
    const proposalMsg = dm.msgs.find(m => m.type === 'proposal');
    if (!proposalMsg) throw new Error('DM did not receive a proposal while paused:\n' + log);
    if (has(player.msgs, 'proposal')) throw new Error('LEAK: player received a proposal');
    const heldPcOps = pcOps(player.msgs);
    if (heldPcOps !== 0) throw new Error('gate failed: player already received a consequence before approval');
    ok('paused: player action staged as a DM-only proposal; no consequence reached the player');

    // Traces are DM-only.
    if (!has(dm.msgs, 'trace')) throw new Error('DM received no agent traces:\n' + log);
    if (has(player.msgs, 'trace')) throw new Error('LEAK: player received an agent trace');
    ok('agent traces reach the DM but never the player');

    // DM approves → ruling executes → consequence reaches the player.
    dm.ws.send(JSON.stringify({ type: 'dm-control', action: 'approve', proposalId: proposalMsg.proposal.id }));
    await sleep(1100);

    if (pcOps(player.msgs) <= heldPcOps) {
      throw new Error('after approval, no consequence (pc-hero/item-key op) reached the player:\n' + log);
    }
    if (!has(dm.msgs, 'proposal-resolved')) throw new Error('DM got no proposal-resolved ack');
    ok('approve: the held ruling executed and the consequence committed to the player');

    dm.ws.close(); player.ws.close();
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    fs.rmSync(savePath, { force: true });
    await sleep(150);
  }

  console.log(`\n${passed} DMView Slice 2+3 smoke checks passed.`);
  process.exit(0);
})().catch(err => { console.error('\n❌ DMVIEW S2 SMOKE FAILED:', err.message); process.exit(1); });
