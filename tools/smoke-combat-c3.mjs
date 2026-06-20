/**
 * tools/smoke-combat-c3.mjs — C3 enemies as agents over the live server (mock LLM).
 *
 *   (a) a plain Move fight makes ZERO LLM narration/dialogue calls (cost discipline)
 *   (b) an improvised "throw sand in its eyes" → an engine check + a `blind` status
 *   (c) talking to an enemy (@Snarling …) → a dialogue line in the imp's voice
 *   (d) reduce an imp below morale → its decision beat fires and it flees (leaves the encounter)
 *
 * Run: node tools/smoke-combat-c3.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8481;
const SAVE = 'c3smoke';
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
const q = async (p) => (await (await fetch(`http://localhost:${PORT}${p}`)).json());
const encEnemies = async () => {
  const r = await q('/sense/query?kind=world-state');
  const e = (r.results.find(x => x.id === 'encounter') || {}).components;
  return (e && e.encounter && e.encounter.enemies) || [];
};

const combatBanner = (phase) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === phase;
const statusLine = (kind) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'status' && o.data.detail && o.data.detail.kind === kind;
const sysKind = (kind, intent) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === kind && (!intent || (o.data.detail && o.data.detail.intent === intent));
// An LLM beat = a streamed narration (has streamId) or any dialogue event.
const llmEvt = (o) => o.op === 'event' && ((o.name === 'narration' && o.data && o.data.streamId) || o.name === 'dialogue');

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  await sleep(200);

  // Make every imp tanky so none dies during the deterministic window (no surprise
  // morale breaks) and the morale target stays on the timeline (death prunes it).
  sendOps(['npc-imp-1', 'npc-imp-2', 'npc-imp-3', 'npc-imp-4'].map(id => ({ op: 'merge', id, component: 'stats', value: { hp: 80, maxHp: 80 } })));
  await sleep(200);

  // ---- (a) plain Move fight → 0 LLM beats ----
  const mark = allOps().length;
  sendMove('I attack the imp with my katana', 'Katana Sword Slash', 'npc-imp-1');
  await waitForOp(combatBanner('start'), 8000, 'combat start');
  await sleep(800);
  const llmCount = allOps().slice(mark).filter(llmEvt).length;
  if (llmCount !== 0) throw new Error(`plain Move fight made ${llmCount} LLM beat(s) — expected 0`);
  ok('cost discipline: a plain Move fight (with an AI ally) makes 0 LLM narration/dialogue calls');

  // ---- (b) improvised action → check + blind status ----
  sendMove('I throw a fistful of sand in its eyes', undefined, undefined);
  await waitForOp(statusLine('blind'), 8000, 'blind applied via improv');
  await waitForOp(o => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'roll' && /necro-test|difficulty|✦/.test(o.data.text || ''), 8000, 'improv check rolled');
  ok('improv: "throw sand in its eyes" → engine check + a blind status (LLM chose the shape)');

  // ---- (c) talk to an enemy → dialogue in its voice ----
  sendMove('@Cackling why are you doing this?', undefined, undefined);
  await waitForOp(o => o.op === 'event' && o.name === 'dialogue' && o.data && o.data.by === 'npc-imp-2', 8000, 'imp dialogue');
  ok('talk: addressing an enemy (@Cackling) gets a dialogue line in its voice');

  // ---- (d) morale break → the imp decides and flees ----
  // drop ONE imp to 1 HP (others stay healthy, so it's hp — not last-standing — that breaks it).
  sendOps([
    { op: 'merge', id: 'pc-hero', component: 'stats', value: { hp: 28 } },
    { op: 'merge', id: 'npc-imp-2', component: 'stats', value: { hp: 1 } },
  ]);
  await sleep(200);
  sendMove('I steady my breathing', 'Chi Healing');
  await waitForOp(sysKind('morale', 'shaken'), 8000, 'morale breaks (shaken)');
  await waitForOp(sysKind('parley', 'flee'), 8000, 'broken imp flees');
  for (let i = 0; i < 40; i++) {
    const en = await encEnemies();
    if (!en.includes('npc-imp-2')) break;
    await sleep(50);
  }
  const en = await encEnemies();
  if (en.includes('npc-imp-2')) throw new Error('fled imp still in encounter.enemies: ' + JSON.stringify(en));
  ok('morale: a broken imp wakes the LLM, decides to flee, and leaves the encounter');

  console.log(`\n${passed} C3 enemy-agent smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ C3 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
