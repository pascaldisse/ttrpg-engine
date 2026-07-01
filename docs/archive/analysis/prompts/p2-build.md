# Build task: P2 — state, senses, memory, and the AGENT MODEL (DM director + independent NPC agents)

Working dir `/Users/pascaldisse/projects/ttrpg` (the repo; P0+P1 are built + verified here). Build **Phase 2**.

## READ FIRST
- `PROTOTYPE-SPEC.md` (§5 entities/schema, §7 turn engine, §8 senses/memory, §9 everything-is-a-client) — authoritative.
- Existing code you will extend: `shared/schema.js`, `shared/context.js`, `shared/ops.js`, `server/session.js`,
  `server/index.js`, `server/turn.js`, `server/llm.js`, `client/kernel/view.js`, `world/scenes/tavern.json`.
- `analysis/deepseek-integration-notes.md` for caching (stable per-agent prefix FIRST, scene+input LAST).

## Philosophy (unchanged)
Plain JS, no React/TS/JSX/build. `shared/` pure. Server-authoritative; thin reconciler client. Small stable kernel;
domain content is data/plugins. Provider swappable behind `LlmClient` (never hardcode DeepSeek in the engine).
SECURITY: API key only from `process.env`, never logged/written/sent to client. Do NOT modify docs (`*.md`, `analysis/`).

## THE BIG IDEA (the heart of P2)
**NPCs are independent agent-clients — the DM does NOT speak for them.** Each NPC is its own agent with its own
system prompt, scoped private knowledge, and own memory; it emits `event:dialogue` in its own voice. The **DM is a
director/referee/world-voice**: it narrates the environment, and it **routes** player input to the right NPC (and may
inject a director-note into that NPC's context). This is "everything is a client" fully realized.

**Routing rule (implement exactly):**
- If the player text addresses `@name` and a present NPC matches → route to that NPC. **No LLM call.**
- Else if exactly ONE agent-NPC is present in the scene → route to it. **No LLM call.**
- Else if ZERO agent-NPCs present → the DM narrates the world's response (no NPC dialogue).
- Else (2+ present, no @mention) → the DM does an LLM **routing** call returning `{targets:[npcId], note?}`.

**Scope discipline:** prove the model with **ONE NPC (Marta the barkeep)** responding in her own voice with her own
scoped knowledge while the DM narrates environment. Build the multi-NPC seam (routing handles N) but do NOT implement
multi-responder turn-taking or NPC-to-NPC chatter yet. Adjudication/dice/checks are deferred to P5. Do NOT add heavy
LLM memory-summarization — the look frame IS the living summary (regenerated from state), plus a per-agent rolling
window from the journal.

## Files to build / change

### shared/schema.js — new components (via the existing pattern; keep `registerComponents` seam)
- `knowledge`: `{ doc:'Private scoped knowledge for an NPC agent — ONLY this enters the NPC's context. The DM may
  add to it.', default:{ facts:[], secrets:[] }, fields:{ facts:{doc:'Public-ish things this NPC knows.'},
  secrets:{doc:'Things this NPC knows but guards.'} } }`.
- `agent`: `{ doc:'Marks an entity as an autonomous agent-client (NPC). Extension seam for model/voice overrides.',
  default:{ enabled:true }, fields:{ enabled:{doc:'Is this entity an active agent?'}, model:{doc:'Optional LlmClient
  model override.'}, systemPrompt:{doc:'Optional explicit system prompt; else derived from persona.'},
  accent:{doc:'UI accent color (hex) for this NPC\\'s dialogue chip.'} } }`.

### server/sense.js — the sense API (also served over HTTP)
- `look(session)` → text scene frame (the living summary): current location (identity.kind==='location') + its
  description, present NPCs (name + one-line persona), party/pc stats if any, active quest, flags of note. Compact,
  high-salience. PURE-ish (reads session.entities).
- `describe(session, id)` → one-line entity summary.
- `query(session, {has, kind, at})` → array of matching entities `{id, components}`.
- `check(session)` → consistency lint (basic for P2): entities whose `place.locationId` points to a missing entity;
  NPCs marked dead (`status.alive===false`) still referenced as present; duplicate ids. Return a list of findings.
- `presentAgents(session)` → the agent-NPCs in the current scene (identity.kind==='npc' && agent.enabled), used by routing.
- Serve over HTTP in `server/index.js`: `GET /sense/look`, `/sense/describe?id=`, `/sense/query?has=&kind=`, `/sense/check`.

### shared/context.js — per-agent context builders (PURE, cache-ordered)
- `buildNpcContext({ npc, knowledge, look, npcMemory, playerText, directorNote })` → messages:
  1. system: the NPC's stable prefix — derived system prompt (name + persona + voice + "You are {name}. Speak ONLY
     as yourself, first person, in-character. You know ONLY what follows; never invent or reveal knowledge you don't
     have.") + the `knowledge` block. **Byte-stable per NPC → cache hit.**
  2. `npcMemory` (this NPC's recent witnessed beats) as history messages.
  3. system: the shared `look` frame (current scene).
  4. (optional) system: a director-note from the DM, clearly marked as out-of-character stage direction.
  5. user: the player's words addressed to the NPC.
- `buildDmNarrationContext({ systemPrompt, look, history, action })` (reuse/rename existing buildContext logic) — DM
  world-voice narration.
- `buildDmRoutingContext({ presentNpcs, history, action })` — for the LLM routing call: lists present NPCs (id + name
  + one-line persona) and asks for JSON `{targets:[id], note?}`.
- `recentHistory(journal, n)` already exists — extend so it includes both `narration` and `dialogue` done-events
  (mapped to assistant turns, dialogue prefixed with speaker name) and `action` (user turns).
- `npcMemoryFor(journal, npcId, n)` — the beats this NPC witnessed (for P2: all narration/dialogue/action in the
  current scene; refine scoping later). Returns history messages.

### server/agents/ — the agents
- `server/agents/stream-beat.js` — shared helper `streamBeat({ llm, messages, eventName, baseData, broadcast,
  applyAndBroadcast, role })`: streams `llm.stream(messages,{role})` deltas as `{op:'event', name:eventName,
  data:{...baseData, streamId, delta}}` (live broadcast, not journaled); on completion strips stray fenced JSON,
  commits a final `{...baseData, streamId, text, done:true}` via `applyAndBroadcast`; returns the full text. (This is
  the generalized version of P1's narration streaming — refactor P1's logic into here.)
- `server/agents/dm-agent.js` — `createDmAgent({ session, broadcast, applyAndBroadcast, llm })`:
  - `narrate(action)` — DM world-voice; uses `buildDmNarrationContext`; `streamBeat({eventName:'narration',
    baseData:{by:'dm'}, role:'dm'})`. (Reuse P1's 5e SYSTEM_PROMPT, kept here as the DM's prompt.)
  - `route(action, presentNpcs)` — LLM routing (only called for the 2+-NPC ambiguous case); uses
    `buildDmRoutingContext`; `llm.structured(...)` → `{targets, note}` (Zod). On failure default to the first present NPC.
- `server/agents/npc-agent.js` — `createNpcAgent({ session, broadcast, applyAndBroadcast, llm })`:
  - `respond(npcId, playerText, directorNote)` — gather the NPC's `persona`/`knowledge`/`identity`, build
    `buildNpcContext`, `streamBeat({eventName:'dialogue', baseData:{speaker:npcId, name:<identity.name>,
    accent:<agent.accent>}, role:'npc'})`. Returns the line. (Proposed state changes are deferred to P5 — P2 NPCs
    just talk.)

### server/turn.js — refactor into the orchestrator
- Replace the single P1 turn body with: on `action`:
  1. `presentNpcs = sense.presentAgents(session)`.
  2. `route = resolveRoute(action.text, presentNpcs)` implementing the rule above (the `@name` + single-NPC paths are
     pure, no LLM; the ambiguous path calls `dmAgent.route`).
  3. If `route.targets` empty → `await dmAgent.narrate(action)`.
     Else → `await npcAgent.respond(route.targets[0], action.text, route.note)` (P2: respond with the first target only).
  4. Wrap in try/catch with a graceful fallback narration (as P1 did).
- Keep the existing `triggerTurns` fire-and-forget wiring in `index.js` (instantiate DmAgent + NpcAgent + sense and
  pass them into the turn engine).
- `@name` parsing: case-insensitive match of `@token` against present NPC `identity.name` (startsWith/word match).

### client/kernel/view.js — the 4-lane transcript
- Generalize streaming accumulation to ANY event with a `streamId` (deltas append, `done:true` finalizes to `text`).
- Render lanes distinctly:
  - `event:narration` (`by:'dm'`) → **DM narration** lane: full-width prose, muted-gold "narrator" styling, no chip.
  - `event:dialogue` → **NPC dialogue** lane: a speaker chip (`name`) tinted with `accent` (fallback color), a
    portrait slot (empty box for now — P4 fills it), quote/bubble styling.
  - `event:system` → **system** lane: compact, muted, centered (used later; render if present).
  - `action` op (already broadcast) → **player** lane: right-aligned "You: <text>" styling.
- Keep the entity list/inspector reconcile intact. Auto-scroll.

### world/scenes/tavern.json — give it an agent NPC
- Update the barkeep entity (or add `npc-marta`) with: `identity{name:'Marta', kind:'npc', description}`,
  `persona{personality, backstory, voice}`, `knowledge{facts:[...e.g. the Siren's Kiss docked with sealed cargo...],
  secrets:[...something she guards...]}`, `agent{enabled:true, accent:'#c9a227'}`, `place{locationId:'<the tavern
  location id>'}`. Keep it the ONLY agent-NPC present in the starting scene (so single-NPC auto-route triggers).
  Ensure the location entity exists with identity.kind==='location'.

### package.json / scripts — unchanged (no new deps expected). If you add one, justify it.

## Acceptance criteria — verify with the MOCK provider (no key)
Extend `MockLlmClient` so it branches on `opts.role`: `role:'dm'` → narration canned text; `role:'npc'` → a short
in-character quoted line echoing the input; `structured` (routing) → returns `{targets:[<first present npc>], note:''}`.
Run with `LLM_PROVIDER=mock` and a throwaway WS client (delete it after); confirm:
1. Server starts; `GET /sense/look` returns a scene frame naming Marta; `GET /sense/check` returns `[]` for the clean
   sample world.
2. Player action `@Marta hello there` → routes to Marta with **no routing LLM call** → an `event:dialogue` stream with
   `speaker:'npc-marta'`, `name:'Marta'`, `accent` set → final `done` with full text. (Dialogue lane, not narration.)
3. Player action with NO @mention while Marta is the only NPC present → still routes to Marta (single-NPC auto-route).
4. A world-directed action in a scene with ZERO agent-NPCs (temporarily despawn/❮move❯ Marta, or test a no-NPC scene)
   → DM `event:narration` (narration lane). [If easier, simulate by querying routing with empty presentNpcs.]
5. The journal records dialogue/narration done-events with full payload; deltas are live-only (not journaled).
6. P0 + P1 still pass: spawn/set live reconcile, `/schema`, `/events`, restart-persist, and the action→turn path.
7. No key logged; mock needs no key.
Do NOT spend real API calls — a human runs the real DeepSeek smoke test.

## Return
Compact report: files added/changed, how each acceptance criterion was verified (with actual command output), the
NPC system-prompt derivation you used, the exact routing logic, and any deviations + why. Do NOT paste full files or
the API key.
