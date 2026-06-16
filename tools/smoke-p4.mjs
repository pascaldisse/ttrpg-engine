/**
 * tools/smoke-p4.mjs — P4 end-to-end smoke test over the live server (mock LLM).
 *
 * Boots the real server with LLM_PROVIDER=mock and a throwaway save slot, then
 * drives a session over WebSocket to verify:
 *   1. take → item leaves the ground, enters inventory (via canonize)
 *   2. location-scoped routing → the present NPC answers
 *   3. movement → the PC relocates to a connected location
 *   4. cross-room isolation → an NPC left behind does NOT answer
 *
 * Run: node tools/smoke-p4.mjs   (no API key needed)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8472;
const SAVE = 'p4smoke';
const savePath = path.join(root, 'world', 'saves', `session_${SAVE}.json`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- boot server ----
fs.rmSync(savePath, { force: true }); // start from a clean seed
const server = spawn('node', ['server/index.js'], {
  cwd: root,
  env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(PORT), TTRPG_SAVE: SAVE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not become healthy:\n' + serverLog);
}

function cleanup(code) {
  try { server.kill('SIGKILL'); } catch {}
  fs.rmSync(savePath, { force: true });
  process.exit(code);
}

// ---- message-stream helpers ----
const messages = [];
let ws;

/** All ops seen across every broadcast so far, flattened. */
function allOps() {
  return messages.filter(m => m.type === 'ops').flatMap(m => m.ops || []);
}

/** Wait until `pred(op)` is true for some broadcast op, or timeout. */
function waitForOp(pred, ms, label) {
  return new Promise((resolve, reject) => {
    if (allOps().some(pred)) return resolve(true);
    const t = setTimeout(() => reject(new Error(`timeout waiting for: ${label}`)), ms);
    const handler = (raw) => {
      const m = JSON.parse(raw);
      messages.push(m);
      if ((m.type === 'ops' ? (m.ops || []) : []).some(pred)) {
        clearTimeout(t); ws.off('message', handler); resolve(true);
      }
    };
    ws.on('message', handler);
  });
}

function send(text) {
  ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, by: 'player' }], from: 'player' }));
}

const isDialogueBy = (npc) => (op) =>
  op.op === 'event' && op.name === 'dialogue' && op.data && op.data.by === npc;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  // collect every message
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200); // receive initial snapshot

  // 1. TAKE — pick up the torch in the tavern
  send('take the torch');
  await waitForOp(op => op.op === 'merge' && op.id === 'item-torch' && op.component === 'place', 8000,
    'item-torch relocated off the ground (take)');
  // verify final state via HTTP sense (carried = place.locationId === pc-hero)
  const carried = await (await fetch(`http://localhost:${PORT}/sense/query?at=pc-hero`)).json();
  const carriedIds = carried.results.map(r => r.id);
  if (!carriedIds.includes('item-torch')) throw new Error('torch not carried after take: ' + carriedIds);
  ok('take: torch leaves the ground and is carried by the PC');

  // 2. SCOPED ROUTING (tavern) — Marta is present and answers
  send('@marta good evening');
  await waitForOp(isDialogueBy('npc-marta'), 8000, 'Marta answers in the tavern');
  ok('routing: the co-located NPC (Marta) answers in the tavern');

  // 3. MOVEMENT — travel to the docks (deterministic fast-path)
  send('go to the docks');
  await waitForOp(op => op.op === 'merge' && op.id === 'pc-hero' && op.component === 'place'
    && op.value && op.value.locationId === 'loc-docks', 8000, 'PC moved to the docks');
  const loc = await (await fetch(`http://localhost:${PORT}/sense/look`)).json();
  if (!/The Docks/.test(loc.look) || /Marta/.test(loc.look)) {
    throw new Error('look not re-scoped to docks:\n' + loc.look);
  }
  ok('movement: PC relocated to the docks and the scene re-scoped');

  // 4. SCOPED ROUTING (docks) — Jonas answers here
  send('@jonas hello there');
  await waitForOp(isDialogueBy('npc-jonas'), 8000, 'Jonas answers at the docks');
  ok('routing: the docks NPC (Jonas) answers after travel');

  // 5. ISOLATION — Marta must NOT answer at the docks (she was left behind)
  await sleep(700); // drain any in-flight dialogue streams from prior steps first
  const before = messages.length;
  send('@marta are you there?');
  await sleep(1800);
  const martaSpokeAtDocks = messages.slice(before).flatMap(m => m.type === 'ops' ? m.ops : [])
    .some(isDialogueBy('npc-marta'));
  if (martaSpokeAtDocks) throw new Error('Marta answered from another room — scoping broken');
  ok('isolation: the absent NPC (Marta) does NOT answer from another room');

  console.log(`\n${passed} P4 smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ SMOKE FAILED:', err.message);
  console.error('\n--- server log ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  cleanup(1);
});
