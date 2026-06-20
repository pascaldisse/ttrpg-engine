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
export function createTurnEngine({ session, broadcast, applyAndBroadcast, dmAgent, npcAgent, combat, questEngine }) {
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
   * Public entry: run the turn, then re-evaluate quests/progression (P6) on EVERY
   * path (combat, movement, talk, world action) via a finally — so triggers fire
   * off whatever just happened (reached a location, took an item, won a fight).
   * @param {object} actionOp — {op:'action', text, by}
   */
  async function runTurn(actionOp) {
    try {
      await runTurnInner(actionOp);
    } finally {
      if (questEngine) {
        try { await questEngine.evaluate(); }
        catch (e) { console.error('[turn] quest evaluate error:', e.message); }
      }
    }
  }

  /**
   * Orchestrate a turn with full adjudication → checks → narration → consequences.
   * @param {object} actionOp — {op:'action', text, by}
   */
  async function runTurnInner(actionOp) {
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
        const initiation = combat.detectInitiation(actionOp);
        if (initiation) {
          await combat.startAndResolve(actionOp, initiation);
          return;
        }
      }

      // 3. Adjudicate: structured LLM call (the DM's PROPOSED ruling for this action).
      const ruling = await dmAgent.adjudicate(actionOp, presentNpcs);
      emitTrace({ agent: 'dm', phase: 'adjudicate', summary: summarizeRuling(ruling, actionText), detail: ruling });

      // 3.1 GATE (DMView Slice 2): when paused (autopilot off), don't execute the ruling —
      //     stage it as a proposal for the DM to approve / reject / regenerate. The
      //     deterministic fast-paths above (movement/combat/@name) are never gated; only
      //     LLM rulings are. Autopilot on → execute immediately (the original behavior).
      if (isPaused()) {
        stageProposal(actionOp, ruling);
        return;
      }

      await executeRuling(actionOp, ruling);

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

  /**
   * Execute an adjudicated ruling: movement backstop → speakTo → checks → narrate →
   * canonize. Split out from runTurnInner so the DM gate can defer it until approval.
   * Re-derives PC/location context at call time (state may have advanced since the
   * proposal was staged).
   * @param {object} actionOp
   * @param {object} ruling — from dmAgent.adjudicate()
   */
  async function executeRuling(actionOp, ruling) {
    const actionText = (actionOp.text || '').trim();

    const pcEntry = [...session.entities.entries()].find(
      ([_id, comps]) => (comps.identity || {}).kind === 'pc'
    );
    const pcId = pcEntry ? pcEntry[0] : null;
    const pcStats = (pcEntry && pcEntry[1].stats) || {};
    const pcProficiency = pcStats.proficiency || 2;
    const here = pcLocationId(session.entities);
    session._lookCache = senseLook(session);

    // 3.5 Movement decided by the LLM (natural-language backstop).
    if (pcId && ruling.move && ruling.move.to) {
      const dest = ruling.move.to;
      if (here && isConnected(session.entities, here, dest)) {
        await doMove(pcId, dest, actionOp);
        return;
      }
      applyAndBroadcast([{
        op: 'event', name: 'system',
        data: { kind: 'note', text: `(You can't reach "${dest}" directly from here.)` },
      }], 'system');
      // fall through to a plain outcome narration (no checks).
    }

    // 4. speakTo path → NPC conversation
    if (ruling.speakTo) {
      emitTrace({ agent: 'npc', phase: 'respond', summary: `${ruling.speakTo} responds to the player`, detail: { note: ruling.note || '' } });
      await npcAgent.respond(ruling.speakTo, actionText, ruling.note || '');
      return;
    }

    // 5. World action: resolve checks via ENGINE
    const checkResults = [];
    for (const checkReq of ruling.checks || []) {
      const rng = session.rng(); // deterministic, advances rollCount
      const result = resolveCheck(
        {
          check: 'ability-check',
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

      applyAndBroadcast([{
        op: 'event', name: 'system',
        data: {
          kind: 'roll',
          text: formatCheckResult(result),
          detail: {
            check: checkReq.ability, skill: checkReq.skill, dc: checkReq.dc,
            rolls: result.rolls, modifier: result.modifier, total: result.total,
            success: result.success, crit: result.crit, fumble: result.fumble,
            reason: checkReq.reason,
          },
        },
      }], 'system');
    }

    // 6. Narrate the outcome (grounded in the scene + the rolled results).
    const narrationText = await dmAgent.narrateOutcome(actionOp, checkResults, session._lookCache);

    // 7. Canonize: distill what the narration established into ops.
    const canonOps = await dmAgent.canonize(actionOp, narrationText, checkResults);
    emitTrace({ agent: 'dm', phase: 'canonize', summary: `${(canonOps || []).length} consequence op(s)`, detail: canonOps || [] });
    if (canonOps && canonOps.length > 0) {
      await applyConsequences(canonOps, session, applyAndBroadcast);
    }
  }

  // ---- DMView: pause/propose gate (Slice 2) + agent traces (Slice 3) ----

  const pendingProposals = new Map(); // id → {id, actionOp, ruling, actionText, summary, createdAt}
  let proposalSeq = 0;

  /** True when the DM gate is engaged (dm-control.dmControl.autopilot === false). */
  function isPaused() {
    const ctrl = session.entities.get('dm-control');
    return !!(ctrl && ctrl.dmControl && ctrl.dmControl.autopilot === false);
  }

  /** Flip autopilot on/off (merge onto the dm-control singleton; broadcast to all). */
  function setAutopilot(on) {
    applyAndBroadcast([{ op: 'merge', id: 'dm-control', component: 'dmControl', value: { autopilot: !!on } }], 'dm');
  }

  /** One-line human summary of a ruling for the proposal card. */
  function summarizeRuling(ruling, actionText) {
    if (ruling.move && ruling.move.to) return `Move the party → ${ruling.move.to}`;
    if (ruling.speakTo) return `${ruling.speakTo} answers the player`;
    const parts = [];
    if (ruling.checks && ruling.checks.length) {
      parts.push('roll ' + ruling.checks.map(c => `${c.ability || '?'}${c.skill ? '/' + c.skill : ''} DC${c.dc || '?'}`).join(', '));
    }
    if (ruling.ops && ruling.ops.length) parts.push(`${ruling.ops.length} consequence op(s)`);
    return parts.length ? parts.join(' · ') : 'Narrate the outcome';
  }

  /** Emit a DM-only trace of an agent decision / tool call (Slice 3). */
  function emitTrace(trace) {
    broadcast({ type: 'trace', trace: { ...trace, t: Date.now() } }, 'dm');
  }

  /** Stage a ruling as a pending proposal + notify the DM (+ a vague note to players). */
  function stageProposal(actionOp, ruling) {
    const id = `prop-${++proposalSeq}`;
    const actionText = (actionOp.text || '').trim();
    const summary = summarizeRuling(ruling, actionText);
    pendingProposals.set(id, { id, actionOp, ruling, actionText, summary, createdAt: Date.now() });
    broadcast({ type: 'proposal', proposal: { id, actionText, summary, ruling } }, 'dm');
    applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'note', text: '(The dungeon master considers your action…)' } }], 'system');
  }

  /** Pending proposals (for a DM that connects AFTER they were staged). */
  function listProposals() {
    return [...pendingProposals.values()].map(({ id, actionText, summary, ruling }) => ({ id, actionText, summary, ruling }));
  }

  /**
   * DM resolves a proposal: 'approve' → execute the ruling, 'reject' → drop it,
   * 'regenerate' → re-adjudicate and replace it.
   * @param {string} id
   * @param {'approve'|'reject'|'regenerate'} action
   */
  async function resolveProposal(id, action) {
    const pending = pendingProposals.get(id);
    if (!pending) return;

    if (action === 'reject') {
      pendingProposals.delete(id);
      broadcast({ type: 'proposal-resolved', id, action: 'reject' }, 'dm');
      applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'note', text: '(The dungeon master lets the moment pass.)' } }], 'system');
      return;
    }

    if (action === 'regenerate') {
      const presentNpcs = sensePresentAgents(session);
      const ruling = await dmAgent.adjudicate(pending.actionOp, presentNpcs);
      const summary = summarizeRuling(ruling, pending.actionText);
      emitTrace({ agent: 'dm', phase: 'adjudicate', summary: `(regen) ${summary}`, detail: ruling });
      pendingProposals.set(id, { ...pending, ruling, summary });
      broadcast({ type: 'proposal', proposal: { id, actionText: pending.actionText, summary, ruling } }, 'dm');
      return;
    }

    // approve
    pendingProposals.delete(id);
    broadcast({ type: 'proposal-resolved', id, action: 'approve' }, 'dm');
    try {
      await executeRuling(pending.actionOp, pending.ruling);
    } finally {
      if (questEngine) {
        try { await questEngine.evaluate(); }
        catch (e) { console.error('[turn] quest evaluate error:', e.message); }
      }
    }
  }

  return { runTurn, isPaused, setAutopilot, resolveProposal, listProposals };
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
