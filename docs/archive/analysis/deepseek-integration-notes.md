# DeepSeek V4 Flash Integration Guide — P1 Turn Engine

> **Date:** 2026-06-16 — verified against official DeepSeek API docs, pricing page, and changelog.
> Sources cited inline; any uncertainty flagged with ⚠️.

---

## 1. Endpoint & Auth

| Item | Value |
|------|-------|
| Base URL (OpenAI) | `https://api.deepseek.com` |
| Base URL (Anthropic) | `https://api.deepseek.com/anthropic` |
| Auth header | `Authorization: Bearer $DEEPSEEK_API_KEY` |
| Node SDK | `npm install openai` — no DeepSeek-specific package needed |
| SDK constructor | `new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' })` |

**⚠️ Node.js uses `baseURL` (capital RL), not `base_url`.** The Python SDK uses `base_url`.

**Source:** [api-docs.deepseek.com](https://api-docs.deepseek.com/) — official quickstart; [chat-deep.ai/docs/api/](https://chat-deep.ai/docs/api/) — verified May 3, 2026.

The `/v1` suffix works as a compatibility alias (`https://api.deepseek.com/v1`) but is not required.
DeepSeek also documents a `/beta` base URL required for FIM completions, chat prefix completion, and strict-mode tool calls.

**Key constraint:** The API is **stateless** — the server does not record context. You must send the full conversation history with every request. The web chat at chat.deepseek.com keeps session history; the API does not.

---

## 2. Model IDs & Specs (current as of 2026-04-24 V4 launch)

| | `deepseek-v4-flash` | `deepseek-v4-pro` |
|---|---|---|
| **Model ID** | `deepseek-v4-flash` | `deepseek-v4-pro` |
| Params (total / active) | 284B / 13B | 1.6T / 49B |
| Context window | **1,000,000 tokens** | **1,000,000 tokens** |
| Max output tokens | **384,000** | **384,000** |
| Thinking mode | Supported (default: enabled) | Supported (default: enabled) |
| JSON output | ✅ | ✅ |
| Tool calls | ✅ (up to 128 functions) | ✅ (up to 128 functions) |
| FIM completion | Non-thinking only (beta) | Non-thinking only (beta) |
| Concurrency limit | **2,500** | **500** |
| **Best for (our use)** | **Default — cheap, fast narration + op generation** | Hard reasoning, complex multi-step agent tasks |

**⚠️ Legacy aliases** `deepseek-chat` and `deepseek-reasoner` will be **retired 2026-07-24 15:59 UTC**.
They currently map to `deepseek-v4-flash` non-thinking / thinking modes respectively.
**Do not use for new code.**

**Cheapest chat model:** `deepseek-v4-flash` with thinking **disabled** + cache hits on stable prefix.

**Sources:** [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing); [api-docs.deepseek.com/updates](https://api-docs.deepseek.com/updates) (2026-04-24 entry); [deepseekai.guide/api/deepseek-api-documentation/](https://deepseekai.guide/api/deepseek-api-documentation/).

---

## 3. Streaming

Streaming returns SSE chunks via the OpenAI SDK's `stream: true`.

### Node.js pattern

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

const stream = await client.chat.completions.create({
  model: 'deepseek-v4-flash',
  messages: [...],
  stream: true,
  // Disable thinking for fast narration — reasoning_content would delay first visible token
  thinking: { type: 'disabled' },
});

for await (const chunk of stream) {
  const delta = chunk.choices?.[0]?.delta;
  if (delta?.content) {
    // Broadcast this delta as { op: "event", name: "narration", data: { delta } }
    broadcast(delta.content);
  }
}
```

### Key streaming notes

- Not every chunk contains visible text — **always guard `delta?.content`**.
- In thinking mode, chunks may carry `reasoning_content` before `content`. For the turn engine we want **non-thinking mode** so narration starts immediately.
- Stream ends with `data: [DONE]` (SSE protocol).
- Keep-alive: the server may emit `: keep-alive` SSE comments or empty lines during idle; handle these gracefully.

**Source:** [chat-deep.ai/docs/openai-sdk-to-deepseek/](https://chat-deep.ai/docs/openai-sdk-to-deepseek/) (streaming sections).

---

## 4. Prompt Caching (Context Caching on Disk)

### How it works

DeepSeek's disk caching is **enabled by default** for all users — no opt-in, no code changes, no extra fees for storage.

A **cache hit** occurs when a request's **prefix matches a previously persisted cache unit from token 0**.
Partial matches mid-prompt do NOT trigger cache hits.

Cache units are persisted at:
1. **Request boundaries** — end of user input, end of model output.
2. **Common prefix detection** — when the system detects the same prefix across multiple requests, it persists that prefix as an independent unit.
3. **Fixed token intervals** — for very long inputs/outputs, units are carved at regular intervals.

**Minimum unit:** 64 tokens (shorter content is not cached).
**Best-effort:** not 100% guaranteed. Cached entries are evicted after hours/days.

### Pricing

| | V4 Flash cache-hit | V4 Flash cache-miss | Savings |
|---|---|---|---|
| Input / 1M tokens | **$0.0028** | $0.14 | **98%** |

Cache-hit price was reduced to 1/10 of launch price on 2026-04-26.

### Cache-hit monitoring

Response `usage` includes:
- `prompt_cache_hit_tokens` — tokens served from cache
- `prompt_cache_miss_tokens` — tokens computed fresh
- `prompt_tokens` = hit + miss (total)

### Strategy for our engine — MAXIMIZING cache hits

Our design has a **large, byte-stable prefix** (ruleset system prompt + world bible + character sheets)
that is identical every turn. The changing parts are:
- Current scene description (`look` output)
- Recent turn window
- The player's action text

**Optimal message ordering for cache hits:**

```
[
  { role: "system", content: "<RULESET SYSTEM PROMPT>" },       // byte-stable
  { role: "user",   content: "<WORLD BIBLE + CHARACTER SHEETS>" }, // byte-stable
  { role: "assistant", content: "<previous narration 1>" },
  { role: "user",   content: "<previous action 1>" },
  { role: "assistant", content: "<previous narration 2>" },
  { role: "user",   content: "<previous action 2>" },
  // ... rolling window of recent turns ...
  { role: "user",   content: "<CURRENT LOOK + ACTION>" },       // changes every turn
]
```

**Crucial rule:** The stable prefix MUST start at token 0 (the very beginning of `messages[0]`).
Every turn's request must carry the identical prefix bytes. If any character differs (even whitespace),
the cache prefix won't match and you pay full price.

**Multi-turn bonus:** In multi-turn calls, the NEXT turn's full message array includes the PREVIOUS turn's
messages as a prefix → the previous turn's assistant output + user action becomes a cache unit.
So turn N reuses the cache from turn N-1 for the stable system prefix automatically.

**⚠️ Ordering rule that breaks caching:** If you put the current action or scene description BEFORE
the stable prefix (e.g., as the system message or first user message), the prefix from token 0 is
different every turn → ZERO cache hits on the expensive stable content.

**`user_id` for cache isolation:** Pass `user_id` (via `extra_body` in SDK) to isolate KVCache per
session/player. This prevents cross-session cache pollution and ensures each table's cache prefix
hits correctly.

```js
extra_body: {
  thinking: { type: 'disabled' },
  user_id: `session-${sessionId}`,
}
```

**Sources:** [api-docs.deepseek.com/news/news0802](https://api-docs.deepseek.com/news/news0802); [api-docs.deepseek.com/guides/kv_cache](https://api-docs.deepseek.com/guides/kv_cache); [api-docs.deepseek.com/quick_start/rate_limit](https://api-docs.deepseek.com/quick_start/rate_limit) (user_id isolation).

---

## 5. Structured Output — Getting a Validated Op-Batch

### What DeepSeek supports

| Feature | Status | Notes |
|---------|--------|-------|
| JSON mode (`response_format: {type:"json_object"}`) | ✅ | Guarantees valid JSON syntax, NOT schema compliance |
| Tool calling (function calling) | ✅ | Up to 128 functions; model proposes calls, you execute |
| Strict mode tool calls | ✅ (beta) | `baseURL: 'https://api.deepseek.com/beta'`, `strict: true` per function |
| Structured Outputs (OpenAI-style `json_schema`) | ❌ | Not documented as supported ⚠️ |

### JSON mode requirements

1. Set `response_format: { type: 'json_object' }`.
2. Include the word **"json"** in the system or user prompt.
3. Provide an **example JSON shape** in the prompt.
4. Set a generous `max_tokens` — truncated JSON is unparseable.

### Recommended approach for op-batch `{narration, ops[], rolls[]}`

**Primary: JSON mode**

```
System prompt includes:
  "You must respond with valid JSON only. Output format:
  {
    \"narration\": \"<descriptive text>\",
    \"ops\": [
      {\"op\": \"set\", \"id\": \"...\", \"component\": \"...\", \"value\": {...}},
      ...
    ],
    \"rolls\": [
      {\"expr\": \"1d20+3\", \"dc\": 15, \"for\": \"...\", \"reason\": \"...\"},
      ...
    ]
  }
  Include the word json in your output."

Request params:
  response_format: { type: 'json_object' },
  max_tokens: 4096,  // generous — truncation kills JSON
  thinking: { type: 'disabled' },  // faster, no reasoning_content in output
```

**Fallback: lenient parse pipeline** (`shared/parse.js`)

```js
function parseModelOutput(raw) {
  let json = raw.trim();

  // 1. Strip markdown fences if present
  const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) json = fenceMatch[1].trim();

  // 2. Try direct parse
  let parsed;
  try { parsed = JSON.parse(json); } catch (e) {
    // 3. Try to find JSON object in text (greedy match)
    const objMatch = json.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { parsed = JSON.parse(objMatch[0]); } catch (e2) {
        throw new Error('Model output is not parseable JSON');
      }
    } else {
      throw new Error('No JSON object found in model output');
    }
  }

  // 4. Extract fields with defaults
  const narration = typeof parsed.narration === 'string' ? parsed.narration : '';
  const ops = Array.isArray(parsed.ops) ? parsed.ops : [];
  const rolls = Array.isArray(parsed.rolls) ? parsed.rolls : [];

  return { narration, ops, rolls };
}
```

**After parsing, validate with Zod** against the declarative `SCHEMA`:
- Validate each op's shape (op type, component names, value types).
- Reject malformed ops, keep valid ones.
- If an op references an entity ID that doesn't exist → flag as warning.

**Tool-calling alternative (not recommended for P1):**

Tool calling is more complex and the model may hallucinate function arguments. JSON mode is simpler
and sufficient for our op-batch use case. Tool calling becomes useful at P2+ when the AI-DM needs
to query senses (`look`, `check`, `recall`) mid-turn.

**⚠️ JSON mode does NOT enforce schema.** The model may:
- Omit fields
- Add extra fields
- Use wrong types
- Hallucinate op shapes not in the schema

**Always validate with Zod.** The prompt's example shape is a strong hint, not a contract.

**Sources:** [api-docs.deepseek.com/guides/json_mode](https://api-docs.deepseek.com/guides/json_mode); [chat-deep.ai/docs/openai-sdk-to-deepseek/](https://chat-deep.ai/docs/openai-sdk-to-deepseek/) (JSON Output + Tool Calls sections).

---

## 6. Limits & Cost (Ballpark for Multi-Turn Sessions)

### Pricing (per 1M tokens, USD)

| | V4 Flash | V4 Pro |
|---|---|---|
| Input (cache miss) | $0.14 | $0.435 ⚠️ promo until 2026-05-31 |
| Input (cache hit) | $0.0028 | $0.003625 |
| Output | $0.28 | $0.87 ⚠️ promo |
| Free tier | 5M tokens (new accounts) | 5M tokens |

### Concurrency & rate limits

| | V4 Flash | V4 Pro |
|---|---|---|
| Concurrency limit | **2,500** | **500** |
| Rate limit on exceed | HTTP 429 | HTTP 429 |
| Capacity expansion | Free — submit request form | Free — submit request form |

DeepSeek states "no limits on concurrency or rate" beyond the dynamic concurrency cap;
the system handles "up to 1 trillion tokens per day."

### Error codes

| Code | Meaning | Action |
|------|---------|--------|
| 400 | Invalid format | Fix request body |
| 401 | Auth failure | Check/rotate API key |
| 402 | Insufficient balance | Top up account |
| 422 | Invalid parameters | Fix request params |
| 429 | Rate limit | Exponential backoff, retry |
| 500 | Server error | Retry after brief wait |
| 503 | Server overload | Retry after brief wait |

### Multi-turn session cost estimate (V4 Flash)

**Scenario:** 100-turn session, stable prefix ~8K tokens (rules + bible + sheets), per-turn delta ~3K tokens (scene + window + action), output ~500 tokens per turn.

| Component | Per-turn | × 100 turns |
|-----------|----------|-------------|
| Cache-hit (stable prefix 8K) | 8,000 × $0.0028/1M = $0.00002 | $0.002 |
| Cache-miss (~3K delta) | 3,000 × $0.14/1M = $0.00042 | $0.042 |
| Output (~500 tokens) | 500 × $0.28/1M = $0.00014 | $0.014 |
| **Per-turn** | **~$0.00058** | |
| **Total 100 turns** | | **~$0.058** |

Extremely cheap. Even at 10× these numbers (30K prefix, 10K delta), 100 turns ≈ $0.42.

If caching fails entirely: 100 × (11K × $0.14/M + 500 × $0.28/M) = 100 × $0.00168 = **$0.168** for 100 turns.

**Bottom line:** cost is negligible for turn-engine usage. The 5M free tier alone covers thousands of turns.

### Timeouts

- Keep-alive: server sends empty lines / SSE comments while queued.
- If inference hasn't started after **10 minutes**, the connection is closed.
- Set SDK timeout appropriately: `new OpenAI({ ..., timeout: 120_000 })` (2 min is safe for our turn sizes).

**Sources:** [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing); [api-docs.deepseek.com/quick_start/rate_limit](https://api-docs.deepseek.com/quick_start/rate_limit); [costgoat.com/pricing/deepseek-api](https://costgoat.com/pricing/deepseek-api).

---

## 7. Recommended `LlmClient` Interface Shape

```js
// server/llm.js — interface behind which DeepSeek lives

class LlmClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey       — DeepSeek API key (env: DEEPSEEK_API_KEY)
   * @param {string} [opts.baseURL]    — default 'https://api.deepseek.com'
   * @param {string} [opts.model]      — default 'deepseek-v4-flash'
   * @param {string} [opts.sessionId]  — passed as user_id for cache isolation
   */
  constructor(opts) { ... }

  /**
   * Stream narration tokens for live broadcast.
   * @param {Array<{role:string, content:string}>} messages — full context
   * @param {object} [opts]
   * @param {number} [opts.maxTokens]  — default 4096
   * @param {boolean} [opts.thinking]  — default false (disabled)
   * @returns {AsyncIterable<{delta: string, finishReason?: string, usage?: object}>}
   */
  async *stream(messages, opts = {}) { ... }

  /**
   * Complete (non-streaming) call — for post-narration structured output or
   * quick follow-up passes (e.g., narrating dice results).
   * @param {Array<{role:string, content:string}>} messages
   * @param {object} [opts]
   * @returns {Promise<{content: string, usage: {promptTokens, completionTokens, cacheHitTokens, cacheMissTokens}}>}
   */
  async complete(messages, opts = {}) { ... }

  /**
   * Structured output call — JSON mode with built-in lenient parse + Zod validation.
   * @param {Array<{role:string, content:string}>} messages — prompt must include JSON example
   * @param {import('zod').ZodSchema} schema — Zod schema to validate against
   * @param {object} [opts]
   * @returns {Promise<{parsed: object, raw: string, usage: object}>}
   * @throws {LlmClient.ParseError} if JSON unparseable or validation fails
   */
  async structured(messages, schema, opts = {}) { ... }
}
```

### Wire-up (server initialization)

```js
import { LlmClient } from './llm.js';

const llm = new LlmClient({
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  sessionId: process.env.TTRPG_SAVE || 'default',
});
```

### Swapping providers

To swap to OpenAI, OpenRouter, or a local server — change `baseURL` + `apiKey` + `model`.
The interface stays identical.

---

## 8. Caching + Structured-Output Strategy (Concise Playbook)

### Context assembly (`shared/context.js`)

```
messages = [
  { role: "system", content: STABLE_SYSTEM_PROMPT },           // ①
  { role: "user",   content: WORLD_BIBLE_AND_SHEETS },          // ②
  { role: "assistant", content: "Understood. Ready." },         // ③ optional marker
  // --- ROLLING WINDOW (last N turns verbatim) ---
  { role: "assistant", content: "<turn-1 narration>" },
  { role: "user",   content: "<turn-1 action>" },
  { role: "assistant", content: "<turn-2 narration>" },
  { role: "user",   content: "<turn-2 action>" },
  // --- CURRENT TURN ---
  { role: "user",   content: buildLookContext(session) + "\n\n" + action.text },
]
```

① + ② are byte-identical every turn → cache hit.
③ is optional but can signal model state. If included, keep it identical every turn.
The rolling window shifts — previous turns' assistant+user pairs become cache units automatically.
The CURRENT turn's user message changes → cache miss on that portion only.

### Turn flow (`server/turn.js`)

```
1. context = buildContext(session, action)      // shared/context.js
2. narration = ''
3. for await (chunk of llm.stream(context, { thinking: false })) {
     broadcast({ op: 'event', name: 'narration', data: { delta: chunk.delta } })
     narration += chunk.delta
   }
4. // Short 2nd pass: structured output for ops + rolls
   structuredMessages = [
     ...context,
     { role: 'assistant', content: narration },
     { role: 'user', content: 'Now output the JSON op-batch with ops and rolls.' }
   ]
5. { parsed } = await llm.structured(structuredMessages, opBatchSchema)
6. // Validate ops, resolve dice, apply
```

### Why two passes (stream + structured)?

The streaming pass delivers live narration to players immediately (low-latency UX).
The structured pass extracts ops + rolls from the full context + narration. This separation:
- Keeps the streaming prompt simple (no JSON format constraints that would leak into narration).
- Lets the structured pass see the full narration before deciding ops.
- The structured pass is non-streaming, fast, and cheap (~500 output tokens).

### Fallback: single-pass JSON mode with streaming

If you prefer one call: use JSON mode with streaming enabled. Parse completed JSON from the
collected deltas. Trade-off: narration text arrives as JSON field, not raw streaming text;
you'd need to extract and stream the `narration` field progressively. More complex,
but saves one API call per turn.

### Dice handling

Never let the LLM generate dice results. The `rolls[]` array in the op-batch is a REQUEST —
the model says "I need a d20+3 vs DC 15 for perception." The engine resolves it deterministically
(`dice.js`), then feeds results back in a short follow-up `complete()` call if narration is needed:

```js
for (const roll of parsed.rolls) {
  const result = dice.resolve(roll.expr, roll.dc);
  // If narration of result is needed:
  const followup = await llm.complete([
    ...context,
    { role: 'assistant', content: narration },
    { role: 'user', content: `Roll result: ${roll.expr} = ${result.total} vs DC ${roll.dc}. ${result.success ? 'Success!' : 'Failure.'} Narrate the outcome briefly.` }
  ]);
  broadcast({ op: 'event', name: 'narration', data: { delta: followup.content } });
}
```

---

## Summary Checklist for P1 Implementation

- [ ] Install `openai` npm package (already in `package.json` deps)
- [ ] Create `server/llm.js` with `LlmClient` class (stream, complete, structured methods)
- [ ] Wire `DEEPSEEK_API_KEY` env var → `LlmClient` constructor
- [ ] Set `thinking: { type: 'disabled' }` for narration calls (fast first token)
- [ ] Build context in `shared/context.js` with stable prefix FIRST, delta LAST
- [ ] Stream narration live via WS broadcast (`event:narration` with `delta`)
- [ ] Second pass: structured JSON call for op-batch extraction
- [ ] Implement lenient JSON parse in `shared/parse.js` (fence-strip → direct → regex-find)
- [ ] Validate parsed ops against Zod schema derived from `SCHEMA`
- [ ] Resolve dice server-side in `server/dice.js`, never in LLM output
- [ ] Monitor `usage.prompt_cache_hit_tokens` to verify cache strategy working
- [ ] Set `user_id` per session for cache isolation
- [ ] Handle 429/500/503 with exponential backoff + retry

---

*Sources verified against official DeepSeek API documentation as of 2026-06-16. Pricing and model IDs subject to change — always check [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing) before production deployment.*
