# Pi task: DMView Slice 1 — per-seat visibility filter (`shared/visibility.js` + test)

Context: building a DMView. The DM seat sees EVERYTHING; player/npc/spectator seats must NOT receive
private authoring/AI content (an NPC's secret knowledge, backstory, agent internals). The server will
filter every outgoing WS message through this PURE module before sending it to a non-DM client. This
also closes a real info-leak: today players receive the full snapshot incl. every NPC's secrets.

FIRST read `shared/schema.js` (component shapes — esp. `persona`, `knowledge`, `lifelog`, `agent`),
`world/scenes/tavern.json` (real data), and skim `server/session.js` `snapshot()` + how `applyAndBroadcast`
builds `{type:'ops', ops:[...]}` and `{type:'snapshot', ...}` messages (the shapes you redact).

## Create `shared/visibility.js` (PURE — no server/client imports, no fs, no mutation of inputs)

Exports (implement EXACTLY):

```js
// Components hidden ENTIRELY from non-DM seats.
export const PRIVATE_COMPONENTS = ['persona', 'knowledge', 'lifelog'];
// For non-DM seats, the `agent` component is reduced to just these fields (accent drives the
// player's dialogue-chip colour; the rest — controller/systemPrompt/model — is internal).
export const AGENT_PUBLIC_FIELDS = ['enabled', 'accent'];

/** True if a message addressed to `audience` should reach a client in `seat`.
 *  audience ∈ 'all' | 'dm' | 'players'. seat ∈ 'dm' | 'player' | 'npc' | 'spectator'.
 *  'all' → everyone; 'dm' → only dm seats; 'players' → everyone EXCEPT dm. */
export function seatSees(audience, seat) { ... }

/** Redact one entity's components for a seat. seat 'dm' → deep clone unchanged.
 *  Non-dm → return a NEW comps object with PRIVATE_COMPONENTS removed and `agent`
 *  reduced to AGENT_PUBLIC_FIELDS (if present). Never mutates the input. */
export function redactComponentsForSeat(comps, seat) { ... }

/** Redact an outgoing WS message for a seat. seat 'dm' → return msg unchanged.
 *  Non-dm:
 *   - {type:'snapshot', entities:{id→comps}, ...} → new msg with every entity redacted.
 *   - {type:'ops', ops:[...]} → new msg with each op redacted (see below); if the redacted
 *       ops array is EMPTY, return null (nothing to send this client).
 *   - any other message (events: narration/dialogue/system, errors, etc.) → return as-is
 *       (audience-gating, not field-redaction, handles DM-only events upstream).
 *  Never mutates the input. Returns the (possibly new) message, or null to send nothing. */
export function redactForSeat(msg, seat) { ... }
```

### Op redaction rules (inside redactForSeat for {type:'ops'}), non-dm seat:
- `spawn` (`{op:'spawn', id, components}`) → keep, but `components` run through `redactComponentsForSeat`.
- `set`/`merge` (`{op, id, component, value}`):
  - if `component` ∈ PRIVATE_COMPONENTS → DROP the op (omit it).
  - if `component === 'agent'` → keep, but `value` reduced to AGENT_PUBLIC_FIELDS.
  - otherwise → keep unchanged.
- every other op kind (damage/heal/giveItem/take/drop/move/setFlag/event/action/roll/reset/despawn) →
  keep unchanged (they touch public state: stats/inventory/place/flags).

## Create `tools/test-visibility.mjs` (mirror `tools/test-p8.mjs` / `test-p7.mjs` harness style)
Assert at least:
1. `seatSees`: ('all',x)=true for any x; ('dm','dm')=true, ('dm','player')=false; ('players','player')=true,
   ('players','dm')=false.
2. snapshot redaction for `'player'`: an NPC's `persona`/`knowledge` are gone; `agent` reduced to
   {enabled,accent} (no controller/systemPrompt/model); `identity`/`place`/`stats`/`flags`/`inventory` intact.
3. snapshot for `'dm'` deep-equals the input (nothing stripped).
4. ops redaction for `'player'`: a `{op:'merge', component:'knowledge', ...}` op is dropped; an ops msg
   containing ONLY that op → `redactForSeat` returns `null`; a `set agent` op is reduced; a `damage` op
   passes through unchanged.
5. INPUT NOT MUTATED: redacting for 'player' leaves the original snapshot/ops object unchanged
   (deep-equal a pre-redaction structuredClone).
6. Build the snapshot input from real `world/scenes/tavern.json` (npc-marta has persona+knowledge+agent).

## Constraints
- ONLY create `shared/visibility.js` and `tools/test-visibility.mjs`. Touch nothing else.
- PURE module; no deps. Match existing JSDoc/2-space style.

## Verify before returning
`node --check shared/visibility.js && node tools/test-visibility.mjs` pass; also `node tools/test-p8.mjs`
(no regression — you touched no shared module it uses). Return: files, the exact assertions, pasted PASS
lines, any assumption.
