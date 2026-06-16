# Instantale AI Turn-Loop & Prompt Pipeline — Full Technical Analysis

**Slice**: The AI turn-loop, prompt pipeline, narration, action/choice handling,
rules/dice/adjudication, and GM concept.

**Date**: 2026-06-16  
**Source ground truth**: `src/` (reimplementation), with spec/notes cross-validation.

---

## 1. CORE TURN LOOP — Step-by-Step Module Trace

```
Player input (text or button)
  │  screens/game_screen.py : GameScreen._on_submit_text()  [L~340]
  ▼
process_choice() / submit_action()
  │  game/controller.py : GameController.submit_action()  [L181-270]
  │  Determines MODE from action context:
  │    narration (free exploration) → default
  │    conversation (talking to NPC) → submit_conversation_turn() [L272-319]
  │    quest_referee (active quest)  → _process_quest_response() [L390-425]
  │    battle (combat)               → game/battle.py : BattleEngine  [L91-165]
  │
  ▼ ── 1. CONTEXT/PROMPT ASSEMBLY ──
  │  llm/prompt_manager.py : PromptManager.assemble_messages()  [L112-170]
  │    ├─ _build_world_context()     → WorldContext.to_prompt_text()
  │    ├─ _build_game_state_context() → GameState.to_prompt_text()
  │    ├─ (conversation) _build_character_context() → CharacterContext.to_prompt_text()
  │    └─ Appends conversation history (sliding window, max 30 msgs)
  │
  ▼ ── 2. LLM CALL ──
  │  game/controller.py : _call_llm_sync()  [L427-461]
  │    └─ llm/factory.py : create_llm_adapter() → OpenAICompatibleAdapter [L~12, L]
  │       └─ llm/openai_compatible.py : .chat(messages, temperature=0.8, max_tokens=512)
  │          Uses AsyncOpenAI client, discovers model from /models endpoint
  │
  ▼ ── 3. OUTPUT PARSING ──
  │  llm/response_models.py : parse_response(raw, response_type)  [L223-274]
  │    ├─ Tries strict JSON parse
  │    ├─ Falls back to markdown-fenced JSON extraction
  │    ├─ Falls back to regex JSON-object extraction (DeepSeek workaround)
  │    └─ Falls back to wrapping raw text in model (e.g. ConversationResponse(reply=raw))
  │  Pydantic models: NarrationResponse, ConversationResponse,
  │    QuestOutcomeResponse, BattleOutcomeResponse, WorldGenerationResponse,
  │    CharacterCreationResponse, ItemGenerationResponse
  │
  ▼ ── 4. STATE UPDATE ──
  │  game/controller.py : _apply_effects()  [L348-386]
  │    damage→HP, heal→HP, get_item→inventory, remove_item, move_to→location,
  │    start_battle→pending_encounter, text_status_effect, take_a_rest,
  │    gold_delta→party.gold
  │  game/progression.py : process_quest_events()  [L118-205]
  │    certain_success→advance_step, roll_required→dice vs DC check,
  │    certain_failure→fail_quest, battle/field_event triggers
  │  state/game_state.py : history.append(user/assistant pair)  [L254-260]
  │
  ▼ ── 5. RENDER ──
  │  screens/game_screen.py : _render_turn_result()  (approx L350+)
  │    narration_label.text = result.narration
  │    status_label.text = joined effects
  │    refresh_choice_buttons() from controller.available_actions()
  │    If battle triggered → transition to BattleScreen
  │    If game_over → transition to GameOverScreen
```

### Key files in the loop

| Step | Module | Function/Method |
|------|--------|-----------------|
| Input | `screens/game_screen.py` | `_on_submit_text()` |
| Dispatch | `game/controller.py` | `submit_action()`, `submit_conversation_turn()` |
| Context build | `llm/prompt_manager.py` | `assemble_messages()`, per-mode assemblers |
| LLM call | `llm/openai_compatible.py` | `OpenAICompatibleAdapter.chat()` |
| LLM create | `llm/factory.py` | `create_llm_adapter()` |
| Parse | `llm/response_models.py` | `parse_response()`, `lenient_parse_conversation()` |
| Apply | `game/controller.py` | `_apply_effects()`, `_process_quest_response()` |
| Time | `game/progression.py` | `elapse_days()`, `elapse_rest_time()` |
| Render | `screens/game_screen.py` | `_render_turn_result()`, `_refresh_from_controller()` |

---

## 2. PROMPT ARCHITECTURE

### 2.1 System Prompt Templates (~48 total in original, 7 implemented in src)

**Mode-to-prompt mapping** (`llm/prompt_manager.py:PromptManager._select_role_prompt`):

| Mode | Prompt Constant | Persona |
|------|-----------------|---------|
| `narration` | `NARRATOR_PROMPT` | "You are responsible for weaving the story of a dark fantasy RPG." |
| `conversation` | `CONVERSATION_MANAGER_PROMPT` | "You are the manager of conversation events in an RPG and you will reproduce the behavior of the NPC '{npc_name}'." |
| `quest` | `QUEST_REFEREE_PROMPT` | "You are the game master of a dark fantasy TRPG. Provide narration that follows the given quest structure." |
| `battle` | `BATTLE_DM_PROMPT` | "You are the game master of a dark fantasy TRPG. The player has entered and finished a battle." |
| `world_generate` | `WORLD_GENERATOR_PROMPT` | "You are a world map generator for a dark fantasy RPG." |
| `character_create` | `CHARACTER_GENERATOR_PROMPT` | "You are a character generation AI for a dark fantasy RPG." |
| `item_generate` | `ITEM_GENERATOR_PROMPT` | "You are the item generation engine of an RPG." |

### 2.2 What the model is told to be

- **Narrator** — "responsible for weaving the story", writes in third person, 1-2 sentences, max ~15 words, includes "..." with 1/2 probability, no metaphors.
- **Conversation manager** — reproduces NPC behavior "as an NPC in an RPG conversation event", follows personality/emotions, includes full safety policy.
- **Quest referee/DM** — "game master of a dark fantasy TRPG", lyrical yet objective style, evaluates natural-language actions and translates them into "actual in-game processing."
- **Battle DM** — same TRPG persona, "plain, non-polite narrative style," resolves turns mechanically.
- **Generators** (world/character/item) — each with a focused role (world map generator, character generation AI, item generation engine).

### 2.3 How world/location/character facts are injected

Each section is a separate `{"role": "system", "content": ...}` message:

```
[messages[0]]  {"role":"system", "content":"<ROLE PROMPT>"}          # Who you are
[messages[1]]  {"role":"system", "content":"[World Context]\n..."}    # World name, desc, location, time
[messages[2]]  {"role":"system", "content":"[Character Context]\n..."}# NPC personality, traits, affinity
[messages[3]]  {"role":"system", "content":"[Game State]\n..."}       # Player stats, party, inventory, quests
[messages[4]]  {"role":"system", "content":"<JSON OUTPUT INSTRUCTION>"}# Schema constraint
[messages[5..]]  alternating user/assistant pairs                     # Sliding history window
[messages[N]]  {"role":"user",   "content":"<player's current action>"}
```

**Key injection points:**

- `WorldContext.to_prompt_text()` — flat key=value lines: World, Description, Current location, Time of day, Days elapsed, Active quest, Quest phase.
- `CharacterContext.to_prompt_text()` — NPC Name, Category, Physical description, Personality, Backstory, Traits, Equipment, Affinity toward player, Current activity.
- `GameState.to_prompt_text()` — Player name + level + class, Stats, Inventory, Party members, Active/completed quests, extra_context (gold, talent_point).

Physical descriptions are extracted from SD image generation prompts (`positive_prompt`) by stripping known SD boilerplate tokens (`full-body, masterpiece, high quality, watercolor, etc.`).

### 2.4 Sliding window

`get_history_context()` in the original, implemented in `PromptManager.assemble_messages()` — max 30 user/assistant messages, trimmed from the front.

---

## 3. OUTPUT HANDLING

### 3.1 Structured JSON output (primary path)

The LLM is instructed to return JSON with **mode-specific schemas** via a `[Output Format]` system message:

**NarrationResponse** (exploration mode):
```json
{"narration": "...", "choices": [...], "effects": [{"type": "damage|heal|get_item|...", ...}], "next_phase": null}
```

**ConversationResponse** (NPC dialogue):
```json
{"reply": "...", "affinity_delta": -2..10, "action": "retrieve_knowledge|call_free_action|start_battle|leave|null", "action_data": {}, "content_violation": null}
```

**QuestOutcomeResponse** (quest referee):
```json
{"outcome": "...", "events": [{"type": "battle|move_to|field_event|take_a_rest|encounter_final_boss|certain_success|certain_failure|roll_required", ...}], "next_phase": null, "quest_complete": false}
```

**BattleOutcomeResponse** (combat turn):
```json
{"narration": "...", "damage_dealt": {...}, "damage_taken": {...}, "status_effects": [...], "battle_state": "ongoing", "next_turn": "enemy"}
```

### 3.2 Fallback parsing chain

1. Strict `json.loads()` on full text
2. Markdown-fenced ` ```json ... ``` ` extraction
3. Regex extraction of any `{...}` JSON object containing reply/affinity_delta/action keys (DeepSeek sometimes appends JSON after narrative text)
4. Fallback: wrap raw prose as `ConversationResponse(reply=text)` or `NarrationResponse(narration=text)`

### 3.3 Player choices — dual input model

1. **Free-text input** — `TextInput` widget, player types anything (natural language)
2. **Action buttons** — `ActionOption` objects generated by `GameController.available_actions()`:
   - `talk` to NPCs present at current location
   - `move` to reachable adjacent locations
   - `examine` current area
   - `use_item` per inventory item
   - `skill` per party member skill
   - `rest`, `inventory`, `character_sheet`
3. **Choices in narration** — `NarrationResponse.choices` (list[str]) are surfaced as clickable buttons, emulating the original game's "choose your action" menu

### 3.4 State-change extraction from LLM output

Via `_apply_effects()` in `game/controller.py` — maps effect types to state mutations:

| Effect | State Mutation |
|--------|---------------|
| `damage` | Party/player HP -= value |
| `heal` | Party/player HP += value |
| `get_item` | `inventory.items.append(InventoryItem(...))` |
| `remove_item` | Remove from inventory by name or ID |
| `move_to` | `state.current_location = new_location` |
| `start_battle` | Sets `self._pending_encounter` (read by game_screen to transition) |
| `text_status_effect` | Descriptive, no mechanical mutation |
| `take_a_rest` | Full HP/MP restore + time advance (2 steps) |
| `gold_delta` | `party.gold += amount` |

Quest effects are processed separately via `game/progression.py:process_quest_events()`.

---

## 4. RULES / DICE / STATS — Adjudication Analysis

### 4.1 Is there mechanical adjudication? YES, but mostly narrative-steered.

**What exists:**

1. **6 canonical TRPG stats** — STR, CON, DEX, INT, WIS, CHA (confirmed in `character_gen.py:STAT_KEYS`, `prompts-from-binary.md`, system prompts)
2. **Stat-based HP/MP derivation** — `HP = 80 + CON * 4`, `MP = 20 + INT * 2` (`character_gen.py:to_party_member()`)
3. **Dice rolls in quest events** — `QuestEvent` has `dice_roll` (int) and `dc` (difficulty class, int). The `roll_required` event type triggers a pass/fail check: `if dice >= dc: advance_step; else: fail`.
4. **Battle damage** — The LLM resolves battle turns and returns `damage_dealt`/`damage_taken` dicts with integer values. These are **not computed by a deterministic engine** — the LLM `BattleOutcomeResponse` carries them, and the engine merely applies the result. The LLM is instructed: "Calculate damage based on stats. Be fair but grounded."
5. **Status effects** — Named effects with duration (turns), applied/ticked by `BattleEngine._apply_result()` and `_tick_status_effects()`.
6. **Mock battle** — `_mock_resolve()` uses `random.randint(2,8)` for player damage, `random.randint(1,6)` for enemy, providing a statistical baseline for tests.
7. **Character stat rolls** — `_roll_stats()` in `character_gen.py` uses a 3d6-like distribution with target sum ranges (55-70 standard).

### 4.2 What's MISSING vs. traditional TTRPG adjudication:

- **No deterministic skill-check engine** — The original has a `roll_required` event type with DC, but the actual D20 roll is presumably injected by the quest referee LLM, not an independent RNG.
- **No combat subsystem with initiative/turn-order** — Battle is turn-by-turn (player acts, enemy acts) but turn order is LLM-dictated, not stat-derived.
- **No explicit rulebook reference** — No D&D 5e, DSA, or any rulebook is loaded. The LLM uses its own internalized knowledge of "dark fantasy TRPG" conventions.
- **No numerical AC/DC/saving throws** — Damage resolution is LLM-mediated narrative, not a dice-against-target-number system.

### 4.3 Verdict: "Pure narrative with stat-aware suggestions"

The LLM is told to be fair and grounded, given stat values, but the actual damage numbers come from the LLM's internal "fairness" heuristic, not a deterministic engine. This is **rules-as-context (LLM internalized), not rules-as-data (ingested rulebook).**

---

## 5. GM / STEERING CONCEPT

### 5.1 What Instantale has

- **Fully autonomous AI narrator** — no human-DM override, no steering panel, no canon-confirmation step.
- The player interacts via free-text input or action buttons. The AI handles all narration, NPC behavior, combat, quest logic.
- **No "DM seat"** — there is no role distinction between player and DM. The AI fills the narrator/GM role completely.
- The only human agency is the player's actions.

### 5.2 What it lacks

- No override/edit narration capability
- No human "canon pen" to approve or reject AI-generated events
- No slider between fully-autonomous and AI-assisted modes
- No DM-specific UI or tooling (steering panel, production triggers)
- No mechanism for "the DM says" vs "the AI suggests"

---

## 6. MAP ONTO OUR MODEL

### (A) How Instantale does it — summary

- Mode-dispatch: single `submit_action()` entry point, routes to narration/conversation/quest/battle based on context.
- Multi-segment system prompt: role → world → character → state → format instruction → history → user turn.
- Structured JSON output enforced via `[Output Format]` system message, with lenient fallback parsing.
- Effects-based state mutation: standardized effect types (damage, heal, get_item, move_to, start_battle) applied to GameState.
- Sliding window history (max 30 messages), stored in `state.history`.
- LLM-centered battle: damage numbers and turn resolution from LLM, not a separate engine.
- 48 prompt templates across 7 modes (~7 generator personas + sub-mode variants).

### (B) Where it OVERLAPS with our concept

| Instantale Feature | Our Match |
|-------------------|-----------|
| Multi-segment system prompt (role + world + character + state) | **DIRECT overlap** — our FIXED CACHED PREFIX (ruleset + world bible + character sheets) |
| Sliding history window | **DIRECT overlap** — our ROLLING RECENT-HISTORY window |
| Structured JSON output for state extraction | **DIRECT overlap** — our "structured state-change extraction" |
| Mode-based prompt selection (narration/conversation/quest/battle) | **PARTIAL overlap** — our "AI is DM" model needs mode dispatch too |
| Effect types as state-change protocol | **DIRECT overlap** — matches our concept of structured state deltas from LLM output |
| 6 TRPG stats (STR/CON/DEX/INT/WIS/CHA) | **PARTIAL overlap** — we need stats but ours come from ingested rulebooks |
| NPC character context from world data | **DIRECT overlap** — our world DB → LLM context pipeline |
| Quest state machine (phases, steps, events) | **PARTIAL overlap** — our quest tracking needs to be rulebook-aware |

### (C) Where it DIFFERS / what it lacks vs our concept

| What Instantale lacks | Our concept |
|----------------------|-------------|
| **Rules-as-data** (ingested rulebook → adjudicable rules) | Core moat — Instantale has NO rulebook ingestion; relies on LLM internalized RPG conventions |
| **DM seat** with human override/steering | "DM seat" with live slider: autonomous AI ↔ AI-assisted human DM |
| **Canon pen** (human confirms what's true) | Human holds canon pen; AI suggests |
| **Human steering panel** (override narration, drive production) | Key feature — steer narration, trigger music/image changes |
| **Rules-agnostic engine** (swap rulebooks) | Instantale is hardcoded to "dark fantasy TRPG" — no rulebook swapping |
| **Content policy flexibility** | Instantale embeds a safety policy directly in the conversation system prompt — we need per-rulebook content policies |
| **Consistent image gen** across session | We want consistent visuals too, but Instantale's approach is SD prompts embedded in location/character JSON — not runtime style consistency |
| **Music production** | Not yet in scope for us, but Instantale has `scripts.sounds` module |
| **Memory/context curation architecture** | Our architecture: FIXED CACHED PREFIX + LIVING STATE SUMMARY + ROLLING WINDOW. Instantale has simpler sliding window, no explicit summary regeneration |
| **World DB as source of truth** | Our concept: world generated once, persisted to DB, LLM reads from it. Instantale generates world at start, stores in `world_data` dict, no queryable DB |
| **Combat as separate subsystem** | We want JRPG-style overworld→battle transition with swappable combat. Instantale's battle is hybrid: LLM resolves but with some structure |

### (D) "Steal this" + "Don't copy" — concrete inspiration

**STEAL THIS for our web prototype:**

1. **Multi-segment system prompt layout** — Role → World → Character(optional) → State → Format instruction → History → User turn. This is proven, clean, and maps directly onto our FIXED CACHED PREFIX design.

2. **Standardized Effect protocol** — `{type, target, value, extra}` dicts for all state changes. Our structured state-change extraction should use this exact pattern. Add our own effect types for rulebook-specific mutations.

3. **Lenient JSON parsing with fallback** — The chain: strict JSON → markdown-fenced → regex-extract → wrap-as-text. Every real-world LLM deployment needs this. The DeepSeek-specific "append JSON after narrative" regex is gold.

4. **Mode-dispatch architecture** — Single entry point (`submit_action`) routes to mode-specific prompt assembly + parsing. Clean, testable, extensible. We need identical dispatch for exploration ↔ conversation ↔ combat ↔ quest.

5. **PromptManager as pure assembler** — Separates prompt construction from LLM calling. `PromptManager(mode).assemble_messages(user, world, character, state, history)` → message list. This is the right abstraction for our FIXED CACHED PREFIX builder.

6. **Dual input model** (free-text + action buttons) — Both are valid. Free-text goes to LLM directly; action buttons add structured ActionOption context. Good UX for web.

7. **Quest event processing pattern** — `process_quest_events(state, events[])` iterates LLM-returned events and matches to active quests. Our quest subsystem needs this match-and-apply loop.

8. **Character context from world data** — Stripping SD tokens from `positive_prompt` to get physical descriptions is hacky, BUT the pattern of "world data has structured character facts → marshaled into CharacterContext dataclass → injected as system message" is exactly right.

**DON'T COPY (anti-patterns):**

1. **LLM-resolved damage in battle** — "Calculate damage based on stats. Be fair but grounded." This is fragile — the LLM doesn't actually compute, it approximates. Our combat subsystem should use a deterministic engine with stats/dice, and the LLM should NARRATE the results, not invent them.

2. **No human override** — Instantale is "fire and forget" per turn. We need a review step: AI proposes narration + effects → human (or "DM seat" slider) confirms or edits → apply.

3. **SD prompt tokens as character data** — Using Stable Diffusion `positive_prompt` strings to extract physical descriptions is a hack born of coupling image generation to character data. We should have separate structured fields.

4. **Hardcoded persona ("dark fantasy TRPG GM")** — Instantale's system prompts are baked for one genre. Our system prompt must be **rulebook-derived**: "You are the GM for [system name]. The rules are: [summary]. The world is: [bible]."

5. **Safety policy embedded in conversation prompt** — Instantale's copyright/NSFW rules are hardcoded. We need configurable content policies per rulebook/table.

6. **No summary regeneration** — Instantale uses a flat sliding window with no compression. Our LIVING STATE SUMMARY (regenerated every few turns) is the right answer for long campaigns. Don't copy their "just keep the last 30 messages" approach.

7. **LLM-only dice rolls** — The `roll_required` event type has dice_roll and dc values presumably generated by the quest-referee LLM. This makes the LLM both the dice roller AND the arbiter. Our system needs an independent RNG that feeds INTO the context; the LLM interprets results.

---

## Summary Gap Map for OUR Engine

| Feature | Instantale has? | Our engine needs? | Gap |
|---------|----------------|-------------------|-----|
| Multi-segment prompt | ✅ Proven pattern | ✅ Same need | Use as-is |
| Structured JSON output + lenient parse | ✅ Robust | ✅ Same need | Use pattern |
| Effect-based state mutations | ✅ Good protocol | ✅ Same need | Extend with rulebook-specific effects |
| Mode dispatch (narration/conversation/combat/quest) | ✅ Clean | ✅ Same need | Use architecture |
| Dual input (text + buttons) | ✅ Works | ✅ Same need | Use pattern |
| Human DM seat / override | ❌ None | ✅ Core pillar | Build from scratch |
| Rules-as-data ingestion | ❌ None | ✅ Core moat | Build from scratch |
| Canon pen (human confirm) | ❌ None | ✅ Feature | Build from scratch |
| Deterministic combat engine | ❌ LLM-approximated | ✅ Core requirement | Build from scratch |
| Independent RNG + dice adjudicator | ❌ LLM-rolls | ✅ Core requirement | Build from scratch |
| World DB as canonical source | ❌ In-memory dict | ✅ Architecture goal | Build from scratch |
| Living state summary regeneration | ❌ Flat window | ✅ Architecture thesis | Build from scratch |
| FIXED CACHED PREFIX (prompt caching) | ❌ None | ✅ Architecture goal | Build from scratch |
| Music production | ✅ `scripts.sounds` | ⏳ Later | Defer |
| Consistent image gen | ✅ SD prompts in JSON | ✅ Scope (prototype) | Rebuild, don't copy |
| Content policy config | ❌ Hardcoded | ✅ Per-rulebook | Build configurable |
| Swappable combat systems | ❌ One battle mode | ✅ Add-on architecture | Build from scratch |
