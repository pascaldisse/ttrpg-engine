# Instantale Tech Analysis — Architecture, Data Model, API Surface & Portability

Analyst slice: overall tech architecture, data-driven-ness, config/data model,
external API surface, and portability gap to a hosted multiplayer web app.

Status: read `spec/ARCHITECTURE.md`, `spec/api-surface.md`, `spec/config-schema.md`,
`spec/config.json.original`, `notes/REIMPLEMENTATION-PLAN.md`, `notes/BUILD-CONTRACT.md`,
`src/app.py`, `src/config.py`, `src/data/world_loader.py`, `src/game/controller.py`,
`src/state/game_state.py`, `src/state/save_codec.py`, `src/llm/*`, `src/embedding/*`.

---

## 1. Architecture & Stack

### Runtime framework
- **Kivy 2.3** (Python desktop GUI framework) — ScreenManager-based app.
- **Single-player local desktop app** — Kivy renders its own window, no browser, no server,
  no network layer for gameplay. No multiplayer capacity whatsoever.

### Layer decomposition (from `src/` ground truth)

```
src/
├── app.py              InstantaleApp (Kivy App subclass) — ScreenManager, lifecycle, nav
├── config.py           Pydantic models for config.json (AppConfig, AISetting, etc.)
├── assets.py           Asset path resolver
├── screens/            16+ Kivy Screen subclasses (title, world_select, game, battle, etc.)
├── ui/                 HUD widgets, effects, modals, art.py (image resolution)
├── game/
│   ├── controller.py   **GameController** — central loop: submit_action(), turn resolution,
│   │                   apply_effects(), time advance, quest state machine
│   ├── conversation.py NPC dialogue subsystem
│   ├── battle.py       Combat encounter subsystem
│   ├── progression.py  Quest state machine, epilogue/game-over checks
│   ├── world_gen.py    LLM-driven world generation
│   ├── character_gen.py LLM-driven character creation
│   ├── navigation.py   Location graph / move logic
│   └── encounter.py    Encounter dataclasses
├── llm/
│   ├── base.py         LLMAdapter ABC (async chat interface)
│   ├── openai_compatible.py  OpenAI SDK adapter (DeepSeek, any OAI-compatible)
│   ├── factory.py      create_llm_adapter(provider="deepseek")
│   ├── credentials.py  Key loading: env vars → ~/.pi/agent/auth.json
│   ├── llm_config.py   Single-file config: provider/model/base_url
│   ├── prompt_manager.py  48 system prompt templates + message assembler
│   └── response_models.py Pydantic models for Narration, Conversation, Quest responses
├── state/
│   ├── game_state.py   GameState dataclass (party, inventory, quests, world_data, history)
│   └── save_codec.py   JSON serialization to slot files (~/Library/Application Support/…)
├── data/
│   └── world_loader.py World/Character/Location/Monster models, loads from assets/worlds/
├── embedding/
│   ├── engine.py       all-MiniLM-L6-v2 (384-dim sentence-transformers)
│   ├── item_matcher.py Cosine similarity over 2,216 precomputed item embeddings
│   └── db.py           Load/serve item_embeddings JSON
└── imagegen/
    └── base.py         ImageGenAdapter ABC (stub — not fully reimplemented)
```

### Data flow (exploration turn loop from GameController.submit_action)

```
Player input (text + optional ActionOption)
  → PromptManager.assemble_messages() — builds system+world+char+state+history+input
  → LLMAdapter.chat() — via OpenAICompatibleAdapter (DeepSeek)
  → response_models.parse_response() — Pydantic validation
  → _apply_effects() — damage/heal/items/move/battle to GameState
  → _elapse_time() — time-of-day cycle
  → TurnResult returned → screen updates
```

### Key architectural pattern
- **Adapter pattern**: LLM backends are abstracted behind `LLMAdapter.chat()`.
  In the current reimplementation, only one backend is wired (OpenAI-compatible → DeepSeek).
  The original had 9+ backends.
- **Controller owns state**: `GameController` is the single owner of `GameState`.
  Screens read from `app.controller`. State mutations happen ONLY through controller methods.
- **Pydantic response parsing**: LLM outputs are validated against typed schemas
  (NarrationResponse, ConversationResponse, QuestOutcomeResponse, etc.).

---

## 2. Data-Driven-ness

### World = data, loaded by engine
A "world" is defined **entirely as files on disk**, loaded by `src/data/world_loader.py`:

```
assets/worlds/<WorldName>/
├── backgrounds/
│   └── <LocationName>/
│       ├── prompts.json     {"positive_prompt": "...", "negative_prompt": "..."}
│       └── image.png        (pre-generated SD image)
├── characters/
│   └── <CharacterName>/
│       ├── prompts.json     {"category": "...", "positive_prompt": "...",
│       │                     "negative_prompt": "..."}
│       └── generated_image.png, no_bg_image.png, etc.
└── monsters/
    └── <MonsterName>/
        └── *.png            (image files only, no prompts.json typically)
```

Three shipped worlds: **Astergrave** (EN), **暮影裂界** (ZH), **ペルディション** (JP).

### What a world bundle contains
| Component | Format | Content |
|-----------|--------|---------|
| Locations | `backgrounds/*/prompts.json` | SD positive/negative prompts (image-gen instructions) |
| Characters | `characters/*/prompts.json` | category, SD prompts, persona traits, backstory, equipment |
| Art | PNG files per entity | Pre-generated SD images (characters with multiple post-processed variants) |
| Monsters | Image files only | No textual data — LLM generates monster stats on the fly |

### Mod boundary: YES, you can drop in a new world
- `list_worlds()` scans directory names → new world appears in world-select UI.
- `load_world()` parses all `prompts.json` + images from the directory.
- Adding a world = creating the directory structure + prompts.json per entity.
- World data is **purely declarative** — no code changes needed.

### What is NOT data-driven
- **System prompts** are hardcoded Python string constants in `prompt_manager.py`
  (NARRATOR_PROMPT, CONVERSATION_MANAGER_PROMPT, etc.). ~48 templates, none externalized
  to world data.
- **Rules/logic** (damage formulas, time cycle, quest phases) are hardcoded in
  `controller.py` and `progression.py`.
- **UI layout** is Kivy `.kv` strings / Python widget code, not configurable.
- **Gameplay systems** (inventory, skills, battle mechanics) are code, not data.

### Analog to OUR "load any ruleset"
- Instantale has a **content mod boundary** (worlds as drop-in data) but NO **rules mod
  boundary**. The rules engine is baked into code. This is the key gap vs. our "rules as
  data / rules as context" pillar.

---

## 3. Config Schema

`config.json` (at project root, Pydantic model in `src/config.py`):

```
AppConfig
├── version: float (0.4)
├── device_info
│   ├── memory_size, memory_bandwidth, vram_size (GB)
│   └── is_torch_cuda_usable, is_vulkan_usable (bool)
├── ai_setting
│   ├── initial_setting_applied: bool
│   ├── llm_inference: "local" | "cloud"
│   ├── local_model_setting
│   │   ├── sd_backend: {name, character/monster/background_quality, weight,
│   │   │                 advanced_setting: {taesd, vae_tiling, flash_attension,
│   │   │                                   rembg_alpha_matting}}
│   │   ├── llm_backend: "llama-cpp-completion-vulkan" (enum of 8 local backends)
│   │   ├── model_name: SD checkpoint name (e.g. "SoteMixV2.2")
│   │   └── local_llm: {name: GGUF model, weight: int}
│   ├── cloud_model_setting
│   │   ├── cloud_llm_provider: "OpenAI API" | "Anthropic API" | ... (9 options)
│   │   └── cloud_llm: model name string (e.g. "gpt-4.1")
│   ├── server_parameters: per-backend CLI flags (strings, 8 keys)
│   └── environment_setting: per-backend env vars (strings, 8 keys)
└── ui_setting
    ├── window_size: {width: 1152, height: 864}
    ├── font_size: 20
    ├── font_name: "PixelMplus10-Regular.ttf"
    └── language: "en" | "zh"
```

Key toggles: llm_inference (local vs cloud), SD quality presets, LLM provider selection.
The current reimplementation (`src/config.py`) models this faithfully but the
`GameController` currently bypasses most config and uses `src/llm/llm_config.py`
(standalone DeepSeek config file).

---

## 4. External API Surface

### Original (from spec + decompiled evidence)

| Service | Endpoint | Auth | Purpose |
|---------|----------|------|---------|
| **Anthropic Claude** | `api.anthropic.com/v1/messages` | `x-api-key` | Primary LLM (narrator, conversation, quests) |
| **OpenAI** | `api.openai.com/v1/chat/completions` | Bearer token | LLM fallback + DALL-E image gen |
| **Google Gemini** | OpenAI-compatible endpoint | API key | LLM backend |
| **OpenRouter** | `openrouter.ai/api/v1/chat/completions` | Bearer token | LLM proxy |
| **Ollama** | `$OLLAMA_HOST/api/chat` | None (local) | Local LLM |
| **llama.cpp** | local subprocess, OpenAI-compatible | None | Local GGUF inference |
| **Alibaba Qwen** | Alibaba Cloud API | API key | LLM backend |
| **HuggingFace** | HF Inference Endpoints + Hub | `HF_TOKEN` | SD model downloads + image gen fallback |
| **Relay Server** | `instantale-relay-server.onrender.com` | API key | LLM proxy + crash telemetry |
| **Diffusers/OpenVINO** | Local GPU pipeline | None | SD image generation (LCM_SoteMix_INT8_OV) |
| **all-MiniLM-L6-v2** | Local model | None | Embedding similarity (2,216 items) |

### Current reimplementation (`src/llm/llm_config.py` + `src/llm/openai_compatible.py`)

Only **one** backend is wired: **DeepSeek** (via OpenAI-compatible API).

| Item | Source |
|------|--------|
| Base URL | `DEEPSEEK_BASE_URL` env, or `api.deepseek.com` default |
| API key | `DEEPSEEK_API_KEY` env, or `~/.pi/agent/auth.json` |
| Model | `deepseek-v4-flash` (configurable in `llm_config.py`) |

### Key configuration for keys
- Env vars: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`
- File: `~/.pi/agent/auth.json` (key under `"deepseek"` provider)
- Image gen: NOT wired in this reimplementation (stub only)
- Embeddings: `all-MiniLM-L6-v2` loaded via `sentence-transformers` from HF Hub

---

## 5. Save/Persistence Format

### Format: JSON
- Schema: `GameState.to_dict()` → flat JSON with nested party/inventory/quests/history.
- Version: `0.4` (matches original).
- Location: `~/Library/Application Support/Instantale/saves/slot_<N>.json`.
- Multiple slots supported (numbered, listed via `list_slots()`).

### What is saved (`src/state/game_state.py` + `src/state/save_codec.py`)

```json
{
  "version": 0.4,
  "talent_point": 30,
  "current_world": "Astergrave",
  "current_location": "Village Heart",
  "current_character": "Halj the White Ox",
  "days_elapsed": 3,
  "time_of_day": "afternoon",
  "history": [{"role": "user/assistant/system", "content": "..."}],
  "party": { "gold": 500, "max_members": 6, "members": [...] },
  "inventory": { "max_slots": 50, "items": [...] },
  "quests": { "active": [...], "completed": [...], "main_quest_id": "", "flags": {} },
  "world_data": {},
  "flags": {},
  "main_quest_completed": false
}
```

### Notable
- **`history`** (LLM context window) is saved — full dialogue log serialized to JSON.
- No compression, no delta encoding, no cloud sync. Purely local file I/O.

---

## 6. Portability Gap → OUR Hosted Multiplayer Web App

### (A) How Instantale does it
- Python/Kivy desktop app. All computation local. API keys on user's machine.
- Worlds = directories on disk. Saves = JSON files on disk.
- Single user, single session. No auth, no sessions, no state synchronization.
- UI = native Kivy widgets with pixel fonts.

### (B) What overlaps with our concept

| Overlap | How it maps |
|---------|------------|
| **LLM adapter pattern** | `LLMAdapter.chat(messages)` → universal backend abstraction. OUR web backend needs exactly this for DeepSeek. |
| **Structured output parsing** | Pydantic models for LLM responses (NarrationResponse, ConversationResponse, Effect) — directly reusable approach. |
| **World = data, loaded by engine** | Drop-in world bundles (locations + characters + prompts.json). This is OUR "load any world bible" pattern. |
| **Prompt assembly pipeline** | PromptManager.assemble_messages() with system + world + character + state + safety + history layers — structurally matches OUR "fixed cached prefix + living state + rolling history" architecture. |
| **Quest state machine** | progression.py: start → advance_step → complete → check_epilogue. Elegant, minimal. Steal the pattern. |
| **Time-of-day cycle** | Simple morning→afternoon→evening→night loop. Good for OUR "living world" time tracking. |
| **Embedding similarity for items** | all-MiniLM-L6-v2 + precomputed vectors. Useful for OUR "smart loot / shop" generation. |

### (C) What differs or what Instantale lacks vs. our concept

| Missing in Instantale | Why it matters for us |
|----------------------|----------------------|
| **Multiplayer** | No concept of sessions, users, or shared state. We need per-session locks, DM seat, player seats. |
| **Hosted server** | Everything runs locally. We need a web server (FastAPI/Next.js), WebSocket for real-time, DB for persistence. |
| **Rules-as-data** | Rules are hardcoded Python. We need a rules ingestion pipeline (PDF → structured ruleset → cached context prefix). |
| **DM seat / slider** | No distinction between AI-DM and human-DM roles. We need an explicit DM seat with tools + autonomy slider. |
| **Memory architecture** | Simple `history` list (no compaction). We need the full DeepSeek prompt-cache + living-summary + rolling-window architecture. |
| **Combat subsystem** | Rudimentary (resolve_battle with outcome dict). We want JRPG-style decoupled combat with swappable add-ons. |
| **Image gen continuity** | No visual continuity mechanism (each image generated independently). We need consistent character portraits across sessions. |
| **Music** | Original had audio (pygame mixer), but reimplementation has none. We want AI-generated theme music. |
| **World queryability** | Fixed data loaded once. No "write path" for LLM to commit new canon. We need a queryable world DB with narrate-then-canonize. |
| **Server-side API keys** | Keys on client. We need server-held keys, never exposed to browser. |
| **No auth/accounts** | We need user accounts, session management, DM vs. player roles. |

### (D) Steal this for web + don't copy

**STEAL:**
- **World bundle format**: `worlds/<Name>/backgrounds/<Loc>/prompts.json` + characters. Perfect for OUR "game world as data." Extend with `rules.json` and `theme.json`.
- **Prompt layering pattern**: system_role → world_context → character_context → game_state → safety_policy → history → user_input. This IS our context assembly. Just move it to server-side and add a "ruleset" layer.
- **Pydantic response parsing**: Effect types (damage, heal, get_item, move_to, start_battle, text_status_effect, take_a_rest, gold_delta) — these are OUR "adjudicated effects" vocabulary.
- **Quest state machine**: Phase-based (pending→active→completed), step advancement, rewards. Lightweight and correct.
- **Embedding item DB**: precomputed 384-dim vectors for semantic item matching. Reuse for loot/shop generation in any ruleset.

**DON'T COPY:**
- **Kivy UI / desktop-only**: The entire UI layer is irrelevant. Rewrite for React/Next.js.
- **Client-side API keys**: Move ALL credentials to server env.
- **Hardcoded system prompts in Python strings**: Externalize to world/ruleset data bundles.
- **Single-user GameController**: Redesign as a server-side `SessionController` that can have N connected players.
- **Local file save/load**: Replace with DB (PostgreSQL) + JSONB for state.
- **Direct SD/OpenVINO pipeline**: Use cloud image APIs (Replicate, Stability, DALL-E) — no GPU on the server needed for prototype.
- **Monolithic Python app**: Split into API server (FastAPI) + game engine (stateful service) + WebSocket layer.
- **No content moderation in reimplementation**: Original had `check_content_violation()` — we need server-side safety filtering.

---

## Summary of Key Files

| File | Role |
|------|------|
| `src/app.py` | Kivy App entry, ScreenManager, nav |
| `src/config.py` | Pydantic config schema (faithful to original config.json) |
| `src/data/world_loader.py` | World/character/monster data loading from `assets/worlds/` |
| `src/game/controller.py` | Central GameController — turn loop, state mutations, LLM orchestration |
| `src/state/game_state.py` | GameState dataclass + save/load to JSON |
| `src/state/save_codec.py` | Slot-file save management |
| `src/llm/prompt_manager.py` | ~48 system prompt templates + message assembler |
| `src/llm/response_models.py` | Pydantic models for LLM output parsing (Effect, NarrationResponse, etc.) |
| `src/llm/openai_compatible.py` | OpenAI SDK adapter (DeepSeek backend) |
| `src/llm/credentials.py` | API key loading (env → ~/.pi/agent/auth.json) |
| `src/llm/llm_config.py` | Single-file LLM config (provider, model, base_url) |
| `src/embedding/` | all-MiniLM-L6-v2 item similarity (2,216 items) |
| `spec/ARCHITECTURE.md` | Reconstructed high-level architecture from decompiled binary |
| `spec/api-surface.md` | Full API contract (9 LLM backends, 4+ image backends, relay) |
| `spec/config-schema.md` | config.json schema reference |
| `notes/REIMPLEMENTATION-PLAN.md` | Phased build plan for macOS reimplementation |
