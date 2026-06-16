# Pi task: P6 quest + XP world data

FIRST read `analysis/prompts/p6-contracts.md`, then read `world/scenes/tavern.json` to match the exact
entity/component shapes and tone (locations, NPCs, items, the `pc-hero` stat block, the existing enemies
`npc-smuggler`/`npc-thug` at `loc-docks`).

## Goal
Add ONE playable quest that threads through the existing world (exploration → combat → loot), plus the XP
values that make progression fire. Edit ONLY `world/scenes/tavern.json`.

## Do exactly this
1. Add a quest entity `quest-siren`:
   - `identity`: name "The Siren's Kiss", kind "quest", a one-line description.
   - `quest`: `phase:"active"`, `currentStep:0`, and a 3-step machine whose triggers reference REAL entities so
     it actually advances during normal play:
     - step 0 text ≈ "Go down to the docks and find the smuggler's sloop." — trigger `{type:"atLocation", id:"loc-docks"}`
     - step 1 text ≈ "Deal with the smugglers guarding the lashed cargo." — trigger `{type:"allDead", ids:["npc-smuggler","npc-thug"]}`
     - step 2 text ≈ "Take what they were hiding." — trigger `{type:"hasItem", id:"item-crate"}`
     `steps` is the 3 strings; `triggers` is the 3 trigger objects (index-aligned); `rewards`:
     `{ xp: 250, items: [{ id:"item-signet", name:"Smuggler's Signet Ring" }] }`.
   - (The reward item has no world entity — it's granted by giveItem on completion. That's fine.)
2. Add `"xp": 0` to `pc-hero.stats` (so the PC has an xp pool to grow).
3. Add a kill-reward `"xp"` to each enemy's `stats`: `npc-smuggler` → `"xp": 50`, `npc-thug` → `"xp": 25`.
   (Completing the quest = 250 xp; the two kills = 75 xp; total 325 ≥ 300 → the PC reaches level 2.)
4. Keep the file valid JSON; keep every existing entity intact.

## Verify before returning
`node -e "JSON.parse(require('fs').readFileSync('world/scenes/tavern.json','utf8')); console.log('valid')"`
and `node tools/test-p4.mjs` (must still pass — it loads this world).

## Return (compact)
- The quest's 3 steps + their triggers, and the rewards.
- Confirmation pc-hero has xp:0 and the enemies have xp values.
- The two PASS confirmations.
