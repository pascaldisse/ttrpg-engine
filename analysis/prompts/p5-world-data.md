# Pi task: P5 combat encounter — world data

FIRST read `analysis/prompts/p5-contracts.md`, then read `world/scenes/tavern.json` to match the
exact entity/component shape and tone already used (locations, NPCs with persona/knowledge, items
with place.locationId, the `pc-hero` 5e stat block).

## Goal
Add a small, balanced level-1 hostile encounter at the docks (`loc-docks`) so combat has something
to fight, WITHOUT breaking the existing world.

## Do exactly this — edit ONLY `world/scenes/tavern.json`
1. Add two hostile NPC entities placed at `loc-docks`:
   - `npc-smuggler` — a Siren's-Kiss smuggler guarding the lashed cargo crate. Tougher leader.
   - `npc-thug` — a hired dockside thug. Weaker.
   For EACH: `identity` (name/kind:"npc"/description), a 5e `stats` block INCLUDING `ac` and `hp/maxHp`
   (level-1 appropriate: ac ~12–13, hp ~7–11, modest str/dex), `status:{alive:true,conditions:[]}`,
   `place:{locationId:"loc-docks",connections:[]}`, and `flags:{hostile:true}`. Give each a weapon via
   `flags.damage` (e.g. `"1d6"` smuggler, `"1d4"` thug) OR an inventory weapon item — pick one and be
   consistent. These are enemies, NOT chat agents: do NOT give them `agent.enabled` and keep
   `persona`/`knowledge` minimal (a one-line personality is fine; no secrets needed).
2. Keep the file valid JSON and keep every existing entity intact (Jonas, Liesl, Marta, items, locations,
   pc-hero, world-state). Do not change connections except: it is fine to leave the docks graph as-is.
3. Balance note in your summary: confirm pc-hero (hp 20, ac — it currently has NO ac; ADD `"ac": 13`
   to `pc-hero.stats` so the PC can be attacked) can plausibly win this 2-enemy fight at level 1.

## Constraints
- ONLY modify `world/scenes/tavern.json`. Touch nothing else.
- Enemies must have `flags.hostile: true` and an `ac` + `hp/maxHp`.

## Verify before returning
Run: `node -e "JSON.parse(require('fs').readFileSync('world/scenes/tavern.json','utf8')); console.log('valid JSON')"`
and `node tools/test-p4.mjs` (must still pass — it loads this world).

## Return (compact)
- The new entity ids + their ac/hp/damage in a 2-row table.
- Confirmation pc-hero.stats now has `ac`.
- The two PASS confirmations.
