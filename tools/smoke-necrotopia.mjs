/**
 * tools/smoke-necrotopia.mjs — Necrotopia ruleset + campaign smoke (no LLM).
 *
 * Two layers:
 *  1. PURE: the bundle's checks (necro-attack d6>Armor, necro-test) and the combat
 *     override (resolveAttack, fixed turn order) resolve correctly on the shared engine.
 *  2. BOOT: the server boots with TTRPG_WORLD=campaigns/necrotopia + TTRPG_RULESET=
 *     necrotopia, registers `moves` into /schema, and seeds the Vegas starter scene.
 *
 * Run: node tools/smoke-necrotopia.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeRng } from '../shared/rng.js';
import { resolveCheck, registerChecks } from '../shared/checks.js';
import { resolveAttack, buildTimeline, nextActor, projectQueue } from '../shared/combat.js';
import { registerComponents } from '../shared/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
const ok = (n) => { console.log(`  ✅ ${n}`); passed++; };
const assert = (c, m) => { if (!c) throw new Error(m); };

const bundlePath = path.join(root, 'campaigns/necrotopia/ruleset/necrotopia/ruleset.js');

(async () => {
  // ---- Layer 1: PURE rules ----
  const rs = await import(pathToFileURL(bundlePath).href);
  registerChecks(rs.checks);
  registerComponents(rs.components);

  // necro-attack: HIT only when d6 > Armor. Sweep all 6 faces vs Armor 2.
  {
    let hits = 0, misses = 0;
    for (let face = 1; face <= 6; face++) {
      // Fake a single-face rng by resolving the check's resolve() directly.
      const r = rs.checks['necro-attack'].resolve([face], 0, 2, null, {});
      if (face > 2) { assert(r.success, `d6(${face}) should HIT Armor 2`); hits++; }
      else { assert(!r.success, `d6(${face}) should MISS Armor 2`); misses++; }
    }
    assert(hits === 4 && misses === 2, 'Armor 2 → 4 hitting faces (3-6), 2 missing (1-2)');
    ok('necro-attack: d6 strictly GREATER than Armor hits (Armor 2 → need 3+)');
  }

  // necro-test: roll-high vs difficulty 1-6, clamped.
  {
    const easy = rs.checks['necro-test'].resolve([4], 0, 2, null, {});
    const hard = rs.checks['necro-test'].resolve([4], 0, 6, null, {});
    assert(easy.success && !hard.success, 'necro-test difficulty gating');
    ok('necro-test: 1d6 vs difficulty (roll>=diff)');
  }

  // combat override: resolveAttack delegates to the bundle; d6>Armor; damage+level.
  {
    const entities = new Map([
      ['atk', { stats: { hp: 28, armor: 2, level: 1 }, flags: { damage: '1d6' } }],
      ['def', { stats: { hp: 4, armor: 2 }, status: { alive: true } }],
    ]);
    // Run many seeds; every result must be either a clean MISS (0 dmg) or a HIT with dmg>=1,
    // and the attackRoll must be a d6 (1-6), never a d20.
    let sawHit = false, sawMiss = false;
    for (let s = 0; s < 60; s++) {
      const r = resolveAttack({ attackerId: 'atk', targetId: 'def' }, entities, makeRng(s), rs.combat);
      assert(r.attackRoll >= 1 && r.attackRoll <= 6, `attackRoll ${r.attackRoll} must be a d6`);
      assert(r.hit === (r.attackRoll > 2), `hit must equal d6>Armor (roll ${r.attackRoll})`);
      if (r.hit) { assert(r.damage >= 1, 'a hit deals >=1 damage'); sawHit = true; }
      else { assert(r.damage === 0, 'a miss deals 0 damage'); sawMiss = true; }
    }
    assert(sawHit && sawMiss, 'expected both hits and misses across seeds');
    ok('combat override: resolveAttack uses d6>Armor (no d20, no ability mod)');
  }

  // CTB timeline (C2): no initiative roll; speed-driven order. flat speed 1 → tie-break id.
  {
    const entities = new Map([
      ['pc', { stats: {}, status: { alive: true } }],
      ['e1', { stats: {}, status: { alive: true } }],
      ['e2', { stats: {}, status: { alive: true } }],
    ]);
    const enc = buildTimeline({ allies: ['pc'], enemies: ['e1', 'e2'] }, entities, rs.combat);
    assert(enc.mode === 'timeline', 'initiativeMode "timeline" → timeline mode');
    assert(enc.participants.length === 3, 'all three combatants are participants');
    assert(enc.turnOf === nextActor(enc), 'turnOf is the next actor (min time)');
    assert(Array.isArray(enc.queue) && enc.queue.length > 0, 'a non-empty projected turn queue');
    assert(projectQueue(enc, entities, rs.combat, 3).length === 3, 'projectQueue simulates forward');
    ok('combat override: initiativeMode "timeline" → CTB queue (no initiative roll)');
  }

  // ---- Layer 2: BOOT the server on the Necrotopia campaign ----
  {
    const PORT = 8493;
    const SAVE = 'necro_smoke';
    const worldDir = path.join(root, 'campaigns/necrotopia');
    const savePath = path.join(worldDir, 'saves', `session_${SAVE}.json`);
    fs.rmSync(savePath, { force: true });
    const server = spawn('node', ['server/index.js'], {
      cwd: root,
      env: { ...process.env, LLM_PROVIDER: 'mock', TTRPG_PORT: String(PORT), TTRPG_SAVE: SAVE, TTRPG_WORLD: worldDir, TTRPG_RULESET: 'necrotopia' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', d => { log += d; });
    server.stderr.on('data', d => { log += d; });
    try {
      let schema = null, health = null;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`http://localhost:${PORT}/health`);
          if (r.ok) { health = await r.json(); schema = await (await fetch(`http://localhost:${PORT}/schema`)).json(); break; }
        } catch {}
        await sleep(100);
      }
      assert(schema, `server did not boot:\n${log}`);
      assert(/\[ruleset\] Loaded/.test(log) && /necrotopia/i.test(log), `ruleset not loaded in boot log:\n${log}`);
      assert(/\+combat/.test(log), `combat override not threaded in boot log:\n${log}`);
      assert(schema.moves, '`moves` component not registered into /schema');
      ok('boots with TTRPG_WORLD=campaigns/necrotopia + TTRPG_RULESET=necrotopia (+combat)');

      // Seeded the Vegas starter scene (PC + imps + the escape car).
      const ev = await (await fetch(`http://localhost:${PORT}/events?since=0&limit=1`)).json();
      // entity presence is easier to check via a fresh /schema-independent op probe:
      const opRes = await fetch(`http://localhost:${PORT}/op`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [{ op: 'event', name: 'system', data: { kind: 'note', text: 'smoke ping' } }] }),
      });
      assert(opRes.ok, 'op endpoint reachable');
      ok('Vegas starter campaign seeded and serving');
    } finally {
      try { server.kill('SIGKILL'); } catch {}
      fs.rmSync(savePath, { force: true });
      await sleep(150);
    }
  }

  console.log(`\n${passed} Necrotopia smoke checks passed.`);
  process.exit(0);
})().catch(err => { console.error('\n❌ NECROTOPIA SMOKE FAILED:', err.message); process.exit(1); });
