# Combat Overhaul — "Living Timeline" — Implementation Spec (C1–C5)

> **This is a self-contained handoff.** You are a fresh agent implementing a 5-phase combat
> overhaul for this AI-TTRPG engine. Read this whole document, then read the files in
> **§1.3 Read-first**, then implement phases **C1 → C5 in order**, committing at each
> Definition-of-Done. Do not skip the invariants in **§2** — they are why the engine is valuable.

---

## 0. The vision

Replace the current flat "press attack → it attacks back → repeat" loop with **Living Timeline
combat**:

> A Final Fantasy X conditional-turn-based queue where **every combatant — including each enemy —
> is an individual agent** you can fight, exploit, *or talk to*; **statuses that bite** (stun/bleed/
> haste/armor-break tick and modify rolls); **abstract zones & improvised hazards** (BG3-style, but
> the LLM adjudicates *any* off-menu action — "kick the brazier into the oil"); and a **party of
> seats** that can be humans or LLMs interchangeably (multiplayer-ready). **Deterministic math
> underneath; the LLM is invoked only for the interesting moments** (improvised actions, enemy
> social/morale beats).

This is novel: FFX and BG3 *script* their cool moments; here enemies have minds and the board is
open-ended, on a rules-agnostic core.

### Phase map

| Phase | Adds | Kills (the lameness) | LLM in loop? |
|---|---|---|---|
| **C1** | Moves + targeting + **status-effect engine** | "one verb, decorative Moves" | none |
| **C2** | **CTB timeline** + visible turn bar | flat ping-pong, no momentum | none |
| **C3** | **Enemies as agents**: talk / intimidate / morale / improvised actions | dumb enemies, no drama | improv-only |
| **C4** | **Zones & improvised surfaces/hazards** | no battlefield, no positioning | improv-only |
| **C5** | **Party seats** (multiplayer or LLM allies), overdrive meters, summons | solo hero, no FFX party feel | per-seat |

Each phase is independently shippable and leaves the game in a working, tested state.

---

## 1. Orientation

### 1.1 What this engine is
- Node ESM server + Vite plain-JS client + WebSocket. **No build step, no TypeScript, no React, no framework.** Keep it that way.
- **Entity-component store:** `session.entities` is a `Map<id, { componentName: value }>`. Components are declared in `shared/schema.js` (`SCHEMA`).
- **Op protocol + journal:** all state changes are *ops* applied via `shared/ops.js` `applyOp`. Semantic ops (`damage`/`heal`/`take`/`move`/`setFlag`/…) are expanded to canonical `set`/`merge` ops by `shared/effects.js` `expandOp`. The server broadcasts ops to clients (seat-redacted); clients reconcile. Never invent a side-channel — **everything is an op or an `event`.**
- **Rules-as-data:** a *ruleset bundle* (`<world>/ruleset/<id>/ruleset.js` + `system.md`) exports `meta`, `components`, `checks`, `combat`, (and after C1) `statuses`. The core names no ruleset. 5e (`world/ruleset/srd5e`), DSA5 (`world/ruleset/dsa5`), and Necrotopia (`campaigns/necrotopia/ruleset/necrotopia`) all run on one engine.
- **Everything is a client:** DM, NPCs, players are all `presence`/`agent` seats with a `controller` (`'ai'` or a `clientId`). "Produce a beat for seat X" goes through a responder indirection so LLM-now / human-later emit identical ops. See `DESIGN-NOTES.md` #1 and #2. **C5 is the first real use of this for the party; the timeline IS the general `floor` from DESIGN-NOTES #2.**
- **Deterministic dice:** `session.rng()` returns a fresh seeded RNG (`makeRng(seed + rollCount)`) and bumps `rollCount`, so sessions are reproducible. **The engine rolls dice — the LLM NEVER supplies dice values.**

### 1.2 Current combat (what you're replacing)
- `shared/combat.js` (PURE): `rollInitiative`, `buildEncounter(params, entities, rng, rules)`, `currentCombatant`, `resolveAttack(params, entities, rng, rules)`, `advanceTurn`, `outcome`. A **ruleset combat seam** already exists: `rules.resolveAttack` replaces attack math; `rules.initiativeMode:'fixed'` skips the initiative roll (declared order). **Reuse and extend this seam — do not fork it.**
- `server/combat.js`: `createCombatEngine({session, broadcast, applyAndBroadcast, awardXp, rules})` → `{inCombat, detectInitiation, startAndResolve, handlePlayerAction}`. Drives the floor: enemy turns auto-resolve (`runUntilPlayerTurn`), the player's turn pauses for the next action op. Emits combat banners as `event:system {kind:'combat', phase}` and roll lines as `event:system {kind:'roll'}`. `endEncounter` handles victory/defeat/flee + `awardXp`. Neutral `FLAVOR` lines are overridable via `rules.flavor`.
- `server/turn.js` `createTurnEngine`: routes a player `{op:'action', text, by}`. Combat hooks are steps **2.6** (`combat.inCombat()` → `combat.handlePlayerAction`) and **2.7** (`combat.detectInitiation` → `combat.startAndResolve`). These deterministic fast-paths run BEFORE the LLM adjudication path and are never gated by the DM pause.
- The `encounter` component (singleton entity id `encounter`): `{active, round, order, turnIndex, mode:'initiative'|'free'|'round-robin', enemies, allies}`.
- The combat detection is regex-based (`ATTACK_RE`/`FLEE_RE` in `server/combat.js`).

### 1.3 Read-first (in this order, before writing code)
1. `shared/schema.js` — component model + `registerComponents`.
2. `shared/checks.js` — `CHECK_DEFS`, `registerChecks`, `resolveCheck`, `abilityMod`. **Your status/move math reuses this.**
3. `shared/combat.js` — the combat seam you extend.
4. `server/combat.js` — the orchestrator you rewrite into a timeline loop.
5. `server/turn.js` — combat hooks (2.6/2.7) + the DM pause gate + `executeRuling`.
6. `shared/effects.js` + `shared/ops.js` — semantic ops + expansion + validation (you'll add ops).
7. `server/agents/{dm-agent,npc-agent,stream-beat}.js` — adjudication, NPC responder, streaming. **C3 reuses `npcAgent.respond` and `dmAgent.adjudicate`.**
8. `campaigns/necrotopia/ruleset/necrotopia/ruleset.js` + `system.md` + `scenes/vegas.json` — the campaign you make cool.
9. `client/kernel/view.js` + `client/main.js` + `client/net.js` — the player HUD + combat HUD + action sending.
10. `tools/smoke-p5.mjs`, `tools/smoke-necrotopia.mjs`, `tools/test-p5.mjs` — the test patterns you copy.

### 1.4 How to run / verify
- Tests are plain Node scripts: `node tools/test-<x>.mjs` (PURE, fast) and `node tools/smoke-<x>.mjs` (boots the real server on the mock LLM, drives it over WS). Each prints `✅` lines and a count, exits non-zero on failure.
- Boot the campaign: `npm run play:necrotopia` (player client at `:5173`, DM at `:5173/dm.html`). Mock LLM offline if no `DEEPSEEK_API_KEY`.
- After **every** phase, the **full suite must stay green**: `test-p4 p5 p6 p7 dsa`, `smoke-p4 p5 p6 p7 necrotopia` (+ the new tests you add).

---

## 2. Invariants (do not violate)

1. **Neutral core, rules-as-data.** No combat mechanic may hardcode a specific ruleset. Every new mechanic is a **neutral framework** (engine) + **ruleset data** (bundle export). If you write `if (ruleset === 'necrotopia')` anywhere in `shared/` or `server/`, you did it wrong.
2. **The engine rolls dice; the LLM never does.** LLM may *request* a check or *describe* intent; resolution is always deterministic via `resolveCheck`/the resolvers + `session.rng()`.
3. **Deterministic core + improv-only LLM.** Normal turns (declared Move + target, enemy instinct) are pure/deterministic/testable — **zero LLM calls**. The LLM enters ONLY for: (a) a player's off-menu/improvised action, (b) an enemy social/morale beat. Everything else stays cheap and reproducible.
4. **PURE files stay pure.** `shared/*.js` import nothing from `server/` or `client/`. Ruleset bundles import nothing at all (self-contained data + functions). Same-seed-same-config ⇒ identical results.
5. **Everything is an op or an `event`.** New state lives in components and mutates via ops (add handlers to `shared/ops.js`/`shared/effects.js` as needed). Transient combat info (turn bar, roll lines) is broadcast as `event:system` with a `kind`.
6. **No build step / no new heavy deps.** Plain ESM. The client is a hand-rolled reconciler; render new UI in `client/kernel/view.js` following the existing combat-HUD pattern.
7. **Don't regress 5e/DSA.** Timeline/zones/statuses are **opt-in per ruleset**. With no `combat`/`statuses` exports, a ruleset behaves exactly as today. Verify `smoke-p5`/`smoke-p7` after each phase.
8. **Seat-agnostic beats (C5).** An ally's action must emit the same ops whether a human or an LLM produced it. Route through the responder indirection; never special-case "is this a human."
9. **Test every phase** with one PURE `tools/test-combat-c<N>.mjs` + one live `tools/smoke-combat-c<N>.mjs`, mirroring existing harness style. Use `TTRPG_SEED` for reproducibility; PROBE seeds when you need a specific fight outcome (see `smoke-p6.mjs`).
10. **Update docs.** Each phase updates `README.md` (player-facing) and appends a progress line to the memory project file is NOT your job, but DO keep `PROTOTYPE-SPEC.md` §combat and this file's "status" checkboxes current.

---

## 3. Shared data-model additions (the whole overhaul)

Add these to `shared/schema.js` via the SCHEMA object (the engine, validation, `/schema`, and the inspector pick them up automatically). All are **neutral**; rulesets fill the values.

```jsonc
// statuses — the mechanical status-effect engine (C1). DISTINCT from the existing
// `status` {alive, conditions[]} component, which stays for narrative life/flags.
statuses: {
  default: { list: [] },
  // list: [{ kind, magnitude?, remaining, source? }]
  //   kind      — a status id defined by the ruleset's STATUS_DEFS (e.g. "bleed","stun","rage")
  //   magnitude — strength (dmg/turn, +dmg, +armor, speed mult ×10, …); semantics per def
  //   remaining — timeline ticks (C2) or turns (C1) left; decremented on tick; 0 ⇒ expire
  //   source    — entity id that applied it (for attribution/UI)
}

// timeline fields — added to the `encounter` component (C2). Back-compat: when
// mode !== 'timeline', the old order/turnIndex fields drive the loop unchanged.
encounter: {
  // ...existing active/round/mode/enemies/allies...
  // mode gains a new value: 'timeline'
  participants: [ /* { id, time, speed, summonTurns? } */ ],  // time = accumulated CTB cost
  turnOf: null,                                               // id whose turn it is now
  queue: [ /* ids */ ],                                       // projected upcoming order (turn bar)
}

// position — abstract combat zone of a combatant (C4). Absent ⇒ single implicit zone "field".
position: { default: { zoneId: 'field' } }   // fields: { zoneId }

// combatZones / hazards live on the encounter singleton (C4):
encounter.zones:   [ /* { id, label, tags? } */ ],          // e.g. {id:'altar',label:'The Altar',tags:['raised']}
encounter.hazards: [ /* { zoneId, kind, magnitude, remaining } */ ],  // surfaces (fire/oil/…) as statuses-on-a-zone

// meter — resource meters (C5): overdrive, spell points, cooldowns. Neutral container.
meter: { default: {}, /* open map: { overdrive?:0..100, ... } */ }
```

### 3.1 Status-definition registry — `shared/statuses.js` (NEW, PURE)

Mirror `shared/checks.js`. This is the neutral engine; rulesets register defs.

```js
// STATUS_DEFS[kind] = {
//   doc, tag: 'buff'|'debuff'|'dot'|'control',
//   skipTurn?:   boolean,                 // 'stun': actor's turn is skipped while active
//   onTick?(target, status, rng) -> { ops?:Op[], expire?:boolean },   // 'bleed': deal magnitude dmg
//   modifyOutgoing?(ctx) -> { dmgDelta?, hitDelta?, advantage? },     // 'rage' +dmg (on attacker)
//   modifyIncoming?(ctx) -> { armorDelta?, dmgTakenDelta? },          // 'armor-break' -armor (on target)
//   modifySpeed?(speed) -> number,        // 'haste' ×2, 'slow' ×0.5 (C2 timeline)
// }
export const STATUS_DEFS = { /* engine ships an EMPTY default; all defs come from rulesets */ };
export function registerStatuses(defs) { /* deep-merge, like registerChecks */ }
export function applyStatus(entities, targetId, { kind, magnitude, remaining, source }) { /* -> Op[] (merge statuses.list) */ }
export function tickStatuses(entities, combatantId, rng) { /* -> { ops:Op[], skip:boolean } : run onTick, decrement remaining, drop expired */ }
export function aggregateModifiers(entities, attackerId, targetId) {
  /* -> { dmgDelta, hitDelta, armorDelta, advantage } : sum modifyOutgoing(attacker)+modifyIncoming(target). Resolvers call this. */
}
export function speedMultiplier(entities, combatantId) { /* product of modifySpeed over active statuses (C2) */ }
```

Wire it in `server/ruleset.js` `loadRuleset`: after `registerChecks`, call `registerStatuses(mod.statuses || {})` and include `statuses` in the returned object. (It registers globally like checks/components — no need to thread it elsewhere.)

### 3.2 Extended ruleset `combat` export (target shape after C5)

```js
export const combat = {
  initiativeMode: 'timeline',            // 'timeline' (C2) | 'fixed' | undefined→5e initiative
  speedOf(entity) { return 1 },          // C2: base CTB speed (Necrotopia: flat 1)
  moveCost(move) { return move.cost ?? 1 }, // C2: action cost (rank) of a Move
  resolveAttack(params, entities, rng) { … },   // existing: basic weapon attack (fallback)
  resolveMove(move, params, entities, rng) { … },// C1: resolve a chosen Move → {rollLine?, ops, statusOps, summary}
  enemyInstinct(actorId, encounter, entities, rng) { return { move, targetId } }, // C3 default AI
  moraleThreshold: 0.34,                 // C3: hp/maxHp below which an enemy may break/parley
  weaknesses: { /* tag -> multiplier */ },// C3/C4 optional (FFX weakness table)
  overdrive: { fillOnDealt: 1, fillOnTaken: 2, full: 100 }, // C5 optional
  flavor: { begin, victory, defeat, flee }, // existing
};
```

Only the keys a ruleset needs; all optional, all defaulted by the engine.

---

## 4. Phase C1 — Moves + targeting + status engine (no LLM)

**Goal:** every turn is a real choice. The PC's Moves do mechanically distinct things; statuses tick and bite.

### 4.1 Scope
- **In:** the status engine (`shared/statuses.js`); a neutral **Move declaration + resolution** path; Necrotopia `resolveMove` + `STATUS_DEFS`; client move-menu + target picker + status chips; turns consume the declared Move.
- **Out:** timeline (still round-robin/fixed for now), zones, talking to enemies, party. Enemies still use the simple deterministic attack.

### 4.2 Combat action op (client → server)
Extend the player action op with optional structured fields (back-compat: text-only still works):
```jsonc
{ op:'action', by:'player', text:"I cut it down with my katana",
  move:"Katana Sword Slash",   // optional: exact Move name from the actor's `moves.list`
  target:"npc-imp-2" }         // optional: target entity id
```
- `client/kernel/view.js` combat HUD: when `inCombat`, render the PC's `moves.list` as buttons and the living enemies as a target list; clicking a Move then a target (or Move→auto-target if one enemy) calls `view.onAction` with `{text, move, target}`. `client/net.js` `sendAction` must forward `move`/`target`.
- `server/index.js` already dispatches `{op:'action'}` to `turnEngine.runTurn` — pass the whole op (it carries `move`/`target`).

### 4.3 Resolution (server)
- `server/combat.js` `handlePlayerAction(actionOp)`:
  1. If `actionOp.move` is set and names a Move on the actor's `moves.list` → resolve via `combatRules.resolveMove(move, {actorId, targetId}, entities, rng)`. Else fall back to the current `resolveAttack` path (text/ATTACK_RE) so nothing breaks.
  2. Apply the returned `ops` (damage/heal/etc., via `applyAndBroadcast` after `expandOp`) and `statusOps` (from `applyStatus`).
  3. Broadcast a roll line `event:system {kind:'roll', text: result.summary, detail}` and, for each status applied/expired, `event:system {kind:'status', text, detail:{target, kind, remaining}}`.
- **Status ticks:** at the START of each combatant's turn, call `tickStatuses(entities, combatantId, rng)`; apply its `ops` (e.g. bleed damage), broadcast status lines, and if `skip` is true, **skip that combatant's action** (stun) and advance. Wire this into `runUntilPlayerTurn` (enemy turns) and into the player-turn entry (a stunned player loses their turn).
- **Modifiers:** `resolveMove`/`resolveAttack` must call `aggregateModifiers(entities, attackerId, targetId)` and apply `dmgDelta`/`hitDelta`/`armorDelta`/`advantage` so rage/armor-break actually change the math.

### 4.4 Necrotopia content (`ruleset.js`)
- `export const statuses = { … }` registering the Move-table effects with teeth:
  - `bleed`: `{tag:'dot', onTick:(t,s)=> ({ ops:[{op:'damage', id:t.id, amount:s.magnitude}] }) }` (Smoke Poison/Fang Bite: magnitude 1–3, remaining 2).
  - `stun`: `{tag:'control', skipTurn:true}` (Rear-Naked Choke / Hypnosis-Sleep: remaining ≤3, +1/level).
  - `rage`: `{tag:'buff', modifyOutgoing:()=>({dmgDelta:+2})}` (Rage Roar, remaining 2).
  - `armor-aura`: `{tag:'buff', modifyIncoming:()=>({armorDelta:+1})}` (remaining 2).
  - `flawless-aim`: `{tag:'buff', modifyOutgoing:()=>({autoHit:true})}` (Skip Hit Rolls — resolveMove treats autoHit as guaranteed hit).
- `combat.resolveMove(move, {actorId, targetId}, entities, rng)`:
  - `type:'damage'|'area'` → hit roll (`necro-attack` d6 > Armor, honoring aggregate `hitDelta`/`autoHit`) → on hit, roll `move.damage` die + `max(0, level-1)` + `dmgDelta` → `{op:'damage'}`. `area` hits all living enemies in the actor's zone (C4; until then, all living enemies).
  - `type:'heal'` → roll `move.damage` die → `{op:'heal', id: targetId||actorId}` (cannot exceed maxHp).
  - `type:'buff'` → `applyStatus(self or party, {kind: mapped, magnitude, remaining: move.duration})`. No hit roll for self/ally buffs.
  - `type:'stun'` → hit roll first (enemy-targeting) → on hit `applyStatus(target, {kind:'stun', remaining: move.duration})`.
  - `type:'utility'` → no mechanical effect here; return `{ops:[], summary}` and let narration carry it (C3 may route utility to DM adjudication).
  - Map each `move.special`/`type` to a status `kind` via a small table in the bundle (data, not core).
- Update `scenes/vegas.json`: give `pc-hero.moves.list` real `type`/`damage`/`duration`/`cost` fields (Katana Slash type damage 1d6 cost 1; Rage Roar type buff→rage duration 2 cost 1; Chi Healing type heal 1d6 cost 1). Give imps a Move or two (Claw type damage 1d3) so C3 instinct has options; for C1 they can keep the basic attack.
- Update `system.md`: tell the Maestro that Moves now have mechanical effects and statuses tick.

### 4.5 Definition of Done (C1)
- `tools/test-combat-c1.mjs` (PURE): status apply/tick/expire; bleed deals magnitude/turn then expires; stun sets `skip`; rage adds +2 dmg via `aggregateModifiers`; armor-aura raises the hit threshold; `resolveMove` routes each type correctly; same seed ⇒ identical.
- `tools/smoke-combat-c1.mjs` (live WS on Necrotopia): start the chapel fight; `{move:'Chi Healing'}` heals; `{move:'Rage Roar'}` then a Katana Slash shows +2 damage; an imp under `bleed` loses HP on its turn; a `stun`'d imp skips. Assert the `kind:'roll'` and `kind:'status'` event lines.
- Full prior suite green. Commit: `C1: Moves with teeth + status-effect engine`.

---

## 5. Phase C2 — CTB timeline + turn bar (no LLM)

**Goal:** the FFX signature. Turn order is a visible, speed-driven queue; fast Moves act sooner; haste/slow reorder the future.

### 5.1 Neutral framework — `shared/combat.js` (or new `shared/timeline.js`, PURE)
```js
buildTimeline({allies, enemies}, entities, rules) -> encounter{ mode:'timeline', participants:[{id,time:0,speed}], turnOf, queue, … }
nextActor(encounter) -> id            // participant with min time (tie-break: speed desc, then id)
advanceTimeline(encounter, actorId, actionCost, entities, rules) -> encounter  // push actor.time += actionCost / (speed*speedMultiplier); recompute turnOf + queue
projectQueue(encounter, entities, rules, n=8) -> [ids]  // simulate forward n turns for the turn bar (no mutation)
```
- `speed = rules.speedOf(entity)` (Necrotopia flat 1); effective speed multiplied by `speedMultiplier(entities,id)` (haste/slow statuses from C1).
- `actionCost = rules.moveCost(move)` (default 1). Faster Moves (lower cost) ⇒ the actor's next turn comes up sooner.
- Dead combatants are skipped (filter by `status.alive`); summoned combatants (C5) drop off when `summonTurns` hits 0.

### 5.2 Orchestrator — `server/combat.js`
- When `combatRules.initiativeMode === 'timeline'`, build via `buildTimeline` and drive the loop off `nextActor`/`advanceTimeline` instead of `order/turnIndex/advanceTurn`. Keep the old path for `fixed`/initiative rulesets (5e/DSA untouched).
- After each action, broadcast `event:system {kind:'combat', phase:'timeline', queue: projectQueue(...), turnOf}` so the client redraws the turn bar.
- The player's turn still pauses for their action op; enemy turns auto-resolve (C1 logic). Haste/slow applied mid-fight visibly reshuffle `queue`.

### 5.3 Necrotopia content
- `combat.initiativeMode = 'timeline'`, `speedOf: () => 1`, `moveCost: (m) => m.cost ?? 1`. Add a `haste`/`slow` status def (`modifySpeed`) so the timeline visibly reorders (e.g. a future "Adrenaline" Move).

### 5.4 Client
- `client/kernel/view.js`: render the **turn bar** from the latest `phase:'timeline'` payload — a horizontal strip of upcoming actor chips (name + accent + HP pip), current actor highlighted. Mirror the existing combat-HUD render path.

### 5.5 Definition of Done (C2)
- `tools/test-combat-c2.mjs`: `nextActor` picks min-time; a cost-1 actor acts twice before a cost-3 actor acts twice; `haste` (speed ×2) moves a participant earlier in `projectQueue`; determinism.
- `tools/smoke-combat-c2.mjs`: chapel fight emits `phase:'timeline'` with a non-empty `queue`; order reflects Move costs.
- 5e/DSA smokes still pass (they never enter timeline mode). Commit: `C2: CTB timeline + turn bar`.

---

## 6. Phase C3 — Enemies as agents: talk / intimidate / morale / improv (improv-only LLM)

**Goal:** the soul. Each enemy is an agent you can fight, *talk to*, intimidate, or panic — but cheaply.

### 6.1 Enemies become agents (data)
- In `scenes/vegas.json`, give the imps `agent:{enabled:true, accent}`, `persona`, and scoped `knowledge` (e.g. "We were sent through the rift to kill everything warm"; secret: "We fear the big one that comes after us more than we fear you"). This makes them eligible for the existing `npcAgent.respond` path and info-siloing.

### 6.2 Enemy turn policy (deterministic default, LLM on trigger)
- **Default (no LLM):** on an enemy's turn, call `combatRules.enemyInstinct(actorId, encounter, entities, rng)` → `{move, targetId}`. Generic engine fallback if a ruleset omits it: target the living opponent with lowest `hp` (or exploit a `weaknesses` tag if present), use the first affordable damage Move, else basic attack. Resolve via C1 `resolveMove`. **Zero LLM.**
- **Morale trigger → LLM wakes:** after damage resolves, if an enemy's `hp/maxHp < combatRules.moraleThreshold` OR all its allies are dead, set `flags.morale='shaken'`. On its NEXT turn, instead of instinct, invoke a **combat-aware agent decision** (one LLM call via a new `npcAgent.combatDecide(actorId, encounterSummary)` that returns a structured `{intent:'fight'|'flee'|'surrender'|'parley', say?, move?, target?}`). Map the intent to ops: `flee` → remove from `encounter` + set `place` to an exit/`hostile:false`; `surrender`/`parley` → `hostile:false`, leave the encounter, optionally become a talkable NPC; `fight` → fall back to instinct.
- **Player talks to an enemy (LLM):** during combat, a `@imp …` action or text the router classifies as speech → route to that enemy's `npcAgent.respond(enemyId, text, note)` with a combat-context note (its HP, who's winning). The enemy answers in-voice; its reply may *propose* ops (it surrenders, demands a bribe, switches sides) which go through the normal canonize/adjudicate apply path. **This is the "you could even talk to them" moment.**
- **Improvised player action (LLM):** any off-menu combat text that isn't a known Move/target/flee → route to `dmAgent.adjudicate` in a **combat context** (a combat-aware system prompt variant). It returns `{checks:[…], ops:[…]}` — e.g. "I throw sand in its eyes" → a `necro-test` check → on success `applyStatus(target,{kind:'blind'…})`. The engine rolls; deterministic resolution; LLM only chose the *shape*. This is the bridge to C4 surfaces.

### 6.3 Cost discipline
- LLM is invoked **only** on: a morale-broken enemy's decision, the player addressing an enemy, or an improvised off-menu action. A normal fight of "Move → target" exchanges makes **zero** LLM calls. Keep it that way; add a counter to the smoke test asserting 0 calls on the deterministic path (mock LLM: assert no `narration`/`dialogue` events on plain Move turns).

### 6.4 Definition of Done (C3)
- `tools/test-combat-c3.mjs` (PURE): `enemyInstinct` fallback targets lowest-HP; morale flag set below threshold; intent→ops mapping (flee/surrender/fight) produces correct ops.
- `tools/smoke-combat-c3.mjs` (live, mock LLM): (a) a plain Move fight makes 0 LLM-narration calls; (b) reduce an imp below morale → its decision beat fires and it flees/surrenders (entity leaves `encounter`); (c) `@imp` a line → dialogue event in the imp's voice; (d) an improvised "throw sand in its eyes" → a check + a `blind` status applied. Commit: `C3: enemies as agents — talk, intimidate, morale, improv`.

---

## 7. Phase C4 — Zones & improvised surfaces (improv-only LLM)

**Goal:** a battlefield. Abstract positions + hazards, with infinite improvised surfaces via the C3 adjudication path.

### 7.1 Zones (abstract, no grid)
- An encounter carries `zones:[{id,label,tags}]` (authored per scene, or a single implicit `field` zone if none). Each combatant has a `position.zoneId`. A "move within combat" action sets `position.zoneId` (costs a turn or part of one — ruleset `moveCost`).
- Move `range`: `'self'|'melee'|'ranged'|'area'`. Melee requires same zone (or an adjacent-zone rule from the ruleset); ranged hits any zone; area hits a whole zone. `resolveMove` enforces range using `position`.
- Authoring: add `zones` to `scenes/vegas.json`'s chapel (e.g. `the-aisle`, `the-altar` (raised → ranged advantage), `the-doorway`, `the-balcony-edge` (tag `ledge`)). Place imps/PC/Padre in zones.

### 7.2 Hazards / surfaces (statuses on a zone)
- `encounter.hazards:[{zoneId, kind, magnitude, remaining}]`. Reuse the status engine: a hazard of `kind:'fire'` ticks damage to every combatant in its zone at turn start; `oil` is inert until ignited (improv: fire + oil → bigger fire); `electrified-water` triggers on a lightning/metal action. Hazard `kind`s are ruleset `STATUS_DEFS` with a `zoneScoped:true` flag.
- **Improvised surfaces (the differentiator):** the C3 improv-adjudication path can return an op that **creates a hazard** ("kick the brazier into the oil" → `{op:'spawnHazard', zoneId, kind:'fire', magnitude, remaining}`) or **exploits the board** ("shove it off the balcony edge" → an opposed check → on success a large `damage` / instant-kill if zone tag `ledge`). Add a `spawnHazard` semantic op to `shared/effects.js`/`shared/ops.js`.
- BG3 ships ~20 hand-built surfaces; here the surface vocabulary is open because the DM agent maps natural language → a hazard/effect, and the engine resolves it deterministically.

### 7.3 Client
- Render zones as labeled lanes in the combat HUD with combatant chips placed in them and hazard markers. A "move to <zone>" affordance. Keep it text-forward and simple (no canvas).

### 7.4 Definition of Done (C4)
- `tools/test-combat-c4.mjs`: range enforcement (melee blocked across zones); hazard tick damages only same-zone combatants; `spawnHazard` op expands/validates; ledge-shove resolves.
- `tools/smoke-combat-c4.mjs`: improvised "kick the brazier into the oil" creates a `fire` hazard that then damages imps in that zone; "shove the imp off the balcony edge" kills/▼ it. Commit: `C4: zones & improvised surfaces`.

---

## 8. Phase C5 — Party seats (multiplayer or LLM allies), overdrive, summons

**Goal:** FFX party feel + multiplayer, via "everything is a client." Allies are timeline seats driven by humans or LLMs interchangeably.

### 8.1 Seat-driven combatants
- Any ally entity with a `presence`/`agent` seat joins the timeline as a participant. On an ally's turn:
  - `controller` is a human `clientId` → broadcast a DM-only/owner-only "your turn" prompt and **pause** for that client's combat-action op (same shape as the PC's). Other clients see "waiting for <name>."
  - `controller === 'ai'` → run the ally's responder: cheap instinct by default; or the ally's agent for a smarter/in-character choice (reuse `npcAgent`, combat-aware). **Same op output either way** (invariant §2.8).
- Multiplayer: multiple human player presences each own a PC; the timeline naturally interleaves them. The currently-acting seat is `encounter.turnOf`; the server only accepts a combat-action from the client that owns that seat (validate `ws._seat`/controller).
- Solo play: your allies (e.g. Padre Salt) are `controller:'ai'` agents fighting alongside you — turns the lone-hero fight into a party fight with no UI for the player to micromanage.
- This is the general `floor` from DESIGN-NOTES #2: the timeline manages whose turn it is across all seats; "who acts" is a floor decision, not a hardcode.

### 8.2 Overdrive meters (FFX)
- `meter.overdrive` (0..100) on combatants, filled per `combat.overdrive` rules (on damage dealt/taken). At full, the actor unlocks a finisher Move (a Move flagged `requiresOverdrive:true`); using it consumes the meter. Broadcast meter changes as `event:system {kind:'meter'}`; render a fill bar in the HUD.

### 8.3 Summons (the book's templates)
- A Move `type:'summon'` spawns a temporary combatant entity (Guardian Ghost 10 HP / 3 turns / Spectral Slash 1d6; Pet 20 HP) with `participants[].summonTurns`. It takes its own timeline turns (controller `'ai'` instinct) and drops off the timeline + despawns when `summonTurns` hits 0. Reuse the seat machinery — a summon is just another AI seat with a lifetime.

### 8.4 Necrotopia content
- Make `npc-padre` a `controller:'ai'` ally combatant (give him a shotgun Move 1d6, 2 shells then he's out — a cooldown/`meter`). Add Guardian Ghost + Pet summon Moves to the move table / a PC Move. Add an overdrive finisher Move ("Apocalypse Now").

### 8.5 Definition of Done (C5)
- `tools/test-combat-c5.mjs`: timeline interleaves ≥2 ally seats; an `'ai'` ally and a (simulated) human ally emit identical op shapes; overdrive fills and gates the finisher; a summon takes turns then expires.
- `tools/smoke-combat-c5.mjs`: boot with Padre as an AI ally → he acts on his timeline turns; (simulate a second human seat over a second WS) → server only accepts that seat's action on its turn; overdrive finisher fires at full meter; summon appears in the queue for 3 turns. Commit: `C5: party seats (multiplayer/LLM allies) + overdrive + summons`.

---

## 9. Wire protocol summary (events the client/tests rely on)

All are `{op:'event', name:'system', data:{…}}` unless noted. Keep `kind`s stable.

| kind | when | key fields |
|---|---|---|
| `combat` (phase `start`/`turn`/`end`) | encounter begins/per-beat/ends | `phase`, `text`, `round`, `order`/`outcome` (existing) |
| `combat` (phase `timeline`) | after each timeline advance (C2) | `queue:[ids]`, `turnOf` |
| `roll` | any check/attack/move resolution | `text` (summary), `detail:{rolls,success,crit,…}` (existing) |
| `status` | status applied/ticked/expired (C1) | `text`, `detail:{target,kind,magnitude,remaining}` |
| `meter` | overdrive/resource change (C5) | `detail:{id,meter,value}` |
| `morale`/`parley` | enemy social beat (C3) | `text`, `detail:{id,intent}` |
| `dialogue` (name `dialogue`) | enemy/ally speaks (C3) — via existing npc path | speaker chip + accent (existing) |

New semantic ops to add (`shared/effects.js` expand + `shared/ops.js` validate): `applyStatus`/`removeStatus` (→ merge `statuses.list`), `spawnHazard`/`clearHazard` (→ merge `encounter.hazards`), and a `setMeter` (→ merge `meter`). Follow the existing `damage`/`take` expansion pattern exactly.

---

## 10. Ruleset-authoring delta (update `world/ruleset/README.md` + this engine's docs)

After this overhaul a bundle MAY export (all optional; absent ⇒ legacy behavior):
- `statuses` — `STATUS_DEFS` registered via `registerStatuses` (C1).
- `combat.resolveMove`, `combat.speedOf`, `combat.moveCost`, `combat.initiativeMode:'timeline'` (C1/C2).
- `combat.enemyInstinct`, `combat.moraleThreshold`, `combat.weaknesses` (C3).
- `combat.overdrive` (C5).
- A `moves.list` shape on combatants: `{name, type, damage?, duration?, cost?, range?, special?, requiresOverdrive?}`.

5e/DSA keep working untouched because they export none of these (and `initiativeMode` stays unset → classic initiative). Optionally, in a later pass, port 5e onto the timeline to prove neutrality a fourth way — **not required** by this spec.

---

## 11. Sequencing, testing, and PR plan

1. Implement **C1 → C5 in order**, one commit per phase (messages above), on a branch `combat-overhaul`.
2. Each phase: add the two test files, keep the **entire** suite green (`for t in test-p4 p5 p6 p7 dsa test-combat-c1..cN; do node tools/$t.mjs; done` and the smokes). A phase isn't done until its Definition-of-Done tests pass AND no prior test regressed.
3. After C2 and C5, manually play `npm run play:necrotopia` and sanity-check the turn bar + a full chapel fight.
4. Update `README.md` (combat section) and `PROTOTYPE-SPEC.md` as you go. End-state: open a PR summarizing C1–C5 with the test counts.
5. **Working model:** this engine's owner delegates token-heavy/repetitive scaffolding to detached Pi/DeepSeek subagents (the `pi` skill) and keeps the hard wiring + browser code in-agent (Pi can't verify browser/runtime gaps). PURE engine files and test files are great Pi candidates; the `server/turn.js`/`server/combat.js`/`client/*` wiring and all live-WS verification are not — do those yourself and verify by running the tests.

### Status checkboxes (update as you land each)
- [x] C1 — Moves + status engine
- [x] C2 — CTB timeline + turn bar
- [ ] C3 — enemies as agents (talk/intimidate/morale/improv)
- [ ] C4 — zones & improvised surfaces
- [ ] C5 — party seats + overdrive + summons
