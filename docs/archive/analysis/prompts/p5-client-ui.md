# Pi task: P5 combat HUD (client)

FIRST read `analysis/prompts/p5-contracts.md`, then read `client/kernel/view.js` fully and
`client/index.html` to match the existing reconciler style and Tailwind classes.

## Goal
Render a combat HUD when an encounter is active, driven by the singleton `encounter` entity
(component shape in the contracts) and combatants' `stats.hp`. Reuse the existing store→view
reconciler; this is purely additive.

## Do exactly this — edit ONLY `client/kernel/view.js`
1. Add `_renderEncounterHud()` that reads `this.store.entities.get('encounter')`:
   - If its `encounter.active` is true, render into `this.sceneAreaEl` (currently shows the
     "[ scene image — P4 ]" placeholder): a compact HUD showing **Round N**, the **initiative order**
     (each combatant's display name, in order; the one at `turnIndex` highlighted; dead combatants —
     `status.alive===false` — struck through/dimmed) and each combatant's **HP `hp/maxHp`** as a small
     bar or text. Enemies (ids in `encounter.enemies`) vs allies (`encounter.allies`) should be visually
     distinguishable (e.g. red vs blue accent).
   - If not active (or no encounter entity), restore the original placeholder text so exploration looks
     unchanged.
2. Call `_renderEncounterHud()` from: `_rebuildAll()` (snapshot/reset), and in `handle()` for `set`/`merge`
   when `event.id === 'encounter'` OR when the changed entity is a combatant in the current encounter
   (so HP bars update as damage lands).
3. Add an `encounter` case to the inspector's `_renderComponent()` switch (a simple readout) for
   completeness.

## Constraints
- ONLY modify `client/kernel/view.js`. Do NOT touch index.html, main.js, or kernel/{store,net,dom}.js.
- Additive only — existing narration/dialogue/system/action lanes and entity inspector must keep working.
- **Critical syntax warning:** this is a `class` body. Methods are NOT comma-separated — do NOT put a
  comma after a method's closing `}`. (A trailing comma here previously broke the entire client.)
- Combat banner text (`event:system kind:'combat'` with a `text`) already routes to the system lane via
  the existing event handler — you do NOT need to special-case it, but make sure you don't break it.

## Verify before returning
Run `node --check client/kernel/view.js` (must be clean — no syntax errors). Re-read your diff and
confirm no stray comma after any class method.

## Return (compact)
- The methods you added/changed (names only).
- Confirmation `node --check` is clean.
- A 3-line description of what the HUD looks like when active.
