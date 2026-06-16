FIRST read `/Users/pascaldisse/projects/ttrpg/analysis/00-context-brief.md` in full — it explains OUR project,
the source to mine, and the caveats. Your working dir is `~/projects/instantale-mac`.

YOUR SLICE: **Overall tech architecture, data-driven-ness, config/world data model, external API surface, and
portability to a hosted multiplayer WEB app.**

Read (in this order): `spec/ARCHITECTURE.md`, `spec/api-surface.md`, `spec/config-schema.md`,
`spec/config.json.original`, `notes/REIMPLEMENTATION-PLAN.md`, `notes/BUILD-CONTRACT.md`, then `src/app.py`,
`src/config.py`, `src/__init__.py`, and skim `src/data/`. Use `src/` as ground truth.

Answer concretely:
1. **Architecture & stack:** what are the layers/modules and how do they fit (engine core, screens, llm, imagegen,
   state, data)? What UI/runtime framework? Single-player local desktop app — confirm and characterize.
2. **How data-driven is it?** Is a "world" defined as data (files/JSON) that the engine loads, or is content
   hard-coded? What does a world bundle contain (locations, NPCs, prompts, art, config)? Could you add a new world
   by dropping in data — i.e., is there a real mod/content boundary? This is the analog of OUR "load any ruleset."
3. **Config schema:** what does `config.json` control (model, keys, toggles, art style, audio)? Sketch the schema.
4. **External API surface:** enumerate every external service it calls (Anthropic LLM, image gen, embeddings, any
   others) and how keys/endpoints are configured.
5. **Save/persistence format:** how/where is progress saved.
6. **Portability gap to OUR target:** OUR prototype is a HOSTED, MULTIPLAYER WEB app. Instantale is single-player
   local desktop. Concretely: what architecture/ideas port cleanly, what assumptions break (local files, single
   user, desktop UI, client-side API keys), and what the minimal reshaping would be.

Deliver: write full technical findings — file paths, a config-schema sketch, the API-surface list, and the
(A) how / (B) overlap / (C) differs-or-lacks / (D) steal-this-for-web + don't-copy structure — to
`/Users/pascaldisse/projects/ttrpg/analysis/instantale-tech.md`. Return only a compact 6–10 bullet summary.
