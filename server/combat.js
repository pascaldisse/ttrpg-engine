/**
 * server/combat.js — P5 structured combat orchestrator (the encounter handoff).
 *
 * The pure rules live in shared/combat.js. This module wires them into the live
 * session: it starts encounters, drives the floor/turn system (enemy AI turns
 * auto-resolve; the player's turn pauses for input), applies damage as ops, and
 * ends on victory/defeat/flee.
 *
 * DESIGN: combat is "swappable" — structured combat only triggers when the player
 * attacks a HOSTILE entity (flags.hostile === true). Attacking a non-hostile NPC
 * stays on the narrative adjudicate/canonize path (P3). Fully deterministic: no
 * LLM in the combat loop (cheap, reproducible, testable).
 *
 * Turn model: initiative order from shared/combat.buildEncounter. On the player's
 * turn we wait for their action op; between player turns, every living enemy acts.
 */

import {
  buildEncounter, currentCombatant, resolveAttack, advanceTurn, outcome,
} from '../shared/combat.js';
import { expandOp } from '../shared/effects.js';
import { findPc, pcLocationId, entitiesAt } from '../shared/space.js';

const ATTACK_RE = /\b(attack|attacks?|hit|strike|stab|slash|swing|fight|kill|charge|shoot|punch|lunge|cut down|draw (?:my )?(?:sword|blade|steel|weapon))\b/i;
const FLEE_RE = /\b(flee|run away|run|escape|retreat|disengage|get away|leg it|withdraw)\b/i;

const ENCOUNTER_ID = 'encounter';
const MAX_TURN_GUARD = 100; // safety against any pathological loop

export function createCombatEngine({ session, broadcast, applyAndBroadcast, awardXp, rules }) {
  // Rules-as-data combat override (from the loaded ruleset bundle, or null → 5e default).
  const combatRules = rules || {};

  // Neutral flavor lines; a ruleset may override any via `combat.flavor`. The default
  // strings name no setting (the old docks/tavern-specific lines lived here before).
  const FLAVOR = {
    begin: 'Words are done. Weapons come up — the fight is on.',
    victory: 'The last of them drops. Breathing hard, you survey the aftermath as the violence subsides.',
    defeat: 'The world tilts and goes dark. Your strength fails — this is where your story falters.',
    flee: 'You tear yourself from the fight and put distance between you and the enemy, heart hammering.',
    ...(combatRules.flavor || {}),
  };

  // ---- small helpers ----

  const pcId = () => { const pc = findPc(session.entities); return pc ? pc[0] : null; };

  const getEncounter = () => {
    const comps = session.entities.get(ENCOUNTER_ID);
    return (comps && comps.encounter) || null;
  };

  const nameOf = (id) => ((session.entities.get(id) || {}).identity || {}).name || id;
  const isAlive = (id) => ((session.entities.get(id) || {}).status || {}).alive !== false;

  /** Persist the encounter value (spawn the singleton entity first time, set after). */
  function writeEncounter(value) {
    if (session.entities.has(ENCOUNTER_ID)) {
      applyAndBroadcast([{ op: 'set', id: ENCOUNTER_ID, component: 'encounter', value }], 'combat');
    } else {
      applyAndBroadcast([{
        op: 'spawn',
        id: ENCOUNTER_ID,
        components: {
          identity: { name: 'Encounter', kind: 'world-state', description: 'Active combat encounter.' },
          encounter: value,
        },
      }], 'combat');
    }
  }

  function banner(phase, text, extra = {}) {
    applyAndBroadcast([{
      op: 'event', name: 'system',
      data: { kind: 'combat', phase, text, ...extra },
    }], 'combat');
  }

  function attackLine(attackerId, targetId, result) {
    applyAndBroadcast([{
      op: 'event', name: 'system',
      data: {
        kind: 'roll',
        text: `⚔ ${nameOf(attackerId)} → ${nameOf(targetId)}: ${result.summary}`,
        detail: { success: result.hit, crit: result.crit, fumble: result.fumble, total: result.attackRoll, dc: result.ac },
      },
    }], 'combat');
  }

  /** Expand a semantic damage op → canonical ops and apply. */
  function applyDamage(targetId, amount) {
    if (!amount) return;
    const ops = expandOp(session.entities, { op: 'damage', id: targetId, amount });
    if (ops.length) applyAndBroadcast(ops, 'combat');
  }

  /** Resolve one attacker→target attack: broadcast the roll, apply damage, announce a kill. */
  function doAttack(attackerId, targetId) {
    const result = resolveAttack({ attackerId, targetId }, session.entities, session.rng(), combatRules);
    attackLine(attackerId, targetId, result);
    if (result.hit && result.damage > 0) {
      applyDamage(targetId, result.damage);
      if (!isAlive(targetId)) banner('turn', `${nameOf(targetId)} falls!`);
    }
  }

  // ---- target selection ----

  /** Present, living, hostile NPCs at the PC's location. */
  function presentHostiles() {
    const here = pcLocationId(session.entities);
    if (!here) return [];
    return entitiesAt(session.entities, here, { kinds: ['npc'] })
      .filter(([_id, c]) => (c.flags || {}).hostile === true)
      .map(([id]) => id);
  }

  /** Match a named enemy in the text, else the first living enemy. */
  function pickTarget(text, enemyIds) {
    const living = enemyIds.filter(isAlive);
    const lower = (text || '').toLowerCase();
    const named = living.find(id => {
      const n = nameOf(id).toLowerCase();
      return n && lower.includes(n);
    });
    return named || living[0] || null;
  }

  // ---- the floor/turn loop ----

  /**
   * Run AI (enemy) turns starting from the current turn, stopping when it becomes
   * the player's turn or the encounter ends. The PC's turn always pauses for input.
   */
  async function runUntilPlayerTurn() {
    let guard = 0;
    while (guard++ < MAX_TURN_GUARD) {
      const enc = getEncounter();
      if (!enc || !enc.active) return;

      const result = outcome(enc, session.entities);
      if (result !== 'ongoing') { endEncounter(result); return; }

      const cur = currentCombatant(enc);
      if (!cur) return;

      // Player-controlled seat → stop and wait for their action op.
      if (cur === pcId()) return;

      // Enemy seat: attack a living ally (the PC for now) if this enemy is alive.
      if (isAlive(cur)) {
        const target = enc.allies.find(isAlive);
        if (target) doAttack(cur, target);
      }
      // Advance to the next living combatant (skips the dead, bumps the round on wrap).
      writeEncounter(advanceTurn(getEncounter(), session.entities));
    }
  }

  function endEncounter(result) {
    const enc = getEncounter();
    if (enc) writeEncounter({ ...enc, active: false });

    if (result === 'victory') {
      banner('end', 'The fight is over — you stand victorious.', { outcome: 'victory' });
      narrate(FLAVOR.victory);
      // Award kill XP for the defeated enemies (P6 progression).
      if (typeof awardXp === 'function' && enc) {
        let xp = 0;
        for (const id of enc.enemies || []) {
          const e = session.entities.get(id);
          xp += (e && e.stats && e.stats.xp) || 0;
        }
        if (xp > 0) awardXp(xp, 'combat victory');
      }
    } else if (result === 'defeat') {
      banner('end', 'You have fallen.', { outcome: 'defeat' });
      narrate(FLAVOR.defeat);
    } else {
      banner('end', 'You break away from the fight.', { outcome: 'flee' });
      narrate(FLAVOR.flee);
    }
  }

  /** Deterministic DM-voice color line (no LLM) in the narration lane. */
  function narrate(text) {
    applyAndBroadcast([{ op: 'event', name: 'narration', data: { text, done: true, by: 'dm' } }], 'combat');
  }

  // ---- public API (called by the turn engine) ----

  /** Is a structured encounter currently active? */
  function inCombat() {
    const enc = getEncounter();
    return !!(enc && enc.active);
  }

  /**
   * Should this action START a structured encounter?
   * Returns {targetId, enemies, allies} when the player attacks a present hostile, else null.
   */
  function detectInitiation(actionText) {
    if (!ATTACK_RE.test(actionText)) return null;
    const enemies = presentHostiles();
    if (enemies.length === 0) return null;
    const pc = pcId();
    if (!pc) return null;
    const targetId = pickTarget(actionText, enemies) || enemies[0];
    return { targetId, enemies, allies: [pc] };
  }

  /**
   * Begin a structured encounter and process the player's initiating action.
   * Initiative is rolled; enemies that beat the PC act before the declared attack lands.
   */
  async function startAndResolve(actionOp, initiation) {
    const enc = buildEncounter({ allies: initiation.allies, enemies: initiation.enemies }, session.entities, session.rng(), combatRules);
    writeEncounter(enc);
    const orderNames = enc.order.map(nameOf).join(' → ');
    const orderLabel = enc.mode === 'round-robin' ? 'Turn order' : 'Initiative';
    banner('start', `Combat begins! ${orderLabel}: ${orderNames}.`, { round: 1, order: enc.order });
    narrate(FLAVOR.begin);

    // Run any enemies that won initiative, then resolve the player's declared attack.
    await runUntilPlayerTurn();
    if (inCombat()) await handlePlayerAction(actionOp);
  }

  /**
   * Handle the player's action on their combat turn: flee or attack, then run the
   * enemy phase until it's the player's turn again (or the encounter ends).
   */
  async function handlePlayerAction(actionOp) {
    const text = (actionOp.text || '').trim();
    if (!inCombat()) return;

    if (FLEE_RE.test(text) && !ATTACK_RE.test(text)) {
      endEncounter('flee');
      return;
    }

    const enc = getEncounter();
    const target = pickTarget(text, enc.enemies);
    const pc = pcId();
    if (target && pc) {
      doAttack(pc, target);
    } else {
      banner('turn', 'There is no enemy left to strike.');
    }

    if (outcome(getEncounter(), session.entities) !== 'ongoing') {
      endEncounter(outcome(getEncounter(), session.entities));
      return;
    }

    // End the player's turn → enemies act.
    writeEncounter(advanceTurn(getEncounter(), session.entities));
    await runUntilPlayerTurn();
  }

  return { inCombat, detectInitiation, startAndResolve, handlePlayerAction };
}
