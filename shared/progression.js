/**
 * shared/progression.js — XP, level, and proficiency computations (5e).
 *
 * PURE — no imports from server/ or client/. Takes plain data, returns plain data.
 * Never mutates inputs.
 *
 * EXTENSION SEAM: rulesets can replace XP_THRESHOLDS or wrap applyXp to add
 * class features, spell slots, feat choices, etc.
 */

/**
 * 5e cumulative XP thresholds at the START of each level, index = level - 1.
 * Levels 1–10; clamp above level 10.
 */
export const XP_THRESHOLDS = [
  0,      // L1
  300,    // L2
  900,    // L3
  2700,   // L4
  6500,   // L5
  14000,  // L6
  23000,  // L7
  34000,  // L8
  48000,  // L9
  64000,  // L10
];

/**
 * Return the character level (1-based) for a given total XP.
 * If XP exceeds the highest threshold, returns the maximum level (10).
 * @param {number} xp — total experience points
 * @returns {number} level (1–10)
 */
export function levelForXp(xp) {
  for (let i = XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

/**
 * 5e proficiency bonus: 2 + floor((level - 1) / 4).
 * Level 1–4 → +2, 5–8 → +3, 9–12 → +4, etc.
 * @param {number} level
 * @returns {number}
 */
export function proficiencyForLevel(level) {
  return 2 + Math.floor((level - 1) / 4);
}

/**
 * Apply XP to a stats object, returning a NEW stats object with updated
 * xp, level, proficiency, maxHp, and hp (full heal on level-up).
 *
 * Never mutates the input `stats`.
 *
 * On level-up:
 *   - Sets `level` to the new level.
 *   - Sets `proficiency` via `proficiencyForLevel`.
 *   - Raises `maxHp` by `(5 + conMod)` per level gained (conMod = floor((con-10)/2)).
 *   - Sets `hp = maxHp` (full heal).
 *
 * If `stats.xp` is undefined/missing, treats it as 0.
 *
 * @param {object} stats — { hp, maxHp, level, proficiency, con, xp?, ... }
 * @param {number} amount — XP to add (must be >= 0)
 * @returns {{ stats: object, gained: number, leveledUp: boolean,
 *             fromLevel: number, toLevel: number }}
 */
export function applyXp(stats, amount) {
  const oldXp = (stats.xp != null) ? stats.xp : 0;
  const newXp = oldXp + amount;

  const oldLevel = stats.level || 1;
  const newLevel = levelForXp(newXp);
  const leveledUp = newLevel > oldLevel;
  const levelsGained = newLevel - oldLevel;

  const newStats = { ...stats, xp: newXp, level: newLevel };

  if (leveledUp) {
    const conScore = newStats.con || 10;
    const conMod = Math.floor((conScore - 10) / 2);
    const hpGainPerLevel = 5 + conMod;
    const oldMaxHp = newStats.maxHp || 10;

    newStats.proficiency = proficiencyForLevel(newLevel);
    newStats.maxHp = oldMaxHp + hpGainPerLevel * levelsGained;
    newStats.hp = newStats.maxHp;
  }

  return {
    stats: newStats,
    gained: amount,
    leveledUp,
    fromLevel: oldLevel,
    toLevel: newLevel,
  };
}
