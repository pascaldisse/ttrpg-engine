/**
 * shared/combat.js — P5 pure combat engine.
 *
 * PURE — no imports from server/ or client/. Takes plain data + an rng; returns plain data.
 * NEVER mutates inputs. NEVER emits ops — the server layer turns results into ops.
 *
 * EXTENSION SEAM: rulesets can swap damage/initiative rules later.
 *   - `rollInitiative` defaults to d20 + abilityMod(dex)
 *   - `resolveAttack` defaults to d20 attack roll (via resolveCheck) + weapon die damage
 *   - Finesse detection reads `flags.finesse` on the attacker
 *   - Weapon die reads `flags.damage` (e.g. "1d8") or defaults to "1d6"
 *
 * Dependencies: resolveCheck / abilityMod from ./checks.js, makeRng from ./rng.js.
 */

import { resolveCheck, abilityMod } from './checks.js';

// ---- Helpers ----

/**
 * Parse a damage-die string like "1d6", "2d8", "3d4" into { count, sides }.
 * Returns { count: 1, sides: 6 } on unparseable input.
 * @param {string} die
 * @returns {{count:number, sides:number}}
 */
function parseDamageDie(die) {
  const m = /^(\d+)d(\d+)$/.exec(die);
  if (m) return { count: Number(m[1]), sides: Number(m[2]) };
  return { count: 1, sides: 6 };
}

/**
 * Read the attacker's weapon damage die string.
 * Checks flags.damage first, then looks for a weapon item, defaults to "1d6".
 * @param {object} attacker - entity components Map entry for attacker
 * @param {Map<string,object>} entities - full entity store (for weapon lookup)
 * @returns {string}
 */
function readDamageDie(attacker, entities) {
  // flags.damage takes priority
  if (attacker?.flags?.damage) return attacker.flags.damage;
  // Try weapon in inventory (simple: first weapon item with damage field)
  if (attacker?.inventory?.items) {
    for (const itemRef of attacker.inventory.items) {
      const itemId = typeof itemRef === 'string' ? itemRef : itemRef.id;
      const item = entities?.get(itemId);
      if (item?.flags?.damage) return item.flags.damage;
      if (item?.identity?.kind === 'item' && item?.flags?.weapon && item?.flags?.damage) {
        return item.flags.damage;
      }
    }
  }
  return '1d6';
}

/**
 * Determine which ability score to use for an attack.
 * Finesse weapons use dex; otherwise str.
 * @param {object} attacker - attacker entity components
 * @returns {'str'|'dex'}
 */
function attackAbility(attacker) {
  if (attacker?.flags?.finesse === true) return 'dex';
  return 'str';
}

// ---- Public API ----

/**
 * Roll initiative for a list of combatant ids.
 * `init = d20 + abilityMod(dex)`. Sorted by init DESC.
 * Tie-break: higher dex score, then entity id (localeCompare).
 *
 * @param {string[]} ids - combatant entity ids
 * @param {Map<string,object>} entities - entity store (read-only)
 * @param {{d:(s:number)=>number}} rng
 * @returns {{id:string, init:number}[]} sorted by initiative DESC
 */
export function rollInitiative(ids, entities, rng) {
  const results = ids.map(id => {
    const comps = entities.get(id);
    const stats = comps?.stats || {};
    const dex = stats.dex ?? 10;
    const roll = rng.d(20);
    const init = roll + abilityMod(dex);
    return { id, init, dex };
  });

  results.sort((a, b) => {
    if (b.init !== a.init) return b.init - a.init;       // DESC by init
    if (b.dex !== a.dex) return b.dex - a.dex;            // higher dex first
    return a.id.localeCompare(b.id);                       // alphabetical id
  });

  return results.map(({ id, init }) => ({ id, init }));
}

/**
 * Build an encounter component object from allies+enemies lists.
 * Rolls initiative for all combatants and assembles the turn order.
 *
 * @param {{allies:string[], enemies:string[]}} params
 * @param {Map<string,object>} entities
 * @param {{d:(s:number)=>number}} rng
 * @returns {object} encounter component value (active, round, order, turnIndex, mode, enemies, allies)
 */
export function buildEncounter({ allies, enemies }, entities, rng) {
  const allIds = [...allies, ...enemies];
  const initiative = rollInitiative(allIds, entities, rng);
  return {
    active: true,
    round: 1,
    order: initiative.map(r => r.id),
    turnIndex: 0,
    mode: 'initiative',
    enemies: [...enemies],
    allies: [...allies],
  };
}

/**
 * Return the entity id whose turn it currently is.
 * @param {object} encounter - encounter component value
 * @returns {string|null} current combatant id, or null if order is empty
 */
export function currentCombatant(encounter) {
  if (!encounter?.order?.length) return null;
  return encounter.order[encounter.turnIndex] ?? null;
}

/**
 * Resolve a single attack: attacker vs target.
 *
 * Steps:
 * 1. Determine attack ability (str unless attacker has finesse → dex).
 * 2. Parse damage die from flags.damage or weapon item (default 1d6).
 * 3. Call resolveCheck('attack') against target.stats.ac.
 * 4. On hit: roll weapon die + ability mod (min 1). Crit doubles the dice.
 * 5. Return structured result with summary string.
 *
 * @param {{attackerId:string, targetId:string}} params
 * @param {Map<string,object>} entities
 * @param {{d:(s:number)=>number}} rng
 * @returns {{hit:boolean, crit:boolean, fumble:boolean, attackRoll:number, ac:number, damage:number, summary:string, ability:string, weaponDie:string}}
 */
export function resolveAttack({ attackerId, targetId }, entities, rng) {
  const attacker = entities.get(attackerId);
  const target = entities.get(targetId);

  if (!attacker || !target) {
    return {
      hit: false, crit: false, fumble: false,
      attackRoll: 0, ac: 0, damage: 0,
      summary: 'Invalid attacker or target.',
      ability: 'str', weaponDie: '1d6',
    };
  }

  const ability = attackAbility(attacker);
  const weaponDieStr = readDamageDie(attacker, entities);
  const weaponDie = parseDamageDie(weaponDieStr);
  const targetAc = target?.stats?.ac ?? 10;

  // Resolve the attack check
  const checkResult = resolveCheck(
    { check: 'attack', ability, dc: targetAc },
    { stats: attacker.stats || {}, proficiency: attacker.proficiency ?? attacker.stats?.proficiency ?? 0 },
    rng,
  );

  let damage = 0;
  if (checkResult.success) {
    const abilityScore = (attacker.stats || {})[ability] ?? 10;
    const mod = abilityMod(abilityScore);
    const diceCount = checkResult.crit ? weaponDie.count * 2 : weaponDie.count;
    let diceTotal = 0;
    for (let i = 0; i < diceCount; i++) {
      diceTotal += rng.d(weaponDie.sides);
    }
    damage = Math.max(1, diceTotal + mod);
  }

  const summary = checkResult.crit
    ? `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → CRITICAL HIT (${damage} damage)`
    : checkResult.fumble
      ? `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → CRITICAL MISS`
      : checkResult.success
        ? `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → HIT (${damage} damage)`
        : `d20(${checkResult.rolls[0]}) + ${checkResult.modifier} = ${checkResult.total} vs AC ${targetAc} → MISS`;

  return {
    hit: checkResult.success,
    crit: checkResult.crit,
    fumble: checkResult.fumble,
    attackRoll: checkResult.rolls[0],
    ac: targetAc,
    damage,
    summary,
    ability,
    weaponDie: weaponDieStr,
  };
}

/**
 * Advance the encounter's turn to the next living combatant.
 * Skips combatants where `status.alive === false`.
 * When wrapping past the end of the order, increments `round`.
 * Returns a NEW object — never mutates the input.
 *
 * @param {object} encounter - current encounter component value
 * @param {Map<string,object>} entities
 * @returns {object} new encounter value advanced to the next living combatant
 */
export function advanceTurn(encounter, entities) {
  const order = encounter.order || [];
  if (!order.length) return { ...encounter };

  let nextIndex = encounter.turnIndex;
  let round = encounter.round;
  let wrapped = false;
  let checked = 0;

  do {
    nextIndex = (nextIndex + 1) % order.length;
    checked++;

    // Detect wrap: we've gone from end back to start
    if (nextIndex === 0 && !wrapped) {
      wrapped = true;
      round++;
    }

    const entity = entities.get(order[nextIndex]);
    const alive = entity?.status?.alive !== false;
    if (alive) break;

    // Safety: all combatants dead — stop and return what we have
    if (checked >= order.length) break;
  } while (true);

  return {
    active: encounter.active,
    round,
    order: [...order],
    turnIndex: nextIndex,
    mode: encounter.mode,
    enemies: [...(encounter.enemies || [])],
    allies: [...(encounter.allies || [])],
  };
}

/**
 * Determine the outcome of the encounter.
 *
 * @param {object} encounter - encounter component value
 * @param {Map<string,object>} entities
 * @returns {'ongoing'|'victory'|'defeat'}
 */
export function outcome(encounter, entities) {
  const enemies = encounter.enemies || [];
  const allies = encounter.allies || [];

  const allEnemiesDead = enemies.every(id => {
    const ent = entities.get(id);
    return ent?.status?.alive === false;
  });

  const allAlliesDead = allies.every(id => {
    const ent = entities.get(id);
    return ent?.status?.alive === false;
  });

  if (allEnemiesDead) return 'victory';
  if (allAlliesDead) return 'defeat';
  return 'ongoing';
}
