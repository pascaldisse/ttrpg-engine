/**
 * tools/smoke-combat-c2.mjs — C2 CTB timeline over the live server (mock LLM).
 *
 * Boots Necrotopia (initiativeMode 'timeline') and verifies:
 *   - the chapel fight emits combat phase:'timeline' with a non-empty `queue` + `turnOf`
 *   - haste (×2 speed) visibly reshuffles the projected queue (the hasted imp recurs)
 *
 * Run: node tools/smoke-combat-c2.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8478;
const SAVE = 'c2smoke';
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
const sendMove = (text, move, target) => ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, move, target, by: 'player' }], from: 'player' }));
const sendOps = (ops) => ws.send(JSON.stringify({ type: 'ops', ops, from: 'player' }));

const timelineEvt = (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === 'timeline';
const lastTimeline = () => allOps().filter(timelineEvt).pop();
const count = (arr, x) => (arr || []).filter(v => v === x).length;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // 1. Start the chapel fight → a timeline phase event with a populated queue + turnOf.
  sendMove('I attack the imp with my katana', 'Katana Sword Slash', 'npc-imp-1');
  await waitForOp(o => timelineEvt(o) && Array.isArray(o.data.queue) && o.data.queue.length > 0, 8000, 'timeline phase with queue');
  const t1 = lastTimeline();
  if (!t1.data.turnOf) throw new Error('timeline event missing turnOf');
  if (!t1.data.queue.includes('pc-hero')) throw new Error('queue should include the PC: ' + JSON.stringify(t1.data.queue));
  ok(`combat emits phase:'timeline' with a non-empty queue (${t1.data.queue.length}) and turnOf=${t1.data.turnOf}`);

  // 2. Reduce to a clean PC vs one imp, then haste the imp: the projected queue must
  //    give the hasted imp MORE turns than the (equal-speed) PC — a visible reshuffle.
  sendOps([
    { op: 'merge', id: 'npc-imp-1', component: 'status', value: { alive: false } },
    { op: 'merge', id: 'npc-imp-3', component: 'status', value: { alive: false } },
    { op: 'merge', id: 'npc-imp-4', component: 'status', value: { alive: false } },
    { op: 'merge', id: 'npc-imp-2', component: 'statuses', value: { list: [{ kind: 'haste', remaining: 20 }] } },
  ]);
  // wait until the kills are confirmed in canon before acting
  for (let i = 0; i < 40; i++) {
    const q = await (await fetch(`http://localhost:${PORT}/sense/query?kind=npc`)).json();
    const dead = q.results.filter(r => ['npc-imp-1', 'npc-imp-3', 'npc-imp-4'].includes(r.id) && (r.components.status || {}).alive === false).length;
    if (dead === 3) break;
    await sleep(50);
  }
  // take a player turn to force a fresh timeline projection that accounts for haste
  sendMove('I heal up', 'Chi Healing');
  await waitForOp((o) => timelineEvt(o) && o.data.queue
    && !o.data.queue.includes('npc-imp-1')
    && count(o.data.queue, 'npc-imp-2') > count(o.data.queue, 'pc-hero'), 8000, 'hasted imp out-acts the PC');
  // assert on the matching projection (later enemy-turn projections rotate but keep the ratio)
  const after = allOps().filter(timelineEvt).find(o => o.data.queue
    && !o.data.queue.includes('npc-imp-1')
    && count(o.data.queue, 'npc-imp-2') > count(o.data.queue, 'pc-hero'));
  const impN = count(after.data.queue, 'npc-imp-2');
  const pcN = count(after.data.queue, 'pc-hero');
  ok(`haste reshuffles the timeline: hasted imp acts ${impN}× vs PC ${pcN}× in the projected queue`);

  console.log(`\n${passed} C2 timeline smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ C2 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
