/**
 * tools/smoke-dm-d3.mjs — RENDER grounding backstop over the live server (mock LLM).
 *
 * Asserts the Definition-of-Done for D3:
 *   - if a turn's narration NAMES an interactable actor that isn't in the scene, the
 *     demoted-canonize backstop catches it and SPAWNS it — so no pure-text character
 *     survives a turn (the world always matches what the DM said)
 *   - the conjured actor becomes a real, present entity with a ruleset stat block
 *
 * Run: node tools/smoke-dm-d3.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8487;
const SAVE = 'dmd3smoke';
const worldDir = path.join(root, 'campaigns/necrotopia');
const savePath = path.join(worldDir, 'saves', `session_${SAVE}.json`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

fs.rmSync(savePath, { force: true });
const server = spawn('node', ['server/index.js'], {
  cwd: root,
  env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(PORT), TTRPG_SAVE: SAVE, TTRPG_WORLD: worldDir, TTRPG_RULESET: 'necrotopia' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server not healthy:\n' + serverLog);
}
function cleanup(code) { try { server.kill('SIGKILL'); } catch {} fs.rmSync(savePath, { force: true }); process.exit(code); }

const messages = [];
let ws;
const allOps = () => messages.filter(m => m.type === 'ops').flatMap(m => m.ops || []);
function waitForOp(pred, ms, label) {
  return new Promise((resolve, reject) => {
    if (allOps().some(pred)) return resolve(true);
    const t = setTimeout(() => reject(new Error(`timeout: ${label}\n` + serverLog.split('\n').slice(-20).join('\n'))), ms);
    const h = (raw) => {
      const m = JSON.parse(raw); messages.push(m);
      if ((m.type === 'ops' ? (m.ops || []) : []).some(pred)) { clearTimeout(t); ws.off('message', h); resolve(true); }
    };
    ws.on('message', h);
  });
}
const sendMove = (text) => ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, by: 'player' }], from: 'player' }));
const sendOps = (ops) => ws.send(JSON.stringify({ type: 'ops', ops, from: 'player' }));
const q = async (p) => (await (await fetch(`http://localhost:${PORT}${p}`)).json());

const spawnedNamed = (name) => (o) => o.op === 'spawn' && o.components && o.components.identity && o.components.identity.name === name;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // PC alone on the Strip; no one named "Cole" exists yet.
  sendOps([{ op: 'merge', id: 'pc-hero', component: 'place', value: { locationId: 'loc-strip' } }]);
  await sleep(200);
  const pre = (await q('/sense/query?kind=npc')).results.find(r => r.id === 'npc-cole');
  if (pre) throw new Error('npc-cole already exists before the turn');
  ok('precondition: no actor named "Cole" exists');

  // A turn whose narration names an off-scene drifter — the prose introduced someone
  // who does not exist. The grounding backstop must make them real.
  sendMove('I wave the dust off and a wary drifter named Cole wanders up the cracked street');
  await waitForOp(spawnedNamed('Cole'), 8000, 'backstop spawns the named drifter');
  await sleep(300);
  ok('backstop: the prose-named drifter "Cole" was spawned into the world (no pure-text actor)');

  const cole = (await q('/sense/query?kind=npc')).results.find(r => r.id === 'npc-cole');
  if (!cole) throw new Error('npc-cole not present after backstop');
  const c = cole.components;
  if (c.place.locationId !== 'loc-strip') throw new Error('Cole not at the PC location');
  if (!(c.stats && c.stats.hp > 0)) throw new Error('Cole has no engine stat block');
  if (c.status.alive === false) throw new Error('Cole spawned dead');
  ok(`grounded: "Cole" is a living, present entity with a ruleset stat block (hp=${c.stats.hp})`);

  console.log(`\n${passed} DM-D3 grounding-backstop smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ DM-D3 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
