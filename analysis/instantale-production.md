# Instantale Production & Atmosphere Analysis

> Source: `~/projects/instantale-mac` — Kivy reimplementation of original Nuitka-compiled game.
> Our prototype: web app, atmosphere-first, consistent image-gen, AI+curated music, DM seat.

---

## 1. IMAGE GENERATION

### (A) How Instantale does it

**API/Model:**
- `src/imagegen/base.py` is a **stub** — `ImageGenAdapter` ABC with `generate(prompt, negative_prompt, width, height, quality) -> bytes`. No implementation merged.
- `notes/IMAGE-GEN-PLAN.md` specifies provider order: (1) DeepInfra `stabilityai/sdxl-turbo` (lowest cost, ~$3.50 credit), then (2) fal.ai anime-SDXL/Fooocus.
- Original used `SoteMixV2.2` (config.json `ai_setting.local_model_setting.sd_backend.name: "diffusers_openvino"`), a local SD anime model, with quality presets per entity type: `lowres_faster`, `medium`, `highres`.
- **Status: NOT implemented.** Plan explicitly says "Do not build/run generation without explicit user approval."

**Prompt construction (per entity, NOT from narration):**
- Each location has `assets/worlds/<world>/backgrounds/<name>/prompts.json`:
  ```json
  {
    "positive_prompt": "masterpiece, best quality, watercolor, fantasy setting, cave, A deep jagged chasm...",
    "negative_prompt": "photoreal, modern, urban, people, person, human, 1girl, 1boy"
  }
  ```
- Each character has `assets/worlds/<world>/characters/<name>/prompts.json` with `category`, `positive_prompt` (full-body SD), `negative_prompt`, plus `traits`, `backstory`, `personality`.
  ```json
  {
    "category": "young woman",
    "positive_prompt": "full-body, masterpiece,high quality, detailed face, medieval, dark fantasy, watercolor, standing,shabby, young woman, wiry build...empty background,black background,wallpaper",
    "negative_prompt": "photoreal, (worst quality, low quality:1.4), nsfw, ..."
  }
  ```
- Locations also have `background_prompt` in world data (`GAME-FLOW-SPEC.md §3.5`) — a string field on `LocationData` specifically for SD.
- **Prompts are PRE-AUTHORED, not dynamically assembled from narration or scene context** in the reimplementation. The original's `llm_manager_world_generate` presumably generated both the description and the prompt, but in the reimpl, prompts.json ships with the world data.

**When images are triggered:**
- Rule: **prefer bundled `image.png`; generate ONLY when missing AND user approved** (`IMAGE-GEN-PLAN.md`).
- Bundled art: 510 images across 3 preset worlds (122 backgrounds, 233 character portraits, 155 monsters) — but backgrounds have **only prompts.json, NO images** (confirmed by `world_loader.get_background_image()` returning None and `art.py` falling back to placeholders).
- Character/monster images exist: `reduced_color_image.png`, `no_bg_image.png`, `generated_image.png`, `face_image.png`, `pixelated_image_original.png`, `base_image.png`, `add_border_image.png`.
- Resolution priority chain in `src/ui/art.py`:
  - Backgrounds: `reduced_color_image.png` → `generated_image.png` → `image.png` → placeholder
  - Characters: `reduced_color_image.png` → `no_bg_image.png` → `generated_image.png` → `face_image.png` → `pixelated_image_original.png` → placeholder
  - Monsters: `reduced_color_image.png` → `base_image.png` → `pixelated_image_resized.png` → `add_border_image.png` → placeholder

**Visual consistency/continuity — almost NONE:**
- **Style anchors** (informal, in prompts only): shared prefix tokens — `"masterpiece, best quality, watercolor, dark fantasy"`, `"empty background, black background, wallpaper"`, `"medieval"`. These appear in essentially every prompt.json.
- **No seed management**: no seed field in prompts.json or code.
- **No reference-image mechanism**: no img2img, no IP-Adapter, no "use this character's pose from turn 1".
- **No per-world art direction string** — just the shared tokens above.
- **Post-processing pipeline** (`scripts.image_processing.*`, 7 modules, referenced in `spec/api-surface.md` and `spec/maps/modules.txt`):
  - `image_to_pixel` → pixel art conversion
  - `reduce_color` → palette reduction
  - `dark_fantasy_tone` → color grading
  - `darken_image` → darken
  - `add_border` → border
  - `face_crop` → face region crop
  - `request_remove_background` → rembg
  - This pipeline is the **only** consistency mechanism — all images pass through the same post-processing to match the game's pixel/dark-fantasy aesthetic.
- **Caching**: Plan specifies `assets/gen_cache/<hash>.png` keyed by `hash(model, prompt, negative_prompt, size, seed)`. Not implemented.

**Current placeholder system** (`src/ui/art.py` `_make_placeholder()`): Generates dark-purple-black PIL tiles with parchment-colored text labels. Not AI-generated.

### (B) Overlap with our concept
- Pre-authored per-entity prompts with shared style prefix is a simple version of "per-world art direction".
- Post-processing pipeline for unified aesthetic is directly applicable.
- "Never regenerate" caching principle is aligned.
- Bundled art + generation as fallback matches our hybrid approach.

### (C) Differences / what it lacks
- **No dynamic prompt generation from narration/scene/emotion.** Our concept would generate prompts from the "what's happening now" context, not just from pre-authored location strings.
- **No seed/consistency infrastructure.** We need style anchors + reference images + seed management across a session.
- **Image gen is offline/pre-authored, not real-time in the turn loop.** Our web prototype needs session-time generation (or clever pre-generation + caching).
- **No mood-to-image mapping.** No "this scene is tense → darker, higher contrast" logic.
- **Desktop-only** (Kivy + local SD via diffusers_openvino). We can't run local SD in browser.

### (D) Steal this for web
| Technique | Steal? | How to adapt |
|-----------|--------|-------------|
| Prompt-per-location JSON with shared style prefix tokens | **YES** | Use as "world art direction" — generate once from world-gen LLM, reuse forever |
| Post-processing pipeline (pixelate, reduce-color, darken) | **YES** | Run server-side via wasm-free sharp/PIL; bake into generation pipeline |
| Cache by hash(model+p+np+size+seed) | **YES** | Perfect fit for server-side cache; add session-ID prefix |
| Pre-generated images for fixed content + gen for dynamic | **YES** | Our model exactly: pre-gen per ruleset, gen for player-driven content |
| `background_prompt` field on LocationData | **YES** | Extend: add `mood_overrides` map (combat→"chaotic battle scene", etc.) |
| Stub adapter pattern (`ImageGenAdapter` ABC) | **YES** | Swap between providers (Replicate/DeepInfra/own GPU) easily |

**Don't copy:**
- Kivy desktop rendering — must reimplement UI in web (React/Svelte).
- Local sd_backend (diffusers_openvino) — not portable to web; use cloud API or server-side only.
- No seed management — critical gap for our consistency goals.
- Prompts that are fully hand-authored — we'll generate them from world context + mood.

---

## 2. AUDIO / MUSIC

### (A) How Instantale does it

**Music: CURATED/BUNDLED, not AI-generated.**
- `spec/DATA-INVENTORY.md` describes: **16 WAV sound effects + OGG music tracks**, organized by location/mood.
- **No AI music generation anywhere.** The original had a `scripts.sounds` module (address `0x151853500`) but it was purely playback, not generation.
- The `GAME-FLOW-SPEC.md §6.4` explicitly says `scripts.sounds` is "not needed for reimplementation — audio playback can be reimplemented from scratch."
- **Current reimplementation: NO audio code whatsoever.** No sound files in `assets/`. No music playback. Kivy's `kivy.core.audio` is available but unused.
- Music was **not vendored** (gitignored), only documented in DATA-INVENTORY.md.

**Asset sound tree** (from `spec/DATA-INVENTORY.md`):
```
musics/
├── city/
│   ├── calm.ogg
│   ├── eerie.ogg
│   ├── heroic.ogg
│   ├── lively.ogg
│   └── majestic.ogg
├── dungeons/
│   ├── anxiety.ogg
│   ├── desolate.ogg
│   ├── eerie.ogg
│   ├── mystic.ogg
│   ├── scary.ogg
│   ├── silent.ogg
│   ├── solemn.ogg
│   └── tense.ogg
└── village/
    ├── calm.ogg
    ├── desolate.ogg
    ├── eerie.ogg
    ├── mystic.ogg
    └── solemn.ogg

sounds/ (16 WAV files)
├── ui/
│   ├── 常時 (ambient).wav
│   ├── 拠点 (base).wav
│   ├── 労働 (work).wav
│   └── クエスト (quest).wav
```

**Selection logic:**
- Per-location type: city / dungeon / village determines the base bucket.
- Per-mood: calm, eerie, heroic, anxiety, desolate, mystic, scary, silent, solemn, tense, lively, majestic.
- No dynamic crossfading, no adaptive layering, no real-time mixing detected in decompiled code.
- Simple: pick OGG file from the right subfolder, play it.

### (B) Overlap with our concept
- **Mood-based music selection** — exactly our plan for "option of curated soundtrack."
- Location-type buckets (city/dungeon/village) map to our concept of "per-location atmosphere."
- Sound effects by context (ui/base/quest) mirrors our event-driven SFX plan.

### (C) Differences / what it lacks
- **No AI-generated theme music.** Our concept includes AI-generated music as a first-class feature; Instantale has none.
- **No dynamic/adaptive audio** — no layering, no intensity ramping on combat, no crossfading on location change.
- **No web-friendly format** — OGG is fine, but Kivy audio backend is desktop-specific.

### (D) Steal this for web
| Technique | Steal? | How to adapt |
|-----------|--------|-------------|
| Location→mood→track mapping structure | **YES** | Perfect tag-to-file model; extend with DM's mood knob |
| City/dungeon/village bucket categorization | **YES** | Add more buckets: wilderness, combat, tavern, ritual |
| Per-context SFX (ui, base, quest) | **YES** | Great model for our event-driven audio triggers |
| Curated OGG files as bundled assets | **YES** | Ship a curated base soundtrack, augment with AI-gen |

**Don't copy:**
- Kivy audio backend — use Web Audio API.
- Static track selection (no transitions/crossfade) — we want smooth transitions.
- No AI music gen — we're building it.
- Missing ambient/atmospheric layers (only discrete tracks) — we want layered ambience.

---

## 3. SCREEN / SCENE FLOW & UX

### (A) How Instantale does it

**UI Framework: Kivy** (Python, desktop-only).
- `src/app.py` instantiates `ScreenManager` with all screens.
- Navigation via `self.manager.current = "screen_name"` + `app.nav` dict for params.

**Full screen flow** (18 screens registered):

```
BOOT
  │
  ▼
Initial Setting (first launch only — detect device, config AI)
  │
  ▼
Title Screen (New Game / Continue / Settings / Quit)
  │
  ├─→ World Select (list existing worlds + "Create New World")
  │     │
  │     ├─→ World Create (name, theme, tone, seed → LLM generates areas)
  │     ├─→ World Delete (confirmation)
  │     └─→ World selected → Character Select
  │           │
  │           ├─→ Character Create (name hint + seed → LLM generates stats/backstory)
  │           └─→ Character selected → GAME SCREEN (main exploration)
  │                 │
  │                 ├──→ Conversation (overlay: NPC portrait, dialogue log, text input)
  │                 │     └─→ triggers Battle on hostile action
  │                 ├──→ Battle (separate screen: enemy portrait, HP bars, turn loop)
  │                 │     └─→ Victory → back to Game | Defeat → Game Over
  │                 ├──→ Inventory (item list, equip, use, drop)
  │                 ├──→ Character Sheet (stats, equipment slots, skills)
  │                 ├──→ Quest Log (active/completed quests)
  │                 ├──→ Move (location picker from reachable locations)
  │                 ├──→ Save/Load (slot selection)
  │                 ├──→ Options (settings overlay: language, volume, save/load)
  │                 └──→ Menu (back to title)
  │
  └─→ Continue (load saved game)
```

**In-play layout** (`src/screens/game_screen.py`, the "new_hud" equivalent):
```
┌──────────────────────────────────────────┐
│  BACKGROUND IMAGE (top 35%)              │
├──────────────────────────────────────────┤
│ [ Location Name ]      Morning, Day 1    │
├──────────────────────────────────────────┤
│  NARRATION TEXT (scrollable, ~18%)       │
│  "You survey the area..."                │
├──────────────────────────────────────────┤
│  Status: "Moved to Village Square"       │
├──────────────────────────────────────────┤
│ Present: [NPC1] [NPC2] [NPC3] ...        │
├──────────────────────────────────────────┤
│ [Talk] [Move] [Items] [Party] [Menu]     │
├──────────────────────────────────────────┤
│ [____________________text input____] [Act]│
└──────────────────────────────────────────┘
```

- Widgets: Kivy `BoxLayout`, `Label`, `Button`, `TextInput`, `ScrollView`, `Image` (AsyncImage for battle).
- Dark-fantasy palette: BG `(0.02, 0.02, 0.04)`, cards `(0.08, 0.07, 0.05)`, text parchment gold `(0.9, 0.88, 0.78)`, accent `(1, 0.85, 0.55)`.
- Fonts: 7 pixel fonts in `src/assets/fonts/` (JF-Dot, KH-Dot, PixelMplus families), default `PixelMplus10-Regular.ttf`.
- Turn loop: input → background thread LLM call → poll via `Clock.schedule_interval` → render result.
- Text queue: `narration_label.text = result.narration` (overwrites, not appends — single-turn display; conversation screen does append).

### (B) Overlap with our concept
- Screen flow mirrors our planned navigation (world→character→play).
- Free-text + button hybrid input maps to our "DM seat" + player input channels.
- Dark fantasy visual palette is reusable.

### (C) Differences / what it lacks
- **Desktop-only Kivy** — can't port widgets to web. Must rebuild in React/Svelte/HTMX.
- **No DM seat UI** — no override narration, no mood knob, no canon-confirm button.
- **No multiplayer** — single-player desktop game.
- Single-text-input model (no structured action builder beyond button shortcuts).
- Narration overwrites, doesn't append — less "log" feel, more "current scene."
- No image alongside narration (image is fixed per-location background, not per-scene).

### (D) Steal this for web
| Technique | Steal? | How to adapt |
|-----------|--------|-------------|
| Screen flow architecture (world→character→game→end) | **YES** | Same skeleton; add DM seat panel |
| Hybrid text+button input | **YES** | Free text + suggested actions from LLM |
| Dark fantasy color palette + pixel font aesthetic | **YES** | CSS variables; optionally pixel fonts |
| Location background as scene anchor | **YES** | Per-location image + per-scene generated image |
| Background-thread LLM + polling pattern | **YES** | Web equivalent: fetch + streaming or polling |
| `app.nav` dict pattern for inter-screen params | **YES** | URL params / React context / Svelte store |

**Don't copy:**
- Kivy widget tree — rebuild in web framework.
- Overwrite-text narration (single-turn) — we want scrolling chat/history.
- Monolithic `game_screen.py` (→900 lines of widget-building in one file) — separate components.

---

## 4. COMBAT / MODE SWITCHING

### (A) How Instantale does it

**YES — combat is a separate screen (battle_screen.py), not an overlay.**

**Handoff mechanism:**

```
Exploration (game_screen)          Conversation (conversation_screen)
        │                                    │
        │  LLM returns start_battle effect   │  LLM reply.action == "start_battle"
        │  OR quest referee triggers battle  │
        │                                    │
        ▼                                    ▼
  TurnResult.battle = Encounter(...)
  app.nav["encounter"] = encounter
  self.manager.current = "battle"
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
              BattleScreen.on_pre_enter()
                reads controller.pending_encounter()
                builds EnemyData + PlayerBattleData
                inits BattleEngine
                       │
              ┌────────┴────────┐
              │  TURN LOOP      │
              │ Player describes │
              │ attack in text   │
              │      →           │
              │ engine.player_   │
              │ turn(action)     │
              │      →           │
              │ LLM resolve      │
              │      →           │
              │ apply damage     │
              │      →           │
              │ check victory    │
              │      →           │
              │ engine.enemy_    │
              │ turn()           │
              │      →           │
              │ LLM resolve      │
              │      →           │
              │ check defeat     │
              └────────┬────────┘
                       │
                 victory / defeat / flee
                       │
                       ▼
              controller.resolve_battle(outcome)
              → applies loot, XP, party HP
              → returns to game screen (or gameover on party wipe)
```

**Triggers (from GAME-FLOW-SPEC.md §2.8):**
1. Player taps NPC → conversation → NPC becomes hostile → `start_battle_with_in_conversation()`
2. Quest `event_type: "battle"` → quest referee triggers combat
3. Quest `event_type: "encounter_final_boss"` → boss battle
4. Quest `field_event` with hostile roll → random encounter
5. Player free-text "attack the ..." → narration LLM returns `start_battle` effect

**Battle UI layout** (`battle_screen.py`):
```
┌──────────────────────────────────────────┐
│  [Monster Image]  Shadow Beast [Category]│
│                   HP: 42/45              │
├──────────────────────────────────────────┤
│  Party: You (Lv.1) | HP: 85/100          │
├──────────────────────────────────────────┤
│  Battle Log (scrollable, ~55%)           │
│  > I slash with my sword                 │
│  Your blade cuts deep into the beast...  │
├──────────────────────────────────────────┤
│ [______________describe attack____] [Act]│
│ Status: Your turn.                       │
└──────────────────────────────────────────┘
```

**Battle engine** (`src/game/battle.py` — `BattleEngine`):
- Uses `PromptManager(mode="battle")` for role prompt + JSON output format.
- Enemy AI: LLM-driven action selection (mirrors original's 10k-line impl at `0x1513A1F70`).
- Damage calculation: stats-based, resolved by LLM (not dice formulas).
- End states: `player_victory`, `player_defeat`, `flee`, `ongoing`.

**No exploration↔combat mode switch mid-turn** — once in battle, you're in battle until resolution. No "escape to exploration for one action then return."

### (B) Overlap with our concept
- Separate combat mode with distinct UI = our "JRPG overworld→battle handoff" concept.
- LLM-driven combat resolution (not crunchy dice sim) = our "AI adjudicates" pillar.
- Battle→game screen return with state mutation = correct architecture.

### (C) Differences / what it lacks
- **No swappable combat add-ons** — the battle engine is hardcoded LLM-driven turn-based, not a pluggable subsystem.
- **No dice-roll transparency** — all LLM-resolved, no visible DC checks or dice rolls.
- **No "surprise round" or initiative** — just player-then-enemy alternating.
- **Party of 1** — only first party member used in battle; no multi-character turn order.
- **No combat→exploration re-entry during same encounter** — it's an all-or-nothing screen.

### (D) Steal this for web
| Technique | Steal? | How to adapt |
|-----------|--------|-------------|
| Battle as separate screen with `Encounter` data object handoff | **YES** | Our "combat subsystem" architecture exactly |
| LLM-driven natural-language combat (not rigid command menu) | **YES** | Default combat mode; add dice overlay for rules-heavy |
| `resolve_battle(outcome)` → state mutation on return | **YES** | Clean boundary between combat and exploration state |
| Turn loop: player → LLM → enemy → LLM → repeat | **YES** | Keep; add initiative ordering for multi-party |

**Don't copy:**
- Single-player-only party handling — we need multi-character turn order.
- No dice transparency — our rules-agnostic engine needs visible DCs and rolls.
- Hardcoded battle engine — should be swappable plugin (narrative-only, tactical grid, etc.).

---

## 5. ATMOSPHERE MAP FOR OUR WEB PROTOTYPE

### What Instantale's desktop assumptions won't port
| Desktop assumption | Web blocker |
|-------------------|-------------|
| Local SD generation (diffusers_openvino + SoteMix model) | Can't run in browser; must use server-side or cloud API |
| Kivy widget tree + Canvas primitives | Complete UI rebuild in React/Svelte |
| Kivy `core.audio` MP3/OGG playback | Web Audio API |
| File-system cache (`assets/gen_cache/`) | Server-side cache or IndexedDB |
| Pre-bundled 510 images in vendored `assets/worlds/` | Must serve images via CDN or pre-generate on server |
| Synchronous file I/O for image loading | Async fetch with loading states |
| Single-player state in memory | Multiplayer state management |

### Techniques to steal (prioritized for atmosphere-first prototype)

1. **Per-location `prompts.json` with shared style prefix** — every location has a `positive_prompt` and `negative_prompt` with shared tokens (`"watercolor, dark fantasy, masterpiece"`). Extend this: add a per-world "art direction" string injected into every prompt + seed the first image and derive subsequent seeds.

2. **Post-processing pipeline** — `image_to_pixel → reduce_color → dark_fantasy_tone` unifies all generated images. Run server-side on every image; makes any model output visually consistent. This is the single most valuable steal.

3. **Mood→music mapping** (city/dungeon/village × calm/eerie/heroic/etc.) — simple tag-to-file model. Extend with DM's mood knob that biases selection (e.g., "tense → 70% anxiety, 30% desolate").

4. **`ImageGenAdapter` ABC** — swap providers without touching game logic. Mirror this for our backend: adapter interface with Replicate, DeepInfra, fal.ai implementations.

5. **Cache-by-hash** — `hash(model, positive_prompt, negative_prompt, size, seed)` as cache key. Add session/world prefix in our version.

6. **Placeholder tiles on missing images** — `_make_placeholder()` generates dark-fantasy themed fallback tiles. Web version: CSS-only placeholders or cached server-side tiles.

### Critical gaps WE must fill (Instantale doesn't address)
- **Visual consistency across a session**: seed management, reference-image system, per-world style string injection, character pose/look preservation across scenes.
- **AI-generated music**: not present. We need to build it.
- **DM seat UI**: mood knob, narration override, canon-confirm button. None in Instantale.
- **Real-time streaming**: Instantale uses blocking LLM calls in background threads. We want streaming SSR/SSE.
- **Multiplayer web**: Instantale is single-player desktop.
