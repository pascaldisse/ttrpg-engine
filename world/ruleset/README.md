# Ruleset extension seam

This directory holds rules-as-data bundles. A ruleset typically ships:

- `schema.js` — calls `registerComponents(...)` from `shared/schema.js` to register its stat blocks, skills, conditions, spells, etc.
- `system.md` — the cached system prompt prefix loaded by the turn engine (P1+).

To load a ruleset, set `TTRPG_RULESET=my-ruleset` and place the bundle here.

**P0**: no ruleset loaded yet. The base `SCHEMA` in `shared/schema.js` covers the essentials.

## Optional combat exports (Combat Overhaul C1–C5)

All optional — a bundle that exports none behaves exactly as before (5e/DSA do):

- `statuses` — `STATUS_DEFS` registered via `registerStatuses` (`shared/statuses.js`): `onTick`, `skipTurn`,
  `modifyOutgoing`/`modifyIncoming`, `modifySpeed`, `zoneScoped`. (C1/C2/C4)
- `combat.resolveMove(move, params, entities, rng, mods)` — resolve a declared Move → `{ops, statusOps, summary}`. (C1)
- `combat.initiativeMode: 'timeline'` + `combat.speedOf(entity)` + `combat.moveCost(move)` — the CTB timeline. (C2)
- `combat.enemyInstinct(actorId, encounter, entities, rng)`, `combat.moraleThreshold`, `combat.weaknesses`. (C3)
- `combat.overdrive: { fillOnDealt, fillOnTaken, full }`. (C5)
- A `moves.list` shape on combatants: `{name, type, damage?, duration?, cost?, range?, status?, magnitude?, requiresOverdrive?, summon?}`.

See `campaigns/necrotopia/ruleset/necrotopia/` for a complete, import-free example.
