/**
 * server/ruleset.js — ruleset loader.
 *
 * Loads a rules-as-data bundle from world/ruleset/<id>/ and registers its
 * component schema extensions and check definitions into the shared engine.
 *
 * This is scaffolding only — do NOT wire into index.js or dm-agent.js here.
 * Boot/integration is done by Claude.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { registerComponents } from '../shared/schema.js';
import { registerChecks } from '../shared/checks.js';
import { registerStatuses } from '../shared/statuses.js';

/**
 * Load a ruleset bundle by id from the world directory.
 *
 * 1. dynamic-import() <worldDir>/ruleset/<id>/ruleset.js
 * 2. registerComponents(mod.components || {})
 * 3. registerChecks(mod.checks || {})
 * 4. read <worldDir>/ruleset/<id>/system.md (utf8; '' if missing)
 * 5. return { meta, systemPrompt, components, checks, combat }
 *
 * `combat` (optional bundle export) is the rules-as-data combat override consumed
 * by the combat engine — see shared/combat-rules.js. null when the bundle ships none.
 *
 * @param {string} id — ruleset id (e.g. 'srd5e', 'dsa5', 'necrotopia')
 * @param {string} worldDir — absolute path to the world/ directory
 * @returns {Promise<{meta:object, systemPrompt:string, components:object, checks:object, combat:object|null}>}
 */
export async function loadRuleset(id, worldDir) {
  const bundleDir = `${worldDir}/ruleset/${id}`;
  const bundleFile = `${bundleDir}/ruleset.js`;

  let mod;
  try {
    mod = await import(pathToFileURL(bundleFile).href);
  } catch (err) {
    throw new Error(
      `Ruleset '${id}' not found: ${bundleFile} — ${err.message}`,
    );
  }

  registerComponents(mod.components || {});
  registerChecks(mod.checks || {});
  registerStatuses(mod.statuses || {});

  let systemPrompt = '';
  try {
    systemPrompt = await readFile(`${bundleDir}/system.md`, 'utf8');
  } catch {
    // system.md is optional — keep ''
  }

  return {
    meta: mod.meta,
    systemPrompt,
    components: mod.components || {},
    checks: mod.checks || {},
    statuses: mod.statuses || {},
    combat: mod.combat || null,
    actorTemplates: mod.actorTemplates || null,
  };
}
