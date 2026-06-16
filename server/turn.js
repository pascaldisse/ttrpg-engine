/**
 * server/turn.js — the turn engine (orchestrator).
 *
 * Triggered when a client emits an action op.
 * Routes player input to the correct agent (DM or NPC) following the routing rule:
 *   1. @name match → route to matched NPC (no LLM)
 *   2. Single agent-NPC present → route to it (no LLM)
 *   3. Zero agent-NPCs → DM narrates
 *   4. 2+ agent-NPCs, no @mention → LLM routing call
 *
 * Each NPC is an independent agent-client; the DM is a director/world-voice.
 */

import { presentAgents as sensePresentAgents, look as senseLook } from './sense.js';

/**
 * Resolve which NPC(s) to route to based on player text and present agents.
 * Rule (no LLM for @mention and single-NPC cases):
 *
 * @param {string} text — player action text
 * @param {Array<{npcId:string, name:string, persona:string, accent:string|null, locationId:string|null}>} presentNpcs
 * @returns {{target:string|null, note:string, needsRouting:boolean}}
 *   - target: the npcId to route to (or null for DM)
 *   - note: optional director note
 *   - needsRouting: true if LLM routing call is required
 */
function resolveRoute(text, presentNpcs) {
  const trimmed = (text || '').trim();

  // Rule 1: @mention match (case-insensitive, word-start match)
  const atMatch = trimmed.match(/@(\S+)/);
  if (atMatch) {
    const token = atMatch[1].toLowerCase();
    // Match against identity.name — case-insensitive startsWith or word match
    for (const npc of presentNpcs) {
      const npcName = (npc.name || '').toLowerCase();
      if (npcName.startsWith(token) || npcName === token) {
        // Strip the @mention from the text for the NPC (cleaner input)
        return { target: npc.npcId, note: '', needsRouting: false };
      }
    }
    // @mention but no match found — fall through to normal routing
  }

  // Rule 2: exactly one agent-NPC present → auto-route to it
  if (presentNpcs.length === 1) {
    return { target: presentNpcs[0].npcId, note: '', needsRouting: false };
  }

  // Rule 3: zero agent-NPCs → DM narrates
  if (presentNpcs.length === 0) {
    return { target: null, note: '', needsRouting: false };
  }

  // Rule 4: 2+ agent-NPCs, no @mention → need LLM routing
  return { target: null, note: '', needsRouting: true };
}

/**
 * Create the turn engine.
 *
 * @param {object} params
 * @param {import('./session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast        — raw broadcast (live-only, no journal)
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast — canonical commit
 * @param {object} params.llm                          — LlmClient instance
 * @param {object} params.dmAgent                      — DmAgent instance
 * @param {object} params.npcAgent                    — NpcAgent instance
 * @returns {{runTurn: (actionOp:object) => Promise<void>}}
 */
export function createTurnEngine({ session, broadcast, applyAndBroadcast, llm, dmAgent, npcAgent }) {
  /**
   * Orchestrate a turn: resolve route → agent responds.
   * @param {object} actionOp — {op:'action', text, by}
   */
  async function runTurn(actionOp) {
    const actionText = actionOp.text || '';
    if (!actionText.trim()) return;

    try {
      // 1. Get present agent-NPCs
      const presentNpcs = sensePresentAgents(session);

      // 2. Resolve route
      let route = resolveRoute(actionText, presentNpcs);

      // 2b. If routing needed, call DM routing LLM
      if (route.needsRouting) {
        const routingResult = await dmAgent.route(actionOp, presentNpcs);
        route = {
          target: routingResult.targets[0] || null,
          note: routingResult.note || '',
          needsRouting: false,
        };
      }

      // 3. Execute: NPC response or DM narration.
      if (route.target) {
        // Responder indirection (DESIGN-NOTES.md #1): resolve WHO drives this NPC seat.
        // 'ai' → the LLM agent; a clientId → a human puppeting it (future drop-in). Either
        // path emits the same event:dialogue ops, so nothing downstream cares who authored it.
        const tgt = session.entities.get(route.target) || {};
        const controller = (tgt.agent && tgt.agent.controller) || 'ai';
        if (controller !== 'ai') {
          // FUTURE: solicit input from the human occupying this seat instead of the LLM.
          console.log(`[turn] NPC ${route.target} controller="${controller}" — human handoff not yet implemented; using AI agent.`);
        }
        await npcAgent.respond(route.target, actionText, route.note);
      } else {
        // No target → DM narrates the world's response.
        await dmAgent.narrate(actionOp);
      }
    } catch (err) {
      console.error('[turn] Turn engine error:', err.message);
      // Broadcast a graceful failure narration
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
