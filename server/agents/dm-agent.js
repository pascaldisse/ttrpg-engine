/**
 * server/agents/dm-agent.js — DM director agent.
 *
 * The DM is the world-voice: narrates environment, routes player input to NPCs,
 * AND adjudicates actions for checks + consequences (P3).
 * Does NOT speak for NPCs — those are independent agent-clients.
 */

import { z } from 'zod';
import { buildDmNarrationContext, buildDmRoutingContext } from '../../shared/context.js';
import { streamBeat } from './stream-beat.js';
import { semanticOpTypes } from '../../shared/effects.js';
import { look as senseLook } from '../sense.js';

// ---- 5e system prompt for the DM (narration voice) ----

const DM_SYSTEM_PROMPT = `You are the Dungeon Master of a Dungeons & Dragons 5th Edition game.

Your role:
- Narrate vividly but concisely in 2nd person ("You see...", "You feel...").
- Describe the scene, NPC reactions, and consequences of player actions.
- Rely on your knowledge of 5e rules for any checks, combat, or spellcasting.

Guidelines:
- Keep narration to 2-4 sentences unless the situation demands more.
- Be specific about sensory details — what is seen, heard, smelled, felt.
- Maintain consistent tone matching the scene's mood.
- Track NPC attitudes and world state implicitly.
- Do NOT break character or address the player out-of-game.
- Respond with prose ONLY — never JSON or code blocks.

When told check results, INCORPORATE them into your narration naturally:
- Success → describe the character succeeding ("Your blade bites deep...", "The lock clicks open...").
- Failure → describe the consequence ("Your footing slips...", "The mechanism jams...").
- Crit → a spectacular success ("A perfect strike...").
- Fumble → a spectacular failure ("Disaster strikes...").

Always stay in the fiction. You are the world.`;

// ---- Adjudication system prompt (referee voice) ----

const ADJUDICATE_SYSTEM_PROMPT = `You are the DM referee. For each player action, decide:
1. Does the action target an NPC for conversation? → set speakTo to that npcId.
2. Does the player want to TRAVEL to a connected place? → set move:{"to":"<locationId>"}
   using an EXACT targetId from the scene's Exits list. NEVER move to a place that is
   not listed as an exit. When moving, leave checks and ops empty — arrival is narrated separately.
3. Does the action require dice checks? → list them (ability, optional skill, dc, reason).
   You must NEVER invent dice values — only REQUEST checks. The engine rolls.
4. Does the action have certain consequences? → provide semantic ops.
   - If a check is requested: provide ops for the SUCCESS case only.
   - For no-check actions: provide ops directly.
   - To PICK UP a world object that is present in the scene, use
     {op:'take', id:<PC_ID>, item:{id:<the item's entity id>, name:<Name>}} — NOT giveItem.

IMPORTANT: Only reference NPCs, items, and exits that appear in the scene below.
The player can only interact with what is HERE.

Available semantic ops:
- {op:'take', id:<PC_ID>, item:{id:<itemEntityId>, name:<displayName>}} — pick up a PRESENT world object
- {op:'damage', id:<entityId>, amount:<number>} — deal damage (engine computes new hp)
- {op:'heal', id:<entityId>, amount:<number>} — heal (engine caps at maxHp)
- {op:'giveItem', id:<entityId>, item:{id:<itemId>, name:<displayName>}} — abstract grant with NO world entity
- {op:'setFlag', key:<string>, value:<any>, id?<world-state-id>}

Respond with JSON ONLY. No narration, no commentary.`;

// ---- Canonize system prompt (canon-recorder voice; "narrate freely, canonize second") ----

const CANONIZE_SYSTEM_PROMPT = `You are the DM's canon-recorder. You read the narration that was JUST delivered to the player and output the concrete world-state changes it ESTABLISHED, as semantic ops in JSON.

Be THOROUGH about concrete changes — even if the narration also contains description or dialogue, extract EVERY concrete change inside it:
- The player picks up / takes / grabs / loots / pockets an object that EXISTS in the scene below → {"op":"take","id":"<PC_ID>","item":{"id":"<that item's entity id>","name":"<Name>"}}
- The player is granted something that has NO entity in the scene (coins, a note, abstract loot) → {"op":"giveItem","id":"<PC_ID>","item":{"id":"<slug>","name":"<Name>"}}
- The player loses / drops / uses up / hands over an item → {"op":"takeItem","id":"<PC_ID>","item":{"id":"<slug>"}}
- The player or a target takes damage → {"op":"damage","id":"<entityId>","amount":N}; is healed → {"op":"heal","id":"<entityId>","amount":N}
- A world fact becomes true → {"op":"setFlag","key":"<k>","value":<v>}

Rules:
- Record ONLY what the narration actually made true (it already reflects success/failure — a FAILED attempt changes nothing).
- Do NOT invent changes the narration didn't describe.
- Do NOT record movement between locations — travel is handled by the engine separately.
- Prefer the EXACT item entity ids shown in the scene below when the object is already present.
- If truly nothing concrete changed (pure talk or observation), return {"ops":[]}.
- The player character's id is "<PC_ID>"; the world flags entity id is "world-state".

Examples:
- Scene has "**Brass Key** (item-key)"; Narration: "You pry the lockbox open and pocket the brass key inside." → {"ops":[{"op":"take","id":"<PC_ID>","item":{"id":"item-key","name":"Brass Key"}}]}
- Narration: "The blade rakes your arm — a hot line of pain, blood welling." → {"ops":[{"op":"damage","id":"<PC_ID>","amount":5}]}
- Narration: "She studies you warily but says nothing more." → {"ops":[]}

Respond with JSON ONLY: {"ops":[...]}.`;

// ---- Routing result schema ----

const routingSchema = z.object({
  targets: z.array(z.string()).default([]),
  note: z.string().optional().default(''),
});

// ---- Adjudication result schema (P3) ----

const checkRequestSchema = z.object({
  ability: z.string(),
  skill: z.string().optional(),
  dc: z.number().min(1).max(50),
  reason: z.string().optional(),
});

// Permissive on purpose: a real LLM's JSON shape varies (extra fields, a string
// where we expect an object, dc out of range, a check missing `ability`). A strict
// schema here makes structured() THROW, which drops the WHOLE ruling — silently
// losing movement and checks. So we accept anything and coerce in adjudicate().
const adjudicationSchema = z.object({
  speakTo: z.any().optional(),
  note: z.any().optional(),
  move: z.any().optional(),
  checks: z.any().optional(),
  ops: z.any().optional(),
}).passthrough();

// ---- Canonize result schema (P3.1) ----

const canonizeSchema = z.object({
  ops: z.array(z.any()).default([]),
});

// ---- Stream counter (shared across agents) ----

let streamCounter = 0;

/**
 * Create the DM agent.
 *
 * @param {object} params
 * @param {import('../session.js').Session} params.session
 * @param {(msg:object)=>void} params.broadcast
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast
 * @param {object} params.llm — LlmClient
 * @returns {{narrate, route, adjudicate, narrateOutcome}}
 */
export function createDmAgent({ session, broadcast, applyAndBroadcast, llm }) {
  const systemPrompt = DM_SYSTEM_PROMPT;
  const sessionId = process.env.TTRPG_SAVE || 'default';

  /**
   * DM world-voice narration (P1-P2 fallback; used for ambient/look actions).
   * @param {object} actionOp — {op:'action', text, by}
   * @returns {Promise<string>} — the full narration text
   */
  async function narrate(actionOp) {
    const actionText = actionOp.text || '';

    const messages = buildDmNarrationContext({
      systemPrompt,
      session,
      action: actionText,
    });

    const streamId = `narr-${++streamCounter}`;

    return streamBeat({
      llm,
      messages,
      eventName: 'narration',
      baseData: { by: 'dm' },
      broadcast,
      applyAndBroadcast,
      role: 'dm',
      streamId,
    });
  }

  /**
   * LLM routing call — only for the ambiguous case (2+ NPCs, no @mention).
   * Returns {targets, note} validated against the routing Zod schema.
   * On failure, defaults to the first present NPC.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {Array} presentNpcs — from sense.presentAgents()
   * @returns {Promise<{targets:string[], note:string}>}
   */
  async function route(actionOp, presentNpcs) {
    const actionText = actionOp.text || '';

    const messages = buildDmRoutingContext({
      presentNpcs,
      session,
      action: actionText,
    });

    try {
      const { parsed } = await llm.structured(messages, routingSchema, {
        user: sessionId,
        role: 'routing',
      });
      // Validate targets reference actual present NPCs
      const validTargets = (parsed.targets || [])
        .filter(t => presentNpcs.some(n => n.npcId === t));
      return {
        targets: validTargets.length > 0 ? validTargets : [presentNpcs[0]?.npcId].filter(Boolean),
        note: parsed.note || '',
      };
    } catch (err) {
      console.error('[dm-agent] Routing call failed:', err.message);
      // Default to first present NPC
      return {
        targets: presentNpcs.length > 0 ? [presentNpcs[0].npcId] : [],
        note: '',
      };
    }
  }

  /**
   * Adjudicate: structured LLM call to decide routing, checks, and consequences.
   * The LLM NEVER supplies dice values — it only REQUESTS checks.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {Array} presentNpcs — from sense.presentAgents()
   * @returns {Promise<{speakTo:string|null, note:string, checks:object[], ops:object[]}>}
   */
  async function adjudicate(actionOp, presentNpcs) {
    const actionText = actionOp.text || '';

    // Build adjudication context
    const npcList = presentNpcs.map(n => {
      const pers = n.persona ? ` — ${n.persona}` : '';
      return `- ${n.name} (id: "${n.npcId}")${pers}`;
    }).join('\n');

    // Find PC entity for stats context
    const pcEntry = [...session.entities.entries()].find(
      ([_id, comps]) => (comps.identity || {}).kind === 'pc'
    );
    const pcId = pcEntry ? pcEntry[0] : null;
    const pcStats = pcEntry && pcEntry[1].stats ? JSON.stringify(pcEntry[1].stats) : '{}';
    const pcName = (pcEntry && pcEntry[1].identity && pcEntry[1].identity.name) || 'the hero';

    // Location-scoped scene frame (lists present NPCs/items + exits the player may use).
    const lookText = session._lookCache || senseLook(session);

    const messages = [
      {
        role: 'system',
        content: adjudicatePrompt()(npcList, pcId, pcName, pcStats, lookText),
      },
      {
        role: 'user',
        content: `Player action: "${actionText}"\n\nRespond with JSON ONLY: {"speakTo":<npcId|null>, "move":{"to":"<locationId>"}|null, "note":"<director note for NPC if speaking>", "checks":[{ability,skill?,dc,reason}], "ops":[<semantic ops for SUCCESS case>]}`,
      },
    ];

    try {
      const { parsed } = await llm.structured(messages, adjudicationSchema, {
        user: sessionId,
        role: 'adjudicate',
      });

      // Coerce every field here so a slightly-off shape never silently drops the ruling.
      const ruling = { speakTo: null, move: null, note: '', checks: [], ops: [] };

      // speakTo → a present agent-NPC id, else null
      if (typeof parsed.speakTo === 'string' && parsed.speakTo.trim()) {
        const id = parsed.speakTo.trim();
        if (presentNpcs.some(n => n.npcId === id)) ruling.speakTo = id;
        else console.warn(`[dm-agent] Adjudicate speakTo=${id} is not a present agent-NPC; ignoring.`);
      }

      // move → {to:string} (accept a bare string or {to}); connectivity is checked downstream
      if (parsed.move) {
        if (typeof parsed.move === 'string' && parsed.move.trim()) {
          ruling.move = { to: parsed.move.trim() };
        } else if (typeof parsed.move === 'object' && typeof parsed.move.to === 'string' && parsed.move.to.trim()) {
          ruling.move = { to: parsed.move.to.trim() };
        }
      }

      if (typeof parsed.note === 'string') ruling.note = parsed.note;
      if (Array.isArray(parsed.ops)) ruling.ops = parsed.ops;

      // checks → clamped, defaulted check requests (drops malformed entries, never throws)
      const rawChecks = Array.isArray(parsed.checks) ? parsed.checks : [];
      ruling.checks = rawChecks
        .filter(c => c && typeof c === 'object')
        .map(c => {
          let dc = Number(c.dc);
          if (!Number.isFinite(dc)) dc = 12;
          dc = Math.max(1, Math.min(50, Math.round(dc)));
          return {
            ability: String(c.ability || 'wis').toLowerCase(),
            skill: c.skill ? String(c.skill) : undefined,
            dc,
            reason: c.reason ? String(c.reason) : '',
          };
        });

      return ruling;
    } catch (err) {
      console.error('[dm-agent] Adjudication call failed:', err.message);
      // Fallback: treat as pure narration
      return { speakTo: null, move: null, note: '', checks: [], ops: [] };
    }
  }

  /**
   * Narrate an action outcome incorporating resolved check results.
   * Streams narration, returns the full text.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {object[]} checkResults — resolved check results from checks.js
   * @param {string} lookText — cached scene look frame
   * @returns {Promise<string>}
   */
  async function narrateOutcome(actionOp, checkResults, lookText) {
    const actionText = actionOp.text || '';

    // Build context with check results injected
    const { recentHistory } = await import('../../shared/context.js');
    const history = recentHistory(session.journal, 12);

    // Format check results for the DM
    let checkText = '';
    if (checkResults && checkResults.length > 0) {
      checkText = '\n\n## Resolved checks (ALREADY ROLLED — incorporate into narration):\n';
      for (const r of checkResults) {
        checkText += `- ${r.summary}\n`;
      }
    }

    const messages = [
      { role: 'system', content: DM_SYSTEM_PROMPT },
      ...history,
      { role: 'system', content: (lookText || '(scene unknown)') + checkText + '\n\nNarrate the outcome of the player\'s action, incorporating the check results above. Do NOT roll dice or reference rules — the dice are already rolled. Describe what HAPPENS in the fiction.' },
      { role: 'user', content: actionText },
    ];

    const streamId = `narr-${++streamCounter}`;

    return streamBeat({
      llm,
      messages,
      eventName: 'narration',
      baseData: { by: 'dm' },
      broadcast,
      applyAndBroadcast,
      role: 'dm',
      streamId,
    });
  }

  /**
   * Canonize: distill the state changes the just-delivered narration ESTABLISHED into ops.
   * "Narrate freely, canonize second" — keeps story and state in sync. The narration is
   * already outcome-aware, so the recorded consequences match what the player was told.
   *
   * @param {object} actionOp — {op:'action', text, by}
   * @param {string} narrationText — the narration just streamed to the player
   * @param {object[]} checkResults — resolved check results (for context)
   * @returns {Promise<object[]>} — semantic/canonical ops (unexpanded)
   */
  async function canonize(actionOp, narrationText, checkResults) {
    const actionText = actionOp.text || '';
    const pcEntry = [...session.entities.entries()].find(
      ([_id, comps]) => (comps.identity || {}).kind === 'pc'
    );
    const pcId = pcEntry ? pcEntry[0] : 'pc-hero';

    let checkText = '';
    if (checkResults && checkResults.length > 0) {
      checkText = '\nDice results: ' + checkResults.map(r => r.summary).join('; ');
    }

    // Ground canonize in the scoped scene so it can reference real item entity ids.
    const lookText = session._lookCache || senseLook(session);

    const messages = [
      { role: 'system', content: CANONIZE_SYSTEM_PROMPT.replaceAll('<PC_ID>', pcId) },
      {
        role: 'user',
        content: `Scene (the entities that exist HERE — use these exact ids):\n${lookText}\n\nPlayer action: "${actionText}"${checkText}\n\nNarration just delivered to the player:\n"""\n${narrationText}\n"""\n\nOutput JSON {"ops":[...]} capturing ONLY the concrete state changes this narration established. If nothing concrete changed, return {"ops":[]}.`,
      },
    ];

    try {
      const { parsed } = await llm.structured(messages, canonizeSchema, {
        user: sessionId,
        role: 'canonize',
      });
      return Array.isArray(parsed.ops) ? parsed.ops : [];
    } catch (err) {
      console.error('[dm-agent] Canonize failed:', err.message);
      return [];
    }
  }

  return { narrate, route, adjudicate, narrateOutcome, canonize };
}

/** Build the adjudicate system prompt with dynamic scene/PC info injected. */
function adjudicatePrompt() {
  const base = ADJUDICATE_SYSTEM_PROMPT;
  return (npcList, pcId, pcName, pcStats, lookText) =>
    base + `\n\n## Scene (only these entities exist HERE)\n${lookText || '(scene unknown)'}\n\nNPCs you may route to:\n${npcList || '(none)'}\n\n## The PC\nID: "${pcId || 'unknown'}"\nName: ${pcName}\nStats: ${pcStats}\nWorld-state id: "world-state"`;
}
