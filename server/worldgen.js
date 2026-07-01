/**
 * server/worldgen.js — P8 "charge with meaning" pass + writer.
 *
 * Stage 2 of world generation. Takes the PURE procgen skeleton from
 * shared/worldgen-skeleton.js (a connected location graph with placeholder names) and
 * uses an LlmClient to fill in identity (name/description), persona, knowledge,
 * and art prompts — turning generic slots into a coherent themed world. Then
 * validates referential integrity and writes a scene JSON in the exact shape the
 * Session seeds from. "Generated once → fixed data."
 *
 * Robustness: charging is per-location and best-effort. If a location's LLM call
 * fails (network/parse/validation), that location falls back to deterministic
 * placeholder names — generation NEVER aborts the whole world over one bad call.
 * The skeleton already guarantees valid structure, so the output always seeds.
 *
 * SECURITY: never logs/echoes secrets. The LlmClient owns the API key; this
 * module only receives an already-constructed client.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { generateSkeleton } from '../shared/worldgen-skeleton.js';
import { validateWorld } from '../shared/worldcheck.js';
import { makeRng } from '../shared/rng.js';

// ---- LLM output schema (one call per location, names everything co-located) ----

const InhabitantSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  personality: z.string().optional(),
  backstory: z.string().optional(),
  voice: z.string().optional(),
  facts: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
}).passthrough();

const LocationChargeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  artPrompt: z.string().optional(),
  inhabitants: z.array(InhabitantSchema).optional(),
}).passthrough();

const QuestChargeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()).optional(),
}).passthrough();

// ---- Helpers ----

/** Deterministic placeholder name from a generation hint (fallback when no LLM). */
function placeholderName(role, n) {
  switch (role) {
    case 'entrance': return `The Gateway`;
    case 'lair':     return `The Lair`;
    case 'location': return `Area ${n}`;
    case 'local':    return `Townsfolk ${n}`;
    case 'enemy':    return `Marauder ${n}`;
    case 'prize':    return `The Prize`;
    case 'item':     return `Curio ${n}`;
    case 'pc':       return `The Wanderer`;
    case 'quest':    return `The Errand`;
    default:         return `Thing ${n}`;
  }
}

/** Entities co-located at a location id (npcs/enemies/items/pc), in id order. */
function inhabitantsOf(entities, locId) {
  const out = [];
  for (const [id, comps] of Object.entries(entities)) {
    if (id === locId) continue;
    if (comps.place && comps.place.locationId === locId) out.push(id);
  }
  return out.sort();
}

/** Short role descriptor for the prompt, derived from skeleton hints + components. */
function roleLine(id, comps, hint) {
  const role = (hint && hint.role) || (comps.identity && comps.identity.kind) || 'thing';
  const kind = comps.identity ? comps.identity.kind : 'thing';
  if (role === 'enemy' || comps.flags?.hostile) return `${id} — a hostile enemy (combatant)`;
  if (role === 'prize') return `${id} — the prize item the quest hinges on`;
  if (kind === 'item') return `${id} — an item/object present here`;
  if (kind === 'pc') return `${id} — the player character (the protagonist)`;
  if (kind === 'npc') return `${id} — a friendly/neutral character to talk to`;
  return `${id} — ${role}`;
}

// ---- Charge one location ----

/**
 * Charge a single location and everything in it. Mutates `entities` in place.
 * Returns true on LLM success, false if it fell back to placeholders.
 */
async function chargeLocation(entities, meta, locId, theme, llm, sessionId) {
  const loc = entities[locId];
  const hints = meta.hints || {};
  const locHint = hints[locId] || {};
  const inhabIds = inhabitantsOf(entities, locId);

  // Neighboring location roles give the model spatial context for coherent naming.
  const neighbors = (loc.place?.connections || [])
    .map(c => `${c.targetId} (${(hints[c.targetId] || {}).role || 'area'})`)
    .join(', ');

  const inhabLines = inhabIds.map(id => '  - ' + roleLine(id, entities[id], hints[id])).join('\n');

  const system = [
    `You are a world-builder for a tabletop RPG. Theme: ${theme || 'a grounded low-fantasy adventure'}.`,
    `Invent vivid, concrete, internally-consistent names and one-to-three-sentence descriptions.`,
    `This is ONE location of a connected world. Its role: ${locHint.role || 'location'}.`,
    neighbors ? `It connects to: ${neighbors}. Keep geography plausible.` : ``,
    `Give friendly characters a distinct personality, a short backstory, a voice cue, and 1-3`,
    `"facts" (public knowledge) plus 0-2 "secrets". Enemies need only a name + menacing description`,
    `+ short personality. Items need a name + description. The player character needs a name + a`,
    `one-line description. Reuse the EXACT ids given; do not invent new ids.`,
  ].filter(Boolean).join('\n');

  const user = [
    `Name and describe this location and everything in it. Return JSON ONLY:`,
    `{"name": "...", "description": "...", "artPrompt": "<image prompt>",`,
    ` "inhabitants": [{"id": "<exact id>", "name": "...", "description": "...",`,
    `   "personality": "...", "backstory": "...", "voice": "...",`,
    `   "facts": ["..."], "secrets": ["..."]}]}`,
    ``,
    `Location id: ${locId} (role: ${locHint.role || 'location'})`,
    inhabIds.length ? `Inhabitants/objects here (use these exact ids):\n${inhabLines}` : `Nothing else is here.`,
  ].join('\n');

  try {
    const { parsed } = await llm.structured(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      LocationChargeSchema,
      { user: sessionId, role: 'worldgen' }
    );
    applyLocationCharge(entities, locId, parsed);
    return true;
  } catch (e) {
    fallbackLocation(entities, meta, locId);
    return false;
  }
}

/** Apply a validated location charge result onto the entities. */
function applyLocationCharge(entities, locId, parsed) {
  const loc = entities[locId];
  if (loc.identity) {
    loc.identity.name = parsed.name || loc.identity.name;
    if (parsed.description) loc.identity.description = parsed.description;
  }
  if (loc.art && parsed.artPrompt) loc.art.prompt = parsed.artPrompt;

  const byId = new Map((parsed.inhabitants || []).map(o => [o.id, o]));
  for (const id of inhabitantsOf(entities, locId)) {
    const o = byId.get(id);
    if (!o) continue;
    const e = entities[id];
    if (e.identity) {
      if (o.name) e.identity.name = o.name;
      if (o.description) e.identity.description = o.description;
    }
    if (e.persona) {
      if (o.personality) e.persona.personality = o.personality;
      if (o.backstory && 'backstory' in e.persona) e.persona.backstory = o.backstory;
      if (o.voice && 'voice' in e.persona) e.persona.voice = o.voice;
    }
    if (e.knowledge) {
      if (Array.isArray(o.facts)) e.knowledge.facts = o.facts;
      if (Array.isArray(o.secrets)) e.knowledge.secrets = o.secrets;
    }
  }
}

/** Deterministic placeholder fill for a location that failed to charge. */
function fallbackLocation(entities, meta, locId) {
  const hints = meta.hints || {};
  const loc = entities[locId];
  if (loc.identity && /^Location \d+$/.test(loc.identity.name || '')) {
    const n = parseInt((locId.match(/(\d+)/) || [])[1] || '0', 10);
    loc.identity.name = placeholderName((hints[locId] || {}).role || 'location', n);
  }
  for (const id of inhabitantsOf(entities, locId)) {
    const e = entities[id];
    const n = parseInt((id.match(/(\d+)/) || [])[1] || '0', 10);
    if (e.identity) e.identity.name = placeholderName((hints[id] || {}).role || e.identity.kind, n);
  }
}

// ---- Charge the quest ----

async function chargeQuest(entities, meta, theme, llm, sessionId) {
  const qId = meta.questId;
  const q = entities[qId];
  if (!q || !q.quest) return false;

  const entrance = entities[meta.locationIds?.[0]];
  const lair = entities[meta.lairId];
  const ctx = [
    entrance?.identity ? `Start: ${entrance.identity.name}` : '',
    lair?.identity ? `Climax location: ${lair.identity.name}` : '',
  ].filter(Boolean).join('. ');

  const system = `You are a quest designer. Theme: ${theme || 'a grounded low-fantasy adventure'}. `
    + `Write a short main quest that fits this world. ${ctx}. The quest has exactly 3 steps: `
    + `(1) reach the climax location, (2) defeat the enemies there, (3) seize the prize.`;
  const user = `Return JSON ONLY: {"name":"...", "description":"<1-2 sentences>", `
    + `"steps":["<step 1>","<step 2>","<step 3>"]}`;

  try {
    const { parsed } = await llm.structured(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      QuestChargeSchema,
      { user: sessionId, role: 'worldgen' }
    );
    if (q.identity) {
      q.identity.name = parsed.name || q.identity.name;
      if (parsed.description) q.identity.description = parsed.description;
    }
    if (Array.isArray(parsed.steps) && parsed.steps.length) {
      // Preserve count; only replace strings we were given.
      q.quest.steps = q.quest.steps.map((s, i) => parsed.steps[i] || s);
    }
    return true;
  } catch (e) {
    if (q.identity && /^The Main Quest$/.test(q.identity.name || '')) q.identity.name = 'The Errand';
    return false;
  }
}

// ---- Deterministic post-pass: rewrite connection labels from named targets ----

function relabelConnections(entities) {
  for (const comps of Object.values(entities)) {
    if (!comps.place || !Array.isArray(comps.place.connections)) continue;
    for (const conn of comps.place.connections) {
      const target = entities[conn.targetId];
      const name = target?.identity?.name;
      if (name) conn.label = `To ${name}`;
    }
  }
}

// ---- Public API ----

/**
 * Charge a skeleton with meaning via the LLM. Mutates and returns the skeleton's
 * entities. Always returns valid, seedable entities (failed calls fall back to
 * deterministic placeholders).
 *
 * @param {{entities:object, meta:object}} skeleton  — from generateSkeleton()
 * @param {object} opts
 *   @param {object} opts.llm        — an LlmClient (DeepSeek/Mock)
 *   @param {string} [opts.theme]    — flavor seed for the world
 *   @param {string} [opts.sessionId]
 *   @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{entities:object, charged:number, failed:number}>}
 */
export async function chargeWorld(skeleton, { llm, theme, sessionId = 'worldgen', log = () => {} } = {}) {
  const { entities, meta } = skeleton;
  let charged = 0, failed = 0;

  for (const locId of (meta.locationIds || Object.keys(entities))) {
    if (!entities[locId]) continue;
    const ok = await chargeLocation(entities, meta, locId, theme, llm, sessionId);
    if (ok) { charged++; log(`charged ${locId} → "${entities[locId].identity?.name}"`); }
    else    { failed++;  log(`fallback ${locId} (LLM unavailable)`); }
  }

  const qOk = await chargeQuest(entities, meta, theme, llm, sessionId);
  if (qOk) log(`charged quest → "${entities[meta.questId]?.identity?.name}"`);

  relabelConnections(entities);
  return { entities, charged, failed };
}

/**
 * Full generate → charge → validate pipeline (no write). Throws if the charged
 * world fails referential-integrity validation (should never happen given a valid
 * skeleton; this is a safety net).
 *
 * @param {object} opts  — {size, locations, seed, theme, llm, sessionId, log}
 * @returns {Promise<{entities:object, meta:object, charged:number, failed:number}>}
 */
export async function generateWorld(opts = {}) {
  const { size = 'small', locations, seed = 42, theme, llm, sessionId, log = () => {} } = opts;
  const rng = makeRng(seed);
  const skeleton = generateSkeleton({ size, locations }, rng);
  skeleton.meta.seed = seed;
  log(`skeleton: ${Object.keys(skeleton.entities).length} entities, ${skeleton.meta.locationIds?.length} locations`);

  const { entities, charged, failed } = await chargeWorld(skeleton, { llm, theme, sessionId, log });

  const check = validateWorld(entities);
  if (!check.ok) {
    throw new Error('Generated world failed validation:\n  - ' + check.errors.join('\n  - '));
  }
  return { entities, meta: skeleton.meta, charged, failed };
}

/**
 * Write a world entity-map to a scene JSON file (creates parent dirs).
 * @param {object} entities
 * @param {string} outPath
 */
export function writeWorld(entities, outPath) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(entities, null, 2), 'utf-8');
  return outPath;
}
