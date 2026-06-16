/**
 * tools/smoke-p6.mjs — P6 quests & progression end-to-end (live server, mock LLM).
 *
 * Quests + combat + progression are deterministic (no LLM). The opening fight is a
 * fair ~50/50, so we probe seeds (TTRPG_SEED) until the PC wins, then assert the
 * FULL chain on that run:
 *   travel → docks  → quest advances (atLocation trigger)
 *   win the fight   → quest advances (allDead trigger) + combat kill-XP
 *   take the crate  → quest completes (hasItem trigger) → 250 XP + signet → level 2
 *
 * Run: node tools/smoke-p6.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

/** Run the full P6 scenario on one seed. Returns { won, ...state } or throws on a broken invariant. */
async function runScenario(seed, port) {
  const SAVE = `p6smoke_${seed}`;
  const savePath = path.join(root, 'world', 'saves', `session_${SAVE}.json`);
  fs.rmSync(savePath, { force: true });

  const server = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(port), TTRPG_SAVE: SAVE, TTRPG_SEED: String(seed) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const teardown = () => { try { server.kill('SIGKILL'); } catch {} fs.rmSync(savePath, { force: true }); };

  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://localhost:${port}/health`)).ok) break; } catch {}
      await sleep(100);
    }

    const messages = [];
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw)); } catch {} });
    await sleep(150);

    const allOps = () => messages.filter(m => m.type === 'ops').flatMap(m => m.ops || []);
    const send = (text) => ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, by: 'player' }], from: 'player' }));
    const q = async (p) => (await (await fetch(`http://localhost:${port}${p}`)).json());
    const quest = async () => (((await q('/sense/query?kind=quest')).results.find(r => r.id === 'quest-siren')) || {}).components.quest;
    const pc = async () => (await q('/sense/query?kind=pc')).results[0].components;
    function waitForOp(pred, ms, label) {
      return new Promise((resolve, reject) => {
        if (allOps().some(pred)) return resolve(true);
        const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
        const h = (raw) => { const m = JSON.parse(raw); messages.push(m);
          if ((m.type === 'ops' ? (m.ops || []) : []).some(pred)) { clearTimeout(t); ws.off('message', h); resolve(true); } };
        ws.on('message', h);
      });
    }

    // A. Travel to the docks → atLocation trigger advances the quest to step 1.
    send('go to the docks');
    await waitForOp(o => o.op === 'merge' && o.id === 'pc-hero' && o.component === 'place'
      && o.value && o.value.locationId === 'loc-docks', 8000, 'moved to docks');
    await sleep(400); // let the post-turn quest evaluate run
    const qAfterMove = await quest();
    if (qAfterMove.currentStep !== 1) throw new Error(`quest did not advance on arrival (step=${qAfterMove.currentStep})`);

    // B. Fight to the finish.
    send('attack the smuggler');
    let ended = false, outcome = null;
    for (let r = 0; r < 25 && !ended; r++) {
      await sleep(450);
      const end = allOps().filter(o => o.op === 'event' && o.name === 'system' && o.data && o.data.kind === 'combat' && o.data.phase === 'end').pop();
      if (end) { ended = true; outcome = end.data.outcome; break; }
      send('attack');
    }
    if (!ended) throw new Error('combat never ended');
    if (outcome !== 'victory') { ws.close(); return { won: false }; }

    // Victory → allDead trigger advanced quest to step 2; combat kill-XP awarded.
    await sleep(400);
    const qAfterWin = await quest();
    const pcAfterWin = await pc();
    if (qAfterWin.currentStep !== 2) throw new Error(`quest did not advance after victory (step=${qAfterWin.currentStep})`);
    if ((pcAfterWin.stats.xp || 0) < 75) throw new Error(`combat XP not awarded (xp=${pcAfterWin.stats.xp})`);

    // C. Take the crate → hasItem trigger COMPLETES the quest → rewards + level-up.
    send('take the crate');
    await waitForOp(o => o.op === 'merge' && o.id === 'quest-siren' && o.component === 'quest'
      && o.value && o.value.phase === 'completed', 8000, 'quest completed');
    await sleep(400);
    const qDone = await quest();
    const pcDone = await pc();
    ws.close();

    return {
      won: true, seed,
      phase: qDone.phase,
      xp: pcDone.stats.xp,
      level: pcDone.stats.level,
      maxHp: pcDone.stats.maxHp,
      inv: pcDone.inventory.items.map(it => it.id),
    };
  } finally {
    teardown();
    await sleep(150);
  }
}

(async () => {
  let result = null;
  for (let i = 0; i < SEEDS.length; i++) {
    const r = await runScenario(SEEDS[i], 8480 + i);
    if (r.won) { result = r; break; }
    console.log(`  · seed ${SEEDS[i]}: PC lost the fight — trying another seed`);
  }
  if (!result) throw new Error('PC never won across probed seeds (combat or quest wiring broken)');

  ok(`travel→docks advanced the quest (atLocation trigger) [seed ${result.seed}]`);
  ok('victory advanced the quest (allDead trigger) + awarded combat kill-XP');
  // Final completion assertions
  if (result.phase !== 'completed') throw new Error('quest not completed');
  if (!result.inv.includes('item-signet')) throw new Error('reward item (signet) not granted: ' + result.inv);
  if (!result.inv.includes('item-crate')) throw new Error('crate not taken: ' + result.inv);
  if (result.xp !== 325) throw new Error(`expected 325 xp (75 combat + 250 quest), got ${result.xp}`);
  if (result.level !== 2) throw new Error(`expected level 2, got ${result.level}`);
  if (!(result.maxHp > 20)) throw new Error(`maxHp should rise on level-up, got ${result.maxHp}`);
  ok(`take crate completed the quest → +250 XP + signet, leveled to ${result.level} (xp ${result.xp}, maxHp ${result.maxHp})`);

  console.log(`\n${passed} P6 quest/progression smoke checks passed (mock provider).`);
  process.exit(0);
})().catch(err => { console.error('\n❌ P6 SMOKE FAILED:', err.message); process.exit(1); });
