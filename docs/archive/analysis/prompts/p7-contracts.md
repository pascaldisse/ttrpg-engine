# P7 Rules-as-data (the moat) — shared contracts (READ FIRST)

Part of the AI-TTRPG engine. The point of P7: the engine boots a **ruleset bundle** instead of hardcoding
5e. A bundle supplies (a) component/schema extensions, (b) check definitions (dice + resolution), and
(c) the DM system-prompt voice. Proving it on **DSA5** (3d20 roll-under) as well as **5e** (d20-vs-DC) is the
moat — one engine, rules as data.

Read `PROTOTYPE-SPEC.md` §13, `world/ruleset/README.md`, `shared/checks.js` (CHECK_DEFS + `resolveCheck`),
and `shared/schema.js` (`registerComponents`). **Do not break existing tests** (test-p4/p5/p6, smoke-p4/p5/p6).

## Hard conventions (same as the whole engine)
- **No build step.** Plain ES modules. No TypeScript/JSX/bundler. `shared/` stays pure (no server/client imports).
- Dice come from the engine via `shared/rng.js`; the LLM never rolls.
- Extensible/data-driven. The engine core must name no specific ruleset.

## How checks already work (use this — don't change the core)
`CHECK_DEFS[kind]` entries each carry `{ dice:{count,sides}, comparator, modSource(ctx), resolve(rolls, mod, dc, def, ctx) }`.
`resolveCheck(checkDescriptor, actorCtx, rng)` rolls `dice.count` d`dice.sides`, computes `mod = modSource(ctx)`,
and returns `def.resolve(rolls, mod, dc, def, ctx)` where `ctx = {...actorCtx, ...checkDescriptor}`. So a ruleset
expresses ANY resolution by shipping its own `resolve()` — the `comparator` field is just metadata. DSA fits as a
CHECK_DEF whose `resolve()` does 3d20 roll-under. **Do not modify `resolveCheck` itself.**

## New engine seam (single owner: the loader brief, in `shared/checks.js`)
Add `registerChecks(defs)` mirroring `registerComponents` in `shared/schema.js`: deep-merge `defs` into
`CHECK_DEFS` (new kinds added; existing kinds overridden field-wise). Pure, idempotent.

## Ruleset bundle format (a directory under `world/ruleset/<id>/`)
- `ruleset.js` — ES module exporting:
  - `export const meta = { id, name, dice, summary }` (pure literal).
  - `export const components = { ... }` — argument for `registerComponents` (may be `{}`).
  - `export const checks = { ... }` — argument for `registerChecks` (CHECK_DEF entries; may be `{}`).
- `system.md` — the DM system-prompt prefix (plain text) for this ruleset's voice/rules framing.

## Loader (single owner: the loader brief) — `server/ruleset.js`
`export async function loadRuleset(id, worldDir)`:
1. dynamic-`import()` `<worldDir>/ruleset/<id>/ruleset.js`.
2. `registerComponents(mod.components || {})` and `registerChecks(mod.checks || {})`.
3. read `<worldDir>/ruleset/<id>/system.md` (utf8; '' if missing).
4. return `{ meta: mod.meta, systemPrompt: <system.md text>, components: mod.components, checks: mod.checks }`.
Throw a clear error if the bundle dir/`ruleset.js` is missing. (Boot wiring in index.js + the DM-prompt sourcing
is done by Claude — your loader just needs to load+register+return.)

## srd5e bundle (loader brief) — `world/ruleset/srd5e/`
Formalizes the CURRENT 5e behavior as data: `meta` (id 'srd5e', dice 'd20'); `checks` may re-export the existing
ability-check/attack/saving-throw shape (or `{}` since they're built-in — your call, but `test-p7` must show a 5e
check resolving after load); `system.md` = a 5e DM narration prompt (you may adapt the tone of the existing
`DM_SYSTEM_PROMPT` in `server/agents/dm-agent.js`, but DO NOT edit that file). Some `components` (e.g. a `skills`
or `conditions` doc) to prove component registration.

## dsa5 bundle (DSA brief) — `world/ruleset/dsa5/`
The moat proof. `meta` (id 'dsa5', dice '3d20', summary 'Das Schwarze Auge 5 — 3d20 roll-under'). `components`:
register a DSA `attributes` component (the 8 DSA attrs MU/KL/IN/CH/FF/GE/KO/KK, doc + sensible defaults).
`checks`: add `CHECK_DEFS['dsa-skill']`:
- `dice: { count: 3, sides: 20 }`, `comparator: 'le'`, `modSource: () => 0` (unused).
- `resolve(rolls, _mod, _dc, _def, ctx)` implementing the DSA5 skill check:
  - ctx provides `attrs: [a1,a2,a3]` (the 3 governing attribute values), `fw` (Fertigkeitswert / skill points),
    and optional `mod` (positive = easier; negative = harder).
  - For each die i: `target = attrs[i] + (mod||0)`; `shortfall_i = max(0, rolls[i] - target)`.
  - `spent = shortfall_0 + shortfall_1 + shortfall_2`; `remaining = fw - spent`; `success = remaining >= 0`.
  - On success: `ql = clamp(ceil(remaining / 3), 1, 6)` (remaining 0 → QL 1). On failure: `ql = 0`.
  - Criticals: `ones = count(roll===1)`, `twenties = count(roll===20)`. `crit = ones >= 2` (auto-success),
    `fumble = twenties >= 2` (auto-fail). When crit → success true; when fumble → success false, ql 0.
  - Return `{ rolls, success, ql, crit, fumble, spent, remaining, dc: undefined, total: undefined,
    summary: '3d20(a,b,c) vs [attrs] FW fw → SUCCESS QLn | FAILURE', outcome: 'SUCCESS QLn'|'FAILURE' }`.
- `system.md` = a DSA5-flavored DM prompt (roll-under, Qualitätsstufen, German dark-fantasy tone).

## Acceptance
- `tools/test-p7.mjs` (loader brief): after `loadRuleset('srd5e', <world>)`, a 5e check resolves
  (`resolveCheck({check:'ability-check',ability:'wis',dc:12}, {stats:{wis:14},proficiency:2}, rng)` returns a
  well-formed result) and the returned `systemPrompt` is non-empty. Registration is visible.
- `tools/test-dsa.mjs` (DSA brief): after registering the dsa5 checks, `resolveCheck({check:'dsa-skill',
  attrs:[14,13,12], fw:6, mod:0}, {}, makeRng(<seed>))` is well-formed; a high-FW easy check succeeds with QL≥1,
  a fw:0 check against low attrs fails; `crit`/`fumble` fire on ≥2 ones / ≥2 twenties (you may unit-test the
  resolve() directly with crafted rolls if easier than seed-fishing).
- All existing tests + smokes still pass.
