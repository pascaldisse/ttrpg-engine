/**
 * tools/smoke-p4-deepseek.mjs — P4 validation against the REAL DeepSeek model.
 *
 * Exercises the LLM-dependent P4 paths the mock cannot validate:
 *   A. adjudicate → check → narrateOutcome  (real JSON shape + outcome-aware prose)
 *   B. grounded canonize → take             (real model uses the scene's actual item id)
 *   C. adjudicate `move` backstop           (NL travel the deterministic fast-path misses)
 *
 * Requires .env with DEEPSEEK_API_KEY + LLM_PROVIDER=deepseek.
 * Run: node tools/smoke-p4-deepseek.mjs
 * The API key is read only from .env by the child process — never logged here.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8473;
const SAVE = 'p4ds';
const savePath = path.join(root, 'world', 'saves', `session_${SAVE}.json`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const redact = (s) => s.replace(/sk-[A-Za-z0-9]+/g, 'sk-***');

fs.rmSync(savePath, { force: true });
// --env-file-if-exists loads .env (incl. the key) into the child; we force deepseek + port/slot.
const server = spawn('node', ['--env-file-if-exists=.env', 'server/index.js'], {
  cwd: root,
  env: { ...process.env, LLM_PROVIDER: 'deepseek', TTRPG_PORT: String(PORT), TTRPG_SAVE: SAVE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server not healthy:\n' + redact(serverLog));
}

function cleanup(code) {
  try { server.kill('SIGKILL'); } catch {}
  fs.rmSync(savePath, { force: true });
  process.exit(code);
}

const messages = [];
let ws;
const allOps = () => messages.filter(m => m.type === 'ops').flatMap(m => m.ops || []);
function waitForOp(pred, ms, label) {
  return new Promise((resolve, reject) => {
    if (allOps().some(pred)) return resolve(true);
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    const h = (raw) => {
      const m = JSON.parse(raw); messages.push(m);
      if ((m.type === 'ops' ? (m.ops || []) : []).some(pred)) { clearTimeout(t); ws.off('message', h); resolve(true); }
    };
    ws.on('message', h);
  });
}
const send = (text) => ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, by: 'player' }], from: 'player' }));
const rollSeen = () => allOps().some(o => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'roll');
const narrationDone = (sinceIdx = 0) => (o) => o.op === 'event' && o.name === 'narration' && o.data && o.data.done === true;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

async function pcLocation() {
  const r = await (await fetch(`http://localhost:${PORT}/sense/query?kind=pc`)).json();
  const pc = r.results[0];
  return pc && pc.components.place ? pc.components.place.locationId : null;
}

(async () => {
  await waitForHealth();
  if (!/Using DeepSeekClient/.test(serverLog)) {
    throw new Error('server is NOT using DeepSeek (mock fallback?). Log:\n' + redact(serverLog));
  }
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(300);

  // A. adjudicate → (likely check) → narrateOutcome
  console.log('… turn A: "force the lockbox open with brute strength"');
  send('force the lockbox open with brute strength');
  await waitForOp(narrationDone(), 45000, 'narration completed (turn A)');
  console.log(`     roll requested by the model: ${rollSeen() ? 'yes' : 'no'}`);
  ok('adjudicate → narrateOutcome completed on real DeepSeek');

  // B. grounded canonize → take (real model must use the scene's real item id).
  // Wait on the torch-SPECIFIC relocation op so a stale inventory-set from turn A
  // can't satisfy it (the take expander always emits merge item-torch.place=pc).
  console.log('… turn B: "take the wall torch off the wall"');
  send('take the wall torch off the wall');
  await waitForOp(o => o.op === 'merge' && o.id === 'item-torch' && o.component === 'place',
    45000, 'torch relocated off the ground (grounded canonize → take)');
  await sleep(1500); // allow the full take batch (set inventory + merge place) to apply
  const carried = await (await fetch(`http://localhost:${PORT}/sense/query?at=pc-hero`)).json();
  const carriedIds = carried.results.map(r => r.id);
  const invQ = await (await fetch(`http://localhost:${PORT}/sense/query?kind=pc`)).json();
  const inv = (invQ.results[0].components.inventory || {}).items.map(i => i.id || i);
  if (!carriedIds.includes('item-torch') && !inv.includes('item-torch')) {
    throw new Error('torch not taken. carried=' + carriedIds + ' inv=' + inv);
  }
  ok('grounded canonize → take used the real item id (torch off the ground)');

  // C. movement via adjudicate move backstop. "I'd like to visit the docks" has a
  //    clear destination but no leading movement-gate verb, so the deterministic
  //    fast-path declines and the LLM `move` field must carry it.
  console.log('… turn C: "I\'d like to visit the docks"');
  const startLoc = await pcLocation();
  send("I'd like to visit the docks");
  await waitForOp(o => o.op === 'merge' && o.id === 'pc-hero' && o.component === 'place'
    && o.value && o.value.locationId && o.value.locationId !== startLoc, 45000, 'PC moved (move backstop)');
  await sleep(500);
  const endLoc = await pcLocation();
  if (endLoc === startLoc || !endLoc) throw new Error('PC did not move; loc=' + endLoc);
  console.log(`     moved ${startLoc} → ${endLoc}`);
  ok('adjudicate move backstop relocated the PC to a connected location');

  console.log(`\n${passed} P4 real-DeepSeek checks passed.`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ DEEPSEEK SMOKE FAILED:', redact(err.message));
  console.error('\n--- server log (tail) ---\n' + redact(serverLog.split('\n').slice(-20).join('\n')));
  cleanup(1);
});
