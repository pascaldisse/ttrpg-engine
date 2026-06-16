/**
 * server/sense.js — the sense API.
 * Text senses over the canonical entity store. PURE-ish: reads session.entities.
 *
 * Based on GAIA's sense.js text-sense pattern.
 */

/**
 * Build a compact text scene frame — the "living summary".
 * Current location, present NPCs (+one-line persona), party/pc stats, active quest, flags.
 * High-salience, generated fresh from state each call.
 *
 * @param {import('./session.js').Session} session
 * @returns {string}
 */
export function look(session) {
  const { entities } = session;
  if (!entities || entities.size === 0) {
    return 'Current scene: (empty — no entities loaded).';
  }

  const locations = [];
  const npcs = [];
  const items = [];
  const pcs = [];
  const quests = [];
  const flags = [];

  for (const [id, comps] of entities) {
    const identity = comps.identity || {};
    const kind = identity.kind || '?';
    const name = identity.name || id;

    switch (kind) {
      case 'location': {
        const desc = identity.description || '';
        const connections = (comps.place && comps.place.connections) || [];
        const exits = connections.map(c => `${c.label || c.targetId || '?'}`).join(', ');
        let line = `- **${name}** (${id}): ${desc}`;
        if (exits) line += ` Exits: ${exits}.`;
        locations.push(line);
        break;
      }
      case 'npc': {
        const status = comps.status || {};
        if (status.alive === false) continue; // skip dead NPCs in look
        const desc = identity.description ? ` — ${identity.description}` : '';
        const place = comps.place || {};
        const at = place.locationId ? ` (at ${place.locationId})` : '';
        const persona = comps.persona || {};
        const pers = persona.personality ? ` Personality: ${persona.personality}.` : '';
        const agent = comps.agent || {};
        const agentTag = agent.enabled ? ' [AGENT]' : '';
        npcs.push(`- **${name}** (${id})${agentTag}${at}${desc}${pers}`);
        break;
      }
      case 'item': {
        const desc = identity.description ? ` — ${identity.description}` : '';
        const place = comps.place || {};
        const at = place.locationId ? ` (at ${place.locationId})` : '';
        items.push(`- **${name}** (${id})${at}${desc}`);
        break;
      }
      case 'pc': {
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
      case 'quest': {
        const phase = (comps.quest && comps.quest.phase) || '?';
        const steps = (comps.quest && comps.quest.steps) || [];
        const currentStep = (comps.quest && comps.quest.currentStep) || 0;
        const current = steps[currentStep] || '';
        quests.push(`- **${name}** (${id}) phase:${phase} step:${currentStep + 1}/${steps.length} "${current}"`);
        break;
      }
      case 'world-state': {
        const fs = comps.flags || {};
        for (const [k, v] of Object.entries(fs)) {
          flags.push(`- ${k}: ${JSON.stringify(v)}`);
        }
        break;
      }
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

  if (quests.length > 0) {
    parts.push('\nActive quests:');
    parts.push(...quests);
  }

  if (flags.length > 0) {
    parts.push('\nWorld flags:');
    parts.push(...flags);
  }

  if (parts.length === 1) {
    parts.push('\n(No entities of interest in the current scene.)');
  }

  return parts.join('\n');
}

/**
 * One-line entity summary.
 * @param {import('./session.js').Session} session
 * @param {string} id
 * @returns {string}
 */
export function describe(session, id) {
  const comps = session.entities.get(id);
  if (!comps) return `Entity "${id}" not found.`;

  const identity = comps.identity || {};
  const name = identity.name || id;
  const kind = identity.kind || '?';
  const desc = identity.description || '';
  const status = comps.status || {};
  const alive = status.alive !== false ? '' : ' [DEAD]';
  const place = comps.place || {};
  const at = place.locationId ? ` at ${place.locationId}` : '';

  return `${name} (${id}) — ${kind}${alive}${at}${desc ? ': ' + desc : ''}`;
}

/**
 * Query entities by component and/or kind.
 * @param {import('./session.js').Session} session
 * @param {{has?:string, kind?:string, at?:string}} params
 * @returns {Array<{id:string, components:object}>}
 */
export function query(session, { has, kind, at } = {}) {
  const results = [];
  for (const [id, comps] of session.entities) {
    const identity = comps.identity || {};

    // Filter by kind
    if (kind && identity.kind !== kind) continue;

    // Filter by component presence
    if (has && !comps[has]) continue;

    // Filter by location
    if (at) {
      const place = comps.place || {};
      if (place.locationId !== at && id !== at) continue;
    }

    results.push({ id, components: JSON.parse(JSON.stringify(comps)) });
  }
  return results;
}

/**
 * Consistency lint — basic checks.
 * Returns a list of finding strings.
 *
 * @param {import('./session.js').Session} session
 * @returns {string[]}
 */
export function check(session) {
  const { entities } = session;
  const findings = [];
  const ids = new Set(entities.keys());

  // Detect duplicate ids (already impossible with Map, but check just in case — checking
  // against journal might reveal them; skip for P2)

  for (const [id, comps] of entities) {
    const identity = comps.identity || {};
    const kind = identity.kind || '?';
    const place = comps.place || {};

    // Check place.locationId references
    if (place.locationId && !ids.has(place.locationId)) {
      findings.push(`${id} (${identity.name || '?'}) references missing location "${place.locationId}"`);
    }

    // Check NPC marked dead still present (false positive if corpse — warn)
    const status = comps.status || {};
    if (kind === 'npc' && status.alive === false) {
      findings.push(`${id} (${identity.name || '?'}) is an NPC marked dead but still present in entities`);
    }

    // Check connections
    if (comps.place && comps.place.connections) {
      for (const conn of comps.place.connections) {
        if (conn.targetId && !ids.has(conn.targetId)) {
          findings.push(`${id} connection "${conn.label || conn.targetId}" references missing target "${conn.targetId}"`);
        }
      }
    }
  }

  return findings;
}

/**
 * Return the agent-NPCs in the current scene (identity.kind==='npc' && agent.enabled).
 * Used by the routing engine.
 *
 * @param {import('./session.js').Session} session
 * @returns {Array<{npcId:string, name:string, persona:string, accent:string|null}>}
 */
export function presentAgents(session) {
  const agents = [];
  for (const [id, comps] of session.entities) {
    const identity = comps.identity || {};
    if (identity.kind !== 'npc') continue;

    const agent = comps.agent || {};
    if (!agent.enabled) continue;

    const status = comps.status || {};
    if (status.alive === false) continue;

    const persona = comps.persona || {};
    const place = comps.place || {};

    // Include: any NPC with agent.enabled in the current scene.
    // For P2, "in current scene" = they have a place.locationId pointing to a location.
    // If no location filter available, include all agent-NPCs.
    agents.push({
      npcId: id,
      name: identity.name || id,
      persona: persona.personality || '',
      accent: agent.accent || null,
      locationId: place.locationId || null,
    });
  }
  return agents;
}
