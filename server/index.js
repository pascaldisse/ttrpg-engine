/**
 * server/index.js — entry point.
 * HTTP server + WebSocket hub. Owns one Session.
 *
 * Based on GAIA's server/index.js architecture.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Session } from './session.js';
import { SCHEMA } from '../shared/schema.js';
import { validateOpBatch } from '../shared/ops.js';
import { createLlmClient } from './llm.js';
import { createTurnEngine } from './turn.js';
import { createDmAgent } from './agents/dm-agent.js';
import { createNpcAgent } from './agents/npc-agent.js';
import * as sense from './sense.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TTRPG_PORT = parseInt(process.env.TTRPG_PORT || '8420', 10);
const TTRPG_WORLD = process.env.TTRPG_WORLD || path.resolve(__dirname, '..', 'world');
const TTRPG_SAVE = process.env.TTRPG_SAVE || 'default';

// ---- Session ----

const session = new Session(TTRPG_WORLD, TTRPG_SAVE);
console.log(`[session] Seeding from ${TTRPG_WORLD}`);
session.seedFromWorld(TTRPG_WORLD);
session.load();
console.log(`[session] Ready — ${session.entities.size} entities, counter ${session.counter}`);

// ---- LLM Client ----

const llm = createLlmClient();

// ---- Agents ----

const dmAgent = createDmAgent({ session, broadcast, applyAndBroadcast, llm });
const npcAgent = createNpcAgent({ session, broadcast, applyAndBroadcast, llm });

// ---- Turn Engine ----

const turnEngine = createTurnEngine({ session, broadcast, applyAndBroadcast, dmAgent, npcAgent });

/**
 * After applying a batch of ops, fire the turn engine for any action ops.
 * Fire-and-forget (do NOT await) so the HTTP response / WS ack returns
 * immediately; narration streams over WS as it arrives.
 */
function triggerTurns(ops, from) {
  for (const op of ops) {
    if (op.op === 'action' && op.text) {
      turnEngine.runTurn(op).catch(err => {
        console.error('[turn] Fire-and-forget error:', err.message);
      });
    }
  }
}

// ---- HTTP helpers ----

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

// ---- Broadcast helpers ----

/** Send a message object to every open WS client. */
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

/**
 * Validate + apply a batch of ops, then broadcast the resulting ops to all
 * clients (and a fresh snapshot if a reset occurred). Single path for HTTP,
 * WS, presence join/leave — so the wire always carries full op payloads.
 */
function applyAndBroadcast(ops, from) {
  const validation = validateOpBatch(ops);
  if (!validation.ok) return { ok: false, error: validation.error, status: 400 };
  const result = session.applyOps(validation.ops, from);
  if (!result.ok) return { ...result, status: 409 };
  if (result.resnapshot) broadcast(session.snapshot());
  if (result.broadcast && result.broadcast.length) {
    broadcast({ type: 'ops', ops: result.broadcast });
  }
  return result;
}

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${TTRPG_PORT}`);

  try {
    // GET /schema
    if (req.method === 'GET' && url.pathname === '/schema') {
      return json(res, SCHEMA);
    }

    // GET /events?since=&limit=
    if (req.method === 'GET' && url.pathname === '/events') {
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      return json(res, session.eventsSince(since, limit));
    }

    // POST /op
    if (req.method === 'POST' && url.pathname === '/op') {
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, { ok: false, error: 'Invalid JSON' }, 400);
      }
      const ops = Array.isArray(payload.ops) ? payload.ops : [payload];
      const from = payload.from || 'http-client';

      const result = applyAndBroadcast(ops, from);
      if (!result.ok) {
        return json(res, { ok: false, error: result.error, applied: result.applied }, result.status || 400);
      }
      // Trigger turn engine for action ops (fire-and-forget)
      triggerTurns(ops, from);
      return json(res, { ok: true, applied: result.applied });
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, {
        status: 'ok',
        entities: session.entities.size,
        journal: session.journal.length,
      });
    }

    // GET /sense/look
    if (req.method === 'GET' && url.pathname === '/sense/look') {
      return json(res, { ok: true, look: sense.look(session) });
    }

    // GET /sense/describe?id=
    if (req.method === 'GET' && url.pathname === '/sense/describe') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json(res, { ok: false, error: 'Missing id param' }, 400);
      return json(res, { ok: true, description: sense.describe(session, id) });
    }

    // GET /sense/query?has=&kind=
    if (req.method === 'GET' && url.pathname === '/sense/query') {
      const has = url.searchParams.get('has') || undefined;
      const kind = url.searchParams.get('kind') || undefined;
      const at = url.searchParams.get('at') || undefined;
      return json(res, { ok: true, results: sense.query(session, { has, kind, at }) });
    }

    // GET /sense/check
    if (req.method === 'GET' && url.pathname === '/sense/check') {
      return json(res, { ok: true, findings: sense.check(session) });
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error('[http] Error:', e);
    json(res, { ok: false, error: e.message }, 500);
  }
});

// ---- WebSocket ----

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[ws] Client connected');

  // Send snapshot immediately
  ws.send(JSON.stringify(session.snapshot()));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    // Hello — register presence
    if (msg.type === 'hello') {
      const pres = msg.presence || { seat: 'player', who: 'anonymous', mode: 'play' };
      const presenceId = msg.presenceId || `presence-${Date.now()}`;
      applyAndBroadcast([{ op: 'spawn', id: presenceId, components: { presence: pres } }], 'system');
      ws._presenceId = presenceId; // remembered for cleanup on disconnect
      return;
    }

    // Ops batch
    if (msg.type === 'ops') {
      const result = applyAndBroadcast(msg.ops || [], msg.from || 'ws-client');
      if (!result.ok) {
        ws.send(JSON.stringify({ type: 'error', error: result.error }));
        return;
      }
      // Trigger turn engine for action ops (fire-and-forget)
      triggerTurns(msg.ops || [], msg.from || 'ws-client');
      return;
    }
  });

  ws.on('close', () => {
    if (ws._presenceId) {
      applyAndBroadcast([{ op: 'despawn', id: ws._presenceId }], 'system');
    }
    console.log('[ws] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[ws] Error:', err.message);
  });
});

// ---- Start ----

server.listen(TTRPG_PORT, () => {
  console.log(`[server] HTTP + WS listening on port ${TTRPG_PORT}`);
  console.log(`[server] World: ${TTRPG_WORLD}`);
  console.log(`[server] Save slot: ${TTRPG_SAVE}`);
});
