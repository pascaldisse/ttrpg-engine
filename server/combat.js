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
  buildEncounter, currentCombatant, resolveAttack, resolveMove, advanceTurn, outcome,
  buildTimeline, advanceTimeline, projectQueue, enemyInstinct, moraleShaken, decisionToOps,
} from '../shared/combat.js';
import { expandOp, expandOps } from '../shared/effects.js';
import { tickStatuses } from '../shared/statuses.js';
import { resolveCheck, formatCheckResult } from '../shared/checks.js';
import { findPc, pcLocationId, entitiesAt } from '../shared/space.js';

const ATTACK_RE = /\b(attack|attacks?|hit|strike|stab|slash|swing|fight|kill|charge|shoot|punch|lunge|cut down|draw (?:my )?(?:sword|blade|steel|weapon))\b/i;
const FLEE_RE = /\b(flee|run away|run|escape|retreat|disengage|get away|leg it|withdraw)\b/i;

const ENCOUNTER_ID = 'encounter';
const MAX_TURN_GUARD = 100; // safety against any pathological loop

export function createCombatEngine({ session, broadcast, applyAndBroadcast, awardXp, rules, dmAgent, npcAgent }) {
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

  // ---- timeline (C2) vs legacy turn-order helpers ----

  const isTimeline = () => combatRules.initiativeMode === 'timeline';

  /** The id whose turn it is now (timeline: turnOf; else order[turnIndex]). */
  const curActor = (enc) => (isTimeline() ? (enc && enc.turnOf) || null : currentCombatant(enc));

  /** The CTB action cost of a Move (ruleset moveCost, else move.cost, else 1). */
  function actionCostOf(move) {
    if (typeof combatRules.moveCost === 'function') return combatRules.moveCost(move || {});
    return (move && move.cost) || 1;
  }

  /** Broadcast the projected turn bar (timeline mode only). */
  function broadcastTimeline() {
    const enc = getEncounter();
    if (!enc || enc.mode !== 'timeline') return;
    banner('timeline', '', { queue: projectQueue(enc, session.entities, combatRules, 8), turnOf: enc.turnOf });
  }

  /** Advance the floor after `actorId` acted (timeline charges Move cost; legacy bumps turnIndex). */
  function advanceAfter(actorId, move) {
    const enc = getEncounter();
    const next = isTimeline()
      ? advanceTimeline(enc, actorId, actionCostOf(move), session.entities, combatRules)
      : advanceTurn(enc, session.entities);
    writeEncounter(next);
    if (isTimeline()) broadcastTimeline();
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

  /** Broadcast a Move/roll line (C1 — same lane as attack rolls). */
  function moveLine(actorId, targetId, result) {
    const arrow = targetId && targetId !== actorId ? ` → ${nameOf(targetId)}` : '';
    applyAndBroadcast([{
      op: 'event', name: 'system',
      data: {
        kind: 'roll',
        text: `✦ ${nameOf(actorId)}${arrow}: ${result.summary}`,
        detail: { ...(result.detail || {}) },
      },
    }], 'combat');
  }

  /** Broadcast a status applied/ticked/expired line (C1). */
  function statusEvent(text, detail) {
    applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'status', text, detail } }], 'combat');
  }

  /** Find a Move by name on an actor's moves.list (exact, then case-insensitive). */
  function findMove(actorId, name) {
    if (!name) return null;
    const list = ((session.entities.get(actorId) || {}).moves || {}).list || [];
    return list.find(m => m.name === name)
      || list.find(m => (m.name || '').toLowerCase() === name.toLowerCase())
      || null;
  }

  /** Apply a batch of (possibly semantic) ops via the expander. */
  function applyOps(ops) {
    if (!ops || !ops.length) return;
    const expanded = expandOps(session.entities, ops);
    if (expanded.length) applyAndBroadcast(expanded, 'combat');
  }

  /**
   * Resolve + apply a declared Move: choose a sensible target, broadcast the roll,
   * apply damage/heal ops and status ops (with status lines), announce kills.
   */
  function doMove(actorId, move, requestedTarget, text) {
    const enc = getEncounter();
    const type = move.type || 'damage';
    let targetId = requestedTarget;

    if (type === 'heal' || type === 'buff' || type === 'utility') {
      targetId = requestedTarget || actorId;            // self by default
    } else if (type !== 'area') {
      if (!targetId || !isAlive(targetId)) targetId = pickTarget(text, enc.enemies || []);
    }

    const result = resolveMove(move, { actorId, targetId }, session.entities, session.rng(), combatRules);

    moveLine(actorId, targetId, result);
    applyOps(result.ops || []);

    for (const sop of (result.statusOps || [])) {
      applyOps([sop]);
      statusEvent(
        `${nameOf(sop.id)} gains ${sop.kind}${sop.remaining ? ` (${sop.remaining})` : ''}`,
        { target: sop.id, kind: sop.kind, magnitude: sop.magnitude, remaining: sop.remaining },
      );
    }

    // Announce any combatant that the move's damage just dropped.
    for (const o of (result.ops || [])) {
      if (o.op === 'damage' && o.id && !isAlive(o.id)) banner('turn', `${nameOf(o.id)} falls!`);
    }
  }

  /**
   * Tick a combatant's statuses at the start of their turn: bleed bites, expired
   * statuses drop, and a `skip` (stun) is reported. No-op (no roll consumed) when
   * the combatant carries no statuses — so 5e/DSA fights are unaffected.
   * @returns {boolean} skip — true if this combatant loses their turn (stun)
   */
  function tickAndApply(combatantId) {
    const comps = session.entities.get(combatantId);
    const list = (comps && comps.statuses && comps.statuses.list) || [];
    if (!list.length) return false;

    const { ops, skip, lines } = tickStatuses(session.entities, combatantId, session.rng());
    applyOps(ops);
    for (const ln of lines) statusEvent(ln.text, ln.detail);
    return skip;
  }

  // ---- C3: enemies as agents (instinct / morale / talk / improv) ----

  const isAgentEnemy = (id) => !!((session.entities.get(id) || {}).agent || {}).enabled;

  /** Broadcast an enemy social beat (morale/parley). */
  function moraleEvent(id, intent, text) {
    applyAndBroadcast([{
      op: 'event', name: 'system',
      data: { kind: intent === 'shaken' ? 'morale' : 'parley', text: text || `${nameOf(id)} ${intent}`, detail: { id, intent } },
    }], 'combat');
  }

  /**
   * After damage, mark agent-enemies whose HP fell below the morale threshold (or who
   * are the last enemy standing) as `flags.morale='shaken'`. On their NEXT turn they
   * wake the LLM (combatDecide) instead of running instinct.
   */
  function checkMorale() {
    const enc = getEncounter();
    if (!enc) return;
    const threshold = combatRules.moraleThreshold ?? 0.34;
    const livingEnemies = (enc.enemies || []).filter(isAlive);
    for (const id of livingEnemies) {
      if (!isAgentEnemy(id)) continue;
      const comps = session.entities.get(id) || {};
      if ((comps.flags || {}).morale === 'shaken') continue;
      const lonely = livingEnemies.length === 1 && (enc.enemies || []).length > 1;
      if (moraleShaken(comps, threshold, lonely)) {
        applyOps([{ op: 'setFlag', id, key: 'morale', value: 'shaken' }]);
        moraleEvent(id, 'shaken', `${nameOf(id)}'s nerve breaks — it falters!`);
      }
    }
  }

  /** A short combat-context summary for an enemy's morale decision. */
  function encounterSummary(actorId) {
    const enc = getEncounter();
    const s = (session.entities.get(actorId) || {}).stats || {};
    const foes = (enc.allies || []).filter(isAlive).map(nameOf).join(', ');
    const allies = (enc.enemies || []).filter(id => isAlive(id) && id !== actorId).map(nameOf).join(', ') || 'none — you are the last one';
    return `You (${nameOf(actorId)}) are at ${s.hp ?? '?'}/${s.maxHp ?? '?'} Health. Still-standing allies: ${allies}. Your enemies: ${foes}. The fight is going against you.`;
  }

  /** Remove a combatant from the active encounter (it fled/surrendered). */
  function removeFromEncounter(id) {
    const enc = getEncounter();
    if (!enc) return;
    writeEncounter({
      ...enc,
      enemies: (enc.enemies || []).filter(e => e !== id),
      allies: (enc.allies || []).filter(a => a !== id),
      participants: (enc.participants || []).filter(p => p.id !== id),
      order: (enc.order || []).filter(o => o !== id),
    });
  }

  /** Map a morale decision to ops (flee/surrender/parley leave the fight; fight = instinct). */
  async function applyEnemyDecision(actorId, decided) {
    const intent = decided.intent || 'fight';
    if (decided.say && npcAgent && typeof npcAgent.say === 'function') npcAgent.say(actorId, decided.say);

    if (intent === 'fight') {
      runInstinct(actorId);
      return;
    }

    // flee / surrender / parley → leave the encounter, drop hostility.
    const { ops } = decisionToOps(actorId, intent);
    applyOps(ops);
    removeFromEncounter(actorId);
    const verb = intent === 'flee' ? 'breaks and runs' : intent === 'surrender' ? 'throws down and surrenders' : 'pleads for parley';
    moraleEvent(actorId, intent, `${nameOf(actorId)} ${verb}.`);
  }

  /** Deterministic enemy turn: instinct Move (or basic attack). Zero LLM. */
  function runInstinct(actorId) {
    const { move, targetId } = enemyInstinct(actorId, getEncounter(), session.entities, session.rng(), combatRules);
    if (move) doMove(actorId, move, targetId, '');
    else if (targetId) doAttack(actorId, targetId);
  }

  /**
   * Enemy turn policy (C3): a morale-broken AGENT enemy wakes the LLM to decide
   * (fight/flee/surrender/parley); everyone else runs deterministic instinct.
   */
  async function enemyAct(actorId) {
    const comps = session.entities.get(actorId) || {};
    const shaken = (comps.flags || {}).morale === 'shaken';
    if (shaken && isAgentEnemy(actorId) && npcAgent && typeof npcAgent.combatDecide === 'function') {
      const decided = await npcAgent.combatDecide(actorId, encounterSummary(actorId));
      await applyEnemyDecision(actorId, decided);
    } else {
      runInstinct(actorId);
    }
    checkMorale();
  }

  /**
   * Improvised player action (C3): off-menu combat text routed to the DM in a combat
   * context → {checks, ops}. The ENGINE rolls the checks; ops apply on success only.
   * The LLM only chose the shape — deterministic resolution underneath.
   */
  async function resolveImprov(actionOp) {
    if (!dmAgent || typeof dmAgent.adjudicateCombat !== 'function') {
      banner('turn', 'Nothing comes of it.');
      return;
    }
    const enc = getEncounter();
    const livingEnemies = (enc.enemies || []).filter(isAlive);
    const ruling = await dmAgent.adjudicateCombat(actionOp, livingEnemies);

    const pc = pcId();
    const pcStats = (session.entities.get(pc) || {}).stats || {};
    const proficiency = pcStats.proficiency || 2;

    let success = true;
    for (const c of (ruling.checks || [])) {
      const result = resolveCheck(
        { check: c.check || 'ability-check', ability: c.ability, skill: c.skill, dc: c.dc || 3, reason: c.reason || '' },
        { stats: pcStats, proficiency },
        session.rng(),
      );
      applyAndBroadcast([{
        op: 'event', name: 'system',
        data: { kind: 'roll', text: `✦ ${nameOf(pc)}: ${formatCheckResult(result)}`, detail: { success: result.success, rolls: result.rolls, total: result.total, dc: result.dc, reason: c.reason } },
      }], 'combat');
      if (!result.success) success = false;
    }

    if (success && (ruling.ops || []).length) {
      applyOps(ruling.ops);
      for (const o of ruling.ops) {
        if (o.op === 'applyStatus') statusEvent(`${nameOf(o.id)} gains ${o.kind}${o.remaining ? ` (${o.remaining})` : ''}`, { target: o.id, kind: o.kind, remaining: o.remaining });
        if (o.op === 'damage' && o.id && !isAlive(o.id)) banner('turn', `${nameOf(o.id)} falls!`);
      }
    } else if (!success) {
      banner('turn', `${nameOf(pc)}'s improvised gambit fails.`);
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

      if (outcome(enc, session.entities) !== 'ongoing') { endEncounter(outcome(enc, session.entities)); return; }

      const cur = curActor(enc);
      if (!cur) return;

      // Start-of-turn status tick (bleed bites; stun flags a skip). Only if alive.
      let skip = false;
      if (isAlive(cur)) {
        skip = tickAndApply(cur);
        // A bleed tick can drop a combatant (incl. the current one) → re-check outcome.
        if (outcome(getEncounter(), session.entities) !== 'ongoing') { endEncounter(outcome(getEncounter(), session.entities)); return; }
      }

      // Player-controlled seat: a stunned/dead PC loses the turn; otherwise wait for input.
      if (cur === pcId()) {
        if (!isAlive(cur)) { advanceAfter(cur); continue; }
        if (skip) {
          banner('turn', `${nameOf(cur)} is stunned and loses the turn!`);
          advanceAfter(cur);
          continue;
        }
        return; // the player acts
      }

      // Enemy seat: morale-broken agents decide via the LLM; else deterministic instinct.
      if (isAlive(cur) && !skip) {
        await enemyAct(cur);
      } else if (isAlive(cur) && skip) {
        banner('turn', `${nameOf(cur)} is stunned and can't act!`);
      }

      if (outcome(getEncounter(), session.entities) !== 'ongoing') { endEncounter(outcome(getEncounter(), session.entities)); return; }
      // Advance the floor (timeline charges cost; legacy skips dead + bumps round).
      advanceAfter(cur);
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
   * Triggers when the text reads like an attack OR a declared Move names a present
   * hostile as its target (the HUD move→enemy flow). Returns {targetId, enemies, allies} or null.
   * @param {object|string} actionOp — the player action op (or bare text, back-compat)
   */
  function detectInitiation(actionOp) {
    const actionText = typeof actionOp === 'string' ? actionOp : (actionOp.text || '');
    const reqTarget = (typeof actionOp === 'object' && actionOp.target) || null;
    const enemies = presentHostiles();
    if (enemies.length === 0) return null;
    const pc = pcId();
    if (!pc) return null;

    const targetIsHostile = reqTarget && enemies.includes(reqTarget);
    if (!ATTACK_RE.test(actionText) && !targetIsHostile) return null;

    const targetId = targetIsHostile ? reqTarget : (pickTarget(actionText, enemies) || enemies[0]);
    return { targetId, enemies, allies: [pc] };
  }

  /**
   * Begin a structured encounter and process the player's initiating action.
   * Initiative is rolled; enemies that beat the PC act before the declared attack lands.
   */
  async function startAndResolve(actionOp, initiation) {
    const enc = isTimeline()
      ? buildTimeline({ allies: initiation.allies, enemies: initiation.enemies }, session.entities, combatRules)
      : buildEncounter({ allies: initiation.allies, enemies: initiation.enemies }, session.entities, session.rng(), combatRules);
    writeEncounter(enc);

    const orderSeq = isTimeline() ? enc.queue : enc.order;
    const orderNames = (orderSeq || []).map(nameOf).join(' → ');
    const orderLabel = isTimeline() ? 'Timeline' : (enc.mode === 'round-robin' ? 'Turn order' : 'Initiative');
    banner('start', `Combat begins! ${orderLabel}: ${orderNames}.`, { round: 1, order: enc.order, queue: enc.queue, turnOf: enc.turnOf });
    if (isTimeline()) broadcastTimeline();
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

    // Flee (only when it isn't also a declared Move / attack).
    if (FLEE_RE.test(text) && !ATTACK_RE.test(text) && !actionOp.move) {
      endEncounter('flee');
      return;
    }

    const pc = pcId();
    let acted = false;
    let usedMove = null;

    // C1: a declared Move on the actor's moves.list resolves via combat.resolveMove.
    if (pc && actionOp.move) {
      const move = findMove(pc, actionOp.move);
      if (move) {
        doMove(pc, move, actionOp.target, text);
        usedMove = move;
        acted = true;
      }
    }

    // Not a declared Move: a plain attack falls back to a basic strike; anything else
    // off-menu ("I throw sand in its eyes") is an IMPROVISED action → DM adjudication.
    if (!acted) {
      if (ATTACK_RE.test(text)) {
        const target = (actionOp.target && isAlive(actionOp.target))
          ? actionOp.target
          : pickTarget(text, getEncounter().enemies);
        if (target && pc) doAttack(pc, target);
        else banner('turn', 'There is no enemy left to strike.');
      } else {
        await resolveImprov(actionOp);
      }
    }

    checkMorale();

    if (outcome(getEncounter(), session.entities) !== 'ongoing') {
      endEncounter(outcome(getEncounter(), session.entities));
      return;
    }

    // End the player's turn → enemies act.
    advanceAfter(pc, usedMove);
    await runUntilPlayerTurn();
  }

  return { inCombat, detectInitiation, startAndResolve, handlePlayerAction };
}
