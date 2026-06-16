# Research task: DeepSeek V4 Flash integration guide (for our engine's LlmClient, P1)

Working dir `/Users/pascaldisse/projects/ttrpg`. **Read-only on the repo except your ONE output file.** Do NOT
create/modify any engine files, `package.json`, `world/`, etc. — a separate build is running concurrently in this
dir; stay out of its way. Write findings to `/Users/pascaldisse/projects/ttrpg/analysis/deepseek-integration-notes.md`.

Context: we're building an AI-TTRPG engine (see `PROTOTYPE-SPEC.md`). Runtime LLM = **DeepSeek V4 Flash** (cheapest)
by default, behind a swappable `LlmClient` interface, called server-side from Node via the OpenAI SDK against
DeepSeek's OpenAI-compatible endpoint. We need a concrete integration guide for **P1 (the turn engine)**.

Use `skill:brave-search` to research current facts (cite source URLs; flag anything uncertain or version-dependent).
Cross-reference: `~/projects/instantale-mac/src/llm/openai_compatible.py` + `llm_config.py` show a working
DeepSeek-via-OpenAI-SDK wiring you may read for base_url/model patterns (but verify current model ids on the web).

Answer concretely:
1. **Endpoint & auth:** base URL, API key header, OpenAI-SDK (Node) setup pointing at DeepSeek.
2. **Model ids:** the exact current id(s) for DeepSeek "V4 Flash" and "V4 Pro" (and whatever the cheapest current
   chat model is). Note context-window size(s) and max output tokens.
3. **Streaming:** how to stream tokens via the OpenAI SDK against DeepSeek (so we can broadcast narration live).
4. **Prompt caching:** does DeepSeek cache prompt prefixes automatically (context/disk caching)? How is it billed,
   and **how do we structure calls to maximize cache hits** for our design (a large, byte-stable prefix =
   ruleset + world bible + character sheets that is identical every turn)? Any ordering/field rules that break caching.
5. **Structured output:** does DeepSeek support JSON mode / `response_format` / function(tool) calling? How reliable
   is JSON output in practice? Recommend the approach for getting a validated **op-batch** (`{narration, ops[],
   rolls[]}`) out — JSON mode vs tool-calling vs prompt-only — plus a lenient-parse fallback strategy.
6. **Limits/cost:** rate limits, pricing ballpark for V4 Flash (input/output/cached), anything that affects a
   long multi-turn session.

Deliver: a tight integration guide + a recommended **`LlmClient` interface** shape (e.g. `stream(messages, opts)`,
`complete(messages, opts)`, and a `structured(messages, schema)` helper) and the **caching + structured-output
strategy** we should adopt. Write the full guide to the output file; return a compact 6–10 bullet summary.
