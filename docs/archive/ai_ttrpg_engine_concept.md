# AI-Assisted TTRPG Engine — Concept Document

*A rules-agnostic, AI-powered tabletop RPG engine where the AI is the Dungeon Master's instrument, not its replacement.*

---

## Core Premise

A tabletop RPG engine that can become **any** RPG by loading a ruleset. You upload a rulebook (PDF, markdown), and the engine runs a coherent, adjudicated campaign on it — narration, dice, NPCs, story — with AI handling the rules and the production, while a human stays free to be the storyteller.

The thing that makes it new: **the AI is the DM's instrument, not the DM's replacement.** Most AI-RPGs are "the AI is the DM and you obey it." This is "the AI is the rules-engine and the production crew; the human brings imagination and taste." It scales smoothly from fully-autonomous AI DM to human-DM-with-AI-power-tools.

The personal motivation behind it: *liking the creative half of DMing without wanting to memorize 300 pages of rules.* The barrier to running a great game stops being "did you learn the whole rulebook" and becomes "do you have good ideas and a feel for a story."

---

## The Rules System

### Two approaches, split by *who holds it and when*

**Rules-as-context (play time, always).**
The player never waits for a compile. Drop in a PDF or markdown ruleset, and the engine just *runs* on it — flexible, story-first, frictionless. This is the campfire experience.

**Rules-as-data (build time, authoring tool).**
A heavier process run *once* by a creator (official partner or modder) to produce a polished, structured, tested add-on. The buyer downloads something already baked — structured ruleset *plus* context, QA'd and consistent. They never compile anything; they get the compiled artifact.

So rules-as-data was never the player's burden — it's the **workbench**, and the workbench is itself a product shipped to creators.

### Why rules-derivation is the moat

Anyone can wire an LLM to generate an NPC. Almost nobody can build a system that ingests an arbitrary human-written rulebook and produces a *consistent, adjudicable* ruleset that holds together across a long campaign without contradicting itself. That's the genuinely hard, genuinely defensible part — and the thing a frontier reasoning model unlocks.

---

## Context & Consistency Architecture

The whole engine sits on one question: *can rules-as-context hold a real ruleset together for a long session on a model you can afford to run?*

### Cost model

DeepSeek V4 as the runtime model — extremely cheap, with a native **1M-token context window at no surcharge** and aggressive prompt caching. The key insight for a TTRPG: the **ruleset and world bible are a fixed prefix**, identical on every call in a session. Cache it once, and every turn after pays full price only for the *new* stuff (player action, recent history) while the giant rulebook rides along nearly free.

### A big window doesn't save you from context management

1M tokens of room does **not** mean fill it. Two problems hit before you run out of space:

- **Attention degradation** — models get worse at using info buried deep in very long contexts, even when it technically fits. A fact at token 400k gets "forgotten" in practice.
- **Consistency drift** — over a long session the model loses the thread of established facts (this NPC is dead; the child is named Aya; this faction hates that one) unless they're actively maintained in compact, high-salience form.

### The architecture that works — curation, not accumulation

- **Fixed cached prefix** — ruleset + world bible + character sheets. Never changes mid-session, stays cached and cheap.
- **Living state summary** — a compact, structured "what is true right now" (party HP, inventory, active quests, who's dead, key relationships, recent decisions). Regenerated/updated every few turns, kept near the *end* of context where attention is strongest.
- **Rolling recent-history window** — the last N turns verbatim; older turns get *compressed* into the state summary rather than kept raw.

That summarize-and-evict loop is the whole game. The thing worth studying in other AI-RPGs is **not** how they generate content — it's how they decide what to keep, compress, and throw away. Generation is the easy, visible part; memory architecture is the invisible part that determines whether a session survives hour three.

---

## The DM Seat (the heart of the project)

The host of a session can take an **admin / Dungeon Master role** — and this isn't a bolt-on feature, it changes what the app fundamentally *is*. The AI is the DM's *instrument*. The human stays the storyteller; the app is the rules-engine and production crew.

### What the DM seat holds

- **Steer the narration** — nudge, redirect, or override the AI's narration before/as it lands. The AI drafts; the human has veto and redirect.
- **Drive the production** — pick/swap music, set the visual mood for image generation ("everything darker, more rain"), trigger images on demand. The atmosphere knobs are the human's.
- **Hold the canon pen** — the human decides what's true. The AI suggests, the human confirms. This is also the consistency safety valve: a human in the loop catches contradictions an autonomous AI-DM would commit, which makes the whole living-world problem dramatically easier.

### Build it DM-seat-first

Build "**the DM seat has these tools**," with the AI as the *default occupant* of that seat. Don't build "AI runs the game" and wedge a human in later. The architecture that assumes a human *can* hold the controls also runs fine when the AI holds them — not vice versa.

- No one takes the seat → AI runs it autonomously (standard AI-RPG).
- Someone takes the seat → AI-assisted human DMing.
- Same engine, two modes, with a live slider between them. That slider is the thing nobody else offers.

**The pitch:** *You bring the imagination and the taste; the app handles the rules, the dice, the art, the music, and the memory.*

---

## Distribution & Marketplace

### Free modding commons + official paid partners

- **Normal users share, never sell.** No open paid marketplace for regular users — deliberately. A paid open market turns you into a payments company, tax handler, refund desk, fraud unit, and copyright cop overnight (people immediately upload rulebooks they don't own and charge for them). Free-only kills that whole class of problem at the root.
- **Culture selection.** Paid-open selects for hustle (SEO-spam, asset flips, paywalled drip). A free commons selects for *love* — people making the thing because they want it to exist. Better content, kopimi-adjacent.
- **Revenue comes from official licensed add-ons.** Real publishers (Wizards/D&D, Ulisses/DSA, Chaosium/Call of Cthulhu) come to *you* because you're the distribution layer with the engine and the audience. They bring the license, you bring the platform, you split it. Clean money, no moderation nightmare attached.

This is the Tabletop Simulator model: a huge, mostly-free Workshop + a small shelf of official paid DLC from real publishers.

### Modder tools

Release the rules-as-data authoring tools **free** to modders, so the best community creators can match official quality. Gate *paid/official* content behind a validation/certification pass; free content can be wild-west. Same pipeline, certification only where money or IP is involved.

### Protecting partner IP

Because official add-ons ship **pre-compiled with context**, a partner's rules-as-data artifact can be sealed/encrypted — the buyer gets a runnable module, not a plaintext dump of the whole rulebook. That's what makes a real licensing conversation possible; nobody licenses IP if the output is a copyable markdown of their book on the customer's disk.

### Offline vs. online split (solves copyright two ways)

- **Offline + Steam Workshop** — inherit Valve's moderation and hosting; Workshop content lives under Steam's DMCA umbrella, not yours. You're a game that reads local files; what the user loads is their business.
- **Online, per-user private sessions** — let people upload anything to *their own* sessions (like keeping a PDF in their own Dropbox — defensible). Keep multiplayer **invite-only**, never public/listed. Never index or surface user-uploaded rulesets publicly. The line: private upload for own use = fine; content becoming discoverable/redistributable to people who didn't upload it = distribution, and murkier.
- **Public listings** stay limited to free community mods + official paid partners.
- Keep a **takedown path** ready regardless — free doesn't make infringing content legal, but it's a vastly smaller problem than policing paid theft.

---

## First Iteration (prototype scope)

A **web app**, hosted, **multiplayer** — because you test a tabletop game by *playing it with people*. That's how the game is meant to be played.

**Focus: atmosphere, not features.**
- Consistent **image generation** (visual continuity across a session).
- Good **narration** and storytelling.
- **Music** — AI-generated theme music *and* the option of a curated soundtrack to play.
- Just enough **world-state plumbing** to stay coherent across a session (state summary, who's where, what's true).
- The **DM seat**, with the AI as default occupant.

**Explicitly later:** world generation, marketplace, offline mode, combat add-ons beyond a default.

### First ruleset targets

- **D&D 5e first — to prove the *loop*.** The model knows 5e cold from training, so you can run a playable session *now* (even context-free) and test atmosphere + loop + DM seat + multiplayer in isolation, before the ingestion pipeline is solid. One unknown at a time.
  - *Caveat:* D&D-from-memory proves the loop, **not** the engine. It can look perfect while the rules-derivation is hollow. Don't mistake it for proof of concept.
  - *Optional intermediate step:* run 5e with the SRD loaded, to test the ingestion path on a ruleset the model also knows — catch pipeline bugs on familiar ground.
- **DSA (Das Schwarze Auge) — to prove the *engine*.** The adversarial case: under-represented in training data, genuinely different mechanics (3d20 attribute probes, roll-under), German source material. If the pipeline runs a coherent, correctly-adjudicated DSA session, the rules-derivation thesis is proven. *That's* the moment the project is real.

### Combat

Combat is its **own subsystem**, decoupled from exploration — a separate mode you drop into when an encounter triggers (classic JRPG overworld→battle-screen pattern). Default combat mode ships with the engine; it can be swapped/expanded via add-ons (tactical, card-based, narrative). The exploration layer just hands off "a fight happens here" and gets back "it resolved this way."

---

## Future: World Generation

*(Post-prototype. The ambitious layer — intended to be built with a frontier reasoning model.)*

### Generate a real world, not just context

A world the player can actually **explore** — a map with stuff in it, Dwarf-Fortress-style world-gen but less complex. The map is a **worldview / exploration layer**, not a combat grid. You run around, you find things.

### The critical principle: generate once, into fixed data

The world must be **generated once, serialized to data, and then it just exists.** It is *not* the LLM imagining the map fresh each time you move — that's the failure mode (drift, contradiction, forgetting). A real world is a fixed artifact the engine renders and the LLM *reads from*, never re-invents.

### Two-pass generation

**Generation time (once per world):**
- **Procgen builds the bones** — heightmap, biomes, rivers (drainage sim), settlement placement (poisson-disk spacing), territories (Voronoi), dungeons, roads. Mostly *not* an LLM job — classic deterministic procgen. Guarantees the world is **navigable and fair** (nothing unreachable, sensible spacing).
- **LLM charges it with meaning** — reads the structure and authors the *why*: who's in that tower and what they want, why this kingdom hates that one, which quest connects this ruin to that village. This is what makes each world *story-shaped* and unique rather than just procedurally varied. Frozen into the world data at generation.

Keep the boundary sharp: procgen places **structural** things (guaranteed reachable), LLM places **narrative** things (the soul). Let the LLM place structure → unreachable nonsense. Let procgen place narrative → soulless radiant-quest feeling.

**Runtime:**
- The LLM **never touches map geometry.** It reads world-state for the location it's in and narrates/adjudicates against fixed data. The world bible *is* the cached prefix — now it's the whole generated world, cheap and consistent.
- **Discovery loop:** the map shows *where* (a tower); the LLM reveals *what it means* on contact (the grief-stricken hermit who knows about the crypt). The gap between seeing-the-place and learning-its-story is what makes wandering compelling instead of mere traversal.

### Tilesets (pure presentation, clean add-on category)

The world generates as **abstract semantic data** ("shallow water," "stone floor," "forest"). A tileset is just a **skin** mapping those tags → images. Swap the tileset, the same world renders Diablo-gloomy or bright JRPG or hand-drawn — nothing about the world changed, only the tag→sprite lookup. Zero gameplay logic, can't break anything → perfect free-community-mod material.

- Ship with solid **default sets** (dark-fantasy Diablo-ish, clean JRPG).
- **AI-generated tilesets** are a *different kind of AI* (image-gen, not language) — keep it architecturally at arm's length from the DM runtime. It's a content tool: "generate a 32×32 tileset for these semantic slots in this style." Both human-made and AI-made sets drop in through the same tag-mapping interface.

### The dream: a *living* world

This is the actual reason to build the project. Everything else is a prettier version of a classic RPG; the living world is the thing only AI can do — and the thing every other AI-RPG has done badly.

**The honest problem:** a living world is a consistency problem that *compounds.* A static world has to be self-consistent once. A living world has to stay consistent with itself *and* the player's actions *and* everything it previously improvised, forever, as it grows. Living worlds don't fail because the AI can't invent — they fail because it can't *remember what it already invented* well enough to stay true to it.

**The unlock:** the world grows by **writing back into the same fixed, queryable data structure** the static world lived in. "Living" is not free improvisation into context — it's the DM-LLM *committing new canon* to the world database, in the same format as the original placements. Improvisation happens *once*, at authoring, then it's frozen and binding like everything else. The hermit invented in hour three is in the database by hour four.

So living isn't a different runtime mode — it's the *same* read-from-fixed-data runtime **plus a write path.** The DM can read the world (always) and commit new canon (deliberately).

**Concrete architecture for the hard part:**
- **Canon-commit step** — when the DM improvises something with lasting consequence (new NPC, location, plot thread, faction shift), it triggers a *structured write* into world state. Two-phase: **narrate freely first, canonize second** — a separate pass distills the narration into canonical data. Prose stays alive; the *record* stays disciplined.
- **Consistency-on-write, not on-read** — check coherence at the moment of authoring, when there's one new fact to validate against existing canon (cheap, local, tractable). Don't try to keep a giant context internally consistent every turn (unwinnable).
- **World state is the source of truth; context is just a working window** — in naive living worlds the *context* is the world, so it rots with the window. Here the *database* is the world; the context can forget freely because nothing important lives only there.

This is literally modeling the **DM's notebook**: improvise in the moment, write it in your notes, and from then on it's canon you're bound by. The improvisation is the magic; the notebook is what makes it *stick* and cohere into a world instead of evaporating.

**The open design question:** what's worth committing to canon vs. ephemeral? "The tavern was smoky" (flavor, forget it) vs. "the tavern-keeper's brother was murdered by the count" (canon, must persist, binds the future). Deciding what crosses that line — what the DM-LLM has earned the right to make permanent — is the actual heart of the system.

**Prototype path to get there without drowning:** build the **static** version first (fixed world, read-only at runtime) — but build it on the **world-database-as-source-of-truth** architecture from day one, *not* world-in-context. Get read-from-fixed-data solid. *Then* add the write path. If the read architecture is right, living is an *addition*, not a rewrite. Build world-in-context and you throw it all away to get to living.

---

## One-Line Summary

*A rules-agnostic AI tabletop engine where you upload any rulebook and the AI runs it — handling dice, narration, art, music, and memory — while a human can take the DM seat and stay the storyteller. Free modding commons, official paid partners, atmosphere first. The endgame is a genuinely living world that grows by writing its own canon to disk.*
