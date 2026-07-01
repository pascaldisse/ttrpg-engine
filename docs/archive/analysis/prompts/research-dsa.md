# Design-validation task: can our engine represent DSA (Das Schwarze Auge / The Dark Eye)? — the moat test

Working dir `/Users/pascaldisse/projects/ttrpg`. **Read-only on the repo except your ONE output file.** Do NOT
create/modify any engine files, `package.json`, `world/`, etc. — a separate build is running concurrently; stay out
of its way. Write findings to `/Users/pascaldisse/projects/ttrpg/analysis/dsa-representability-check.md`.

Context: our AI-TTRPG engine's whole moat is **rules-as-data** — load an arbitrary rulebook and run it. Our design
(read `PROTOTYPE-SPEC.md` §4–§7 and `analysis/gaia-design-extraction.md`) uses: a declarative **schema-as-data**
(`SCHEMA` with a `registerComponents()` extension seam), an **ops** mutation protocol, and a **deterministic dice
resolver** (`roll` op, `dice.js`) where the engine rolls and the LLM narrates. D&D 5e (d20, roll-high vs DC) is the
easy case. **DSA is the adversarial case** — under-represented, genuinely different mechanics. Validate that our
model can faithfully express it, and surface architectural gaps NOW while the kernel is still soft.

Use `skill:brave-search` to research DSA5 / The Dark Eye 5th edition core mechanics (cite sources). Cover enough to
characterize the system's *shape*:
1. The 8 attributes (MU/KL/IN/CH/FF/GE/KO/KK) and derived values (LeP, AsP, KaP, etc.).
2. The core **skill check ("Talentprobe"/Fertigkeitsprobe): roll 3d20, each die roll-UNDER its associated
   attribute**, spend Skill/Fertigkeitspunkte (FW) to offset failed dice, compute **Quality Levels (QS)**. Get the
   exact algorithm right (how points compensate, criticals/fumbles on double/triple 1s and 20s).
3. Combat basics: Attack (AT) / Parry (PA / Verteidigung), initiative (INI), damage (TP), wounds.
4. How a DSA character sheet differs structurally from a 5e one.

Then the DESIGN ANALYSIS (the real deliverable):
- Map DSA onto our model: what does the `stats` component need; how would `registerComponents` declare DSA's sheet;
  can a single generic `roll` op + `dice.js` express "3d20 roll-under, distribute FW across the three dice, return
  QS / success / crit"? Or do we need a richer **"check" abstraction** (a check = {dice, targets[], modifiers,
  resultMapping}) so different systems plug in their resolution rule as data/config rather than code?
- Identify the **gaps**: what in the current spec would FAIL to represent DSA, and the **minimal** architectural
  accommodation that fixes it (e.g. "dice.js must be a pluggable resolver keyed by the ruleset's check definition,
  not a d20-hardcoded function"). Keep recommendations minimal and extensibility-first.

Deliver: a concise **DSA-representability report** — mechanics summary, the mapping, the gaps, and the minimal
recommended accommodations to our schema/ops/dice so both 5e (roll-high vs DC) and DSA (3d20 roll-under + QS) are
just *data/config* on the same engine. Write the full report to the output file; return a compact 6–10 bullet summary.
