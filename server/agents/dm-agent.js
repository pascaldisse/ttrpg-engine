/**
 * server/agents/dm-agent.js — DM director agent.
 *
 * The DM is the world-voice: narrates environment, routes player input to NPCs.
 * Does NOT speak for NPCs — those are independent agent-clients.
 */

import { z } from 'zod';
import { buildDmNarrationContext, buildDmRoutingContext } from '../../shared/context.js';
import { streamBeat } from './stream-beat.js';

// ---- 5e system prompt for the DM (moved from turn.js) ----

const DM_SYSTEM_PROMPT = `You are the Dungeon Master of a Dungeons & Dragons 5th Edition game.

Your role:
- Narrate vividly but concisely in 2nd person ("You see...", "You feel...").
- Describe the scene, NPC reactions, and consequences of player actions.
- Rely on your knowledge of 5e rules for any checks, combat, or spellcasting.

Guidelines:
- Keep narration to 2-4 sentences unless the situation demands more.
- Be specific about sensory details — what is seen, heard, smelled, felt.
- Maintain consistent tone matching the scene's mood.
- Track NPC attitudes and world state implicitly.
- Do NOT break character or address the player out-of-game.
- Respond with prose ONLY — never JSON or code blocks. (A separate step will ask you for structured data.)

Always stay in the fiction. You are the world.`;

// ---- Routing result schema ----

const routingSchema = z.object({
  targets: z.array(z.string()).default([]),
  note: z.string().optional().default(''),
});

// ---- Stream counter (shared across agents) ----

let streamCounter = 0;

/**
 * Create the DM agent.
 *
 * @param {object} params
 * @param {import('../session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast
 * @param {object} params.llm — LlmClient
 * @returns {{narrate: (action:object) => Promise<string>, route: (action:object, presentNpcs:Array) => Promise<{targets:string[], note:string}>}}
 */
export function createDmAgent({ session, broadcast, applyAndBroadcast, llm }) {
  const systemPrompt = DM_SYSTEM_PROMPT;
  const sessionId = process.env.TTRPG_SAVE || 'default';

  /**
   * DM world-voice narration.
   * @param {object} actionOp — {op:'action', text, by}
   * @returns {Promise<string>} — the full narration text
   */
  async function narrate(actionOp) {
    const actionText = actionOp.text || '';

    const messages = buildDmNarrationContext({
      systemPrompt,
      session,
      action: actionText,
    });

    const streamId = `narr-${++streamCounter}`;

    return streamBeat({
      llm,
      messages,
      eventName: 'narration',
      baseData: { by: 'dm' },
      broadcast,
      applyAndBroadcast,
      role: 'dm',
      streamId,
    });
  }

  /**
   * LLM routing call — only for the ambiguous case (2+ NPCs, no @mention).
   * Returns {targets, note} validated against the routing Zod schema.
   * On failure, defaults to the first present NPC.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {Array} presentNpcs — from sense.presentAgents()
   * @returns {Promise<{targets:string[], note:string}>}
   */
  async function route(actionOp, presentNpcs) {
    const actionText = actionOp.text || '';

    const messages = buildDmRoutingContext({
      presentNpcs,
      session,
      action: actionText,
    });

    try {
      const { parsed } = await llm.structured(messages, routingSchema, {
        user: sessionId,
        role: 'routing',
      });
      // Validate targets reference actual present NPCs
      const validTargets = (parsed.targets || [])
        .filter(t => presentNpcs.some(n => n.npcId === t));
      return {
        targets: validTargets.length > 0 ? validTargets : [presentNpcs[0]?.npcId].filter(Boolean),
        note: parsed.note || '',
      };
    } catch (err) {
      console.error('[dm-agent] Routing call failed:', err.message);
      // Default to first present NPC
      return {
        targets: presentNpcs.length > 0 ? [presentNpcs[0].npcId] : [],
        note: '',
      };
    }
  }

  return { narrate, route };
}
