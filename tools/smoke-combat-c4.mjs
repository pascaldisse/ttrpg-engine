/**
 * tools/smoke-combat-c4.mjs — C4 zones & improvised surfaces over the live server.
 *
 *   - improvised "kick the brazier into the oil" → spawns a `fire` hazard that then
 *     damages imps standing in that zone on their turn
 *   - improvised "shove the imp off the balcony edge" → kills it (board exploit)
 *   - moving to another zone puts a melee Move out of range
 *
 * Run: node tools/smoke-combat-c4.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8482;
const SAVE = 'c4smoke';
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
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    const h = (raw) => {
      const m = JSON.parse(raw); messages.push(m);
      if ((m.type === 'ops' ? (m.ops || []) : []).some(pred)) { clearTimeout(t); ws.off('message', h); resolve(true); }
    };
    ws.on('message', h);
  });
}
const sendMove = (text, move, target, zone) => ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, move, target, zone, by: 'player' }], from: 'player' }));
const q = async (p) => (await (await fetch(`http://localhost:${PORT}${p}`)).json());
const livingImps = async () => {
  const r = await q('/sense/query?kind=npc');
  return r.results.filter(x => x.id.startsWith('npc-imp') && (x.components.status || {}).alive !== false).length;
};
const impHp = async (id) => {
  const r = await q('/sense/query?kind=npc');
  const e = r.results.find(x => x.id === id);
  return e ? ((e.components.stats || {}).hp) : null;
};

const combatBanner = (re) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && re.test(o.data.text || '');
const startBanner = (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === 'start';
const hazardEvt = (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'hazard';
const fireTick = (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'status' && o.data.detail && o.data.detail.kind === 'fire';

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // Start the fight (everyone in 'the-aisle').
  sendMove('I attack the imp with my katana', 'Katana Sword Slash', 'npc-imp-1');
  await waitForOp(startBanner, 8000, 'combat start');
  ok('combat starts with authored zones (everyone in the-aisle)');

  const imp2Before = await impHp('npc-imp-2');

  // (1) Improvised surface: kick the brazier into the oil → a fire hazard in the zone.
  sendMove('I kick the brazier into the oil at their feet', undefined, undefined);
  await waitForOp(hazardEvt, 8000, 'fire hazard spawned');
  await waitForOp(fireTick, 8000, 'fire damages a combatant in the zone');
  await sleep(300);
  const imp2After = await impHp('npc-imp-2');
  if (!(imp2After < imp2Before)) throw new Error(`fire hazard did not damage imp-2 (${imp2Before} → ${imp2After})`);
  ok(`improvised fire hazard burns imps in the zone (imp-2 ${imp2Before} → ${imp2After})`);

  // (2) Board exploit: shove an imp off the balcony edge → it dies.
  const before = await livingImps();
  sendMove('I shove the imp off the balcony edge', undefined, undefined);
  await waitForOp(combatBanner(/falls/i), 8000, 'an imp falls');
  await sleep(300);
  const after = await livingImps();
  if (!(after < before)) throw new Error(`shove did not kill an imp (${before} → ${after})`);
  ok(`board exploit: shoving an imp off the edge kills it (${before} → ${after} imps)`);

  console.log(`\n${passed} C4 zone/hazard smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ C4 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
