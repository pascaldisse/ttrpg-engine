/**
 * shared/effects.js — semantic ops → canonical ops expander.
 *
 * PURE — no imports from server/ or client/.
 *
 * LLMs are bad at absolute arithmetic (e.g. "new hp = 23−5"). So the DM emits
 * SEMANTIC ops and the engine expands them into canonical component ops
 * (set/merge) relative to the current entity state.
 *
 * EXTENSION SEAM: rulesets may add new semantic ops later (e.g. DSA-specific
 * conditions). Add entries to SEMANTIC_HANDLERS below.
 *
 * Canonical ops pass through unchanged.
 */

import { upsertStatus } from './statuses.js';

/**
 * Expand ONE semantic op into an array of canonical ops (spawn/set/merge/despawn).
 * Canonical ops pass through as-is (wrapped in array).
 *
 * @param {Map<string,object>} entities — current entity store (read-only)
 * @param {object} op — a semantic or canonical op
 * @returns {object[]} — array of canonical ops
 */
export function expandOp(entities, op) {
  const kind = op.op;

  if (kind in SEMANTIC_HANDLERS) {
    return SEMANTIC_HANDLERS[kind](entities, op);
  }

  // Canonical ops pass through unchanged
  if (['spawn', 'set', 'merge', 'despawn', 'event', 'action', 'roll', 'reset'].includes(kind)) {
    return [op];
  }

  // Unknown — pass through (server will reject or ignore)
  return [op];
}

/**
 * Expand a batch of ops.
 * @param {Map<string,object>} entities
 * @param {object[]} ops
 * @returns {object[]}
 */
export function expandOps(entities, ops) {
  const result = [];
  for (const op of ops) {
    result.push(...expandOp(entities, op));
  }
  return result;
}

// ---- Semantic handlers ----

const SEMANTIC_HANDLERS = {
  /** {op:'damage', id, amount} → merge stats {hp: max(0, cur.hp - amount)} */
  damage(entities, op) {
    const comps = entities.get(op.id);
    if (!comps) return [];
    const stats = comps.stats || {};
    const curHp = stats.hp ?? 0;
    const newHp = Math.max(0, curHp - (op.amount || 0));
    const ops = [
      { op: 'merge', id: op.id, component: 'stats', value: { hp: newHp } },
    ];
    // If hp drops to 0, mark dead
    if (newHp <= 0) {
      ops.push({ op: 'merge', id: op.id, component: 'status', value: { alive: false } });
    }
    return ops;
  },

  /** {op:'heal', id, amount} → merge stats {hp: min(maxHp, cur.hp + amount)} */
  heal(entities, op) {
    const comps = entities.get(op.id);
    if (!comps) return [];
    const stats = comps.stats || {};
    const curHp = stats.hp ?? 0;
    const maxHp = stats.maxHp ?? curHp;
    const newHp = Math.min(maxHp, curHp + (op.amount || 0));
    return [
      { op: 'merge', id: op.id, component: 'stats', value: { hp: newHp } },
    ];
  },

  /** {op:'giveItem', id, item:{id,name,qty?}} → set inventory {items: [...cur, newItem]} */
  giveItem(entities, op) {
    const comps = entities.get(op.id);
    if (!comps) return [];
    const inv = comps.inventory || {};
    const curItems = Array.isArray(inv.items) ? [...inv.items] : [];
    // Don't duplicate if item with same id already present
    const itemId = (op.item && op.item.id) || (typeof op.item === 'string' ? op.item : null);
    if (itemId && curItems.some(i => (typeof i === 'string' ? i : i.id) === itemId)) {
      return [];
    }
    curItems.push(op.item);
    return [
      { op: 'set', id: op.id, component: 'inventory', value: { items: curItems } },
    ];
  },

  /** {op:'takeItem', id, item:{id}} → set inventory {items: cur minus that item} */
  takeItem(entities, op) {
    const comps = entities.get(op.id);
    if (!comps) return [];
    const inv = comps.inventory || {};
    const items = (inv.items || []).filter(
      i => (typeof i === 'string' ? i : i.id) !== (op.item && (op.item.id || op.item))
    );
    return [
      { op: 'set', id: op.id, component: 'inventory', value: { items } },
    ];
  },

  /** {op:'move', id, to} → merge place {locationId: to} (preserves connections) */
  move(entities, op) {
    return [
      { op: 'merge', id: op.id, component: 'place', value: { locationId: op.to } },
    ];
  },

  /**
   * {op:'take', id:<holderId>, item:{id, name?, qty?}} — pick a world object up.
   * Adds it to the holder's inventory AND relocates the world item entity to be
   * CARRIED (place.locationId = holderId), so it leaves the ground and stops
   * showing in the location's scene frame. Name is derived from the world entity
   * if the caller didn't supply one.
   */
  take(entities, op) {
    const holderId = op.id;
    const itemRef = op.item || {};
    const itemId = itemRef.id || (typeof op.item === 'string' ? op.item : null);
    if (!itemId) return [];

    const ops = [];
    const holder = entities.get(holderId);
    if (holder) {
      const inv = holder.inventory || {};
      const curItems = Array.isArray(inv.items) ? [...inv.items] : [];
      const already = curItems.some(i => (typeof i === 'string' ? i : i.id) === itemId);
      if (!already) {
        const worldItem = entities.get(itemId);
        const name = itemRef.name || (worldItem && (worldItem.identity || {}).name) || itemId;
        curItems.push({ id: itemId, name, qty: itemRef.qty || 1 });
        ops.push({ op: 'set', id: holderId, component: 'inventory', value: { items: curItems } });
      }
    }
    // Relocate the world item entity off the ground (only if it exists as an entity).
    if (entities.has(itemId)) {
      ops.push({ op: 'merge', id: itemId, component: 'place', value: { locationId: holderId } });
    }
    return ops;
  },

  /**
   * {op:'drop', id:<holderId>, item:{id}, to?:<locationId>} — inverse of take.
   * Removes the item from the holder's inventory and places the world item entity
   * back on the ground at `to` (defaults to the holder's current location).
   */
  drop(entities, op) {
    const holderId = op.id;
    const itemId = (op.item && op.item.id) || (typeof op.item === 'string' ? op.item : null);
    if (!itemId) return [];

    const ops = [];
    const holder = entities.get(holderId);
    if (holder) {
      const inv = holder.inventory || {};
      const items = (inv.items || []).filter(i => (typeof i === 'string' ? i : i.id) !== itemId);
      ops.push({ op: 'set', id: holderId, component: 'inventory', value: { items } });
    }
    const dest = op.to || (holder && holder.place && holder.place.locationId) || null;
    if (entities.has(itemId) && dest) {
      ops.push({ op: 'merge', id: itemId, component: 'place', value: { locationId: dest } });
    }
    return ops;
  },

  /**
   * {op:'applyStatus', id, kind, magnitude?, remaining, source?} → merge statuses.list
   * with the status added (same kind+source is refreshed, not stacked). C1 status engine.
   */
  applyStatus(entities, op) {
    const comps = entities.get(op.id);
    const cur = (comps && comps.statuses && Array.isArray(comps.statuses.list)) ? comps.statuses.list : [];
    const list = upsertStatus(cur, { kind: op.kind, magnitude: op.magnitude, remaining: op.remaining, source: op.source });
    return [{ op: 'merge', id: op.id, component: 'statuses', value: { list } }];
  },

  /** {op:'removeStatus', id, kind} → merge statuses.list with all entries of `kind` dropped. */
  removeStatus(entities, op) {
    const comps = entities.get(op.id);
    const cur = (comps && comps.statuses && Array.isArray(comps.statuses.list)) ? comps.statuses.list : [];
    const list = cur.filter(s => s.kind !== op.kind);
    return [{ op: 'merge', id: op.id, component: 'statuses', value: { list } }];
  },

  /**
   * {op:'spawnHazard', zoneId, kind, magnitude?, remaining?} → merge encounter.hazards
   * with a new surface (fire/oil/…) on a zone. C4 improvised surfaces.
   */
  spawnHazard(entities, op) {
    const enc = entities.get('encounter');
    const cur = (enc && enc.encounter && Array.isArray(enc.encounter.hazards)) ? enc.encounter.hazards : [];
    const hazards = [...cur, { zoneId: op.zoneId, kind: op.kind, magnitude: op.magnitude ?? 1, remaining: op.remaining ?? 2 }];
    return [{ op: 'merge', id: 'encounter', component: 'encounter', value: { hazards } }];
  },

  /** {op:'clearHazard', zoneId, kind?} → merge encounter.hazards with matching surfaces removed. */
  clearHazard(entities, op) {
    const enc = entities.get('encounter');
    const cur = (enc && enc.encounter && Array.isArray(enc.encounter.hazards)) ? enc.encounter.hazards : [];
    const hazards = cur.filter(h => !(h.zoneId === op.zoneId && (!op.kind || h.kind === op.kind)));
    return [{ op: 'merge', id: 'encounter', component: 'encounter', value: { hazards } }];
  },

  /** {op:'moveZone', id, zoneId} → merge position {zoneId} (move within combat). C4. */
  moveZone(entities, op) {
    return [{ op: 'merge', id: op.id, component: 'position', value: { zoneId: op.zoneId } }];
  },

  /** {op:'setFlag', key, value, id?} → merge flags on id (default 'world-state') */
  setFlag(entities, op) {
    const targetId = op.id || 'world-state';
    return [
      { op: 'merge', id: targetId, component: 'flags', value: { [op.key]: op.value } },
    ];
  },
};

/**
 * Check if an op is semantic (must be expanded before apply).
 * @param {object} op
 * @returns {boolean}
 */
export function isSemanticOp(op) {
  return op.op in SEMANTIC_HANDLERS;
}

/**
 * Get the set of supported semantic op types (for the LLM prompt).
 * @returns {string[]}
 */
export function semanticOpTypes() {
  return Object.keys(SEMANTIC_HANDLERS);
}
