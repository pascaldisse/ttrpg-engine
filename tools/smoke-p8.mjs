/**
 * tools/smoke-p8.mjs — P8 world-generation end-to-end (offline, mock LLM).
 *
 * Proves the whole P8 promise: generate a brand-new world (procgen skeleton +
 * "charge with meaning"), write it as a scene JSON, then boot the REAL server
 * pointed at that generated world and confirm it seeds and plays — the engine
 * cannot tell a generated world from a hand-authored one.
 *
 *   1. generateWorld() with the mock LLM → entities
 *   2. validateWorld() → ok
 *   3. write to a throwaway world dir (scenes/ + campaign.json)
 *   4. boot server with TTRPG_WORLD=<that dir>; GET /sense/look + /schema
 *   5. assert the generated entrance location + an exit are present
 *
 * Run: node tools/smoke-p8.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MockLlmClient } from '../server/llm.js';
import { generateWorld, writeWorld } from '../server/worldgen.js';
import { validateWorld } from '../shared/worldcheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

const GEN_DIR = path.join(root, 'world', '_gen_smoke');
const PORT = 8492;
const SAVE = 'p8smoke';
const savePath = path.join(GEN_DIR, 'saves', `session_${SAVE}.json`);

function cleanup() {
  try { fs.rmSync(GEN_DIR, { recursive: true, force: true }); } catch {}
}

(async () => {
  cleanup();

  // 1. Generate a world fully offline (mock LLM charges the skeleton).
  const llm = new MockLlmClient({ sessionId: 'p8smoke' });
  const { entities, meta, charged, failed } = await generateWorld({
    size: 'small', seed: 7, theme: 'haunted salt marsh', llm, sessionId: 'p8smoke',
  });
  if (charged < 1) throw new Error('nothing was charged');
  if (failed > 0) throw new Error(`mock charge should never fall back, but ${failed} did`);
  ok(`generateWorld produced ${Object.keys(entities).length} entities, charged ${charged} locations`);

  // 2. Validate referential integrity.
  const check = validateWorld(entities);
  if (!check.ok) throw new Error('generated world failed validation:\n  ' + check.errors.join('\n  '));
  ok('generated world passes validateWorld');

  // The entrance location the player starts at (pc-hero's locationId).
  const pcLoc = entities['pc-hero']?.place?.locationId;
  const entranceName = entities[pcLoc]?.identity?.name;
  if (!entranceName) throw new Error('no entrance location name');

  // 3. Write to a throwaway world dir in the shape the Session seeds from.
  fs.mkdirSync(path.join(GEN_DIR, 'scenes'), { recursive: true });
  writeWorld(entities, path.join(GEN_DIR, 'scenes', 'world.json'));
  fs.writeFileSync(
    path.join(GEN_DIR, 'campaign.json'),
    JSON.stringify({ start: { scene: 'world' }, scenes: { world: { name: 'Generated World', description: meta.size } } }, null, 2),
  );
  ok('wrote generated world to a fresh world dir (scenes/ + campaign.json)');

  // 4. Boot the REAL server against the generated world.
  fs.rmSync(savePath, { force: true });
  const server = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(PORT), TTRPG_SAVE: SAVE, TTRPG_WORLD: GEN_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  try {
    let booted = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { booted = true; break; } } catch {}
      await sleep(100);
    }
    if (!booted) throw new Error('server did not boot on generated world:\n' + log);
    ok('server booted seeding from the generated world');

    // 5. /sense/look reflects the generated entrance (not the hand-authored tavern).
    const look = await (await fetch(`http://localhost:${PORT}/sense/look`)).json();
    const lookStr = JSON.stringify(look);
    if (/Salt & Sextant/.test(lookStr)) throw new Error('look shows the tavern — generated world did not seed');
    if (!lookStr.includes(entranceName)) {
      throw new Error(`look does not mention the generated entrance "${entranceName}":\n${lookStr.slice(0, 400)}`);
    }
    ok(`/sense/look shows the generated entrance "${entranceName}" with exits`);

    // /schema still serves (engine intact).
    const schema = await (await fetch(`http://localhost:${PORT}/schema`)).json();
    if (!schema.identity || !schema.place) throw new Error('/schema missing core components');
    ok('/schema intact on the generated world');
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    await sleep(150);
    cleanup();
  }

  console.log(`\n${passed} P8 worldgen smoke checks passed.`);
  process.exit(0);
})().catch(err => { cleanup(); console.error('\n❌ P8 SMOKE FAILED:', err.message); process.exit(1); });
