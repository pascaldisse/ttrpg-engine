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
import { redactForSeat, seatSees } from '../shared/visibility.js';
import { createLlmClient } from './llm.js';
import { createTurnEngine } from './turn.js';
import { createCombatEngine } from './combat.js';
import { createQuestEngine } from './quests.js';
import { loadRuleset } from './ruleset.js';
import { createDmAgent } from './agents/dm-agent.js';
import { createNpcAgent } from './agents/npc-agent.js';
import * as sense from './sense.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TTRPG_PORT = parseInt(process.env.TTRPG_PORT || '8420', 10);
const TTRPG_WORLD = process.env.TTRPG_WORLD || path.resolve(__dirname, '..', 'world');
const TTRPG_SAVE = process.env.TTRPG_SAVE || 'default';

// ---- Ruleset (rules-as-data) ----
// If TTRPG_RULESET is set, load the bundle BEFORE seeding: it registers component
// + check-def extensions and supplies the DM system prompt. No ruleset → built-in 5e.
const TTRPG_RULESET = process.env.TTRPG_RULESET || null;
let rulesetPrompt = null;
let rulesetCombat = null;
if (TTRPG_RULESET) {
  try {
    const rs = await loadRuleset(TTRPG_RULESET, TTRPG_WORLD);
    rulesetPrompt = rs.systemPrompt || null;
    rulesetCombat = rs.combat || null;
    console.log(`[ruleset] Loaded "${(rs.meta && rs.meta.name) || TTRPG_RULESET}" (${(rs.meta && rs.meta.dice) || '?'})${rulesetCombat ? ' +combat' : ''}`);
  } catch (e) {
    console.error(`[ruleset] Failed to load "${TTRPG_RULESET}": ${e.message} — using built-in 5e defaults.`);
  }
}

// ---- Session ----

const session = new Session(TTRPG_WORLD, TTRPG_SAVE);
console.log(`[session] Seeding from ${TTRPG_WORLD}`);
session.seedFromWorld(TTRPG_WORLD);
session.load();
console.log(`[session] Ready — ${session.entities.size} entities, counter ${session.counter}`);

// DMView control singleton (autopilot on by default → today's auto-apply behavior).
// Spawned directly on the store (no clients are connected yet at boot).
if (!session.entities.has('dm-control')) {
  session.applyOps([{
    op: 'spawn', id: 'dm-control',
    components: { dmControl: { autopilot: true }, identity: { name: 'DM Control', kind: 'world-state' } },
  }], 'system');
}

// ---- LLM Client ----

const llm = createLlmClient();

// ---- Agents ----

const dmAgent = createDmAgent({ session, broadcast, applyAndBroadcast, llm, rulesetPrompt });
const npcAgent = createNpcAgent({ session, broadcast, applyAndBroadcast, llm });

// ---- Quest + progression engine (deterministic, no LLM) ----

const questEngine = createQuestEngine({ session, broadcast, applyAndBroadcast });

// ---- Combat Engine (structured encounters; deterministic, no LLM) ----
// Combat awards kill-XP through the quest engine's shared awardXp.

const combat = createCombatEngine({ session, broadcast, applyAndBroadcast, awardXp: questEngine.awardXp, rules: rulesetCombat });

// ---- Turn Engine ----

const turnEngine = createTurnEngine({ session, broadcast, applyAndBroadcast, dmAgent, npcAgent, combat, questEngine });

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

/**
 * Send a message to open WS clients, filtered per recipient seat.
 * - `audience` gates WHO receives it ('all' | 'dm' | 'players') — DM-only events
 *   (proposals, agent traces) use 'dm' so players never see the machinery.
 * - Each recipient's copy is run through redactForSeat(), so non-DM seats never
 *   receive private components (NPC knowledge/persona/agent internals).
 * @param {object} msg
 * @param {'all'|'dm'|'players'} [audience]
 */
function broadcast(msg, audience = 'all') {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const seat = client._seat || 'player';
    if (!seatSees(audience, seat)) continue;
    const out = redactForSeat(msg, seat);
    if (out) client.send(JSON.stringify(out));
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

  // Seat is unknown until `hello`; default to the least-privileged player seat so
  // the immediate snapshot is already redacted. A non-player hello re-sends the
  // entitled view below.
  ws._seat = 'player';
  const initialSnap = redactForSeat(session.snapshot(), ws._seat);
  if (initialSnap) ws.send(JSON.stringify(initialSnap));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    // Hello — register presence + lock in this client's seat for redaction.
    if (msg.type === 'hello') {
      const pres = msg.presence || { seat: 'player', who: 'anonymous', mode: 'play' };
      ws._seat = pres.seat || 'player';
      const presenceId = msg.presenceId || `presence-${Date.now()}`;
      applyAndBroadcast([{ op: 'spawn', id: presenceId, components: { presence: pres } }], 'system');
      ws._presenceId = presenceId; // remembered for cleanup on disconnect
      // A privileged seat (e.g. dm) is entitled to more than the player snapshot it
      // got on connect — re-send the seat-appropriate (unredacted) view.
      if (ws._seat !== 'player') {
        const snap = redactForSeat(session.snapshot(), ws._seat);
        if (snap) ws.send(JSON.stringify(snap));
      }
      // A DM joining after proposals were staged needs to see the backlog.
      if (ws._seat === 'dm') {
        for (const proposal of turnEngine.listProposals()) {
          ws.send(JSON.stringify({ type: 'proposal', proposal }));
        }
      }
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

    // DMView control (Slice 2) — DM seats only: toggle autopilot, resolve proposals.
    if (msg.type === 'dm-control') {
      if (ws._seat !== 'dm') {
        ws.send(JSON.stringify({ type: 'error', error: 'dm-control requires a DM seat' }));
        return;
      }
      if (msg.action === 'setAutopilot') {
        turnEngine.setAutopilot(!!msg.value);
        return;
      }
      // approve | reject | regenerate
      turnEngine.resolveProposal(msg.proposalId, msg.action)
        .catch(err => console.error('[dm-control] resolve error:', err.message));
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
