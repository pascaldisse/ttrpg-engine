# Pi task: P6 quest tracker + XP/level HUD (client)

FIRST read `analysis/prompts/p6-contracts.md`, then read `client/kernel/view.js` fully and
`client/index.html`. NOTE: a combat HUD (P5) already renders into `this.sceneAreaEl` when an encounter is
active — DO NOT fight it for that element.

## Goal
Show the player's active quest(s) and their XP/level, driven by the store→view reconciler. Purely additive.

## Do exactly this — edit ONLY `client/kernel/view.js`
1. Add `_renderQuestTracker()` that:
   - Reads quest entities (`identity.kind === 'quest'`) from `this.store.entities`. For each `active` quest,
     show its name + the CURRENT step text (`quest.steps[quest.currentStep]`) and progress `step k/n`.
     Show completed quests as done (dimmed/✓). If there are no quests, render nothing.
   - Reads the PC (`identity.kind === 'pc'`) and shows `Lv {stats.level} · XP {stats.xp}` (xp may be undefined → 0).
   - Renders into a dedicated block in the `#inspector` panel (e.g. prepend above `#entity-list`), creating a
     container element once and updating it in place. Must NOT disturb the entity list, the transcript lanes,
     or the combat HUD in `sceneAreaEl`.
2. Call `_renderQuestTracker()` from `_rebuildAll()` and from `handle()` on `set`/`merge` when the changed
   entity is a quest OR the PC (so it updates as quests advance and XP changes).
3. Quest/level-up banners (`event:system kind:'quest'|'levelup'` carrying a `text`) already route to the
   system lane via the existing event handler — don't break that; no special-casing needed.

## Constraints
- ONLY modify `client/kernel/view.js`. Additive only.
- **Critical:** this is a `class` body — methods are NOT comma-separated. Do NOT put a comma after a method's
  closing `}` (a trailing comma there previously broke the whole client).

## Verify before returning
`node --check client/kernel/view.js` (must be clean). Re-read your diff for any stray comma after a method.

## Return (compact)
- Methods added/changed (names only).
- Confirmation `node --check` is clean.
- 3-line description of what the tracker shows.
