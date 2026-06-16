/**
 * tools/smoke-p5.mjs — P5 combat end-to-end over the live server (mock LLM).
 *
 * Combat is deterministic (no LLM), so the mock provider never enters the fight.
 * Verifies: travel to the enemies → attacking a hostile STARTS a structured
 * encounter → attacks deal damage → the encounter resolves and ENDS.
 *
 * Run: node tools/smoke-p5.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8475;
const SAVE = 'p5smoke';
const savePath = path.join(root, 'world', 'saves', `session_${SAVE}.json`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

fs.rmSync(savePath, { force: true });
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
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    const h = (raw) => {
      const m = JSON.parse(raw); messages.push(m);
      if ((m.type === 'ops' ? (m.ops || []) : []).some(pred)) { clearTimeout(t); ws.off('message', h); resolve(true); }
    };
    ws.on('message', h);
  });
}
const send = (text) => ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, by: 'player' }], from: 'player' }));
const combatBanner = (phase) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === phase;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };
const q = async (path) => (await (await fetch(`http://localhost:${PORT}${path}`)).json());

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // 1. Travel to the docks where the enemies are.
  send('go to the docks');
  await waitForOp(o => o.op === 'merge' && o.id === 'pc-hero' && o.component === 'place'
    && o.value && o.value.locationId === 'loc-docks', 8000, 'moved to docks');
  ok('reached the docks (enemies present)');

  // 2. Attack a hostile → structured encounter STARTS.
  send('attack the smuggler');
  await waitForOp(combatBanner('start'), 8000, 'encounter start banner');
  // encounter entity should be active
  const encRes = await q('/sense/query?kind=world-state');
  const enc = (encRes.results.find(r => r.id === 'encounter') || {}).components;
  if (!enc || !enc.encounter || enc.encounter.active !== true) throw new Error('encounter not active after start');
  if (!enc.encounter.order.includes('npc-smuggler') || !enc.encounter.order.includes('pc-hero')) {
    throw new Error('initiative order missing combatants: ' + JSON.stringify(enc.encounter.order));
  }
  ok('attacking a hostile started a structured encounter (initiative rolled)');

  // 3. Attack rolls happen + damage lands.
  await waitForOp(o => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'roll'
    && /⚔/.test(o.data.text || ''), 8000, 'an attack roll was broadcast');
  ok('attacks resolve via the engine (roll lines broadcast)');

  // 4. Drive the fight to completion (deterministic; press the attack each round).
  let ended = false;
  for (let i = 0; i < 20 && !ended; i++) {
    await sleep(500);
    ended = allOps().some(combatBanner('end'));
    if (!ended) send('attack');
  }
  if (!ended) throw new Error('combat did not end within 20 rounds');

  const endBanner = allOps().filter(combatBanner('end')).pop();
  const result = endBanner.data.outcome;
  // encounter should be deactivated
  const enc2 = (((await q('/sense/query?kind=world-state')).results.find(r => r.id === 'encounter')) || {}).components;
  if (enc2.encounter.active !== false) throw new Error('encounter still active after end');
  // at least one combatant died (a real fight happened)
  const npcs = (await q('/sense/query?kind=npc')).results;
  const smuggler = npcs.find(r => r.id === 'npc-smuggler');
  const pc = (await q('/sense/query?kind=pc')).results[0];
  const someoneDied = (smuggler && smuggler.components.status.alive === false) || pc.components.status.alive === false;
  if (!someoneDied) throw new Error('combat ended but nobody took lethal damage — suspicious');
  ok(`encounter resolved (outcome: ${result}) and deactivated`);

  console.log(`\n${passed} P5 combat smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ P5 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  cleanup(1);
});
