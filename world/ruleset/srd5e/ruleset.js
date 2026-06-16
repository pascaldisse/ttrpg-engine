/**
 * world/ruleset/srd5e/ruleset.js — D&D 5th Edition SRD rules-as-data bundle.
 *
 * Formalizes 5e behaviour as data so the engine boots without hardcoding the
 * ruleset. Supplies component extensions (skills, conditions), uses the
 * built-in check definitions (ability-check, attack, saving-throw), and
 * points to a 5e DM narration system prompt.
 */

export const meta = {
  id: 'srd5e',
  name: 'D&D 5th Edition SRD',
  dice: 'd20',
  summary: 'd20 roll-high vs DC. Ability checks, attacks, saving throws.',
};

export const components = {
  skills: {
    doc: 'D&D 5e skill proficiencies. Boolean flags; the resolver looks for matching skill + proficiency bonus.',
    default: {
      acrobatics: false,
      animalHandling: false,
      arcana: false,
      athletics: false,
      deception: false,
      history: false,
      insight: false,
      intimidation: false,
      investigation: false,
      medicine: false,
      nature: false,
      perception: false,
      performance: false,
      persuasion: false,
      religion: false,
      sleightOfHand: false,
      stealth: false,
      survival: false,
    },
    fields: {
      acrobatics: { doc: 'Dexterity (Acrobatics) proficiency.' },
      animalHandling: { doc: 'Wisdom (Animal Handling) proficiency.' },
      arcana: { doc: 'Intelligence (Arcana) proficiency.' },
      athletics: { doc: 'Strength (Athletics) proficiency.' },
      deception: { doc: 'Charisma (Deception) proficiency.' },
      history: { doc: 'Intelligence (History) proficiency.' },
      insight: { doc: 'Wisdom (Insight) proficiency.' },
      intimidation: { doc: 'Charisma (Intimidation) proficiency.' },
      investigation: { doc: 'Intelligence (Investigation) proficiency.' },
      medicine: { doc: 'Wisdom (Medicine) proficiency.' },
      nature: { doc: 'Intelligence (Nature) proficiency.' },
      perception: { doc: 'Wisdom (Perception) proficiency.' },
      performance: { doc: 'Charisma (Performance) proficiency.' },
      persuasion: { doc: 'Charisma (Persuasion) proficiency.' },
      religion: { doc: 'Intelligence (Religion) proficiency.' },
      sleightOfHand: { doc: 'Dexterity (Sleight of Hand) proficiency.' },
      stealth: { doc: 'Dexterity (Stealth) proficiency.' },
      survival: { doc: 'Wisdom (Survival) proficiency.' },
    },
  },
  conditions: {
    doc: 'D&D 5e conditions. Active conditions that affect gameplay.',
    default: { list: [] },
    fields: {
      list: {
        doc: 'Array of active condition names: blinded, charmed, deafened, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious, exhausted.',
      },
    },
  },
};

export const checks = {};
// 5e uses the built-in check definitions in shared/checks.js.
// No overrides needed — ability-check, attack, and saving-throw ship with the engine.
