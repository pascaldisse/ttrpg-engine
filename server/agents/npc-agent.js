/**
 * server/agents/npc-agent.js — NPC agent-client.
 *
 * Each NPC is its own agent with its own system prompt, scoped private knowledge,
 * and own memory. Emits event:dialogue in its own voice.
 *
 * The DM routes player input to an NPC agent; the NPC responds in-character.
 */

import { buildNpcContext, npcMemoryFor } from '../../shared/context.js';
import { look as senseLook } from '../sense.js';
import { streamBeat } from './stream-beat.js';

// ---- Stream counter (module-level, shared with dm-agent) ----

let streamCounter = 0;

/**
 * Create an NPC agent.
 *
 * @param {object} params
 * @param {import('../session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast
 * @param {object} params.llm — LlmClient
 * @returns {{respond: (npcId:string, playerText:string, directorNote?:string) => Promise<string>}}
 */
export function createNpcAgent({ session, broadcast, applyAndBroadcast, llm }) {
  /**
   * Have an NPC respond to the player in-character.
   *
   * @param {string} npcId — the entity id of the NPC
   * @param {string} playerText — what the player said/asked
   * @param {string} [directorNote] — optional DM stage direction injected into context
   * @returns {Promise<string>} — the NPC's response text
   */
  async function respond(npcId, playerText, directorNote) {
    // Gather NPC components
    const comps = session.entities.get(npcId);
    if (!comps) {
      // NPC missing — fallback: broadcast a system note
      applyAndBroadcast([{
        op: 'event',
        name: 'system',
        data: {
          text: `[Unknown entity ${npcId}]`,
          done: true,
        },
      }], 'system');
      return '';
    }

    const identity = comps.identity || {};
    const persona = comps.persona || {};
    const knowledge = comps.knowledge || { facts: [], secrets: [] };
    const agent = comps.agent || {};
    const accent = agent.accent || '#4a9eff';

    const npcDef = {
      id: npcId,
      name: identity.name || npcId,
      personality: persona.personality || '',
      backstory: persona.backstory || '',
      voice: persona.voice || '',
      knowledge,
      systemPrompt: agent.systemPrompt || null,
    };

    // Build NPC context
    const lookText = senseLook(session);
    const memory = npcMemoryFor(session.journal, npcId, 12);

    const messages = buildNpcContext({
      npc: npcDef,
      look: lookText,
      playerText,
      npcMemory: memory,
      directorNote: directorNote || null,
    });

    const streamId = `dial-${++streamCounter}`;

    return streamBeat({
      llm,
      messages,
      eventName: 'dialogue',
      baseData: {
        by: npcId,
        speaker: npcId,
        name: identity.name || npcId,
        accent,
      },
      broadcast,
      applyAndBroadcast,
      role: 'npc',
      streamId,
    });
  }

  return { respond };
}
