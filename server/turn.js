/**
 * server/turn.js — the turn engine (orchestrator). P3: action→consequence loop.
 *
 * Triggered when a client emits an action op.
 * NEW FLOW (P3):
 *   1. @name match → fast-path to that NPC (no LLM), npcAgent.respond(...), done.
 *   2. Otherwise → dmAgent.adjudicate(action, presentNpcs):
 *      a. If speakTo set → npcAgent.respond(speakTo, text, note) (conversation), done.
 *      b. Else (world action):
 *         - Resolve each checks[] via shared/checks.js + session.rng() (ENGINE rolls).
 *         - Broadcast roll results as event:system.
 *         - dmAgent.narrateOutcome(action, checkResults) (stream narration).
 *         - Expand + apply consequence ops (adjudication ops for success case).
 *         - Guard: ignore ops targeting pc/presence despawns.
 */

import { presentAgents as sensePresentAgents, look as senseLook } from './sense.js';
import { resolveCheck, formatCheckResult } from '../shared/checks.js';
import { expandOp } from '../shared/effects.js';
import { validateOp } from '../shared/ops.js';

/**
 * Create the turn engine.
 *
 * @param {object} params
 * @param {import('./session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast
 * @param {object} params.llm
 * @param {object} params.dmAgent
 * @param {object} params.npcAgent
 * @returns {{runTurn: (actionOp:object) => Promise<void>}}
 */
export function createTurnEngine({ session, broadcast, applyAndBroadcast, dmAgent, npcAgent }) {
  /**
   * Orchestrate a turn with full adjudication → checks → narration → consequences.
   * @param {object} actionOp — {op:'action', text, by}
   */
  async function runTurn(actionOp) {
    const actionText = (actionOp.text || '').trim();
    if (!actionText) return;

    try {
      // 0. Cache the look frame for narrateOutcome (avoid re-computation)
      session._lookCache = senseLook(session);

      // 1. Get present agent-NPCs
      const presentNpcs = sensePresentAgents(session);

      // 0.1 Find PC entity for stat context (needed for check resolution)
      const pcEntry = [...session.entities.entries()].find(
        ([_id, comps]) => (comps.identity || {}).kind === 'pc'
      );
      const pcStats = (pcEntry && pcEntry[1].stats) || {};
      const pcProficiency = pcStats.proficiency || 2;

      // 2. @name fast-path (no LLM) → route to matched NPC directly
      const atMatch = actionText.match(/@(\S+)/);
      if (atMatch) {
        const token = atMatch[1].toLowerCase();
        for (const npc of presentNpcs) {
          const npcName = (npc.name || '').toLowerCase();
          if (npcName.startsWith(token) || npcName === token) {
            const cleanText = actionText.replace(/@\S+\s*/, '').trim() || 'Hello.';
            await npcAgent.respond(npc.npcId, cleanText, '');
            return;
          }
        }
        // @mention but no match → fall through to adjudication
      }

      // 3. Adjudicate: structured LLM call
      const ruling = await dmAgent.adjudicate(actionOp, presentNpcs);

      // 4. speakTo path → NPC conversation (talk-only in P3)
      if (ruling.speakTo) {
        await npcAgent.respond(ruling.speakTo, actionText, ruling.note || '');
        return;
      }

      // 5. World action: resolve checks via ENGINE
      const checkResults = [];

      for (const checkReq of ruling.checks || []) {
        const rng = session.rng(); // deterministic, advances rollCount
        const result = resolveCheck(
          {
            check: 'ability-check', // P3: only ability-check; attack/saving-throw reserved
            ability: checkReq.ability || 'wis',
            skill: checkReq.skill,
            dc: checkReq.dc || 12,
            reason: checkReq.reason || '',
          },
          { stats: pcStats, proficiency: pcProficiency },
          rng,
        );
        result.reason = checkReq.reason || '';
        result.def = (checkReq.skill || checkReq.ability || 'check');
        checkResults.push(result);

        // Broadcast roll as event:system
        applyAndBroadcast([{
          op: 'event',
          name: 'system',
          data: {
            kind: 'roll',
            text: formatCheckResult(result),
            detail: {
              check: checkReq.ability,
              skill: checkReq.skill,
              dc: checkReq.dc,
              rolls: result.rolls,
              modifier: result.modifier,
              total: result.total,
              success: result.success,
              crit: result.crit,
              fumble: result.fumble,
              reason: checkReq.reason,
            },
          },
        }], 'system');
      }

      // 6. Narrate the outcome (grounded in the scene + the rolled results).
      const narrationText = await dmAgent.narrateOutcome(actionOp, checkResults, session._lookCache);

      // 7. Canonize: distill what the narration ACTUALLY established into ops
      //    ("narrate freely, canonize second"). The narration is already outcome-aware
      //    (success vs failure), so the recorded consequences match the story — no separate
      //    success-gating needed. This keeps state in sync with what the player was told.
      const canonOps = await dmAgent.canonize(actionOp, narrationText, checkResults);
      if (canonOps && canonOps.length > 0) {
        await applyConsequences(canonOps, session, applyAndBroadcast);
      }

    } catch (err) {
      console.error('[turn] Turn engine error:', err.message);
      broadcast({
        type: 'ops',
        ops: [{
          op: 'event',
          name: 'narration',
          data: {
            text: `(The dungeon master pauses — a shadow passes over the world. Perhaps try again?)`,
            done: true,
            by: 'dm',
          },
        }],
      });
    }
  }

  return { runTurn };
}

/**
 * Expand semantic ops → canonical ops, validate, and apply.
 * Guards: ignore ops that would despawn a pc/presence entity.
 *
 * @param {object[]} ops — proposed ops (may be semantic or canonical)
 * @param {import('./session.js').Session} session
 * @param {(ops:object[], from:string)=>object} applyAndBroadcast
 */
async function applyConsequences(ops, session, applyAndBroadcast) {
  const canonicalOps = [];

  for (const op of ops) {
    const expanded = expandOp(session.entities, op);
    for (const canonOp of expanded) {
      // Guard: no despawn of pc or presence entities
      if (canonOp.op === 'despawn') {
        const comps = session.entities.get(canonOp.id);
        if (comps && (comps.presence || ((comps.identity || {}).kind === 'pc'))) {
          console.warn(`[turn] Ignoring despawn op targeting protected entity ${canonOp.id}`);
          continue;
        }
      }

      // Validate
      const validation = validateOp(canonOp);
      if (!validation.ok) {
        console.warn(`[turn] Invalid consequence op: ${validation.error}`);
        continue;
      }

      canonicalOps.push(canonOp);
    }
  }

  if (canonicalOps.length > 0) {
    const result = applyAndBroadcast(canonicalOps, 'dm');
    if (!result.ok) {
      console.error('[turn] Consequence apply failed:', result.error);
    }
  }
}
