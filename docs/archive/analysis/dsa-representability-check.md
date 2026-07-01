# DSA5 Representability Check — Can Our Engine Run The Dark Eye?

**Date:** 2026-06-16  
**Purpose:** Design-validation moat test — map DSA5 (Das Schwarze Auge 5th Edition) onto our
AI-TTRPG engine model (PROTOTYPE-SPEC.md §4–§7), identify all representation gaps, and
recommend *minimal* architectural accommodations to make both D&D 5e and DSA5 just data/config
on the same kernel.

**Sources:** Wiki Aventurica (de.wiki-aventurica.de), DSA Forum (dsaforum.de), DSA5 Beta Rules
analysis (rpgnosis.wordpress.com), DSA5 Foundry VTT module docs, DSA5 probability calculator
(dsa5.mueller-kalthoff.com).

---

## 1. DSA5 Mechanics Summary

### 1.1 The 8 Attributes (Eigenschaften)

| Abbr | Name (DE) | Name (EN) | Typical Range | Role |
|------|-----------|-----------|---------------|------|
| MU | Mut | Courage | 8–14 | Resistance to fear, combat attacks (historically), many social/interaction skill checks |
| KL | Klugheit | Cleverness / Intelligence | 8–14 | All knowledge skills, perception skills |
| IN | Intuition | Intuition | 8–14 | Perception, social, combat sequencing (INI base) |
| CH | Charisma | Charisma | 8–14 | Social skills, some magic traditions |
| FF | Fingerfertigkeit | Dexterity / Fine Motor | 8–14 | Craft skills, lockpicking, delicate magic |
| GE | Gewandtheit | Agility | 8–14 | Physical movement, dodge, some combat techniques |
| KO | Konstitution | Constitution | 8–14 | LeP base, wound threshold, endurance skills |
| KK | Körperkraft | Strength | 8–14 | Most melee AT/PA/TP base, physical feats |

Racial modifiers shift the ceiling. Human max without legendary traits: typically 20.

**Comparison to 5e:** 8 attributes vs 6. No direct 1:1 mapping. DSA attributes are always
roll-UNDER targets, never modifiers. No "modifier = floor((score-10)/2)" transform — the raw
score IS the target number.

### 1.2 Derived Values

| Value | Abbr | Derivation |
|-------|------|------------|
| Lebenspunkte (Life Points) | LeP | Base from profession + KO (or race base) + advantages |
| Astralpunkte (Mana) | AsP | Base (20 for mages) + governing attribute of tradition + advantages |
| Karmapunkte (Divine) | KaP | Similar to AsP, keyed to CH + tradition |
| Attacke (Attack) | AT | Profession base + governing attribute bonus (KK or GE) per weapon technique |
| Parade (Parry) | PA | Profession base + governing attribute bonus per weapon technique; typically ~AT/2 or similar |
| Initiative | INI | IN + d6 (rolled fresh each combat round — NOT a static modifier) |
| Schicksalspunkte (Fate Points) | SchiP | Fixed pool, used to re-roll or boost |
| Wundschwelle (Wound Threshold) | WS | KO/2 (+ advantages like "Eisern") |
| Rüstungsschutz (Armor) | RS | From equipped armor, flat damage reduction |
| Belastung (Encumbrance) | BE | Affects movement and some checks |

**Key difference from 5e:** Derived values are pre-computed and static (except INI which
gets a new d6 each round). AT/PA are the target numbers you roll under, not modifiers added
to a d20.

### 1.3 The Core Skill Check: Fertigkeitsprobe (3d20 Roll-Under + QS)

This is the defining mechanic of DSA and the biggest challenge for our engine.

#### Algorithm

```
Input:  entity, skill_name, modifier
Output: {success: bool, qs: 0–6, crit: bool, fumble: bool, detail: {...}}

1. Look up skill definition for skill_name:
   - FW (Fertigkeitswert) = entity.stats.skills[skill_name].value
   -attributes [attr_A, attr_B, attr_C]
     e.g., Willenskraft uses [MU, IN, CH]

2. Apply modifier to EACH attribute target:
   attr_target[i] = entity.stats.attributes[attributes[i]] + modifier
   If any attr_target[i] <= 0 → check impossible (fail)

3. Roll 3d20.
   For each die i (1-indexed):
     if roll[i] <= attr_target[i]: excess[i] = 0 (die passed)
     else: excess[i] = roll[i] - attr_target[i] (die failed by this much)

4. Detect crit/fumble:
   - Triple-20 (20,20,20) or Double-20 → automatic fumble ("Patzer"), regardless of FW
   - Triple-1 (1,1,1) or Double-1 → automatic critical success ("Meisterhafte Probe")
     (Note: DSA5 core uses Double-1/Double-20; some talents may override)

5. If crit → success=true, special result, return
   If fumble → success=false, special result, return

6. total_excess = sum(excess[i] for i in 1..3)
   remaining = FW - total_excess

7. If remaining < 0 → success=false, return

8. Compute Quality Level (QS) from remaining FW:
   ┌───────────┬─────┐
   │ remaining │ QS  │
   ├───────────┼─────┤
   │   0 – 3   │  1  │
   │   4 – 6   │  2  │
   │   7 – 9   │  3  │
   │  10 – 12  │  4  │
   │  13 – 15  │  5  │
   │    16+    │  6  │
   └───────────┴─────┘

9. Return {success:true, qs, remaining, crit:false, fumble:false,
           detail: {rolls:[...], targets:[...], excess:[...], FW, modifier, remaining}}
```

**Critical nuance:** The modifier applies to *each attribute's target*, NOT to the FW pool.
This is a deliberate DSA5 design change from DSA4. A -1 modifier means ALL THREE attribute
targets drop by 1. This makes modifiers significantly more impactful than if they just
reduced the FW pool.

**Source:** DSA Forum post #p1941979 (dsaforum.de/viewtopic.php?t=54222), Wiki Aventurica
probability tables confirming QS brackets.

### 1.4 Combat Basics

#### Attack and Parry (both roll-UNDER)

```
Attack:  roll d20 ≤ AT  → hit
Parry:   roll d20 ≤ PA  → attack parried (no damage)
```

- AT and PA are per weapon/combat technique. Each technique has its own governing
  attribute (KK for most melee, GE for daggers/fencing, FF for ranged).
- AT = base AT (from profession) + (governing_attribute - 8) + technique FV bonus
- PA = base PA (from profession) + (governing_attribute - 8) + technique FV bonus
- Both AT and PA can be modified by combat maneuvers (Finte, Wuchtschlag, etc.),
  status effects, wounds, and tactical position.

#### Initiative

- INI = IN base value. Each combat round, roll d6 and add to INI base.
- Characters act in descending INI order.
- Some special abilities allow altering the initiative order or holding actions.

#### Damage and Wounds

```
Effective damage = max(0, weapon_TP + KK_bonus + modifiers - target_RS)
```

- KK_bonus = additional damage from strength (varies by weapon)
- RS (armor) = flat subtraction
- **Wound system:** If effective damage ≥ WS (Wundschwelle = KO/2), a wound is inflicted.
  Wounds stack and cause cumulative penalties. Multiple WS thresholds exist:
  - WS1 = KO/2 (1st wound)
  - WS2 = KO (2nd wound, etc.)
  - Each wound gives a level of "Schmerz" (pain) → -1 on all checks per wound level
- 0 LeP = helpless (not dead, but incapacitated)
- Death at -KO LeP

### 1.5 Character Sheet Structural Differences vs D&D 5e

| Dimension | D&D 5e | DSA5 |
|-----------|--------|------|
| **Attributes** | 6 scores → 6 modifiers | 8 scores, used directly as roll-under targets |
| **Skills** | 18 skills, each tied to 1 attribute, proficiency binary | ~60+ talents, each tied to 3 attributes, numeric FW value |
| **Resolution** | d20 + modifier ≥ DC (roll-high) | 3d20 ≤ three different targets (roll-under), pool compensation, QS |
| **Combat** | d20 + ATK_bonus ≥ AC (roll-high) | d20 ≤ AT (roll-under), opposed by d20 ≤ PA (roll-under) |
| **HP/Resources** | 1 pool (HP) | 3 pools (LeP, AsP, KaP) |
| **Class/Level** | 12 classes, 20 levels | No classes — profession-based starting package, AP-based advancement |
| **Crit/Fumble** | Natural 20/1 on d20 | Double-1/Double-20 on 3d20 |
| **Degree of success** | Rare (mostly binary) | Every skill check produces QS 0–6 |
| **Advantages/Disadvantages** | Feats (optional, few) | ~54 advantages, ~77 disadvantages, 163 special abilities — deeply integrated into checks |
| **Wound system** | None (HP is abstract) | Explicit wound thresholds, location effects, pain penalties |

---

## 2. Mapping DSA5 onto Our Model

### 2.1 What the Current Spec Already Supports

The current prototype spec (as-written) can handle DSA in these ways **without changes**:

1. **Component-document entity model (§5):** DSA characters are just entities with
   components. The `stats` component can hold the full DSA sheet shape — the spec
   explicitly says `stats` shape is "defined by the loaded ruleset." ✅

2. **`registerComponents()` extension seam (§5):** A DSA ruleset can register additional
   components like `spellbook`, `wounds`, `advantages`, `conditions` — the schema extension
   was designed for this. ✅

3. **Schema-as-data + Zod-derived validation:** The DSA ruleset contributes its stat
   shape to the `SCHEMA`, and Zod validators are derived from it. LLM output contract
   automatically covers DSA sheet ops. ✅

4. **Op protocol (spawn/set/merge):** All DSA mutations (update attributes, spend FW,
   apply wounds, change LeP) are just `set`/`merge` ops on entity components. ✅

5. **Living summary + journal:** `look` generates the current-scene frame including DSA
   character state; turns are journaled. ✅

### 2.2 How `registerComponents` Would Declare DSA's Sheet

```js
// In the DSA5 ruleset bundle:
export function registerComponents(SCHEMA) {
  SCHEMA.stats.fields = {
    attributes: {
      doc: 'The 8 core Eigenschaften',
      fields: {
        MU: { doc: 'Mut (Courage)', range: [1, 25] },
        KL: { doc: 'Klugheit (Cleverness)', range: [1, 25] },
        IN: { doc: 'Intuition', range: [1, 25] },
        CH: { doc: 'Charisma', range: [1, 25] },
        FF: { doc: 'Fingerfertigkeit (Dexterity)', range: [1, 25] },
        GE: { doc: 'Gewandtheit (Agility)', range: [1, 25] },
        KO: { doc: 'Konstitution (Constitution)', range: [1, 25] },
        KK: { doc: 'Körperkraft (Strength)', range: [1, 25] },
      }
    },
    derived: {
      doc: 'Computed derived values',
      fields: {
        LeP: { doc: 'Lebenspunkte', fields: { current: {}, max: {} } },
        AsP: { doc: 'Astralpunkte', fields: { current: {}, max: {} } },
        KaP: { doc: 'Karmapunkte', fields: { current: {}, max: {} } },
        INI: { doc: 'Initiative base (IN + modifiers)' },
        WS: { doc: 'Wundschwelle (Wound Threshold)' },
      }
    },
    skills: {
      doc: 'Talente — each has FW value and associated attribute triplet',
      // dynamic map of skill_name → { FW, attr1, attr2, attr3 }
    },
    combat_techniques: {
      doc: 'Kampftechniken — per-weapon AT/PA/TP + governing attribute',
      // dynamic map of technique_name → { FV, AT, PA, TP, attribute }
    },
    advantages: {
      doc: 'Vor- und Nachteile',
      // reference list of advantage IDs
    },
    conditions: {
      doc: 'Active status effects (wounds, poison, etc.)',
    }
  };

  // Register ruleset-specific components:
  SCHEMA.spellbook = {
    doc: 'Zauberbuch — known spells with FW, AsP cost, modifiers',
    default: { spells: {} },
    fields: { /* ... */ }
  };

  SCHEMA.wounds = {
    doc: 'Active wounds and pain levels',
    default: { count: 0, pain_level: 0 },
    fields: { /* ... */ }
  };
}
```

This works today. The component model is flexible enough. **No change needed here.**

### 2.3 Where the Current `roll` Op Fails for DSA

The current spec defines:

```jsonc
{"op":"roll", "expr":"1d20+3", "dc":15, "for":"player-c001", "reason":"perception"}
```

This assumes:
- A **single dice expression** (`1d20+3`)
- A **single target DC** (15)
- **Roll-high vs DC** comparison
- **Binary pass/fail** result
- **Natural 20/1** crit/fumble detection

DSA needs from a single check:
- **3 dice, each compared against a different target** (not one DC)
- **Roll-UNDER, not roll-high** (each die compared independently)
- **Pool compensation** (spend FW across the three failing dice)
- **QS mapping** (not binary — 6 degrees of success)
- **Different crit/fumble detection** (double-1/double-20, not single 20/1)
- **Modifier applied to targets, not to dice result**

These are **fundamentally different resolution models**, not parameter variations on the
same function. The current `roll` op **cannot** express a DSA skill check.

### 2.4 Can a Single Generic `roll` Op + `dice.js` Express Both?

**No, not with the current design.** The `roll` op's shape (`expr` + `dc`) encodes the 5e
paradigm. Even if `dice.js` were made extensible, the op carries the wrong semantics —
there's no place for multi-target, pool, or QS in `{expr, dc}`.

**The solution is a "check" abstraction** that is one level higher than `roll`.

---

## 3. Gaps Identified

### Gap 1: Resolution Paradigm Is Hardcoded to 5e

**Symptom:** The `roll` op shape `{expr, dc}` and `dice.js` design assume d20 roll-high-vs-DC.

**Severity: BLOCKER.** DSA cannot be represented without changing the resolution model.

**Minimal fix:** Introduce a `check` abstraction.

### Gap 2: No Multi-Target Roll Support

**Symptom:** DSA requires 3d20 each against a different target number. The current model
supports exactly one dice pool vs one DC.

**Severity: BLOCKER.**

**Fix:** The `check` definition declares an array of `dice[]` and `targets[]`.

### Gap 3: No Pool Compensation Mechanism

**Symptom:** DSA's FW pool can be spent to offset individual die failures. No equivalent
exists in 5e (you don't "spend proficiency bonus" to salvage a roll).

**Severity: BLOCKER.**

**Fix:** The `check` definition declares a `compensation` block (pool source, spend rate).

### Gap 4: No Rich Result Mapping (QS / Degrees of Success)

**Symptom:** The current model returns binary pass/fail (maybe with a crit flag). DSA
requires QS 0–6, and in published adventures, QS≥3 is often the threshold for "all
information." The LLM must narrate quality gradations.

**Severity: HIGH.** You could jury-rig by returning `remaining_pool` and letting the LLM
infer QS, but that puts rules logic in the LLM (anti-pattern from the spec).

**Fix:** The `check` definition includes a `resultMap` that the engine evaluates
deterministically, returning a structured `{qs, success, crit, fumble, remainingPool}`.

### Gap 5: Crit/Fumble Detection Is System-Specific

**Symptom:** 5e uses natural 20/1. DSA uses double-20/double-1 on 3d20. Other systems
use other rules. Hardcoded detection doesn't scale.

**Severity: MEDIUM.** Crit/fumble is a narrow concern but it's deeply embedded in the
resolution logic.

**Fix:** The `check` definition declares `critOn` and `fumbleOn` patterns.

### Gap 6: Modifier Application Rules Vary

**Symptom:** In 5e, a +3 bonus is added to the d20 result. In DSA5, a -1 modifier
applies to ALL THREE attribute targets (not to the dice or the FW pool). These are
fundamentally different modifier semantics — and a system could also apply modifiers
to dice results, to the pool, or to individual targets.

**Severity: HIGH.** Getting modifier application wrong means the rules are misrepresented.

**Fix:** The `check` definition declares `modifierAppliesTo: "target" | "result" | "pool" | "none"`.

### Gap 7: No Derived-Value Computation

**Symptom:** DSA has many derived values (AT, PA, LeP_max, AsP_max, WS, INI) computed by
formula from attributes. The current spec has no derivation system; values are just stored.

**Severity: LOW.** For now, derived values can be pre-computed and stored on the character
sheet (in `stats.derived`). A derivation engine (formula → automatic update on attribute
change) is a nice-to-have for later.

### Gap 8: d6 Initiative Per Round

**Symptom:** DSA initiative is IN + d6 rolled fresh each round. The current spec has no
concept of per-round rolls. This is a turn-structure concern, not a dice concern.

**Severity: LOW.** The combat sub-mode can handle round-start rolls. The `check` abstraction
already covers "roll d6, add to INI, order by result."

### Gap 9: Combat Checks Are Also Roll-Under

**Symptom:** DSA combat uses d20 ≤ AT (attack) and d20 ≤ PA (parry) — both roll-under,
not roll-high. The current `roll` op assumes roll-high.

**Severity: BLOCKER** (same as Gap 1). Fix is covered by the `check` abstraction.

### Gap 10: Spell/Liturgy/Ritual Probes Have Additional Layers

**Symptom:** DSA spells use the same 3d20-FW pool mechanic, but with: AsP cost, casting
time, range, duration, modifications (reduce cost for +difficulty), and spell-specific
effects on success/failure. This is a content problem, not an engine problem — but the
`check` definition must accommodate "cost" and "effect metadata" fields.

**Severity: LOW.** The `check` definition can carry arbitrary metadata. Content problem.

---

## 4. Recommended Architectural Accommodations

### Recommendation 1: Replace `roll` Op with `check` Op (BLOCKER FIX)

**Replace:**
```jsonc
{"op":"roll", "expr":"1d20+3", "dc":15, ...}
```

**With:**
```jsonc
{
  "op": "check",
  "check": "skill-check",              // key into ruleset's check definitions
  "params": {
    "skill": "willenskraft",           // which skill/talent on the entity
    "modifier": -1                     // optional; system-wide modifier
  },
  "for": "player-c001",
  "reason": "resisting intimidation"
}
```

The `check` name is a key into a **check registry** provided by the loaded ruleset.
The engine resolves the check definition, evaluates targets against entity state,
rolls dice, applies compensation, computes result, and returns structured output.

**Backward compatibility:** 5e "ability checks" become a check definition in the 5e
ruleset. The existing `roll` op can be kept as a shorthand that expands to `check`
internally, or deprecated in favor of `check` everywhere.

### Recommendation 2: Check Definition as Ruleset Data (BLOCKER FIX)

A ruleset bundle includes a `checks.js` (or `checks/` directory) that exports a map of
check names to check definitions. The engine imports this at boot and uses it to resolve
every `check` op.

**DSA5 skill-check definition:**
```js
{
  "skill-check": {
    // --- Dice roll specification ---
    dice: [
      { type: "d20", target: "{entity.stats.attributes[skill.attr1] + params.modifier}" },
      { type: "d20", target: "{entity.stats.attributes[skill.attr2] + params.modifier}" },
      { type: "d20", target: "{entity.stats.attributes[skill.attr3] + params.modifier}" },
    ],
    comparator: "under-or-equal",        // roll ≤ target

    // --- Pool compensation ---
    compensation: {
      pool: "{entity.stats.skills[params.skill].FW}",
      spendRate: 1,                      // 1 FW compensates 1 point of excess
    },

    // --- Crit/fumble detection ---
    critOn:   { pattern: "double-1" },    // any two dice show 1
    fumbleOn: { pattern: "double-20" },   // any two dice show 20

    // --- Result mapping ---
    resultMap: [
      { condition: { crit: true },               result: "critical-success" },
      { condition: { fumble: true },              result: "fumble" },
      { condition: { remainingPool: { lt: 0 } },  result: "fail", qs: 0 },
      { condition: { remainingPool: { lte: 3 } }, result: "success", qs: 1 },
      { condition: { remainingPool: { lte: 6 } }, result: "success", qs: 2 },
      { condition: { remainingPool: { lte: 9 } }, result: "success", qs: 3 },
      { condition: { remainingPool: { lte: 12 } },result: "success", qs: 4 },
      { condition: { remainingPool: { lte: 15 } },result: "success", qs: 5 },
      { condition: { remainingPool: { gte: 16 } },result: "success", qs: 6 },
    ],

    // --- Modifier application ---
    modifierAppliesTo: "target",           // DSA5: modifier alters attribute targets
  }
}
```

**5e ability-check definition (for comparison — same engine, different config):**
```js
{
  "ability-check": {
    dice: [
      { type: "d20" }
    ],
    modifier: "{entity.stats.abilityMods[params.ability] + (params.proficient ? entity.stats.proficiencyBonus : 0)}",
    modifierAppliesTo: "result",           // 5e: modifier added to d20 result
    dc: "{params.dc}",
    comparator: "greater-or-equal",        // roll + mod ≥ DC
    // No compensation pool
    critOn:   { value: 20 },
    fumbleOn: { value: 1 },
    resultMap: [
      { condition: { crit: true },   result: "critical-success" },
      { condition: { fumble: true },  result: "fumble" },
      { condition: { pass: true },    result: "success" },
      { condition: { pass: false },   result: "fail" },
    ],
  }
}
```

**Both are data/config on the same engine.** The engine's `resolveCheck()` function reads
the definition, evaluates all expressions against the entity's state, rolls, compares,
compensates, and maps to result.

### Recommendation 3: Make `dice.js` a Check Engine, Not a Fixed Function (BLOCKER FIX)

**Current envisioned API:**
```js
roll(expr, dc) → { result, crit }
```

**Recommended API:**
```js
resolveCheck(checkDef, entityState, params, rng) → {
  diceResults: [ { die: "d20", raw: 14, target: 12, passed: false, excess: 2 }, ... ],
  compensation: { pool_initial: 5, spent: 2, remaining: 3 },
  crit: false,
  fumble: false,
  success: true,
  qs: 1,                              // QS level
  resultLabel: "success",             // human-readable label from resultMap
  summary: "QS 1 (FW 3 remaining)",   // one-line summary for LLM context
}
```

**Responsibilities of the check engine:**
1. Parse the check definition, evaluating all `{expression}` templates against entity state
2. Roll the specified dice
3. Apply the comparator (under/over/equal) per die
4. Compute excess per die
5. Apply compensation pool
6. Detect crit/fumble patterns
7. Map remaining pool + crit/fumble to structured result per resultMap
8. Return a deterministic, machine-readable result

The LLM receives this result and narrates it. The engine NEVER trusts the LLM to interpret
dice results — that's the core anti-pattern we designed out.

### Recommendation 4: Expression Templates for Target/Modifier Evaluation

The check definitions use expression templates like `{entity.stats.attributes.MU + params.modifier}`.
These need a simple, safe expression evaluator in `shared/` that:
- Resolves paths against `entityState` and `params`
- Supports basic arithmetic (`+`, `-`, `*`, `/`, `Math.floor`)
- Does NOT execute arbitrary code
- Is implemented once in `shared/check-resolve.js`

This is the **minimal evaluator** — not a full scripting language. The expression surface
is intentionally limited to arithmetic on entity fields and params.

### Recommendation 5: Ruleset Bundle Structure (Check Definitions Live in Ruleset)

```
world/
├── campaign.json
├── ruleset/
│   ├── ruleset.json          # { name: "dsa5", version: "1.0" }
│   ├── schema-extension.js   # registerComponents(SCHEMA) — adds DSA components
│   ├── checks.js             # export const CHECKS = { "skill-check": {...}, "attack": {...}, ... }
│   ├── system-prompt.txt     # DSA-specific world-rules prefix (for cached LLM context)
│   └── data/                 # Static data tables (skill→attribute mappings, weapon stats, etc.)
│       ├── skills.json
│       ├── combat-techniques.json
│       └── spells.json
└── scenes/...
```

The server loads `ruleset/checks.js` at boot, registers the check definitions in memory,
and resolves them when a `check` op arrives. This is the same pattern as schema extension:
ruleset data loaded at boot extends the kernel.

### Recommendation 6: `stats` Component Holds Arbitrary Shape (ALREADY HANDLED)

No change needed. The spec already says `stats` shape is "defined by the loaded ruleset."
The component model accepts arbitrary nested JSON. DSA's 8 attributes, derived pools,
skill mappings, and combat technique values all fit inside `stats`.

**Recommended DSA stats shape** (for illustration — not a spec change):
```js
stats: {
  attributes: { MU:14, KL:12, IN:13, CH:10, FF:11, GE:13, KO:14, KK:15 },
  derived: {
    LeP: { current: 35, max: 35 },
    AsP: { current: 0, max: 0 },     // non-caster
    KaP: { current: 0, max: 0 },
    INI: 13,
    WS: 7,                            // KO/2 = 14/2
  },
  skills: {
    willenskraft:      { FW: 4,  attr1: "MU", attr2: "IN", attr3: "CH" },
    selbstbeherrschung:{ FW: 6,  attr1: "MU", attr2: "MU", attr3: "KO" },
    koerperbeherrschung:{ FW: 3,  attr1: "GE", attr2: "GE", attr3: "KO" },
    sinnesschaerfe:    { FW: 5,  attr1: "KL", attr2: "KL", attr3: "IN" },
    // ... ~60+ skills
  },
  combat_techniques: {
    schwerter:  { FV: 12, AT: 16, PA: 11, TP: "1W6+4", attribute: "KK" },
    raufen:     { FV: 8,  AT: 14, PA: 9,  TP: "1W6+2", attribute: "GE" },
    boegen:     { FV: 6,  AT: 14, PA: 0,  TP: "1W6+8", attribute: "FF" },
  },
  advantages: ["eisern_I", "hohe_lebenskraft_I"],
  disadvantages: ["neugier", "hoehenangst"],
  special_abilities: ["wuchtschlag_I", "gezielter_stich"],
}
```

### Recommendation 7: Derived-Value Computation (DEFER — Not a Blocker)

For the initial DSA implementation, derived values (LeP_max, AT, PA, WS, etc.) can be
**pre-computed** when the character is created or leveled up, and stored directly in
`stats.derived` and `stats.combat_techniques`. This avoids building a derivation engine
in the kernel.

A later phase can add a `computeDerived(entity)` function that the ruleset provides,
called on `spawn` and `set` of attributes. But this is a luxury — the core can run
DSA without it.

### Recommendation 8: Combat Sub-Mode for DSA

DSA combat is structurally different enough from 5e that the combat sub-mode needs to
be ruleset-aware. Specifically:
- **Round start:** Roll d6 for each combatant, compute INI order
- **Attack/Parry sequence:** AT check → PA check → damage → wounds → status effects
- **Opposed checks:** AT vs PA is an opposed roll-under — two checks in sequence
- **Wound tracking:** On damage ≥ WS, increment wound count, apply pain penalty

These are all expressible as sequences of `check` ops. The combat sub-mode orchestrates
the sequence; the individual checks follow the check definitions. **No new engine
primitives needed** — just a ruleset-aware combat loop.

---

## 5. Summary: Minimal Accommodations Required

| # | Accommodation | Current Spec | Target Spec | Blocker? |
|---|---|---|---|---|
| 1 | `check` op replaces/extends `roll` op | `roll{expr, dc}` d20-centric | `check{check, params}` — system-agnostic | **YES** |
| 2 | Check definition registry in ruleset | Not present | `ruleset/checks.js` exports `CHECKS` map | **YES** |
| 3 | `dice.js` → pluggable check engine | `roll(expr, dc)` fixed function | `resolveCheck(def, entity, params)` | **YES** |
| 4 | Expression template evaluator for targets | Not needed | `shared/check-resolve.js` — safe path eval + arithmetic | **YES** |
| 5 | Multi-target, pool compensation, QS mapping | Not supported | Built into check definition + `resolveCheck` | **YES** |
| 6 | Crit/fumble as check-definition patterns | Hardcoded nat-20/1 | `critOn:{pattern:"double-1"}, fumbleOn:{...}` | Medium |
| 7 | Modifier application rules | Implicit (add to result) | Explicit `modifierAppliesTo: "target"\|"result"` | Medium |
| 8 | `stats` component shape extensibility | Already handled (`registerComponents`) | No change needed | No |
| 9 | Derived-value computation | Not present | Defer — pre-compute values in sheet data | No |
| 10 | Ruleset bundle structure | Partially specified | Add `checks.js` to `ruleset/` | No |

---

## 6. Verdict

**YES, our model can represent DSA5 — with 5 targeted changes to the resolution layer.**

The **good news:** The component model, op protocol, schema-as-data, journal, sense system,
and "everything is a client" architecture all carry over unchanged. The entity→component
model absorbs DSA's complex character sheet naturally. The DM seat, multiplayer, and
narrative engine need zero DSA-specific changes.

The **critical fix:** The `roll` op and `dice.js` must evolve from a 5e-coupled function
into a **data-driven check engine** where the resolution rule is defined by the ruleset,
not the kernel. The same `resolveCheck()` function reads a 5e ability-check definition
(one d20, roll-high, binary) and a DSA skill-check definition (3d20, roll-under, pool
compensation, QS 0–6) from the same check registry.

**The moat holds:** Once the check engine exists, adding a new TTRPG system means writing
a new `checks.js` file — no kernel changes. That's exactly the "rules-as-data" promise.

---

## References

- Wiki Aventurica: `https://de.wiki-aventurica.de/wiki/Wahrscheinlichkeit_f%C3%BCr_das_Bestehen_einer_Talentprobe` — DSA5 probability tables, QS bracket confirmation, crit/fumble probabilities
- DSA Forum: `https://dsaforum.de/viewtopic.php?t=54222` — FW-to-QS mapping table, modifier application rules
- Glumbosch's Schmiede: `https://glumbosch.home.blog/2020/05/26/wertekasten-aufwerter-fur-dsa5/` — Complete talent-to-attribute mapping (~60+ skills), attribute abbreviations confirmation
- RPGnosis DSA5 Beta Analysis: `https://rpgnosis.wordpress.com/2014/05/25/dsa-5-betaregeln-4-kampfregeln/` — Combat values derivation (AT/PA from attributes), DSA4→DSA5 changes, balance analysis
- DSA5 Foundry VTT Module: `https://foundryvtt.com/packages/dsa5` — Confirms system feature surface: skills, spells, liturgies, rituals, opposed tests, wounds, automatic advantage/disadvantage integration
- Orkenspalter Forum: `https://www.orkenspalter.de/index.php?thread/34230-initiative/` — Initiative mechanics discussion (INI + d6 per round)
- DSA Forum (AsP calculation): `https://dsaforum.de/viewtopic.php?t=52544` — AsP derivation formula, Leiteigenschaft per tradition
- DSA5 Probability Calculator: `http://dsa5.mueller-kalthoff.com/` — Interactive QS probability visualization confirming the mathematical model
