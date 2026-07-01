/**
 * shared/worldgen-skeleton.js — PURE deterministic world skeleton generator (Module A).
 *
 * Generates a connected, bidirectional location graph populated with a PC,
 * friendly NPCs, hostile enemies, items, and one quest wired to real ids.
 * Identity names and descriptions are PLACEHOLDERS — the LLM charge pass
 * fills them. Every structural component is fully and validly populated.
 *
 * PURE: no server/client imports, no fs, no Date, no Math.random.
 * Deterministic: same config + same-seeded rng ⇒ JSON.stringify-identical.
 *
 * @module shared/worldgen
 */

// ---- internal helpers ----------------------------------------------------

/** Accent palette for NPC agent chips — deterministic by index. */
const ACCENT_PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
  '#9A6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1',
  '#000075', '#a9a9a9',
];

/** Damage dice options for enemies. */
const DAMAGE_DICE = ['1d4', '1d6', '1d8'];

/**
 * Check whether a location entity already has a connection to targetId.
 * @param {object} locEntity
 * @param {string} targetId
 * @returns {boolean}
 */
function hasConnection(locEntity, targetId) {
  return locEntity.place.connections.some(c => c.targetId === targetId);
}

/**
 * Add a bidirectional edge between two location entities.
 * @param {Record<string, object>} entities
 * @param {string} idA
 * @param {string} idB
 */
function addBidirectionalEdge(entities, idA, idB) {
  if (!hasConnection(entities[idA], idB)) {
    entities[idA].place.connections.push({ targetId: idB, label: `To ${idB}` });
  }
  if (!hasConnection(entities[idB], idA)) {
    entities[idB].place.connections.push({ targetId: idA, label: `To ${idA}` });
  }
}

/**
 * Resolve generation counts from config + size preset.
 * @param {object} config
 * @returns {{size:string, locCount:number, npcCount:number, enemyCount:number, itemCount:number}}
 */
function resolveCounts(config) {
  let size = config.size;
  if (!['small', 'medium', 'large'].includes(size)) size = 'small';

  const presets = {
    small:  { locations: 3, npcs: 2, enemies: 2, items: 3 },
    medium: { locations: 5, npcs: 4, enemies: 3, items: 5 },
    large:  { locations: 8, npcs: 6, enemies: 5, items: 8 },
  };

  const preset = presets[size];
  const locCount =
    typeof config.locations === 'number' &&
    config.locations > 0 &&
    Number.isInteger(config.locations)
      ? config.locations
      : preset.locations;

  return {
    size,
    locCount,
    npcCount: preset.npcs,
    enemyCount: preset.enemies,
    itemCount: preset.items,
  };
}

// ---- exported generator --------------------------------------------------

/**
 * Generate the structural skeleton of a world.
 *
 * @param {object} config
 *   @param {'small'|'medium'|'large'} [config.size='small']
 *   @param {number} [config.locations]   explicit location count (overrides size preset)
 * @param {{next:()=>number,int:(a,b)=>number,d:(s)=>number}} rng  — from makeRng(seed)
 * @returns {{ entities: Record<string, object>, meta: object }}
 */
export function generateSkeleton(config = {}, rng) {
  const { size, locCount, npcCount, enemyCount, itemCount } = resolveCounts(config);

  const entities = {};
  const meta = {
    size,
    pcId: 'pc-hero',
    questId: 'quest-1',
    lairId: null,
    locationIds: [],
    hints: {},
  };

  // ---- 1. Create locations ------------------------------------------------

  for (let i = 1; i <= locCount; i++) {
    const id = `loc-${i}`;
    meta.locationIds.push(id);
    entities[id] = {
      identity: { name: `Location ${i}`, kind: 'location', description: '' },
      place: { connections: [] },
      status: { alive: true, conditions: [] },
      art: { prompt: '', image: null },
    };
    meta.hints[id] = { kind: 'location', role: i === 1 ? 'entrance' : 'location' };
  }

  // Lair: any location except the entrance
  let lairId;
  if (locCount < 2) {
    lairId = meta.locationIds[0];
  } else {
    const lairIdx = rng.int(1, locCount - 1);
    lairId = meta.locationIds[lairIdx];
  }
  meta.lairId = lairId;
  meta.hints[lairId].role = 'lair';

  // Non-lair locations (for NPC placement)
  const nonLairLocs = meta.locationIds.filter(id => id !== lairId);
  if (nonLairLocs.length === 0) nonLairLocs.push(meta.locationIds[0]);

  // ---- 2. Build location graph --------------------------------------------

  // Spanning path (guarantees connectivity)
  for (let i = 0; i < locCount - 1; i++) {
    addBidirectionalEdge(entities, meta.locationIds[i], meta.locationIds[i + 1]);
  }

  // Extra chords (~floor(N/3)) for non-linearity
  const extraEdges = Math.floor(locCount / 3);

  // Collect non-self-loop, non-duplicate candidate pairs
  const candidates = [];
  for (let i = 0; i < locCount; i++) {
    for (let j = i + 1; j < locCount; j++) {
      if (!hasConnection(entities[meta.locationIds[i]], meta.locationIds[j])) {
        candidates.push([i, j]);
      }
    }
  }

  // Fisher-Yates shuffle using the rng for deterministic candidate ordering
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  // Add the first extraEdges valid candidates
  for (let e = 0; e < Math.min(extraEdges, candidates.length); e++) {
    const [a, b] = candidates[e];
    addBidirectionalEdge(entities, meta.locationIds[a], meta.locationIds[b]);
  }

  // ---- 3. Create PC -------------------------------------------------------

  const pcHp = rng.int(18, 22);
  entities['pc-hero'] = {
    identity: { name: 'Hero', kind: 'pc', description: '' },
    stats: {
      str: rng.int(12, 16),
      dex: rng.int(12, 16),
      con: rng.int(10, 14),
      int: rng.int(8, 14),
      wis: rng.int(8, 14),
      cha: rng.int(8, 14),
      hp: pcHp,
      maxHp: pcHp,
      ac: rng.int(12, 14),
      proficiency: 2,
      level: 1,
      xp: 0,
    },
    status: { alive: true, conditions: [] },
    place: { locationId: 'loc-1', connections: [] },
    inventory: { items: [{ id: 'item-startgear', name: "Traveler's Pack", qty: 1 }] },
    flags: {},
  };
  meta.hints['pc-hero'] = { kind: 'pc', role: 'pc' };

  // ---- 4. Create friendly NPCs --------------------------------------------

  for (let i = 1; i <= npcCount; i++) {
    const id = `npc-${i}`;
    const npcLoc = nonLairLocs[rng.int(0, nonLairLocs.length - 1)];

    entities[id] = {
      identity: { name: `Townsperson ${i}`, kind: 'npc', description: '' },
      persona: { personality: '', backstory: '', voice: '' },
      knowledge: { facts: [], secrets: [] },
      agent: { enabled: true, accent: ACCENT_PALETTE[(i - 1) % ACCENT_PALETTE.length] },
      status: { alive: true, conditions: [] },
      place: { locationId: npcLoc, connections: [] },
      inventory: { items: [] },
      flags: { trust_player: 0 },
    };
    meta.hints[id] = { kind: 'npc', role: 'local' };
  }

  // ---- 5. Create enemies (all at the lair) --------------------------------

  const enemyIds = [];
  for (let i = 1; i <= enemyCount; i++) {
    const id = `enemy-${i}`;
    enemyIds.push(id);

    const eHp = rng.int(7, 13);
    entities[id] = {
      identity: { name: `Foe ${i}`, kind: 'npc', description: '' },
      persona: { personality: '' },
      stats: {
        str: rng.int(8, 14),
        dex: rng.int(8, 14),
        con: rng.int(8, 14),
        int: rng.int(8, 12),
        wis: rng.int(8, 12),
        cha: rng.int(8, 12),
        hp: eHp,
        maxHp: eHp,
        ac: rng.int(11, 13),
        xp: rng.int(25, 50),
      },
      status: { alive: true, conditions: [] },
      place: { locationId: lairId, connections: [] },
      flags: { hostile: true, damage: DAMAGE_DICE[rng.int(0, 2)] },
    };
    meta.hints[id] = { kind: 'npc', role: 'enemy' };
  }

  // ---- 6. Create items (one prize at the lair) ----------------------------

  const prizeItemIdx = rng.int(1, itemCount); // 1-based index
  const prizeItemId = `item-${prizeItemIdx}`;

  for (let i = 1; i <= itemCount; i++) {
    const id = `item-${i}`;
    let itemLoc;

    if (i === prizeItemIdx) {
      itemLoc = lairId;
      meta.hints[id] = { kind: 'item', role: 'prize' };
    } else {
      itemLoc = meta.locationIds[rng.int(0, locCount - 1)];
      meta.hints[id] = { kind: 'item', role: 'item' };
    }

    entities[id] = {
      identity: { name: `Object ${i}`, kind: 'item', description: '' },
      status: { alive: true, conditions: [] },
      place: { locationId: itemLoc, connections: [] },
    };
  }

  // ---- 7. Create quest ----------------------------------------------------

  entities['quest-1'] = {
    identity: { name: 'The Main Quest', kind: 'quest', description: '' },
    quest: {
      phase: 'active',
      currentStep: 0,
      steps: ['Step one description', 'Step two description', 'Step three description'],
      triggers: [
        { type: 'atLocation', id: lairId },
        { type: 'allDead', ids: [...enemyIds] },
        { type: 'hasItem', id: prizeItemId },
      ],
      rewards: { xp: 250, items: [{ id: 'item-reward', name: 'Reward' }] },
    },
  };
  meta.hints['quest-1'] = { kind: 'quest', role: 'quest' };

  // ---- 8. world-state singleton -------------------------------------------

  entities['world-state'] = { flags: {} };

  return { entities, meta };
}
