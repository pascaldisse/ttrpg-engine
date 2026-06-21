/**
 * shared/staging.js — world-first actor spawning (PURE — no server/ imports).
 *
 * The DM "stages" its narration into the world BEFORE describing it: any NPC,
 * creature, or threat the DM is about to mention must first exist as a real
 * entity. This module turns a lightweight spawn intent (an archetype name + a
 * few overrides) into a canonical `spawn` op, drawing the actual stat block from
 * the RULESET's `actorTemplates` data — the engine never invents numbers.
 *
 * NEUTRAL: stat blocks/moves/personae come from `templates` (a ruleset bundle
 * export). A ruleset that ships no `actorTemplates` gives the DM no spawn power
 * (resolveActorSpawn returns null unless the caller supplies explicit stats),
 * so non-Necrotopia rulesets keep their classic behavior. No `if (ruleset===…)`.
 */

/** "Tuxedoed Groomsman" → "tuxedoed-groomsman"; empty → "actor". */
export function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'actor';
}

/**
 * First free `npc-<slug>` id (then `npc-<slug>-2`, `-3`, …) not already in `entities`.
 * @param {string} slug
 * @param {Map<string,object>} entities
 * @returns {string}
 */
export function uniqueActorId(slug, entities) {
  const base = `npc-${slug}`;
  if (!entities.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!entities.has(id)) return id;
  }
}

/** Pull a die string ("1d3") out of an actor's first damage-bearing move, if any. */
function damageOf(template) {
  const list = (template && template.moves && template.moves.list) || [];
  const dmgMove = list.find((m) => m && m.damage);
  return dmgMove ? dmgMove.damage : undefined;
}

/**
 * Resolve a DM spawn intent into a canonical `spawn` op grounded in ruleset data.
 *
 * @param {object} spec — { archetype?, name?, description?, persona?, hostile?, ally?, place, zoneId?, accent? }
 * @param {object|null} templates — ruleset `actorTemplates` map (archetype → template), or null
 * @param {Map<string,object>} entities — current store (for unique-id assignment)
 * @returns {{op:'spawn', id:string, components:object}|null}
 */
export function resolveActorSpawn(spec, templates, entities) {
  spec = spec || {};
  const tmap = templates || {};
  // Choose the named template, else the ruleset's _default, else nothing.
  const template = (spec.archetype && tmap[spec.archetype]) || tmap._default || null;

  // No template AND no explicit stats ⇒ this ruleset grants no spawn power.
  if (!template && !spec.stats) return null;
  const t = template || {};

  const name = spec.name || t.name || (spec.archetype ? titleCase(spec.archetype) : 'Stranger');
  const slug = slugify(spec.name || spec.archetype || name);
  const id = uniqueActorId(slug, entities);

  // Faction: explicit spec flags win, else the template's declared faction.
  const hostile = spec.hostile === true || (spec.hostile == null && t.faction === 'hostile');
  const ally = spec.ally === true || (spec.ally == null && t.faction === 'ally');

  const components = {
    identity: {
      name,
      kind: 'npc',
      description: spec.description || t.description || '',
    },
    stats: clone(spec.stats || t.stats || { hp: 4, maxHp: 4 }),
    status: { alive: true, conditions: [] },
    place: { locationId: spec.place || null, connections: [] },
    moves: clone(t.moves || { list: [] }),
    // Agent seat — controller drives the seat indirection (D5); default AI.
    agent: { enabled: true, controller: spec.controller || 'ai', accent: spec.accent || t.accent || '#a64dff' },
  };

  const persona = spec.persona || t.persona;
  if (persona) components.persona = clone(persona);
  if (spec.zoneId) components.position = { zoneId: spec.zoneId };

  const flags = {};
  if (hostile) {
    flags.hostile = true;
    const dmg = spec.damage || damageOf(t);
    if (dmg) flags.damage = dmg;
  }
  if (ally) flags.ally = true;
  if (Object.keys(flags).length) components.flags = flags;

  return { op: 'spawn', id, components };
}

function titleCase(s) {
  return String(s || '').replace(/(^|[\s-])([a-z])/g, (_, b, c) => b + c.toUpperCase());
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
