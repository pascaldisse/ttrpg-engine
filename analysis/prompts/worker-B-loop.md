FIRST read `/Users/pascaldisse/projects/ttrpg/analysis/00-context-brief.md` in full — it explains OUR project,
the source to mine, and the caveats. Your working dir is `~/projects/instantale-mac`.

YOUR SLICE: **The AI turn-loop, prompt pipeline, narration, action/choice handling, and any rules/dice/adjudication
or GM concept.**

Read (in this order): `notes/PROMPT-PIPELINE.md`, `notes/GAME-FLOW-SPEC.md`, `spec/prompts-from-binary.md`,
everything under `spec/prompts/` and `spec/prompts-new/` (the actual prompt corpora — readable), then `src/llm/`
and `src/game/`, and the LLM-related parts of `spec/api-surface.md`. Use `src/` as ground truth.

Answer concretely:
1. Trace the **core turn loop**: player input → context/prompt assembly → LLM call → output parsing → state update
   → render. Which module/function does each step?
2. **Prompt architecture:** what system prompt(s)/templates exist? What is the model told to be (narrator? GM?)?
   How are world/location/character facts injected? Reproduce the SHAPE of the main prompt (sections + roles).
3. **Output handling:** does the LLM return free prose, or structured output (JSON, tagged actions, tool/function
   calls)? How are player choices presented — free-text input, generated menu of options, both? How does the engine
   extract state changes (location moves, item gains, flags) from the LLM output?
4. **Rules/dice/stats:** is there ANY mechanical adjudication — stats, skill checks, RNG/dice, success/failure,
   combat? Or is it pure narrative? Be specific.
5. **GM/steering:** is there any human-DM, override, or steering concept, or is it a fully autonomous AI narrator?
6. Map onto OUR model (rules-as-context, DM seat with AI as default occupant, dice/adjudication, structured
   state-change extraction). What's reusable, what's missing.

Deliver: write full technical findings — file paths, the prompt-shape sketch, and the (A) how / (B) overlap /
(C) differs-or-lacks / (D) steal-this + don't-copy structure — to
`/Users/pascaldisse/projects/ttrpg/analysis/instantale-loop.md`. Return only a compact 6–10 bullet summary.
