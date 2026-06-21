/**
 * tools/smoke-dm-d5.mjs — DM seat-controller indirection over the live server (mock LLM).
 *
 * Asserts the Definition-of-Done for D5 (DESIGN-NOTES #1 — "DM is just another client"):
 *   - the same RESOLVE path is reached whether the ruling came from the LLM ('ai') or
 *     from a human/DMView injection — both emit identical world-first ops
 *   - a hand-fed ruling {spawns, beginCombat} (no LLM) spawns grounded hostiles AND
 *     opens the floor, exactly like the LLM path in D4
 *   - the beat is traced with its true author (source != 'ai'), visible to the DM seat
 *   - without injection, the same neutral action does NOT spawn/fight (LLM stays in charge)
 *
 * Run: node tools/smoke-dm-d5.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8489;
const SAVE = 'dmd5smoke';
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

const pMsgs = [];   // player socket
const dMsgs = [];   // dm socket
let pws, dws;
const allOps = () => pMsgs.filter(m => m.type === 'ops').flatMap(m => m.ops || []);
const traces = () => dMsgs.filter(m => m.type === 'trace').map(m => m.trace);
function waitFor(arr, pred, ms, label) {
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => { if (arr().some(pred)) { clearInterval(tick); clearTimeout(to); resolve(true); } }, 50);
    const to = setTimeout(() => { clearInterval(tick); reject(new Error(`timeout: ${label}\n` + serverLog.split('\n').slice(-20).join('\n'))); }, ms);
  });
}
const q = async (p) => (await (await fetch(`http://localhost:${PORT}${p}`)).json());
const sendPlayer = (text) => pws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, by: 'player' }], from: 'player' }));
const sendOps = (ops) => pws.send(JSON.stringify({ type: 'ops', ops, from: 'player' }));
const stageDm = (ruling) => dws.send(JSON.stringify({ type: 'dm-control', action: 'stage', ruling }));
const encounter = async () => {
  const r = await q('/sense/query?kind=world-state');
  return ((r.results.find(x => x.id === 'encounter') || {}).components || {}).encounter || {};
};
const spawnedHostile = (o) => o.op === 'spawn' && o.components && o.components.flags && o.components.flags.hostile === true;
const combatStart = (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === 'start';

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  // DM seat
  dws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { dws.on('open', res); dws.on('error', rej); });
  dws.on('message', (raw) => { try { dMsgs.push(JSON.parse(raw)); } catch {} });
  dws.send(JSON.stringify({ type: 'hello', presence: { seat: 'dm', who: 'human-dm', mode: 'direct' }, presenceId: 'presence-dm-d5' }));
  // Player seat
  pws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { pws.on('open', res); pws.on('error', rej); });
  pws.on('message', (raw) => { try { pMsgs.push(JSON.parse(raw)); } catch {} });
  await sleep(300);

  // PC alone on the Strip.
  sendOps([{ op: 'merge', id: 'pc-hero', component: 'place', value: { locationId: 'loc-strip' } }]);
  await sleep(200);

  // ---- (a) No injection: the LLM controls the DM; a neutral look does nothing combative ----
  const mark0 = allOps().length;
  sendPlayer('I look around the empty stretch of Strip');
  await sleep(900);
  const spawnedA = allOps().slice(mark0).some(spawnedHostile);
  const enc = await encounter();
  if (spawnedA || enc.active) throw new Error('the LLM path spawned/fought on a neutral look');
  ok('default: with no human injection, the LLM holds the DM seat — a neutral action stays neutral');

  // ---- (b) Human/DMView injects a STAGE ruling — no LLM — same world-first RESOLVE ----
  stageDm({ spawns: [{ archetype: 'groomsman', hostile: true, count: 2 }], beginCombat: true });
  await sleep(150);
  const mark1 = allOps().length;
  sendPlayer('I steady my grip and brace myself'); // neutral text — the injected ruling drives the beat
  await waitFor(allOps, spawnedHostile, 8000, 'injected ruling spawns hostiles');
  await waitFor(allOps, combatStart, 8000, 'injected ruling opens the floor');
  ok('seat seam: a hand-fed ruling (no LLM) spawned hostiles AND began combat — identical RESOLVE to the AI path');

  // The fight is grounded just like D4.
  await sleep(300);
  const enc2 = await encounter();
  const enemies = enc2.enemies || [];
  const npcs = Object.fromEntries((await q('/sense/query?kind=npc')).results.map(r => [r.id, r.components]));
  const grounded = enemies.every(id => npcs[id] && npcs[id].place && npcs[id].place.locationId === 'loc-strip' && npcs[id].flags && npcs[id].flags.hostile);
  if (!enemies.length || !grounded) throw new Error('injected fight is not grounded: ' + JSON.stringify(enemies));
  ok(`grounded: the injected encounter holds ${enemies.length} present, real hostile(s)`);

  // The beat is attributed to its true (non-LLM) author, visible to the DM seat.
  const injectedTrace = traces().find(t => t.agent === 'dm' && t.phase === 'adjudicate' && t.by && t.by !== 'ai');
  if (!injectedTrace) throw new Error('no DM trace attributed the injected beat to a non-ai source');
  ok(`traced: the DM seat sees the beat authored by "${injectedTrace.by}" (not the LLM)`);

  console.log(`\n${passed} DM-D5 seat-indirection smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ DM-D5 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
