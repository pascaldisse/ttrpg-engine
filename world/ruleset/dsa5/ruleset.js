/**
 * world/ruleset/dsa5/ruleset.js — Das Schwarze Auge 5 rules-as-data bundle.
 *
 * PURE — no server/ or client/ imports.
 * Proves the engine is rules-agnostic: 3d20 roll-under + Qualitätsstufen
 * on the SAME engine as 5e d20-vs-DC.
 */

export const meta = {
  id: 'dsa5',
  name: 'Das Schwarze Auge 5',
  dice: '3d20',
  summary: '3d20 roll-under + Qualitätsstufen',
};

// ---- Components: DSA5-specific schema extensions ----

export const components = {
  attributes: {
    doc: 'DSA5 Eigenschaften — the 8 base attributes. Range 1–20 (human typical 8–14). MU=0 means no courage at all.',
    default: { MU: 12, KL: 12, IN: 12, CH: 12, FF: 12, GE: 12, KO: 12, KK: 12 },
    fields: {
      MU: { doc: 'Mut (Courage) — bravery, willpower, resisting fear.', range: [0, 20] },
      KL: { doc: 'Klugheit (Cleverness) — logic, memory, puzzle-solving.', range: [0, 20] },
      IN: { doc: 'Intuition (Intuition) — gut feeling, perception, empathy.', range: [0, 20] },
      CH: { doc: 'Charisma (Charisma) — presence, persuasion, leadership.', range: [0, 20] },
      FF: { doc: 'Fingerfertigkeit (Dexterity) — fine motor skills, sleight of hand.', range: [0, 20] },
      GE: { doc: 'Gewandtheit (Agility) — acrobatics, dodging, full-body movement.', range: [0, 20] },
      KO: { doc: 'Konstitution (Constitution) — endurance, resisting poison/disease.', range: [0, 20] },
      KK: { doc: 'Körperkraft (Strength) — raw physical power, lifting, melee damage.', range: [0, 20] },
    },
  },
};

// ---- Checks: DSA5 3d20 roll-under skill check ----

export const checks = {
  'dsa-skill': {
    doc: 'DSA5 Fertigkeitsprobe — 3d20 roll-under vs three governing attributes, spend skill points (FW) to compensate shortfalls. Quality Level 1–6 on success.',
    dice: { count: 3, sides: 20 },
    comparator: 'le',

    /** DSA uses ctx.mod directly; the engine-calculated mod is unused. */
    modSource() {
      return 0;
    },

    /**
     * Resolve a DSA5 3d20 skill check.
     *
     * @param {number[]} rolls   — [d20, d20, d20] from the engine
     * @param {number}   _mod    — unused (engine-calculated; always 0)
     * @param {number}   _dc     — unused (no DC in DSA5)
     * @param {object}   _def    — this CHECK_DEF entry
     * @param {object}   ctx     — { attrs:[a1,a2,a3], fw:number, mod?:number }
     * @returns {{rolls, success, ql, crit, fumble, spent, remaining, dc:undefined,
     *            total:undefined, summary:string, outcome:string}}
     */
    resolve(rolls, _mod, _dc, _def, ctx) {
      const attrs = ctx.attrs || [8, 8, 8];
      const fw = ctx.fw || 0;
      const bonus = ctx.mod || 0;

      // Per-die shortfall
      let spent = 0;
      for (let i = 0; i < 3; i++) {
        const target = attrs[i] + bonus;
        spent += Math.max(0, rolls[i] - target);
      }

      const remaining = fw - spent;

      // Criticals
      let ones = 0;
      let twenties = 0;
      for (const r of rolls) {
        if (r === 1) ones++;
        if (r === 20) twenties++;
      }
      const crit = ones >= 2;
      const fumble = twenties >= 2;

      let success;
      let ql;

      if (fumble) {
        success = false;
        ql = 0;
      } else if (crit) {
        success = true;
        const r = Math.max(0, remaining);
        ql = Math.max(1, Math.min(6, Math.ceil(r / 3)));
      } else {
        success = remaining >= 0;
        if (success) {
          ql = Math.max(1, Math.min(6, Math.ceil(remaining / 3)));
        } else {
          ql = 0;
        }
      }

      const outcome = success ? `SUCCESS QL${ql}` : 'FAILURE';
      const summary = `3d20(${rolls.join(',')}) vs [${attrs.join(',')}] +${bonus} FW${fw} → ${outcome}`;

      return {
        rolls,
        success,
        ql,
        crit,
        fumble,
        spent,
        remaining,
        dc: undefined,
        total: undefined,
        summary,
        outcome,
      };
    },
  },
};
