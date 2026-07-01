# Authoring a Ruleset Bundle

A ruleset is **pure data + tiny pure functions** in one directory. The engine
never names your system; you plug mechanics into seams. Necrotopia
(`campaigns/necrotopia/ruleset/necrotopia/`) is the complete worked example —
d6-over-Armor combat, custom Moves, statuses, overdrive, actor templates, in
~360 lines with zero imports.

## Layout

```
mycampaign/
  campaign.json            # {start:{scene}, ruleset, title, blurb, scenes:{…}}
  scenes/*.json            # {entityId: {components}} — the seeded world
  ruleset/mysystem/
    ruleset.js             # the bundle (everything below)
    system.md              # the DM's narration voice / table rules (prompt)
```

Run it: `TTRPG_WORLD=mycampaign TTRPG_RULESET=mysystem npm run dev`

## ruleset.js exports (all optional)

### `meta`
```js
export const meta = { id: 'mysystem', name: 'My System', dice: 'd10', summary: '…' };
```

### `components` — schema extensions
Registered via `registerComponents`; the DM inspector, LLM contract, and op
validation pick them up automatically.
```js
export const components = {
  stats: { doc: 'What hp/armor/etc MEAN in this system', fields: { edge: { doc: 'luck pool', range: [0, 5] } } },
};
```

### `checks` — how dice work
Each check kind supplies its dice, modifier source, and resolution. This is the
whole trick: 5e (d20+mod ≥ DC), DSA (3d20 roll-under), Necrotopia (d6 > Armor)
are just different entries.
```js
export const checks = {
  'my-test': {
    doc: 'Roll d10 vs difficulty.',
    dice: { count: 1, sides: 10 },
    comparator: 'ge',
    modSource(ctx) { return (ctx.stats && ctx.stats.edge) || 0; },
    resolve(rolls, mod, dc) {
      const total = rolls[0] + mod;
      return { rolls, modifier: mod, total, dc, success: total >= dc,
               margin: total - dc, crit: rolls[0] === 10, fumble: rolls[0] === 1,
               summary: `d10(${rolls[0]})+${mod} vs ${dc}`, outcome: total >= dc ? 'SUCCESS' : 'FAILURE' };
    },
  },
};
```

### `defaultCheck` — what the DM requests for generic actions
Without it the engine falls back to 5e ability-checks.
```js
export const defaultCheck = { kind: 'my-test', dcDoc: 'a difficulty from 2 (easy) to 9 (heroic)', dcDefault: 5 };
```

### `statuses` — effects that tick
```js
export const statuses = {
  burn: { onTick: (s) => ({ damage: s.magnitude || 1 }), duration: 3 },
  stun: { skipTurn: true },
  rage: { modifyOutgoing: (dmg) => dmg + 2 },
};
```

### `combat` — the combat override
```js
export const combat = {
  initiativeMode: 'timeline',              // CTB queue; omit → d20 initiative
  speedOf(entity) { return (entity.stats || {}).speed || 1; },
  moveCost(move) { return move.cost || 1; },
  resolveAttack({ attackerId, targetId }, entities, rng) { /* → {hit, damage, summary} */ },
  resolveMove(move, params, entities, rng, mods) { /* → {ops, statusOps, summary} */ },
  enemyInstinct: 'nearest',                // deterministic enemy AI
  moraleThreshold: 0.34,                   // below this HP fraction the LLM decides fight/flee/parley
  overdrive: { onDealt: 1, onTaken: 2 },   // limit-break meter fill
  flavor: { begin: '…', victory: '…', defeat: '…', flee: '…' },
};
```

### `actorTemplates` — who the DM may spawn
World-first staging: the LLM names an archetype + intent; the ENGINE supplies
the stat block. No templates → no spawn power (classic behavior).
```js
export const actorTemplates = {
  raider:  { name: 'Raider', stats: { hp: 6, maxHp: 6, armor: 3, speed: 1 },
             faction: 'hostile', moves: { list: [{ name: 'Pipe Swing', type: 'damage', damage: '1d6' }] } },
  // a `player` template shapes NEW party members joining in multiplayer:
  player:  { stats: { hp: 10, maxHp: 10, armor: 2, speed: 1 },
             moves: { list: [{ name: 'Improvised Strike', type: 'damage', damage: '1d6' }] } },
  _default: { name: 'Stranger', stats: { hp: 4, maxHp: 4 } },
};
```

### `system.md`
The DM's voice: tone, table rules, what checks to prefer, what the world is.
Keep it byte-stable — it is the LLM cache prefix.

## Keep bundles pure

No imports from `server/` or `client/` — a bundle is data the engine consumes.
If you need a helper (a dice-string parser, an armor lookup), write it inline.
This is what keeps every ruleset portable and the engine rules-agnostic.
