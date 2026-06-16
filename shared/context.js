/**
 * shared/context.js — prompt construction for LLM turn engine.
 *
 * PURE — no imports from server/ or client/.
 *
 * EXTENSION SEAM: when rulesets are loaded (P6), the system prompt prefix
 * will be extended from ruleset data (ruleset/system-prompt.txt + schema).
 */

/**
 * Build an ordered chat-message array for cache-friendly streaming.
 *
 * Order (DeepSeek caches prefixes from token 0):
 * 1. {role:'system', content: systemPrompt}   — BYTE-STABLE across turns
 * 2. Recent history (alternating user/assistant)
 * 3. {role:'system', content: look}            — current scene frame (changes → late)
 * 4. {role:'user', content: action}            — player's action (last)
 *
 * @param {object} params
 * @param {string} params.systemPrompt — byte-stable ruleset system prompt
 * @param {string} params.look        — current scene frame text (from buildLookFrame)
 * @param {Array<{role:string,content:string}>} [params.history] — recent turns
 * @param {string} params.action      — the player's action text
 * @returns {Array<{role:string, content:string}>}
 */
export function buildContext({ systemPrompt, look, history = [], action }) {
  const messages = [];

  // Byte-stable system prompt at token 0 → cache hit every turn
  messages.push({ role: 'system', content: systemPrompt });

  // Rolling window of recent turns (alternating)
  for (const entry of history) {
    messages.push(entry);
  }

  // Current scene frame (changes per turn → placed after stable prefix)
  messages.push({ role: 'system', content: look });

  // Player's action (always last)
  messages.push({ role: 'user', content: action });

  return messages;
}

/**
 * Build a compact text "scene frame" from the entity store.
 * High-salience summary: current location, present NPCs/items, party stats.
 *
 * @param {Map<string,object>|Record<string,object>} entities
 * @returns {string}
 */
export function buildLookFrame(entities) {
  const entries = entities instanceof Map
    ? [...entities.entries()]
    : Object.entries(entities);

  if (entries.length === 0) {
    return 'Current scene: (empty — no entities loaded).';
  }

  const locations = [];
  const npcs = [];
  const items = [];
  const pcs = [];
  const worldFlags = [];

  for (const [id, comps] of entries) {
    const identity = comps.identity || {};
    const kind = identity.kind || '?';

    switch (kind) {
      case 'location': {
        const desc = identity.description || '';
        const name = identity.name || id;
        locations.push(`- **${name}** (${id}): ${desc}`);
        break;
      }
      case 'npc': {
        const name = identity.name || id;
        const status = comps.status || {};
        const alive = status.alive !== false ? '' : ' [DEAD]';
        const desc = identity.description ? ` — ${identity.description}` : '';
        const place = comps.place || {};
        const at = place.locationId ? ` (at ${place.locationId})` : '';
        const persona = comps.persona || {};
        const pers = persona.personality ? ` Personality: ${persona.personality}` : '';
        npcs.push(`- **${name}** (${id})${alive}${at}${desc}${pers}`);
        break;
      }
      case 'item': {
        const name = identity.name || id;
        const desc = identity.description ? ` — ${identity.description}` : '';
        const place = comps.place || {};
        const at = place.locationId ? ` (at ${place.locationId})` : '';
        items.push(`- **${name}** (${id})${at}${desc}`);
        break;
      }
      case 'pc': {
        const name = identity.name || id;
        const stats = comps.stats || {};
        const hpStr = stats.hp !== undefined ? ` HP:${stats.hp}/${stats.maxHp}` : '';
        const place = comps.place || {};
        const at = place.locationId ? ` (at ${place.locationId})` : '';
        const status = comps.status || {};
        const conds = status.conditions && status.conditions.length > 0
          ? ` Conditions: ${status.conditions.join(', ')}` : '';
        pcs.push(`- **${name}** (${id})${at}${hpStr}${conds}`);
        break;
      }
      case 'world-state': {
        const flags = comps.flags || {};
        for (const [k, v] of Object.entries(flags)) {
          worldFlags.push(`- ${k}: ${JSON.stringify(v)}`);
        }
        break;
      }
      // presence, faction, quest — skip for P1 (no actionable context)
    }
  }

  const parts = ['Current scene frame:'];

  if (locations.length > 0) {
    parts.push('\nLocation:');
    parts.push(...locations);
  }

  if (npcs.length > 0) {
    parts.push('\nNPCs present:');
    parts.push(...npcs);
  }

  if (items.length > 0) {
    parts.push('\nItems:');
    parts.push(...items);
  }

  if (pcs.length > 0) {
    parts.push('\nParty:');
    parts.push(...pcs);
  }

  if (worldFlags.length > 0) {
    parts.push('\nWorld flags:');
    parts.push(...worldFlags);
  }

  if (parts.length === 1) {
    parts.push('\n(No entities of interest in the current scene.)');
  }

  return parts.join('\n');
}

/**
 * Extract the last n journal entries relevant for LLM context.
 * Maps action→user, narration/dialogue(done)→assistant.
 * Dialogue entries are prefixed with the speaker name.
 *
 * @param {Array<{op:string,name?:string,text?:string,data?:object}>} journalEntries
 * @param {number} [n=12] — max entries to return
 * @returns {Array<{role:string, content:string}>}
 */
export function recentHistory(journalEntries, n = 12) {
  if (!Array.isArray(journalEntries)) return [];

  const relevant = [];
  // Walk from end, collect action + done-narration + done-dialogue entries
  for (let i = journalEntries.length - 1; i >= 0 && relevant.length < n; i--) {
    const entry = journalEntries[i];

    if (entry.op === 'action' && entry.text) {
      relevant.unshift({ role: 'user', content: entry.text });
    } else if (entry.op === 'event' && entry.name === 'narration') {
      const data = entry.data || {};
      if (data.done && data.text) {
        relevant.unshift({ role: 'assistant', content: data.text });
      }
    } else if (entry.op === 'event' && entry.name === 'dialogue') {
      const data = entry.data || {};
      if (data.done && data.text) {
        const speakerName = data.name || data.speaker || 'NPC';
        relevant.unshift({ role: 'assistant', content: `${speakerName}: ${data.text}` });
      }
    }
  }

  return relevant;
}

/**
 * Extract the last n beats that a specific NPC witnessed.
 * For P2: all narration/dialogue/action in the current scene.
 * Returns chat-message array for the NPC's context.
 *
 * @param {Array<{op:string,name?:string,text?:string,data?:object}>} journalEntries
 * @param {string} npcId
 * @param {number} [n=12]
 * @returns {Array<{role:string, content:string}>}
 */
export function npcMemoryFor(journalEntries, npcId, n = 12) {
  if (!Array.isArray(journalEntries)) return [];

  // For P2: return all recent beats (the NPC is present and witnesses everything)
  // Future: filter by location/scene scope
  return recentHistory(journalEntries, n);
}

/**
 * Build context messages for an NPC agent's response.
 * Cache-ordered: stable prefix first, dynamic scene+input last.
 *
 * @param {object} params
 * @param {object} params.npc            — {id, name, personality, backstory, voice, knowledge, systemPrompt?}
 * @param {string} params.look           — the scene frame text (from sense.look)
 * @param {string} params.playerText     — what the player said
 * @param {Array}  params.npcMemory      — NPC's recent witnessed beats [{role,content}]
 * @param {string} [params.directorNote] — optional DM stage direction
 * @returns {Array<{role:string, content:string}>}
 */
export function buildNpcContext({ npc, look, playerText, npcMemory, directorNote }) {
  const messages = [];

  // 1. SYSTEM: stable prefix — NPC identity + private knowledge (byte-stable → cache hit)
  const derivedPrompt = npc.systemPrompt || deriveNpcSystemPrompt(npc);
  const knowledgeBlock = formatKnowledge(npc.knowledge);
  messages.push({
    role: 'system',
    content: derivedPrompt + (knowledgeBlock ? '\n\n' + knowledgeBlock : ''),
  });

  // 2. NPC memory — recent witnessed beats as history
  messages.push(...(npcMemory || []));

  // 3. SYSTEM: the shared look frame (current scene — changes but placed late)
  messages.push({ role: 'system', content: look || 'Current scene: (none).' });

  // 4. (optional) SYSTEM: director-note — clearly marked OOC stage direction
  if (directorNote && directorNote.trim()) {
    messages.push({
      role: 'system',
      content: `[STAGE DIRECTION from the DM — use this to guide your response, but do NOT quote it directly]\n${directorNote.trim()}`,
    });
  }

  // 5. USER: the player's words addressed to the NPC
  messages.push({ role: 'user', content: playerText || '' });

  return messages;
}

/**
 * Derive system prompt for an NPC from its persona.
 *
 * @param {object} npc — {name, personality, backstory, voice}
 * @returns {string}
 */
function deriveNpcSystemPrompt(npc) {
  const name = npc.name || 'the character';
  const personality = npc.personality || '';
  const backstory = npc.backstory || '';
  const voice = npc.voice || '';

  let prompt = `You are ${name}. Speak ONLY as yourself, in first-person, in-character.\n`;
  prompt += `You know ONLY what follows; never invent or reveal knowledge you don't have.\n`;
  prompt += `Keep responses short — 1 to 3 sentences, like natural dialogue.\n`;

  if (personality) prompt += `\nPersonality: ${personality}`;
  if (backstory) prompt += `\nBackstory: ${backstory}`;
  if (voice) prompt += `\nVoice: ${voice}`;

  return prompt;
}

/**
 * Format knowledge component for inclusion in NPC system prompt.
 *
 * @param {{facts:string[], secrets:string[]}} knowledge
 * @returns {string}
 */
function formatKnowledge(knowledge) {
  if (!knowledge) return '';
  const parts = [];

  if (knowledge.facts && knowledge.facts.length > 0) {
    parts.push('## Things you know (public):');
    for (const f of knowledge.facts) {
      parts.push(`- ${f}`);
    }
  }

  if (knowledge.secrets && knowledge.secrets.length > 0) {
    parts.push('\n## Things you know but guard (secrets):');
    for (const s of knowledge.secrets) {
      parts.push(`- ${s}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build context messages for the DM's world-voice narration.
 * Reuses the existing buildContext ordering: stable prefix + look + history + action.
 *
 * @param {object} params
 * @param {string} params.systemPrompt   — DM system prompt
 * @param {object} params.session        — Session instance
 * @param {string} params.action         — player action text
 * @returns {Array<{role:string, content:string}>}
 */
export function buildDmNarrationContext({ systemPrompt, session, action }) {
  return buildContext({
    systemPrompt,
    look: buildLookFrame(session.entities),
    history: recentHistory(session.journal, 12),
    action,
  });
}

/**
 * Build context messages for the DM routing call (which NPC to address).
 * Lists present NPCs and asks for JSON {targets, note?}.
 *
 * @param {object} params
 * @param {Array} params.presentNpcs     — from sense.presentAgents()
 * @param {object} params.session        — Session instance
 * @param {string} params.action         — player action text
 * @returns {Array<{role:string, content:string}>}
 */
export function buildDmRoutingContext({ presentNpcs, session, action }) {
  const npcList = presentNpcs.map(n => {
    const pers = n.persona ? ` — ${n.persona}` : '';
    return `- ${n.name} (id: "${n.npcId}")${pers}`;
  }).join('\n');

  const systemPrompt =
    `You are the DM director. Your job is to route player input to the correct NPC.\n` +
    `Do NOT narrate or speak. Output ONLY a JSON object.\n\n` +
    `NPCs present in the scene:\n${npcList || '(none)'}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Player action: "${action}"\n\nWhich NPC(s) should respond? Output: {"targets":["<npcId>"], "note":"<optional director note for the NPC>"}\n\nIf the player is addressing no specific NPC (ambient observation / world action), return {"targets":[], "note":""}.` },
  ];

  return messages;
}


