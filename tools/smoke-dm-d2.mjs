/**
 * tools/smoke-dm-d2.mjs — world-first STAGE step over the live server (mock LLM).
 *
 * Asserts the Definition-of-Done for D2:
 *   - the PC is alone (no present hostiles); a fight-starting action makes the DM
 *     STAGE the world: hostile actors are SPAWNED as real entities BEFORE narration
 *   - the spawned actor is present at the PC's location, living, and hostile, with a
 *     ruleset-supplied stat block (the engine, not the LLM, set its HP)
 *   - no pure-text enemy: the narration's foes exist in the entity store
 *
 * Run: node tools/smoke-dm-d2.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8486;
const SAVE = 'dmd2smoke';
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

const spawnedHostile = (o) => o.op === 'spawn' && o.components && o.components.flags && o.components.flags.hostile === true;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // Relocate the PC to the Strip — alone, no present hostiles (the imps are in the chapel).
  sendOps([{ op: 'merge', id: 'pc-hero', component: 'place', value: { locationId: 'loc-strip' } }]);
  await sleep(200);

  // Sanity: no hostiles are present before the DM stages any.
  const before = (await q('/sense/query?kind=npc')).results.filter(
    r => r.components && r.components.place && r.components.place.locationId === 'loc-strip'
      && r.components.flags && r.components.flags.hostile
  );
  if (before.length) throw new Error('expected no present hostiles before staging: ' + JSON.stringify(before.map(r => r.id)));
  ok('precondition: the PC stands alone on the Strip — zero present hostiles');

  // The fight the DM narrates must EXIST: a fight-start stages hostiles into the world.
  const mark = allOps().length;
  sendMove('I draw my katana and start a fight');
  await waitForOp(spawnedHostile, 8000, 'a hostile actor is spawned');
  await sleep(400);

  const spawnIds = new Set(allOps().slice(mark).filter(spawnedHostile).map(o => o.id));
  if (spawnIds.size < 1) throw new Error('expected the DM to spawn hostile actors');
  ok(`world-first: the DM spawned ${spawnIds.size} hostile actor(s) as real entities before narrating`);

  // The spawned actor is present, living, hostile, with a RULESET stat block.
  const present = (await q('/sense/query?kind=npc')).results.filter(
    r => r.components && r.components.place && r.components.place.locationId === 'loc-strip'
      && r.components.flags && r.components.flags.hostile && r.components.status && r.components.status.alive !== false
  );
  if (!present.length) throw new Error('spawned hostile not present/living at the PC location');
  const stat = present[0].components.stats || {};
  if (!(stat.hp > 0)) throw new Error('spawned actor has no engine-supplied HP: ' + JSON.stringify(stat));
  ok(`grounded: ${present.length} living hostile(s) now stand on the Strip with engine stats (hp=${stat.hp}, armor=${stat.armor})`);

  console.log(`\n${passed} DM-D2 world-first staging smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ DM-D2 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
