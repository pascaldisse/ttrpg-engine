# Build task: P1 — the turn engine ("prove the loop")

Working dir `/Users/pascaldisse/projects/ttrpg` (the repo; P0 is already built here). Build **Phase 1**: wire the
LLM turn loop so a player `action` produces streamed narration + adjudicated state ops.

## READ FIRST
- `PROTOTYPE-SPEC.md` (§4 ops, §7 turn engine, §8 senses, §13 P1) — authoritative.
- `analysis/deepseek-integration-notes.md` — DeepSeek V4 Flash: SDK setup, streaming, **prompt-caching (prefix from
  token 0 → put stable content FIRST, changing content LAST)**, JSON mode (not schema-enforced → always Zod-validate),
  non-thinking mode for cheap+fast first token, two-pass (stream narration, then structured extraction). FOLLOW IT.
- Existing code: `shared/ops.js`, `shared/schema.js`, `server/session.js`, `server/index.js`, `client/kernel/*`.

## Philosophy (unchanged from P0)
Plain JS only, no React/TS/JSX/build. `shared/` stays pure (no server/client imports). Server-authoritative; client
is a thin reconciler. **Small stable kernel; LLM provider is swappable behind an interface — never hardcode DeepSeek
in the engine.** Do NOT modify the docs (`*.md`, `analysis/`). Comment extension seams.

## SECURITY (critical)
The API key lives in `.env` (gitignored), loaded via Node `--env-file`. **Read it ONLY from `process.env`. NEVER log
it, never print it, never write it into any file, never send it to the client.** The Vite client must never see keys.

## What to build

### shared/context.js (PURE)
- `buildContext({ systemPrompt, look, history, action })` → ordered chat-message array for cache hits:
  1. `{role:'system', content: systemPrompt}` — **byte-stable** across turns (no per-turn data).
  2. recent `history` mapped to alternating `{role:'user'|'assistant', content}` messages.
  3. `{role:'system', content: look}` — the current scene frame (changes per turn → placed late).
  4. `{role:'user', content: action}` — the player's action (last).
- `buildLookFrame(entities)` — PURE: from the entities object/Map, produce a compact text "scene frame": the current
  location (identity.kind==='location') + its description, NPCs/items present (identity name+kind), and any pc/party
  stats. Keep it short and high-salience (this is our living-summary stand-in for P1).
- `recentHistory(journalEntries, n=12)` — PURE: take the last n entries whose op is `action` or a narration `event`
  (name==='narration' && data.done), map action→user / narration→assistant `{role, content}`.

### shared/parse.js (PURE)
- `parseModelOutput(raw)` → `{ ok, value?, error?, raw }`. Lenient: try strict `JSON.parse`; else strip ```json fences;
  else extract first balanced `{...}`. Then validate shape `{ narration?:string, ops?:Op[], checks?:any[] }` — reuse
  `validateOpBatch` from `ops.js` for `ops`. On failure return `{ok:false, error, raw}` so the caller can fall back to
  treating `raw` as narration-only. Never throw.

### server/llm.js — the LlmClient interface + adapters + factory
- Document an `LlmClient` interface with three methods:
  - `async *stream(messages, opts)` → yields `{ delta }` text chunks.
  - `async complete(messages, opts)` → `{ text, usage }`.
  - `async structured(messages, zodSchema, opts)` → Zod-validated parsed object (JSON mode + lenient parse).
- `DeepSeekClient` — uses the `openai` SDK: `new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL:
  process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' })`, model `process.env.DEEPSEEK_MODEL ||
  'deepseek-v4-flash'`. Streaming via `stream:true`. `structured` uses `response_format:{type:'json_object'}` + the
  word "json" in the prompt. Use **non-thinking mode** per the notes. Pass an optional `user` (session id) for cache
  isolation. Handle 429/5xx with a small exponential backoff.
- `MockLlmClient` — NO network, deterministic. `stream` yields a short canned narration in ~5 chunks that echoes the
  player's last action (so streaming is visibly working). `structured` returns a deterministic, schema-valid op batch
  that exercises the apply path — e.g. `{ narration:"<same text>", ops:[{op:'merge', id:'world-state', component:'flags',
  value:{ lastAction:<action text truncated> }}], checks:[] }`. This makes P1 fully verifiable WITHOUT a key.
- `createLlmClient()` factory: select by `process.env.LLM_PROVIDER` ('mock' → MockLlmClient; default 'deepseek' →
  DeepSeekClient). **If provider is deepseek but `DEEPSEEK_API_KEY` is missing, fall back to MockLlmClient with a
  console warning** (so the server never hard-crashes without a key). `npm install openai` (add to deps).

### server/turn.js — the turn engine
- `createTurnEngine({ session, broadcast, applyAndBroadcast, llm })` → returns `{ runTurn(actionOp) }`.
- `runTurn(actionOp)`:
  1. Build `look = buildLookFrame(session.entities)`, `history = recentHistory(session.journal)`, and a fixed 5e
     `systemPrompt` (a constant in this file: "You are the Dungeon Master of a Dungeons & Dragons 5e game. Narrate
     vividly but concisely in 2nd person. Rely on your knowledge of 5e rules. …"). `messages = buildContext({...})`.
  2. Stream narration: pick a `streamId = "narr-" + <incrementing>`; for each `{delta}` from `llm.stream(messages,
     {user: sessionId})`, `broadcast({type:'ops', ops:[{op:'event', name:'narration', data:{streamId, delta, by:'dm'}}]})`.
     These delta events are LIVE-ONLY (broadcast directly, NOT journaled).
  3. After the stream, assemble the full narration text. Then call `llm.structured(messages + an instruction to return
     `{narration, ops, checks}` as json, OpBatchResultSchema)` to extract state ops (a Zod schema you define for
     `{narration?, ops?, checks?}`). On parse failure, fall back to ops=[] (narration-only turn).
  4. Canonical commit: `applyAndBroadcast([{op:'event', name:'narration', data:{streamId, text: fullText, done:true,
     by:'dm'}}, ...stateOps], 'dm')` — this journals the final narration + applies/persists/broadcasts the state ops.
  5. Wrap in try/catch; on error, broadcast a narration event with a graceful failure line and log the error
     (never the key).

### server/index.js — wiring
- Build the LlmClient (`createLlmClient()`) and the turn engine once at startup, passing `broadcast` and
  `applyAndBroadcast`.
- **Remove the P0 action→narration stub** from `server/session.js` (`applyOps`). Action ops remain ephemeral
  (journaled, broadcast). After `applyAndBroadcast` processes a batch, for each `action` op in it, fire
  `turnEngine.runTurn(actionOp)` **without awaiting** (fire-and-forget; the narration streams over WS). Catch/log
  errors. Do this for both the HTTP `/op` and WS `ops` paths (centralize so both trigger it).

### client — stream-aware narration
- `client/kernel/store.js`: `event` already emits `{kind:'event', name, data}` — no change needed (data carries
  streamId/delta/text/done).
- `client/kernel/view.js`: update narration handling to accumulate streamed deltas by `streamId`:
  - keep a `Map<streamId, element>`; on a delta event, find/create the entry and append `data.delta`;
  - on a `done:true` event, set the entry's text to `data.text` (final) and mark complete;
  - events with no `streamId` (back-compat) render as a single complete entry.
  - auto-scroll the log. Keep the existing entity-list/inspector reconcile intact.

### package.json
- Add `openai` to deps. Update scripts to load env (graceful if `.env` absent):
  - `"server": "node --env-file-if-exists=.env server/index.js"`
  - `"dev": "concurrently -k \"node --env-file-if-exists=.env server/index.js\" \"vite\""`
  - keep `"client": "vite"`.

## Acceptance criteria — verify with the MOCK provider (no key needed)
Run the server with `LLM_PROVIDER=mock`. Using a short throwaway Node WS client (delete it afterward), confirm:
1. Server starts; with `LLM_PROVIDER=mock` no key is required and no key is ever logged.
2. Sending an `action` op (WS or via `tools/patch.mjs`/HTTP) results in: **multiple `event:narration` delta broadcasts**
   with the same `streamId`, then a **final `done:true` narration event** carrying the full text.
3. The mock's state op is applied + broadcast + persisted (e.g. `world-state.flags.lastAction` set), reconciled to a
   connected client, and present in `/events` with full payload.
4. P0 still works: spawn/set live-reconcile (broadcast carries components/value), `/schema`, `/events`, restart-persist.
5. The P0 stub is gone (no `(P0 stub)` text anywhere).
Do NOT spend real API calls in your verification — use the mock. (A human will run the real DeepSeek smoke test.)

## Return
Compact report: files added/changed, how each acceptance criterion was verified (with actual command output), the
exact 5e systemPrompt you used, and any deviations + why. Do NOT paste full file contents. Do NOT print the API key.
