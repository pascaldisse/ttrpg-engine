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
import { resolveExit, isConnected, pcLocationId } from '../shared/space.js';

/**
 * Movement-intent gate for the deterministic fast-path. The text must READ like
 * travel before we try to match it to an exit — anchored at the start so it can't
 * false-trigger on "examine the door to the docks". An optional polite preamble
 * ("I'd like to", "let's", "can we") may precede the movement verb. If the verb is
 * present but no exit matches, we fall through to LLM adjudication (move backstop).
 */
export const MOVE_INTENT_RE = /^\s*(?:(?:i(?:'d| would)?\s+(?:like|want|wish|love|need)\s+to|i\s+(?:wanna|want to)|let'?s|let us|can we|could we|shall we|time to|off)\s+)?(?:go|move|walk|head|travel|journey|venture|proceed|return|leave|exit|enter|run|step|climb|descend|cross|wander|stroll|visit|approach|make (?:my|our) way|set off|set out)\b/i;

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
export function createTurnEngine({ session, broadcast, applyAndBroadcast, dmAgent, npcAgent, combat }) {
  /**
   * Move the PC to a connected location, then narrate the arrival.
   * The move itself is engine-applied (deterministic, already canon) so we do
   * NOT canonize the arrival prose — it only describes the new room.
   *
   * @param {string} pcId
   * @param {string} targetId — destination location id (already validated as connected)
   * @param {object} actionOp — the originating player action (for narration context)
   */
  async function doMove(pcId, targetId, actionOp) {
    await applyConsequences([{ op: 'move', id: pcId, to: targetId }], session, applyAndBroadcast);
    // Refresh the scene frame to the NEW location and narrate arrival.
    session._lookCache = senseLook(session);
    await dmAgent.narrateOutcome(actionOp, [], session._lookCache);
  }

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

      // 1. Get present agent-NPCs (already scoped to the PC's location)
      const presentNpcs = sensePresentAgents(session);

      // 0.1 Find PC entity for stat context (needed for check resolution + movement)
      const pcEntry = [...session.entities.entries()].find(
        ([_id, comps]) => (comps.identity || {}).kind === 'pc'
      );
      const pcId = pcEntry ? pcEntry[0] : null;
      const pcStats = (pcEntry && pcEntry[1].stats) || {};
      const pcProficiency = pcStats.proficiency || 2;
      const here = pcLocationId(session.entities);

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

      // 2.5 Movement fast-path (deterministic, no LLM): the action must read like
      //     travel AND resolve unambiguously to a connected exit.
      if (pcId && here && MOVE_INTENT_RE.test(actionText)) {
        const target = resolveExit(session.entities, here, actionText);
        if (target) {
          await doMove(pcId, target, actionOp);
          return;
        }
        // ambiguous / no exit matched → fall through to adjudication (move backstop)
      }

      // 2.6 Combat (no LLM): if an encounter is active, every action is a combat action.
      if (combat && combat.inCombat()) {
        await combat.handlePlayerAction(actionOp);
        return;
      }

      // 2.7 Combat initiation (no LLM): attacking a present HOSTILE starts a structured
      //     encounter. Attacking a non-hostile NPC falls through to the narrative path.
      if (combat) {
        const initiation = combat.detectInitiation(actionText);
        if (initiation) {
          await combat.startAndResolve(actionOp, initiation);
          return;
        }
      }

      // 3. Adjudicate: structured LLM call
      const ruling = await dmAgent.adjudicate(actionOp, presentNpcs);

      // 3.5 Movement decided by the LLM (natural-language backstop).
      if (pcId && ruling.move && ruling.move.to) {
        const dest = ruling.move.to;
        if (here && isConnected(session.entities, here, dest)) {
          await doMove(pcId, dest, actionOp);
          return;
        }
        // Destination not reachable from here — tell the player; then narrate normally.
        applyAndBroadcast([{
          op: 'event',
          name: 'system',
          data: { kind: 'note', text: `(You can't reach "${dest}" directly from here.)` },
        }], 'system');
        // fall through to a plain outcome narration (no checks).
      }

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
