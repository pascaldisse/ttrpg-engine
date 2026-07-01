FIRST read `/Users/pascaldisse/projects/ttrpg/analysis/00-context-brief.md` in full — it explains OUR project,
the source to mine, and the caveats. Your working dir is `~/projects/instantale-mac`.

YOUR SLICE: **Memory / world-state / persistence / embedding-retrieval architecture.** This is OUR project's #1
concern, so be thorough and technical.

Read (in this order, skim then deepen): `notes/GAME-FLOW-SPEC.md`, `notes/DATA-SCHEMA.md`,
`spec/DATA-INVENTORY.md`, `spec/maps/` (method maps), then `src/state/`, `src/embedding/`, `src/data/`, and the
save data examples `spec/common_savedata.json.original` / `spec/common_savedata.new.json`. Use `src/` (real Python)
as ground truth; do NOT read the `.c` decompiles for string content.

Answer concretely:
1. What game/world state does Instantale track across a session, and in what data structures? What gets persisted
   to save files, and in what schema?
2. **How is the LLM context assembled per turn?** Is there a fixed/cached prefix? A rolling recent-history window?
   Any summarization / compression / eviction of old turns? Quote the actual assembly logic if you can find it.
3. **How does the embedding/retrieval system work?** What text gets embedded, how is `get_similar_id` /
   similarity used, and how are retrieved memories injected back into the prompt? Is this their answer to
   long-session memory (RAG-style) instead of/alongside summarization?
4. How does it fight consistency drift / "forgetting" established facts (dead NPCs, names, relationships)?
5. Map their approach onto OUR 3-layer architecture (fixed cached prefix / living state summary / rolling window).
   What do they have that we don't, and vice versa?

Deliver: write full technical findings — with file paths, data-shape sketches, and the (A) how / (B) overlap /
(C) differs-or-lacks / (D) steal-this-for-web-prototype + don't-copy structure — to
`/Users/pascaldisse/projects/ttrpg/analysis/instantale-memory.md`. Return only a compact 6–10 bullet summary.
