/**
 * tools/smoke-dmview-s1.mjs — DMView Slice 1: per-seat visibility filter, end-to-end.
 *
 * Proves the leak is actually closed on the wire (not just in the pure unit test):
 * boot the real server, connect one client as a PLAYER and one as a DM, and confirm
 * the player's snapshot has NPC secrets/persona/agent-internals stripped while the
 * DM's snapshot is complete.
 *
 * Run: node tools/smoke-dmview-s1.mjs
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

const PORT = 8493;
const SAVE = 'dmview_s1_smoke';
const savePath = path.join(root, 'world', 'saves', `session_${SAVE}.json`);

/** Open a WS, send hello with `seat`, collect every snapshot; resolve the LAST one seen. */
function snapshotForSeat(seat) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const snaps = [];
    const timer = setTimeout(() => { ws.close(); resolve(snaps[snaps.length - 1] || null); }, 900);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', presence: { seat, who: `${seat}-smoke`, mode: 'play' }, presenceId: `presence-${seat}` }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'snapshot') snaps.push(msg.entities || {});
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  fs.rmSync(savePath, { force: true });
  const server = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(PORT), TTRPG_SAVE: SAVE },
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

    const playerSnap = await snapshotForSeat('player');
    const dmSnap = await snapshotForSeat('dm');
    if (!playerSnap || !dmSnap) throw new Error('did not receive snapshots');

    const pMarta = playerSnap['npc-marta'] || {};
    const dMarta = dmSnap['npc-marta'] || {};

    // Player must NOT see the NPC's private head.
    if (pMarta.knowledge) throw new Error('LEAK: player received npc-marta.knowledge');
    if (pMarta.persona) throw new Error('LEAK: player received npc-marta.persona');
    ok('player snapshot: npc-marta persona + knowledge (secrets) stripped');

    // Player keeps what they legitimately need to render.
    if (!pMarta.identity || !pMarta.place) throw new Error('player lost identity/place for npc-marta');
    if (pMarta.agent && (pMarta.agent.systemPrompt || pMarta.agent.controller)) {
      throw new Error('LEAK: player received agent internals');
    }
    if (pMarta.agent && pMarta.agent.accent === undefined) throw new Error('player lost agent.accent (needed for dialogue chip)');
    ok('player snapshot: identity/place kept, agent reduced to public fields (accent intact)');

    // DM sees everything.
    if (!dMarta.knowledge || !Array.isArray(dMarta.knowledge.secrets) || !dMarta.knowledge.secrets.length) {
      throw new Error('DM did not receive npc-marta.knowledge.secrets');
    }
    if (!dMarta.persona || !dMarta.persona.backstory) throw new Error('DM did not receive npc-marta.persona.backstory');
    ok('dm snapshot: full npc-marta (persona + knowledge.secrets) delivered');
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    fs.rmSync(savePath, { force: true });
    await sleep(150);
  }

  console.log(`\n${passed} DMView Slice 1 smoke checks passed.`);
  process.exit(0);
})().catch(err => { console.error('\n❌ DMVIEW S1 SMOKE FAILED:', err.message); process.exit(1); });
