# Context Brief — Analyzing "Instantale" as inspiration for our AI-TTRPG engine

You are one of several analysts studying an existing AI-narrative game ("Instantale", a Nuitka-compiled
Python game, reverse-engineered + reimplemented in `~/projects/instantale-mac`). The goal is to mine it for
inspiration for OUR project: a rules-agnostic AI TTRPG engine. Read this brief, then do your assigned slice.

## OUR concept (what we are building) — summary

A rules-agnostic, AI-powered tabletop RPG engine. You load any rulebook (PDF/markdown) and the engine runs a
coherent adjudicated campaign on it: narration, dice, NPCs, story — AI handles rules + production, a human can
stay the storyteller.

Pillars:
1. **AI is the DM's instrument, not its replacement.** There's a "DM seat" with tools (steer/override narration,
   drive production = music/visual-mood/image triggers, hold the "canon pen" = human confirms what's true). AI is
   the *default occupant* of that seat; a live slider runs from fully-autonomous-AI-DM → AI-assisted-human-DM.
2. **Rules-as-context (play time)** vs **rules-as-data (build-time authoring tool)**. Rules-derivation (ingest an
   arbitrary rulebook → consistent adjudicable ruleset) is the moat.
3. **Memory/Context architecture = the real game.** Runtime model = DeepSeek (cheap, 1M ctx, prompt caching).
   Architecture: (a) FIXED CACHED PREFIX = ruleset + world bible + character sheets; (b) LIVING STATE SUMMARY =
   compact "what's true now" (HP, inventory, quests, who's dead, relationships), regenerated every few turns, kept
   near end of context; (c) ROLLING RECENT-HISTORY window, older turns compressed into the summary. The thesis:
   "the thing worth studying in other AI-RPGs is NOT how they generate content — it's how they decide what to
   keep, compress, and throw away." Curation, not accumulation. Attention degradation + consistency drift are the
   enemies.
4. **Distribution:** free modding commons + official paid partners (Tabletop-Simulator model). Not prototype scope.
5. **Combat** = its own subsystem, decoupled from exploration (JRPG overworld→battle-screen handoff). Default
   combat ships; swappable via add-ons.
6. **Future: world generation** — procgen builds the bones (heightmap/biomes/rivers/settlements, navigable+fair),
   LLM "charges it with meaning" (who's in the tower, why kingdoms feud). Generate ONCE → serialize to fixed data
   → LLM reads from it at runtime, never re-invents geometry. Tilesets = pure tag→sprite skins (free-mod material).
   **Living world** = same read-from-fixed-data runtime PLUS a write path: DM-LLM commits new canon to the same
   queryable DB (narrate-freely-then-canonize; consistency-checked on-write, not on-read). World DB is source of
   truth; context is just a working window.

## FIRST PROTOTYPE scope (what matters MOST for this analysis)

A **web app, hosted, multiplayer**. **Atmosphere, not features.** Specifically:
- Consistent **image generation** (visual continuity across a session).
- Good **narration**/storytelling.
- **Music** — AI-generated theme music + option of curated soundtrack.
- Just enough **world-state plumbing** to stay coherent across a session.
- The **DM seat**, AI as default occupant.
- First rulesets: D&D 5e (prove the loop, model knows it cold) then DSA/Das Schwarze Auge (prove the engine).
- Explicitly LATER: world generation, marketplace, offline mode, combat add-ons beyond a default.

## The source to mine (`~/projects/instantale-mac`), in priority order
1. `notes/GAME-FLOW-SPEC.md` — single best systems overview.
2. `notes/decompiled/INDEX.md` → the ~324 .c files (every module + ~120 impls).
3. `spec/` — ARCHITECTURE.md, api-surface.md, config-schema.md, method maps, modules.txt, prompt corpora.
4. `src/` — the working reimplementation (often clearest way to read a system end-to-end).
   Modules: app, assets, config, data, embedding, game, imagegen, llm, screens, state, ui.

### Caveats (IMPORTANT)
- The decompiled C is CPython-API C, NOT 1:1 Python; string constants (labels, prompt text, location names) are
  opaque addresses. Read readable content from `spec/prompts*` + `spec/prompts-new` + vendored world data + `src/`,
  NOT the `.c` files.
- `assets/worlds/`, `assets/data/`, `ida/*.i64` are gitignored (present on disk now).
- The game uses the **Anthropic** SDK (see decompiled `anthropic.*.c`) for its LLM and has an **embedding** module
  (semantic retrieval). Note both — relevant to our memory + model-runtime design.

## What EVERY analyst returns
For your slice: (A) how Instantale does it (concrete: files, data shapes, prompt structure, flow), (B) where it
OVERLAPS with our concept, (C) where it DIFFERS / what it lacks vs our concept, (D) concrete INSPIRATION /
"steal this" items for our **web prototype** (and explicit "don't copy this" anti-patterns). Be specific and
technical. Write your full findings to your assigned output file; return only a compact 6–10 bullet summary.
