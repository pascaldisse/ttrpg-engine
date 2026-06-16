# Instantale → AI-TTRPG Engine: Inspiration Report

*What an existing, shipped AI-narrative game ("Instantale") teaches us about building our rules-agnostic
AI-TTRPG engine — with a focus on the first, web-based prototype.*

**Sources analyzed:** `~/projects/instantale-mac` (reverse-engineered + reimplemented Nuitka build).
Detailed per-system findings live in `analysis/instantale-{memory,loop,production,tech}.md`. This report
synthesizes them against our concept (`ai_ttrpg_engine_concept.md`).

---

## 0. TL;DR — the one thing to internalize

**Instantale is, almost exactly, a complete and shipped version of our prototype's *default* mode:
"no one takes the DM seat → the AI runs the game autonomously."** It is a single-player, desktop,
single-genre (dark-fantasy) AI-RPG that already does end-to-end what our atmosphere-first loop needs:
LLM narration, NPC conversation, a quest state machine, structured effect-based state mutation, an
image-gen-as-data pipeline, mood-bucketed music, and a JRPG-style exploration→combat handoff.

That makes it two things at once for us:

1. **A de-risked reference implementation of ~70% of the prototype's plumbing.** The turn loop,
   prompt layering, structured-output protocol, mode dispatch, world-as-data bundle, and combat
   handoff are all *proven shapes* we can lift architecturally (not the code — it's Kivy/desktop).

2. **A cautionary tale about the exact 30% that is our moat.** It has **no rules-as-data**
   (it runs purely on the model's internalized "dark fantasy TRPG" conventions), **no human DM seat /
   canon pen / autonomy slider**, and **a naive memory model** (a 30-message sliding window that
   *silently drops* established facts) — which is precisely the "accumulation, not curation" failure
   mode our concept names as "the whole game."

**Strategic takeaway:** Instantale proves the loop + atmosphere are a viable, compelling product on
their own. Steal its plumbing wholesale, then spend our actual engineering on the three things it
deliberately doesn't have — rules-as-data, the DM seat, and the curation-based memory architecture.

---

## 1. What Instantale is (1-paragraph orientation)

A local desktop app (Python + **Kivy** UI). A "world" is **drop-in data on disk**
(`assets/worlds/<Name>/{backgrounds,characters,monsters}/…` with per-entity `prompts.json`).
The engine loads a world, the player picks/creates a character, then plays a free-text + button-driven
loop where one `GameController` owns all state, assembles a multi-segment prompt, calls an LLM
(model-agnostic adapter; original supported 9+ backends incl. Anthropic/OpenAI/Gemini/local GGUF; the
macOS reimpl wires DeepSeek), parses structured JSON back, applies typed **effects** to a `GameState`,
and renders. Combat is a **separate screen** entered via a handoff object. Saves are local JSON.

---

## 2. Overlap map — where Instantale already does what we need

| System | Instantale | Our concept | Verdict |
|---|---|---|---|
| **Turn loop** | Single `submit_action()` entry → mode dispatch (narration/conversation/quest/battle) → prompt assembly → LLM → parse → apply effects → render | Same shape; AI-DM as default occupant | **Direct overlap — lift the architecture** |
| **Prompt layering** | system role → `[World Context]` → `[Character Context]` → `[Game State]` → `[Output Format]` → rolling history → user turn | Fixed cached prefix (ruleset+bible+sheets) + living state summary + rolling window | **Strong structural overlap** (theirs lacks caching + a real summary; see §4) |
| **Structured output** | Pydantic schemas per mode; lenient parse chain (strict JSON → fenced → regex-extract → wrap-as-prose) | Structured state-change extraction from LLM | **Direct overlap — steal the parse chain verbatim** |
| **Effect protocol** | Finite effect vocab: `damage, heal, get_item, remove_item, move_to, start_battle, text_status_effect, take_a_rest, gold_delta` | Adjudicated state deltas from the LLM | **Direct overlap — adopt as our base vocab, extend per ruleset** |
| **Quest tracking** | Data-driven state machine: phases, `steps[]`, `current_step`, `rewards[]`, events (`certain_success`, `roll_required`+DC, `certain_failure`, `battle`, `field_event`) | Rulebook-aware quest adjudication | **Pattern overlap — LLM narrates, data owns progression** |
| **Mechanical state vs. narration** | HP/MP/gold/inventory/quests/flags kept as **structured data**, mutated only via parsed effects | World-state plumbing that survives drift | **Overlap — this is the half of "memory" they got right** |
| **World-as-data** | Worlds are declarative directories; `list_worlds()`/`load_world()` — drop in a folder, it appears | "Load any world bible" | **Direct overlap — a real *content* mod boundary** |
| **Image-gen-as-data** | Per-entity `prompts.json` (positive/negative SD prompts) with shared style tokens; pre-generated PNGs preferred, gen only as fallback; uniform post-processing pipeline | Consistent image generation across a session | **Partial overlap — good bones, missing real continuity (§5)** |
| **Mood music** | Curated OGG tracks bucketed by location-type × mood (city/dungeon/village × calm/eerie/tense/…) | AI + curated soundtrack, mood-driven | **Overlap on the *selection model*; no AI music** |
| **Combat handoff** | Separate `BattleScreen`; enters via `Encounter` data object; `resolve_battle(outcome)` writes loot/XP/HP back; returns to exploration | JRPG overworld→battle subsystem, decoupled | **Direct overlap — exactly our decoupling** |
| **Model-agnostic LLM** | `LLMAdapter.chat()` ABC; original ran 9+ backends, swappable | DeepSeek runtime, swappable | **Direct overlap — adopt the adapter** |
| **Embedding/RAG infra** | `all-MiniLM-L6-v2`, 2,216 precomputed item vectors, cosine `get_similar_id` — present but **dead code in the reimpl** (loaded/tested, never called at runtime; item-matching was the *original's* inferred use) | (Our memory could use semantic retrieval) | **Infra overlap only — the retrieval capability exists but is wired to nothing** |

---

## 3. Divergence map — what we add that Instantale doesn't have

These are our differentiators. Every one is **"build from scratch"** — Instantale offers no shortcut,
only (sometimes) a cautionary anti-pattern.

| Our pillar | Instantale status | Implication |
|---|---|---|
| **Rules-as-data / rules-agnostic** | **None.** Hardcoded to one genre; runs on the model's internalized RPG conventions. No rulebook is ever loaded. Damage numbers are invented by the LLM ("be fair but grounded"). | This is our moat *and* the thing Instantale literally cannot do. It validates the concept's warning: "D&D-from-memory proves the loop, **not** the engine." Instantale = a polished, hollow-rules RPG. Compelling — but proves nothing about ingestion. |
| **The DM seat (human ↔ AI slider)** | **None.** Fully autonomous narrator. No override, no canon-confirm, no steering panel, no production knobs in human hands. | Our central novelty. Build "DM seat with tools, AI as default occupant" from day one; Instantale shows the autonomous endpoint works, nothing about the human end. |
| **Canon pen (human confirms truth)** | **None.** `world_data` is a free-form dict that's **read-mostly and never written at runtime** (read for NPC presence + location links; no assignment sites) — a static load, not a living canon store. | We need a *queryable* world DB + a narrate-freely-then-canonize write path with consistency-on-write. |
| **Curation-based memory** | **Anti-pattern.** 30-msg sliding window that **silently drops** old turns with no compression. Original had an 80-word per-character "life log" summarizer (not in the reimpl); the embedding stack is present but unused at runtime (never wired to memory *or* items in the reimpl). | Our 3-layer architecture (cached prefix + regenerated living summary + rolling window) is precisely the fix for the failure mode Instantale embodies. See §4 — this is the most important section. |
| **Deterministic dice / adjudication** | **LLM-rolled.** `roll_required` has a DC but the roll itself is LLM-produced; combat damage is LLM-approximated, not computed. | Our engine needs an independent RNG/dice resolver that feeds results *into* context; the LLM interprets, never rolls. |
| **Prompt caching** | **None** (desktop, no hosted cache). | Our cost model hinges on caching the fixed prefix on DeepSeek. Design the prefix to be byte-stable per session from day one. |
| **Multiplayer + hosting** | **None.** Single-user, in-memory state, local files, client-side keys. | Reshape `GameController` → server-side `SessionController` (N players + DM seat); DB-backed state; server-held keys. |
| **AI-generated music** | **None** (curated only; reimpl has no audio at all). | First-class feature for us; build on top of their selection model. |
| **Swappable combat add-ons** | **None.** One hardcoded LLM-driven battle mode, party-of-1. | Make combat a plugin behind the handoff boundary (narrative default, tactical, card-based…). |
| **Visual continuity across a session** | **None.** No seeds, no reference images, no per-world art-direction string beyond shared tokens. Each image is independent. | We must add seed management + style anchoring + (ideally) reference/IP-Adapter to hold character/scene identity across turns. |

---

## 4. The most important lesson: their memory model is our cautionary tale

Our concept says the thing worth studying in other AI-RPGs is **not** generation but *what they keep,
compress, and throw away.* Here's Instantale's answer, and why it matters:

- **What they got RIGHT (steal this):** mechanical truth lives as **structured data**, not prose —
  HP/MP/gold/inventory/quest-phase/flags are mutated only through parsed effects, so the LLM cannot
  contradict them. This is drift-resistance for the *mechanical* half of canon, and it's free.
- **What they got WRONG (our opening):** *narrative* canon — "Old Varda is dead," "the player burned
  the bridge to The Maw," "the tavern-keeper's brother was murdered by the count" — lives **only as
  text in the 30-message window.** Past turn ~15, it's gone. There is no structured record, no
  summary fold-down, and (despite having embedding infra) no semantic retrieval of past events.
- **The original's partial fix:** a "Log Manager" prompt that distilled events into **80-word
  per-character life logs** — lossy, unstructured, not consistency-checked, and absent from the
  reimplementation. It's a useful *first* compression step but not a memory architecture.

**Our move:** keep their structured-state discipline, then add exactly what they lack — a
**regenerated living state summary** (who's dead, key relationships, recent decisions) kept near the
end of context, a **world DB as source of truth** with a narrate-then-canonize **write path** and
**consistency-on-write**, and (optionally) repurpose their embedding stack — built but left entirely
unwired — for **semantic memory retrieval** of past events.

---

## 5. "Steal this" — concrete, prioritized for the web prototype

Ranked by value-for-effort for an atmosphere-first, hosted, multiplayer web app.

1. **The whole turn-engine architecture (server-side port).** Mode-dispatch entry point →
   `PromptManager` as a *pure assembler* (no I/O) → adapter `chat()` → lenient Pydantic parse →
   typed-effect application → render. This is a ready-made spec for our engine core. *(loop.md §1, §6)*
2. **The lenient JSON parse chain.** strict → markdown-fenced → regex-extract-object → wrap-as-prose.
   Includes a DeepSeek-specific quirk (it sometimes appends JSON after narrative). Every real LLM
   deployment needs this; theirs is battle-tested. *(loop.md §3.2)*
3. **The effect vocabulary as our base protocol.** `{type, target, value, …}` deltas. Adopt their set
   as the floor, then add rulebook-derived effect types. *(loop.md §3.4)*
4. **The world-as-data bundle format.** `worlds/<Name>/{backgrounds,characters,monsters}/prompts.json`.
   Extend with `rules.json` + `theme.json` + an `art_direction` string → this becomes our "world bible
   + ruleset as data." *(tech.md §2)*
5. **Image post-processing pipeline as the consistency hammer.** `image_to_pixel → reduce_color →
   dark_fantasy_tone → (border/face-crop/rembg)`. Running *every* generated image through one
   server-side pipeline makes heterogeneous model output look like one art-directed game. **Highest
   value-for-effort atmosphere trick in the codebase.** *(production.md §1)*
6. **Cache-by-hash for images.** key = `hash(model, positive, negative, size, seed)`; add a
   session/world prefix. Pairs with "prefer pre-generated, generate only on miss." *(production.md §1)*
7. **`ImageGenAdapter` / `LLMAdapter` ABCs.** Provider-swap (Replicate / DeepInfra / fal.ai / own GPU;
   DeepSeek / others) without touching game logic. *(production.md §1, tech.md §1)*
8. **Mood→music mapping model.** location-type × mood → track. Extend with a **DM-seat mood knob** that
   biases selection (e.g. "tense → 70% anxiety / 30% desolate") and add crossfade. *(production.md §2)*
9. **Quest state machine + `process_quest_events()` match-and-apply loop.** LLM emits events; data owns
   progression. *(loop.md §3, tech.md §2)*
10. **Combat handoff via an `Encounter` object + `resolve_battle(outcome)` writeback.** Clean
    decoupling boundary — exactly our "exploration hands off a fight, gets back a result." Build the
    combat side as a swappable plugin behind it. *(production.md §4)*
11. **Dual input (free-text + LLM-suggested action buttons).** Good web UX; buttons come from
    `available_actions()` / `NarrationResponse.choices`. *(loop.md §3.3)*
12. **Cheap atmosphere primitives:** 4-phase time-of-day cycle in the context; dark-fantasy palette +
    pixel-font option as CSS; location-image-as-scene-anchor. *(production.md §3, memory.md §6.1)*
13. **First summarization step:** resurrect the original's **80-word per-character life log** as the
    v0 of our living-state-summary — cheap, concrete, immediately better than silent eviction.
    *(memory.md §2.5, §6.1)*

> **Reality check on the art:** in the reimpl the *background* layer (the primary scene anchor for
> atmosphere) ships **only `prompts.json`, no images** — `get_background_image()` returns nothing and the
> app renders PIL placeholder tiles. Character/monster PNGs exist; backgrounds don't. So we're stealing
> the *pattern* (per-entity prompts + post-processing + cache), not a working visual pipeline — the
> atmosphere layer is something we build, not inherit. *(production.md §1)*

---

## 6. "Don't copy" + web-porting gaps

**Anti-patterns to consciously avoid:**
- **Silent eviction of history with no compression** — the #1 consistency killer. Replace with
  summary fold-down. *(memory.md §6.2)*
- **LLM-invented damage / LLM-rolled dice** — fragile and non-reproducible. Use a deterministic
  resolver; the LLM narrates outcomes it's given. *(loop.md §4, §6-D)*
- **Hardcoded system prompts / single-genre persona** baked into code — our prompts must be
  **ruleset-derived** and externalized to data. *(loop.md §6-D, tech.md §2)*
- **Embedding infra built but left unwired** (not used for items *or* memory in the reimpl) — wire it to
  memory retrieval. *(memory.md §3)*
- **SD prompt strings doubling as character descriptions** (they strip SD tokens to recover prose) —
  keep separate structured fields. *(loop.md §6-D)*
- **Free-form `world_data` dict as "canon"** (statically loaded, never written) — we need a queryable,
  schema'd world DB with a write path. *(memory.md §6.2)*
- **Hardcoded content/safety policy in the conversation prompt** — make it per-ruleset/per-table
  configurable, server-side. *(loop.md §6-D)*

**Desktop→web reshaping (what breaks and the minimal fix):**

| Desktop assumption | Web fix |
|---|---|
| Kivy widget tree / desktop UI | Rebuild UI in React/Svelte/Next; keep only the *flow* and palette |
| Local SD (diffusers/OpenVINO) | Cloud image API or server GPU; never in-browser |
| Kivy audio | Web Audio API + crossfade |
| Local JSON save files | Postgres + JSONB game-state; per-session rows |
| Client-side API keys | Server-held keys, never exposed to the browser |
| Single-user `GameController` | Server-side `SessionController`: N player seats + 1 DM seat, locking, presence |
| Blocking LLM call on a bg thread + poll | SSE/WebSocket streaming of narration + state diffs |
| In-memory single session | Auth/accounts, session lifecycle, shared multiplayer state |

---

## 7. Strategic validations & warnings (the meta-lessons)

1. **Validation:** an autonomous AI-RPG with strong atmosphere and *zero real rules engine* is already
   a compelling, shippable product. Instantale exists and plays. → Our prototype's "prove the loop on
   5e-from-memory first" path is sound and low-risk.
2. **Warning (the same fact, inverted):** Instantale is living proof that **the loop can look perfect
   while rules-derivation is hollow.** Do not let a great-feeling 5e demo masquerade as proof of the
   engine. The DSA test (under-represented, roll-under 3d20, German source) remains the only thing
   that proves the moat — Instantale gives us *nothing* toward it.
3. **Validation:** the structured-state-vs-narration split is the right backbone, and it's cheap.
   Adopt it immediately; it's most of what keeps a session coherent before the fancy memory layer.
4. **Warning:** their memory model is the precise failure our concept predicts. Treat "summarize +
   canonize to a world DB" as a **prototype-scope requirement**, not a future nicety — it's what makes
   hour three survivable, and it's the thing Instantale conspicuously lacks.
5. **Opportunity:** the DM seat is *pure greenfield differentiation*. Nothing comparable exists in
   Instantale, so there's no "industry default" we're competing against — we define it.

---

## 8. Suggested prototype shape, informed by all of the above

A minimal architecture that lifts Instantale's proven plumbing and front-loads our differentiators:

- **Server core:** `SessionController` (port of their `GameController`, multi-seat) + a pure
  `PromptManager` assembler producing a **byte-stable cached prefix** (ruleset summary + world bible +
  sheets) → living-state-summary block → rolling window → turn. DeepSeek via `LLMAdapter`, prompt
  caching on.
- **State:** structured `GameState` (their schema is a fine starting point) in Postgres/JSONB +
  a **world canon DB** (NPCs alive/dead, relationships, location states, flags) with a
  narrate-then-canonize write path and consistency-on-write.
- **Memory:** regenerated living summary every N turns (start with the 80-word life-log step), rolling
  raw window with summary fold-down on eviction; embedding retrieval of past events optional v1.5.
- **DM seat (build first, AI as default occupant):** narration review/override, mood knob (drives music
  selection + image art-direction), image-trigger, canon-confirm on proposed world-DB writes.
- **Adjudication:** deterministic dice/check resolver feeding results into context; LLM narrates.
  Combat behind an `Encounter` handoff as a swappable plugin (narrative default ships).
- **Production:** image `prompts.json`-per-entity + per-world `art_direction` + **seed + reference**
  for continuity, all run through one server-side **post-processing pipeline**; cache-by-hash;
  mood-bucketed curated music with crossfade (AI-gen music later).
- **Content as data:** `worlds/<Name>/` bundles extended with `rules.json` + `theme.json`; system
  prompts externalized and ruleset-derived, not hardcoded.
- **Rulesets:** 5e-from-memory to exercise the loop + DM seat + multiplayer + atmosphere; SRD-loaded to
  test ingestion on familiar ground; DSA to actually prove the engine.

---

## Appendix — detailed per-system findings

| File | Covers |
|---|---|
| `analysis/instantale-memory.md` | GameState schema, context assembly, sliding window, embedding/retrieval, drift handling, 3-layer mapping |
| `analysis/instantale-loop.md` | Turn-loop trace, prompt architecture, structured output + parse chain, effects, dice/adjudication, (no) GM concept |
| `analysis/instantale-production.md` | Image gen + consistency, audio/music, screen flow + UX, combat handoff, atmosphere map |
| `analysis/instantale-tech.md` | Architecture/stack, data-driven-ness, config schema, external API surface, save format, web-portability gap |
| `analysis/00-context-brief.md` | The shared brief given to all four analysts (our concept distilled) |

*Caveat carried from source: the macOS workspace is a partial reimplementation — image gen is a stub,
audio is absent, background images are not vendored (locations render as placeholders), the embedding
stack is loaded but never called at runtime, and the per-character life-log summarizer was not
reconstructed. The wired model is `deepseek-v4-flash` and **no prompt caching, 1M-context, or cost-model
assumption is exercised anywhere in the code** — our entire cost/caching pillar (§3, §8) is greenfield,
not validated by Instantale. Feature attributions above distinguish "original" vs "reimpl" where it
matters.*
