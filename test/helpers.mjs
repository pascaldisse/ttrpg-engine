/**
 * test/helpers.mjs — boot a real server child process + WS client helpers.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Boot server/index.js on a free port with the Necrotopia campaign + mock LLM. */
export async function bootServer(extraEnv = {}) {
  const port = 9000 + Math.floor(Math.random() * 3000);
  const save = `t-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      TTRPG_PORT: String(port),
      TTRPG_WORLD: 'campaigns/necrotopia',
      TTRPG_RULESET: 'necrotopia',
      TTRPG_SAVE: save,
      LLM_PROVIDER: 'mock',
      ART_PROVIDER: 'mock',
      DEEPSEEK_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  // Wait for /health
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await sleep(100);
  }

  const world = extraEnv.TTRPG_WORLD || 'campaigns/necrotopia';
  const savePath = path.join(ROOT, world, 'saves', `session_${save}.json`);
  return {
    port,
    child,
    getLog: () => log,
    async stop() {
      child.kill('SIGKILL');
      await sleep(50);
      for (const f of fs.readdirSync(path.dirname(savePath))) {
        if (f.includes(save)) fs.rmSync(path.join(path.dirname(savePath), f), { force: true });
      }
    },
  };
}

/** Connect a WS client; resolves after the snapshot arrives and hello is sent. */
export function connectClient(port, who, seat = 'player') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { ws, who, snapshot: null, ops: [], server: [] };
    const timer = setTimeout(() => reject(new Error('no snapshot within 5s')), 5000);
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'snapshot') {
        const first = !c.snapshot;
        c.snapshot = msg.entities;
        if (first) {
          ws.send(JSON.stringify({ type: 'hello', presence: { seat, who, mode: 'play' }, presenceId: `p-${who}-${Date.now()}` }));
          clearTimeout(timer);
          setTimeout(() => resolve(c), 150); // let the hello round-trip settle
        }
        return;
      }
      if (msg.type === 'ops') { c.ops.push(...(msg.ops || [])); return; }
      c.server.push(msg);
    });
    c.act = (text, extra = {}) =>
      ws.send(JSON.stringify({ type: 'ops', ops: [{ op: 'action', text, by: who, mode: 'narration', ...extra }], from: who }));
    c.control = (obj) => ws.send(JSON.stringify({ type: 'dm-control', ...obj }));
    c.sendOps = (ops) => ws.send(JSON.stringify({ type: 'ops', ops, from: who }));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until pred() is truthy or timeout; returns pred()'s value. */
export async function until(pred, { timeout = 8000, step = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('until(): condition not met within timeout');
}
