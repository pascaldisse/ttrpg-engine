# Architecture

A turn-based, JSON-native, op-protocol-driven AI TTRPG engine. Node ESM server +
vanilla-JS Vite client, WebSocket wire, DeepSeek (or any OpenAI-compatible) LLM
behind a provider seam, rules-as-data ruleset bundles.

```
client (player)  client (DMView)
      \               /
       WebSocket + HTTP        ← per-seat redaction (shared/visibility.js)
              |
        server/index.js        ← one Session, one turn chain, one art engine
        /     |      \
   turn.js  combat.js quests.js     ← orchestrators (own the live session)
      |        |         |
   agents/  shared/combat-rules.js  ← pure rules; ruleset bundle overrides
   (LLM)    shared/quest-triggers.js
              |
        shared/ops.js + effects.js  ← THE op protocol (validate → expand → apply)
              |
        server/session.js           ← entity Map + journal + saves + PRNG
```

## The op protocol

Everything that happens is an **op**. Two tiers:

- **Canonical** — `spawn` / `set` / `merge` / `despawn` mutate the entity store
  (`shared/ops.js` `handlerRegistry`). `event` / `action` / `roll` are ephemeral
  (journal + broadcast only). `reset` re-seeds from disk.
- **Semantic** — `damage` / `heal` / `take` / `drop` / `giveItem` / `applyStatus` /
  `spawnHazard` / `moveZone` / `setFlag` / … are *intents*. `shared/effects.js`
  `expandOp()` turns them into canonical ops against current state. This is the
  seam the LLM writes to — it never touches raw state.

Validation happens **at the point of application** (`server/turn.js`
`applyConsequences`, `server/combat.js` `applyOps`): a malformed op is skipped
with a warning, never allowed to nuke a whole ruling. `shared/parse.js` extracts
JSON leniently and returns the FULL object — shape questions belong to the
(deliberately permissive) Zod schemas in the agents.

## The turn pipeline (`server/turn.js`)

Actions are **serialized** through a per-session promise chain (`index.js
triggerTurns`) — two players can never interleave mid-await. Within a turn,
resolution order:

1. `@name` → that NPC responds (no LLM routing).
2. Deterministic movement fast-path (`MOVE_INTENT_RE` + exit matching).
3. Active encounter → every action is a combat action.
4. Attack on a present hostile → combat initiation (no LLM).
5. Otherwise `produceRuling` — the **DM seat indirection**: a DMView-staged human
   ruling wins, else the LLM adjudicates (`dm-agent.adjudicate`). The ruling may:
   speak for an NPC, move the party, request checks (THE ENGINE ROLLS), stage
   actor spawns (world-first), begin combat, or emit semantic ops.
6. Autopilot off → the ruling parks as a **proposal** for DM approve/reject/regen.
7. `narrateOutcome` streams prose grounded in the scene frame; `canonize`
   distills incidental state changes + grounds any actor the prose named.
8. `finally` → quest engine re-evaluates triggers (XP/level-ups are party-wide).

The **scene frame** (`shared/context.js buildLookFrame`) is location-scoped around
the ACTING PC — only what is HERE enters the prompt.

## Multiplayer

- On `hello`, a player seat binds to a PC (`shared/staging.js bindPlayerPc`):
  reclaim own (by `agent.controller`), claim the first unbound PC, or spawn a
  party member from the ruleset's `actorTemplates.player` / first-PC chassis.
- Every engine path resolves the acting PC from `actionOp.by` (`findPcFor`).
- All living PCs at the location join an encounter's ally side; a bound PC's
  combat seat only accepts its own player.
- Per-seat visibility: players never receive `persona`/`knowledge`/`lifelog` or
  agent internals (`shared/visibility.js`); the DM sees everything.

## Combat (`server/combat.js` + `shared/combat-rules.js`)

Deterministic, LLM-free in the loop. Two initiative models: classic d20 order and
a CTB **timeline** (speed-driven queue). Moves with costs/statuses/overdrive,
zones + hazards, morale (the LLM wakes only for broken-morale decisions,
`@name` mid-fight talk, and improvised off-menu actions → `adjudicateCombat`
returns a check + ops, the engine rolls).

## Rules-as-data (the moat)

A ruleset bundle (`<world>/ruleset/<id>/ruleset.js` + `system.md`) exports pure
data + optional hooks; the core names no ruleset:

- `components` — schema extensions (`registerComponents`)
- `checks` — dice + resolution (`registerChecks`) — how 5e d20-vs-DC, DSA 3d20
  roll-under, and Necrotopia d6-over-Armor run on one engine
- `defaultCheck` — `{kind, dcDoc, dcDefault}` the DM requests for generic actions
- `statuses` — status-effect behaviors (`registerStatuses`)
- `combat` — attack/Move resolution, `initiativeMode`, speeds, flavor
- `actorTemplates` — the archetypes the DM may spawn (world-first staging);
  a `player` template shapes multiplayer party members
- `system.md` — the DM narration voice

See `campaigns/necrotopia/ruleset/necrotopia/` for a complete worked example and
`docs/RULESET-AUTHORING.md` for the guide.

## LLM + art seams

- `server/llm.js` — `stream` / `complete` / `structured` interface; DeepSeek and
  a fully deterministic offline Mock. Add providers in `createLlmClient()`.
- `server/art.js` — `GET /art/<entityId>` renders an entity's `art.prompt` once,
  caches to `<world>/cache/art/`. Providers: pollinations (default, keyless),
  mock (offline SVG), openai (opt-in).

## World generation (`shared/worldgen-skeleton.js` + `server/worldgen.js`)

Two passes, sharp boundary — procgen owns **structure**, the LLM owns **meaning**:

1. **Skeleton (pure, deterministic)** — regions chained by roads (settlement →
   wilds/dungeon/landmark → boss dungeon), each internally connected with
   chords; enemy packs distributed per region; boss + prize at the lair (the far
   end of the chain); one main quest + a side quest per pack/relic, every
   trigger wired to real ids. Same seed ⇒ byte-identical world.
2. **Charge (LLM, best-effort)** — one call names all regions, then each
   location is charged with region context and already-named neighbors, then the
   quests. Any failed call falls back to deterministic placeholders — generation
   never aborts.

Output is a scene JSON in the exact shape the Session seeds from: **generated
once → fixed data**. The LLM never re-invents geometry at runtime; it reads the
world. `campaigns/lanternfall/` is a shipped 24-location example.

## The walkable world (`shared/tilegen.js` + `client/kernel/worldview.js`)

Every location carries a `tiles` component: a grid of SEMANTIC TAGS
(floor/wall/water/tree/road/…), exits wired 1:1 to `place.connections`, and
spawn points. Worlds without authored grids get deterministic ones at boot
(same location id ⇒ same map, part of the world fingerprint). The client
renders the grid through a **tileset skin** (`tileset.js`: tag → texture;
default streams AI-painted tiles from `GET /art/tile/<tag>`, offline skin is
procedural) and runs a point-click avatar: exits fire real `move` ops, NPC
clicks prefill talk, enemy clicks walk adjacent and `attack` — the classic
JRPG handoff into the unchanged turn-based combat engine. The `onStep` seam is
where random encounters hang later. Presentation only: no gameplay lives here.

## The breathing world (`shared/clock.js`) + memory (`server/memory.js`)

Every world action ticks a 4-phase day on `world-state.clock` (frozen
mid-encounter). Phase changes banner the time, walk `schedule`-component NPCs
on their rounds, and surface `flags.ambient` lines where the party stands —
deterministic; the DM stages richer beats on top. The DM reads `Time: Day N,
phase` in every scene frame.

The memory engine listens to the journal and writes durable canon into
`lifelog` components: PCs remember quest steps and battle outcomes, NPCs
remember their own words, all clock-stamped. Past a threshold an LLM folds old
entries into an ≤80-word living summary (fold-down, never silent eviction).
Lifelogs reach the prompts (DM scene frame + NPC context) and power
`GET /sense/recall?q=` keyword recall.

## Addons (`server/addons.js` + `client/kernel/addons.js`)

An addon is an out-of-tree directory with an `addon.json` manifest; the loader
merges `addons.json` (persistent install list, editable via `POST
/addons/config` from the ⚙ settings panel) with the `TTRPG_ADDONS` env var.
An addon may ship any mix of:

- **a world + ruleset** — when `TTRPG_WORLD` is unset, the first enabled
  world-shipping addon becomes the campaign (its manifest `ruleset` is the
  default). Seeds at boot, like any campaign.
- **a server hook** — `register(ctx)` runs after every engine exists, with
  `{session, applyEffects, registerRoute, dmAgent, combat, …}`. `applyEffects`
  is the expand-then-apply path (semantic ops welcome); `session.onChange` is
  the journal listener seam (the same one the memory engine uses).
- **a client plugin** — served at `/addons/<id>/…` (traversal-guarded,
  no-store) and dynamically imported by the player client; `mount()` receives
  the store/net/view plus a dedicated root element. Per-browser toggles live in
  localStorage; the ⚙ panel also drives server-side enable/disable and
  install-by-path (client + server hooks load live; worlds need a reboot).
- **DM-prompt extensions** — `systemAppend` files ride behind the ruleset's
  system.md (style guides / house rules as data).

Rulesets gained a fourth registry to match: `effects` →
`registerEffects()` in shared/effects.js — bundle-defined SEMANTIC ops (e.g. a
clamped affection meter). `validateOpBatch` accepts registered kinds (each
handler is its own validator/clamp) and `applyAndBroadcast` expands semantic
ops on every wire path, with batch expansion running against a copy-on-write
overlay so ops later in a batch see earlier effects.

## Persistence

`server/session.js`: debounced save per slot (`TTRPG_SAVE`), flushed on
SIGINT/SIGTERM. Saves carry a format version + a **world fingerprint** — a save
written against different campaign content is backed up as `.stale-<ts>` and the
world boots fresh (edited scenes are never shadowed by old state). The journal
(capped 2000) feeds `GET /events` — clients backfill the story on load.
