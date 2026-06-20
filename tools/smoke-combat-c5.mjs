/**
 * tools/smoke-combat-c5.mjs — C5 party seats / overdrive / summons (live, mock LLM).
 *
 *   - Padre (controller:'ai') acts on his own timeline turns
 *   - a second HUMAN seat (player2, over a 2nd WS) is only accepted on ITS turn
 *   - an overdrive finisher is gated until the meter is full, then fires + spends it
 *   - a summon Move puts a temporary combatant on the timeline queue
 *
 * Run: node tools/smoke-combat-c5.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 8483;
const SAVE = 'c5smoke';
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
let ws, ws2;
const allOps = () => messages.filter(m => m.type === 'ops').flatMap(m => m.ops || []);
async function waitSince(mark, pred, ms, label) {
  for (let i = 0; i < ms / 50; i++) {
    if (allOps().slice(mark).some(pred)) return true;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}
const opsMark = () => allOps().length;
const lastTurnOf = () => {
  const evs = allOps().filter(o => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.turnOf);
  return evs.length ? evs[evs.length - 1].data.turnOf : null;
};
async function waitTurn(id, ms = 8000) {
  for (let i = 0; i < ms / 50; i++) { if (lastTurnOf() === id) return true; await sleep(50); }
  throw new Error(`timeout: waiting for ${id}'s turn (turnOf=${lastTurnOf()})`);
}

const send = (sock, op) => sock.send(JSON.stringify({ type: 'ops', ops: [op], from: op.by }));
const sendOps = (ops) => ws.send(JSON.stringify({ type: 'ops', ops, from: 'player' }));
const rollText = (re) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'roll' && re.test(o.data.text || '');
const banner = (re) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && re.test(o.data.text || '');
const note = (re) => (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'note' && re.test(o.data.text || '');
const meterEvt = (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'meter';
const queueHasSummon = (o) => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === 'timeline' && (o.data.queue || []).some(id => String(id).startsWith('summon-'));

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

(async () => {
  await waitForHealth();
  ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  ws.send(JSON.stringify({ type: 'hello', presence: { seat: 'player', who: 'player' }, presenceId: 'p1' }));
  // second human seat
  ws2 = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); });
  ws2.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
  ws2.send(JSON.stringify({ type: 'hello', presence: { seat: 'player', who: 'player2' }, presenceId: 'p2' }));
  await sleep(300);

  // Spawn a second human-owned ally combatant (sorts after pc-hero so the PC acts first),
  // and make every imp tanky so the fight survives the whole scenario.
  sendOps([
    { op: 'spawn', id: 'zz-ranger', components: {
      identity: { name: 'Ranger Vale', kind: 'npc', description: 'A second survivor with a rifle.' },
      stats: { hp: 20, maxHp: 20, armor: 2, level: 1 },
      status: { alive: true },
      position: { zoneId: 'the-aisle' },
      moves: { list: [{ name: 'Rifle Shot', type: 'damage', damage: '1d6', range: 'ranged', cost: 1 }] },
      agent: { enabled: true, controller: 'player2', accent: '#44dd88' },
      place: { locationId: 'loc-chapel', connections: [] },
      flags: { ally: true, damage: '1d6' },
    } },
    ...['npc-imp-1', 'npc-imp-2', 'npc-imp-3', 'npc-imp-4'].map(id => ({ op: 'merge', id, component: 'stats', value: { hp: 80, maxHp: 80 } })),
  ]);
  await sleep(250);

  // 1. Start the fight (PC initiates). Padre (AI ally) acts on his own turn.
  send(ws, { op: 'action', text: 'I attack the imp with my katana', move: 'Katana Sword Slash', target: 'npc-imp-1', by: 'player' });
  await waitSince(0, rollText(/Padre/), 8000, 'Padre acts');
  ok('Padre (AI ally) fights on his own timeline turns');

  // 2. Multiplayer seat ownership: the loop pauses on the human ally's turn.
  await waitTurn('zz-ranger', 8000);
  // the main player tries to act on the ranger's turn → rejected
  let mark = opsMark();
  send(ws, { op: 'action', text: 'I shoot', move: 'Rifle Shot', target: 'npc-imp-1', by: 'player' });
  await waitSince(mark, note(/turn/i), 4000, 'wrong-seat action rejected');
  // the ranger's OWNER acts → accepted
  mark = opsMark();
  send(ws2, { op: 'action', text: 'I fire my rifle', move: 'Rifle Shot', target: 'npc-imp-1', by: 'player2' });
  await waitSince(mark, rollText(/Ranger Vale/), 6000, 'ranger acts on its own turn');
  ok('multiplayer: a seat\'s action is accepted only from its owner, only on its turn');

  // Hand the ranger to the AI for the rest so the PC flows normally.
  sendOps([{ op: 'merge', id: 'zz-ranger', component: 'agent', value: { controller: 'ai' } }]);
  await sleep(150);

  // 3. Overdrive finisher: gated until full, then it fires and spends the meter.
  await waitTurn('pc-hero', 9000);
  mark = opsMark();
  send(ws, { op: 'action', text: 'APOCALYPSE NOW', move: 'Apocalypse Now', by: 'player' });
  await waitSince(mark, banner(/isn't charged/i), 5000, 'finisher gated when meter empty');
  // charge to full, then fire (canonical merge — raw semantic ops aren't expanded over the wire)
  sendOps([{ op: 'merge', id: 'pc-hero', component: 'meter', value: { overdrive: 100 } }]);
  await sleep(150);
  mark = opsMark();
  send(ws, { op: 'action', text: 'APOCALYPSE NOW', move: 'Apocalypse Now', by: 'player' });
  await waitSince(mark, rollText(/Apocalypse Now/), 6000, 'finisher fires at full meter');
  await waitSince(mark, o => meterEvt(o) && o.data.detail && o.data.detail.value === 0, 6000, 'finisher spends the overdrive meter');
  ok('overdrive: the finisher is gated until full, then fires and resets the meter');

  // 4. Summon: a Move puts a temporary combatant on the timeline queue.
  await waitTurn('pc-hero', 9000);
  mark = opsMark();
  send(ws, { op: 'action', text: 'I call a guardian ghost', move: 'Guardian Ghost', by: 'player' });
  await waitSince(mark, queueHasSummon, 6000, 'summon appears in the timeline queue');
  ok('summon: a summoned ally takes a seat on the timeline queue');

  console.log(`\n${passed} C5 party/overdrive/summon smoke checks passed (mock provider).`);
  cleanup(0);
})().catch(err => {
  console.error('\n❌ C5 SMOKE FAILED:', err.message);
  console.error('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-30).join('\n'));
  cleanup(1);
});
