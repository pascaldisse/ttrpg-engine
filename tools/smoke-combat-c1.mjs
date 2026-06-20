/**
 * tools/smoke-combat-c1.mjs — C1 Moves + status engine over the live server (mock LLM).
 *
 * Boots the Necrotopia campaign and drives the chapel fight over WS:
 *   - a declared Move (Katana Sword Slash) starts the encounter and broadcasts a ✦ roll line
 *   - an imp pre-loaded with `bleed` loses HP on its turn (status tick) + a kind:'status' line
 *   - an imp pre-loaded with `stun` is skipped (combat banner) on its turn
 *   - Rage Roar applies a `rage` status (kind:'status' line)
 *   - Chi Healing restores the PC's Health
 *
 * Combat is deterministic (no LLM enters the loop). Run: node tools/smoke-combat-c1.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8477;
const SAVE = 'c1smoke';
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
async function waitSince(mark, pred, ms, label) {
  for (let i = 0; i < ms / 50; i++) {
    const ops = messages.slice(mark).filter(m => m.type === 'ops').flatMap(m => m.ops || []);
    if (ops.some(pred)) return true;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}

const sendMove = (text, move, target) => ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, move, target, by: 'player' }], from: 'player' }));
const sendOps = (ops) => ws.send(JSON.stringify({ type: 'ops', ops, from: 'player' }));
const q = async (p) => (await (await fetch(`http://localhost:${PORT}${p}`)).json());
const impHp = async (id) => {
  const r = await q('/sense/query?kind=npc');
  const e = r.results.find(x => x.id === id);
  return e ? ((e.components.stats || {}).hp) : null;
};

const combatBanner = (phase) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === phase;
const statusLine = (kind) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'status' && o.data.detail && o.data.detail.kind === kind;

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // Pre-load statuses on two imps that we will NOT attack, so their turns exercise
  // the engine's start-of-turn tick: imp-2 bleeds, imp-3 is stunned.
  const imp2Before = await impHp('npc-imp-2');
  sendOps([
    { op: 'merge', id: 'npc-imp-2', component: 'statuses', value: { list: [{ kind: 'bleed', magnitude: 2, remaining: 3 }] } },
    { op: 'merge', id: 'npc-imp-3', component: 'statuses', value: { list: [{ kind: 'stun', remaining: 2 }] } },
  ]);
  await sleep(200);

  // 1. A declared Move starts the encounter (attack a hostile) and resolves a full round.
  sendMove('I cut the imp down with my katana', 'Katana Sword Slash', 'npc-imp-1');
  await waitForOp(combatBanner('start'), 8000, 'encounter start banner');
  ok('a declared Move (Katana Sword Slash) starts the structured encounter');

  // 2. The Move broadcasts a ✦ roll line.
  await waitForOp(o => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'roll' && /✦/.test(o.data.text || ''), 8000, 'move roll line');
  ok('the Move resolves via the engine (✦ roll line broadcast)');

  // 3. The bleeding imp loses HP on its turn (status tick) + a kind:'status' line.
  await waitForOp(statusLine('bleed'), 8000, 'bleed status line');
  await sleep(300);
  const imp2After = await impHp('npc-imp-2');
  if (!(imp2After < imp2Before)) throw new Error(`bleed did not damage imp-2 (${imp2Before} → ${imp2After})`);
  ok(`bleed ticks: imp-2 lost HP on its turn (${imp2Before} → ${imp2After})`);

  // 4. The stunned imp is skipped (combat banner names it stunned).
  await waitForOp(o => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && /stun/i.test(o.data.text || ''), 8000, 'stun skip banner');
  ok('stun: the stunned imp loses its turn (skip banner)');

  // 5. Rage Roar applies a `rage` status on the PC's next turn.
  sendMove('I roar with rage', 'Rage Roar');
  await waitForOp(statusLine('rage'), 8000, 'rage status applied');
  ok('Rage Roar applies a rage status (kind:status line)');

  // 6. Chi Healing restores the PC's Health (set low, then heal > that).
  const mark = messages.length;
  sendOps([{ op: 'merge', id: 'pc-hero', component: 'stats', value: { hp: 6 } }]);
  await sleep(150);
  sendMove('I center myself and heal', 'Chi Healing');
  await waitSince(mark, o => o.op === 'merge' && o.id === 'pc-hero' && o.component === 'stats' && o.value && typeof o.value.hp === 'number' && o.value.hp > 6, 8000, 'Chi Healing raised HP');
  ok('Chi Healing restores the PC\'s Health');

  console.log(`\n${passed} C1 combat smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ C1 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
