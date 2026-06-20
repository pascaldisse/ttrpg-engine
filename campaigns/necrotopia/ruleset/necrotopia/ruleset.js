/**
 * campaigns/necrotopia/ruleset/necrotopia/ruleset.js
 * Necrotopia: Handbook to the Apocalypse — rules-as-data bundle.
 *
 * PURE — no server/ or client/ imports. Proves the engine is rules-agnostic a THIRD
 * way: a d6 "roll-OVER-Armor" hit + flat d6 damage, no attributes, no skills, no
 * initiative roll — on the SAME engine as 5e (d20 vs DC) and DSA5 (3d20 roll-under).
 *
 * Source mechanics (Necrotopia RPG, K.W. Dunham, 2018):
 *   - Only six-sided dice. To hit: roll 1d6, HIT if the die is strictly GREATER than
 *     the target's Armor (Armor 2 → need 3+, Armor 4 → need 5+).
 *   - Health = 25 + 1d6 at creation, +1 per level. Dead at Health <= 0.
 *   - Armor base 2. It is a to-HIT gate, not damage mitigation.
 *   - A character has exactly 3 custom Moves + 1 weapon (base 1d6 damage, +1/level).
 *   - No initiative roll — the GM announces turn order (party acts, then foes).
 *   - No XP: the GM grants a level after each session / boss (+1 Health, +1 move/upgrade).
 */

export const meta = {
  id: 'necrotopia',
  name: 'Necrotopia: Handbook to the Apocalypse',
  dice: 'd6',
  summary: 'd6 roll-OVER-Armor to hit + d6 damage. No attributes/skills; 3 custom Moves; GM-fiat.',
};

// ---- tiny self-contained dice-string parser (keeps the bundle import-free) ----

/** "2d6" → {count:2, sides:6}; unparseable → {count:1, sides:6}. */
function parseDie(die) {
  const m = /^(\d+)d(\d+)$/.exec(String(die || ''));
  if (m) return { count: Number(m[1]), sides: Number(m[2]) };
  return { count: 1, sides: 6 };
}

/** Read a combatant's Armor (the d6 hit threshold). Necrotopia base = 2. */
function armorOf(entity) {
  const s = entity && entity.stats;
  if (!s) return 2;
  return s.armor ?? s.ac ?? 2;
}

// ---- Components: Necrotopia-specific schema extensions ----

export const components = {
  // Necrotopia has NO ability scores — just Health, Armor and Level. We extend the
  // base `stats` component to teach the inspector/LLM what Armor means here.
  stats: {
    doc: 'Necrotopia core stats. Health = hp/maxHp (dead at hp<=0). Armor is the d6 hit threshold — an attacker must roll OVER it to hit. Level grants +1 Health and +1 damage. No ability scores.',
    default: { armor: 2 },
    fields: {
      armor: { doc: 'Armor — attackers must roll a d6 strictly GREATER than this to hit. Base 2; bosses/gear raise it.', range: [0, 6] },
    },
  },

  moves: {
    doc: 'Necrotopia custom Moves. A character has exactly 3. Each Move is one action: a damage attack, a heal, a buff, a stun, an area hit, or pure utility (carjacking, hacking, etc.). The GM approves new Moves on level-up.',
    default: { list: [] },
    fields: {
      list: {
        doc: 'Array of { name, type, damage?, duration?, special? }. type ∈ damage|bleed|area|heal|buff|stun|utility|summon. damage is a die string like "1d6". duration is rounds for stuns/buffs. Buffs/stuns that target ENEMIES still require a successful hit roll.',
      },
    },
  },
};

// ---- Checks: Necrotopia d6 mechanics (EXTENSION SEAM in shared/checks.js) ----

export const checks = {
  'necro-attack': {
    doc: 'Necrotopia attack — roll 1d6; HIT if the die is strictly GREATER than the target Armor (dc carries the Armor value). No criticals or fumbles.',
    dice: { count: 1, sides: 6 },
    comparator: 'gt',
    modSource() { return 0; },
    resolve(rolls, _mod, dc, _def, _ctx) {
      const roll = rolls[0];
      const armor = (dc == null ? 2 : dc);
      const success = roll > armor;
      const outcome = success ? 'HIT' : 'MISS';
      return {
        rolls, modifier: 0, total: roll, dc: armor,
        success, margin: roll - armor, crit: false, fumble: false,
        summary: `d6(${roll}) vs Armor ${armor} → ${outcome}`,
        outcome,
      };
    },
  },

  'necro-test': {
    doc: 'Necrotopia GM check (non-combat). Roll 1d6 vs a difficulty 1–6 (1=trivial … 6=near-impossible). SUCCESS if roll >= difficulty. 6 is a great success, 1 a botch. The GM picks the difficulty — there are no skills.',
    dice: { count: 1, sides: 6 },
    comparator: 'ge',
    modSource() { return 0; },
    resolve(rolls, _mod, dc, _def, _ctx) {
      const roll = rolls[0];
      const diff = Math.max(1, Math.min(6, dc || 4));
      const success = roll >= diff;
      const outcome = success ? 'SUCCESS' : 'FAILURE';
      return {
        rolls, modifier: 0, total: roll, dc: diff,
        success, margin: roll - diff, crit: roll === 6, fumble: roll === 1,
        summary: `d6(${roll}) vs difficulty ${diff} → ${outcome}`,
        outcome,
      };
    },
  },
};

// ---- Combat override (EXTENSION SEAM in shared/combat.js) ----

/**
 * Necrotopia attack resolution: 1d6 > Armor to hit, then weapon/move die damage
 * (+1 per level above 1). No ability modifier, no crit-doubling. Same params and
 * return shape as the engine's default resolveAttack so the combat engine can call
 * it interchangeably.
 */
function necroResolveAttack({ attackerId, targetId }, entities, rng) {
  const attacker = entities.get(attackerId);
  const target = entities.get(targetId);
  if (!attacker || !target) {
    return { hit: false, crit: false, fumble: false, attackRoll: 0, ac: 0, damage: 0, summary: 'Invalid attacker or target.', ability: '—', weaponDie: '1d6' };
  }

  const armor = armorOf(target);
  const roll = rng.d(6);
  const hit = roll > armor;

  let damage = 0;
  const weaponDieStr = (attacker.flags && attacker.flags.damage) || '1d6';
  if (hit) {
    const die = parseDie(weaponDieStr);
    let total = 0;
    for (let i = 0; i < die.count; i++) total += rng.d(die.sides);
    const level = (attacker.stats && attacker.stats.level) || 1;
    damage = Math.max(1, total + Math.max(0, level - 1)); // +1 damage per level above 1
  }

  const summary = hit
    ? `d6(${roll}) vs Armor ${armor} → HIT (${damage} damage)`
    : `d6(${roll}) vs Armor ${armor} → MISS`;

  return { hit, crit: false, fumble: false, attackRoll: roll, ac: armor, damage, summary, ability: '—', weaponDie: weaponDieStr };
}

export const combat = {
  // No initiative roll in Necrotopia — the GM declares order (party acts, then foes).
  initiativeMode: 'fixed',
  resolveAttack: necroResolveAttack,
  flavor: {
    begin: 'No more talk — weapons up. The apocalypse does not wait.',
    victory: 'The last of them comes apart in a wet heap. The ringing fades; you are still standing, somehow.',
    defeat: 'Your knees buckle and the red dark rushes in. The end of the world claims one more.',
    flee: 'You break and run, lungs burning, the snarls and gunfire dwindling behind you.',
  },
};
