/**
 * tools/smoke-p7.mjs — P7 rules-as-data boot integration (live server, no LLM).
 *
 * Verifies the boot wiring composes: starting with TTRPG_RULESET=<id> loads the
 * bundle, registers its components/checks, and serves them — proving the engine
 * picks up rules as data. Checks both 5e (default-shaped) and DSA5 (the moat).
 *
 * Run: node tools/smoke-p7.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };

/** Boot the server with a ruleset, return { log, schema }. */
async function boot(ruleset, port) {
  const SAVE = `p7smoke_${ruleset}`;
  const savePath = path.join(root, 'world', 'saves', `session_${SAVE}.json`);
  fs.rmSync(savePath, { force: true });
  const server = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(port), TTRPG_SAVE: SAVE, TTRPG_RULESET: ruleset },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  try {
    let schema = null;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://localhost:${port}/health`);
        if (r.ok) { schema = await (await fetch(`http://localhost:${port}/schema`)).json(); break; }
      } catch {}
      await sleep(100);
    }
    if (!schema) throw new Error(`server did not boot with ruleset ${ruleset}:\n${log}`);
    return { log, schema };
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    fs.rmSync(savePath, { force: true });
    await sleep(150);
  }
}

(async () => {
  // DSA5 — the moat: a non-5e ruleset registers its own components through boot.
  const dsa = await boot('dsa5', 8490);
  if (!/\[ruleset\] Loaded/.test(dsa.log)) throw new Error('no ruleset-loaded log line:\n' + dsa.log);
  if (!/Schwarze Auge|dsa5/i.test(dsa.log)) throw new Error('DSA ruleset not named in boot log:\n' + dsa.log);
  if (!dsa.schema.attributes) throw new Error('DSA `attributes` component not registered into /schema');
  ok('DSA5 ruleset boots: bundle loaded + DSA components registered into /schema');

  // srd5e — the 5e ruleset loads cleanly with no error.
  const srd = await boot('srd5e', 8491);
  if (!/\[ruleset\] Loaded/.test(srd.log)) throw new Error('srd5e did not load:\n' + srd.log);
  if (/Failed to load/.test(srd.log)) throw new Error('srd5e load reported a failure:\n' + srd.log);
  ok('srd5e ruleset boots cleanly');

  console.log(`\n${passed} P7 ruleset-boot smoke checks passed.`);
  process.exit(0);
})().catch(err => { console.error('\n❌ P7 SMOKE FAILED:', err.message); process.exit(1); });
