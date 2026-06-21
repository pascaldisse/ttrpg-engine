/**
 * tools/smoke-dm-d4.mjs — DM-initiated combat over the live server (mock LLM).
 *
 * This is the acceptance test for the original bug: the PC stands alone on the Strip
 * (the chapel imps are dead/elsewhere) and types "start a fight". Previously the DM
 * NARRATED a fight that never existed. Now:
 *   - the DM STAGES hostiles into the world, then OPENS THE FLOOR
 *   - a real timeline encounter begins with those spawned hostiles in the queue
 *   - the fight the player was told about is the fight the engine is running
 *
 * Run: node tools/smoke-dm-d4.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8488;
const SAVE = 'dmd4smoke';
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
const encounter = async () => {
  const r = await q('/sense/query?kind=world-state');
  return ((r.results.find(x => x.id === 'encounter') || {}).components || {}).encounter || {};
};
const combatBanner = (phase) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === phase;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // PC alone on the Strip — no present hostiles, no active encounter.
  sendOps([{ op: 'merge', id: 'pc-hero', component: 'place', value: { locationId: 'loc-strip' } }]);
  await sleep(200);
  const enc0 = await encounter();
  if (enc0.active) throw new Error('an encounter was already active');
  ok('precondition: PC alone on the Strip, no active encounter');

  // The original failing input.
  sendMove('I draw my katana and start a fight');
  await waitForOp(combatBanner('start'), 9000, 'combat begins');
  ok('DM-initiated combat: "start a fight" opens the floor (a real combat-start banner)');

  // The encounter is active and its enemies are the freshly-spawned hostiles, present here.
  await sleep(500);
  const enc = await encounter();
  if (!enc.active) throw new Error('encounter not active after start');
  const enemies = enc.enemies || [];
  if (enemies.length < 1) throw new Error('encounter has no enemies');
  const npcs = (await q('/sense/query?kind=npc')).results;
  const byId = Object.fromEntries(npcs.map(r => [r.id, r.components]));
  const grounded = enemies.filter(id => byId[id] && byId[id].place && byId[id].place.locationId === 'loc-strip' && byId[id].flags && byId[id].flags.hostile);
  if (grounded.length !== enemies.length) throw new Error('some encounter enemies are not real present hostiles: ' + JSON.stringify(enemies));
  ok(`grounded fight: ${enemies.length} spawned hostile(s) are in the encounter and present on the Strip`);

  // The timeline queue (CTB) actually holds the combatants.
  const queue = enc.queue || enc.order || [];
  if (!queue.length) throw new Error('combat has no turn queue');
  if (!enemies.some(id => queue.includes(id))) throw new Error('spawned hostiles are not in the turn queue');
  ok(`living timeline: the turn queue holds the staged combatants (${queue.length} on the bar)`);

  console.log(`\n${passed} DM-D4 DM-initiated-combat smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ DM-D4 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
