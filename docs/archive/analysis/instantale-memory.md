# Instantale Memory / World-State / Persistence / Embedding-Retrieval Analysis

> Slice owner: Memory / persistence / context architecture  
> Date: 2026-06-16  
> Sources: `notes/GAME-FLOW-SPEC.md`, `notes/DATA-SCHEMA.md`, `spec/DATA-INVENTORY.md`,
> `spec/prompts-from-binary.md`, `spec/ARCHITECTURE.md`, `src/state/`, `src/embedding/`,
> `src/game/controller.py`, `src/llm/prompt_manager.py`, `src/game/conversation.py`,
> `src/game/progression.py`, `src/llm/response_models.py`

---

## 1. What game/world state does Instantale track?

### 1.1 In-memory state (GameState dataclass)
`src/state/game_state.py` defines the canonical shape (mirrors `scripts.save_codec.c` 35 field constants):

```
GameState
├── version: float (0.4)
├── talent_point: int (meta-currency, shared across saves)
├── current_world: str
├── current_location: str (added in Round 2 reimplementation)
├── current_character: str
├── days_elapsed: int / day: int
├── time_of_day: str ("morning"|"afternoon"|"evening"|"night")
├── party:
│   ├── gold: int, max_members: int
│   └── members[] → PartyMember(name, class, level, hp/max_hp, mp/max_mp, equipment[], skills[])
├── inventory:
│   ├── max_slots: int
│   └── items[] → InventoryItem(id, name, type, rarity, quantity, description, stats{}, skills[])
├── quests:
│   ├── active[] → Quest(id, name, phase, description, steps[], current_step, giver, location, rewards[], quest_type, flags{})
│   ├── completed[] → list[str]
│   ├── main_quest_id: str
│   └── flags: dict[str,str]
├── world_data: dict[Any, Any]  (extensible location/NPC state)
├── history: list[{"role","content"}]  (LLM chat log)
├── flags: dict[str,str]  (global progression flags)
└── main_quest_completed: bool
```

### 1.2 What gets persisted (save files)
**Every field above** serializes via `GameState.to_dict()` → JSON (`v0.4` schema).
Save path: `~/Library/Application Support/Instantale/saves/slot_N.json`.

`src/state/save_codec.py` provides `encode_save` / `decode_save` (thin wrappers),
plus slot-file management (`list_slots`, `delete_slot`). The original decompiled
`scripts.save_codec.c` had 4 impls (encode 929 lines, decode 757, validate 624,
item-specific 900) — confirming the 35 field schema exactly.

### 1.3 NOT persisted (runtime-only)
- Conversation sliding window (rebuilt from history)
- Battle turn state, text queue, image gen queue
- UI window visibility, selected item/skill
- **Life log** (original per-character summarized memories — NOT in reimplementation)
- NPC affinity map (tracked via `affinity_text` + `affinity_delta` in conversation, but computed live)

---

## 2. How is LLM context assembled per turn?

### 2.1 Assembly logic (real code)
`src/llm/prompt_manager.py → PromptManager.assemble_messages()` builds the message list fresh each turn.
Invoked from `src/game/controller.py → submit_action()`.

```
messages = [
  {"role":"system", "content":"<role prompt>"},              # §0: mode-specific (narration/conversation/quest/battle)
  {"role":"system", "content":"[World Context]\n<...>"},     # §1: world name, location, description, time, quest
  {"role":"system", "content":"[Character Context]\n<...>"}, # §2: NPC personality, traits, backstory, affinity (conversation only)
  {"role":"system", "content":"[Game State]\n<...>"},        # §3: player name/class/level, HP/MP, inventory, party, quests
  {"role":"system", "content":"<JSON output instruction>"},  # §4b: schema enforcement (conversation mode only)
  *history,                                                    # §5: past user/assistant pairs (sliding window)
  {"role":"user",   "content":"<player action text>"},        # §6: current turn
]
```

### 2.2 Fixed/cached prefix? **No.**
All system sections (§0–§4b) are regenerated from current `GameState` each turn.
They are small and stable (role prompts are constant strings; world/state context
is compact factual text). No prompt caching mechanism exists — this is a local
LLM desktop app, not a hosted service.

### 2.3 Rolling recent-history window? **Yes.**
`src/game/controller.py` stores each turn pair in `state.history`:
```python
self._state.history.append({"role": "user", "content": text})
self._state.history.append({"role": "assistant", "content": narration})
```
`PromptManager` trims to sliding window:
```python
max_history_msgs = 30
if len(history) > max_history_msgs:
    history = history[-max_history_msgs:]
```

`src/game/conversation.py` uses the same limit: `MAX_HISTORY = 30`.

### 2.4 Summarization / compression / eviction of old turns? **No — in the reimplementation.**
Old turns are **silently dropped** when the window overflows. There is no
compression step that folds old turns into a summary.

### 2.5 What the ORIGINAL had (decompiled evidence)
From `spec/prompts-from-binary.md` and `notes/GAME-FLOW-SPEC.md §2.3`:
- `impl_0x151242670` (830 lines) — "memory/log summarizer" context
- **Log Manager prompt**: *"You are the log manager of a TRPG. With reference to the given character information, summarize the memories that fall within the 'memory range to be summarized' into a passage of about 80 words. Do not use any structured format; narrate the outcome only in natural language prose."*
- `quest_summarizer`, `quest_battle_log_summarizer`, `quest_summarizer_story` — quest-level summary prompts
- `character_knowledge_retrieval()` method — NPC answers from a stored knowledge base

This suggests the original had a **life log** system: per-character 80-word summaries of past events,
kept alongside character data. The reimplementation has not yet reconstructed these.

---

## 3. How does the embedding/retrieval system work?

### 3.1 What gets embedded
**Only items.** `src/embedding/db.py → ItemEmbeddingDB` loads 2,216 precomputed
item embeddings from 17 JSON files (`assets/Data/item_embeddings/`).
Model: `all-MiniLM-L6-v2` (384-dim vectors, L2-normalized).

Categories: body_armor(63), creature_part(171), document(109), drink(53), food(309),
headgear(180), leg_armor(151), long_weapon(76), magical_material(89), ore(63),
other_material(116), potion(61), shield(114), small_weapon(267), tool(214), treasure(170).

### 3.2 How similarity is used
`src/embedding/item_matcher.py → ItemMatcher.get_similar_id(query, k, min_score)`:
1. Encode query text → 384-dim L2-normalized vector via `EmbeddingEngine`
2. Dot product against all 2,216 item embeddings (cosine since L2-normed)
3. Return top-k results sorted by score

The reimplementation references `ItemMatcher` from `inventory_screen.py` (UI help).
**It is NOT wired into prompt assembly or LLM context.** The original's inferred
uses: crafting suggestions, shop inventory generation, NPC equipment recommendations,
loot generation matching quest difficulty.

### 3.3 Are retrieved memories injected back into prompts? **No.**
The embedding system is exclusively for **item similarity**. It is NOT used for:
- Semantic retrieval of past dialogue
- Fact-checking consistency
- Injecting relevant history into context
- Knowledge base queries about world lore

### 3.4 Is this their RAG-style answer to long-session memory? **No.**
Their answer to long-session memory is the **life log summarizer** (per-character 80-word summaries),
not embedding retrieval. The reimplementation doesn't even have the summarizer yet.

---

## 4. How does Instantale fight consistency drift / "forgetting"?

### 4.1 What works (in the reimplementation)
| Mechanism | How it fights drift |
|-----------|-------------------|
| **Quest state machine** (`src/game/progression.py`) | Structural: quest phases, steps, completion are data, not text. Cannot be contradicted by LLM. |
| **Party stats** (HP/MP/gold) | Numeric state stored separately from narration. Damage/heal effects parsed from JSON → applied to data. |
| **Inventory** | Named items as structured data, not just text in narration. |
| **world_data dict** | Extensible bucket for arbitrary canonical facts (though underused). |
| **flags dict** | Arbitrary key-value for progression gates, defeated markers, etc. |
| **GameState serialization** | Full state snapshot on save; no drift across loads. |
| **Affinity tracking** | `affinity_text` + `affinity_delta` in conversation responses. Quantitative, not just text. |

### 4.2 The critical gap
Established narrative facts — dead NPCs, changed relationships, discovered secrets,
player decisions that reshape the world — live **only as text in the sliding history
window**. When the window rolls past turn 15 in a 30-message window, those facts are
**gone**. The LLM has no structured record that "Old Varda is dead" or "the player
burned the bridge to The Maw."

The original's **life log** was the partial answer: per-character 80-word summaries
that distill key facts. But even that is lossy, unstructured, and not consistency-checked.

---

## 5. Mapping Instantale onto OUR 3-layer architecture

| Our layer | Instantale equivalent | Assessment |
|-----------|----------------------|------------|
| **(a) Fixed cached prefix** (ruleset + world bible + char sheets) | Role prompt templates + world/character context assembled fresh each turn | **Overlap**: Stable content sent every turn. **Differs**: No caching (our DeepSeek prompt-cache optimization). No rulebook — role prompts are hardcoded 2-5 sentence templates, not ingested PDFs. World bible is SD image prompts, not narrative canon text. |
| **(b) Living state summary** (HP, inventory, quests, who's dead, relationships) | `[Game State]` section in prompt + `GameState.to_prompt_text()` | **Strong overlap**: This IS a living state summary — compact, factual, regenerated each turn from canonical data. What's missing: explicit death list, relationship graph, established-facts journal. |
| **(c) Rolling recent-history window** | 30-message sliding window + optionally the original's life-log summarizer | **Overlap**: Sliding window exists. **Differs**: No compression of dropped turns into summary. Original had per-character 80-word life log. Our architecture requires this. |

### What Instantale has that we don't (yet)
- Pre-bundled world assets as game content (characters, backgrounds, monsters with SD prompts)
- Item embedding similarity (2,216 precomputed) for crafting/shops
- Multi-mode prompt assembly (7 distinct system prompts for different game modes)
- Time cycle (4 phases) affecting narration context
- Quest state machine with rewards/deep_update
- Conversation safety policy enforcement
- Per-character life log summarizer (original; not in reimpl)

### What we have that Instantale doesn't
- Rules-as-data ingestion pipeline (the moat)
- DeepSeek 1M context + prompt caching (theirs: local 9B GGUF, no caching)
- Regenerated canonical state summary (theirs: assembled fresh each turn but same idea)
- Human "canon pen" / DM override seat
- Image generation for visual continuity (theirs: SD too, but for sprites/backgrounds, not consistent scene illustration)
- Multiplayer support
- Structured consistency check on-write to world DB (theirs: world_data is write-only dict)

---

## 6. Concrete inspirations & anti-patterns for our web prototype

### 6.1 STEAL THIS
1. **Compact `[Game State]` prompt section format**: `GameState.to_prompt_text()` — player name/class/level, party HP/MP, inventory names, active/completed quests. Clean, injectable, ~200 tokens. Use this as our living state summary block.
2. **Quest state machine as structured data**: quests with `phase`, `steps[]`, `current_step`, `rewards[]`. The LLM narrates but doesn't *own* quest progression. Our quest adjudication should work the same way.
3. **Effect type model**: `damage`, `heal`, `get_item`, `text_status_effect`, `start_battle`, `move_to`, `take_a_rest`, `gold_delta`. A clean, finite vocabulary of state mutations parsed from LLM JSON output. Our effect system should be this or superset.
4. **Time cycle**: 4-phase cycle (morning/afternoon/evening/night) affects narration context. Simple, atmospheric, zero-token overhead.
5. **Sliding window with a hard cap** (30 messages): simple, predictable token budget. We'll add summarization on top.
6. **Per-character life log** (original): 80-word summaries of key events per NPC/PC. A low-cost precursor to our (b) layer. Could be our first summarization step.
7. **Affinity tracking** as quantitative delta: `affinity_delta: ±N` in conversation responses. Easy to store, easy to query. Our relationship graph can start here.
8. **`flags` dict** for arbitrary progression gating: simple key-value strings that gates quests, locations, NPC behavior. Dead-simple, infinitely extensible. Our canonical state store should include this.

### 6.2 DON'T COPY THIS
1. **Silently dropping old turns from the window** with no compression. This is the #1 consistency killer. We MUST fold dropped turns into the living state summary.
2. **Embedding system for items only, not memory retrieval**. Their embedding infra (model, cosine search) is clean and correct, but was never used for memory. We should use embedding retrieval for semantic memory search over past events.
3. **No structured "world canon" DB separate from narration history**. Their `world_data` dict is a free-form write-only bucket. We need a queryable world DB with structured fields (NPCs alive/dead, relationships, location states).
4. **No deduplication or conflict resolution in save data**. Save codec just serializes everything. No migration, no integrity checks beyond basic validation.
5. **Hardcoded system prompts** (48 variants, each ~100 words, all in code). We'll load prompts from templates / rulebook data, not magic strings.
6. **No prompt caching**. For a hosted web app with DeepSeek, the fixed prefix (ruleset, world bible) should be cache-hit repeat prefix. They rebuild the whole message list every turn.

---

## Appendix: File reference index

| Concern | File |
|---------|------|
| GameState schema | `src/state/game_state.py` (dataclass, to_dict/from_dict) |
| Save codec | `src/state/save_codec.py` (encode/decode, slot files) |
| Prompt assembly | `src/llm/prompt_manager.py` (assemble_messages, 7 modes) |
| Context model classes | `src/llm/prompt_manager.py` (WorldContext, CharacterContext, GameState) |
| Turn loop + history storage | `src/game/controller.py` (submit_action, submit_conversation_turn) |
| Conversation sliding window | `src/game/conversation.py` (MAX_HISTORY=30, history append/trim) |
| Effect types + parsing | `src/llm/response_models.py` (Effect, NarrationResponse, etc.) |
| Quest state machine | `src/game/progression.py` (phases, steps, rewards, elapse_days) |
| Embedding engine | `src/embedding/engine.py` (all-MiniLM-L6-v2, encode, mean pooling) |
| Item embedding DB | `src/embedding/db.py` (2,216 items, 384-dim, L2-normed) |
| Similarity matcher | `src/embedding/item_matcher.py` (get_similar_id, cosine) |
| World data assets | `src/data/world_loader.py` (prompts.json → Character/Location) |
| Decompiled evidence (prompts) | `spec/prompts-from-binary.md` (48 system prompts, summarizer, life log) |
| Decompiled evidence (flow) | `notes/GAME-FLOW-SPEC.md` (§2.3 context_manager, §2.4 message list, §3 state model) |
| Decompiled evidence (save) | `notes/GAME-FLOW-SPEC.md` (§4 save_codec, 35 field constants) |
