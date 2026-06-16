# Ruleset extension seam

This directory holds rules-as-data bundles. A ruleset typically ships:

- `schema.js` — calls `registerComponents(...)` from `shared/schema.js` to register its stat blocks, skills, conditions, spells, etc.
- `system.md` — the cached system prompt prefix loaded by the turn engine (P1+).

To load a ruleset, set `TTRPG_RULESET=my-ruleset` and place the bundle here.

**P0**: no ruleset loaded yet. The base `SCHEMA` in `shared/schema.js` covers the essentials.
