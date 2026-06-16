/**
 * server/agents/stream-beat.js — shared streaming helper.
 *
 * Generalized version of P1's narration streaming: streams LLM deltas as live
 * event ops, then commits the final result on completion. Strips stray fenced
 * JSON from the final text.
 *
 * Used by dm-agent and npc-agent.
 */

/**
 * Strip stray fenced ```json``` blocks from text.
 */
function stripFences(text) {
  return String(text || '').replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim();
}

/**
 * Stream an LLM call, broadcasting live deltas and committing the final result.
 *
 * @param {object} params
 * @param {object} params.llm                    — LlmClient instance
 * @param {Array<{role:string,content:string}>} params.messages
 * @param {string} params.eventName              — e.g. 'narration' or 'dialogue'
 * @param {object} params.baseData               — fields set on every event (by, speaker, name, accent...)
 * @param {(msg:object)=>void} params.broadcast   — server broadcast (live-only)
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast — canonical commit
 * @param {string} params.role                   — 'dm' or 'npc' (passed to llm.stream opts for provider branching)
 * @param {number} [params.streamId]
 * @returns {Promise<string>} — the full final text
 */
export async function streamBeat({
  llm,
  messages,
  eventName,
  baseData,
  broadcast,
  applyAndBroadcast,
  role,
  streamId,
}) {
  let fullText = '';

  // Stream live deltas
  for await (const { delta } of llm.stream(messages, { role })) {
    fullText += delta;
    broadcast({
      type: 'ops',
      ops: [{
        op: 'event',
        name: eventName,
        data: { ...baseData, streamId, delta },
      }],
    });
  }

  // Strip any stray fenced JSON defensively
  fullText = stripFences(fullText);

  // Canonical commit: final done event
  applyAndBroadcast([{
    op: 'event',
    name: eventName,
    data: { ...baseData, streamId, text: fullText, done: true },
  }], baseData.by || 'dm');

  return fullText;
}
