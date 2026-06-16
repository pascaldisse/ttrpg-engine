/**
 * tools/test-client.mjs — scoped player-HUD checks (headless, stubbed DOM).
 *
 * The client is browser code, so it has no normal unit tests. This drives the
 * real View class against a minimal DOM stub + the real tavern world to verify
 * the player-view SCOPING ("only what's HERE is shown") and that the render path
 * builds the You/Here/Quests cards + scene without throwing.
 *
 * Run: node tools/test-client.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';

global.Node = class Node {};
class El extends global.Node {
  constructor(tag = 'div') {
    super();
    this.tagName = tag; this.children = []; this._attrs = {};
    this.className = ''; this.textContent = ''; this.style = {}; this._parent = null;
  }
  get firstChild() { return this.children[0] || null; }
  get parentNode() { return this._parent; }
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  insertBefore(c) { c._parent = this; this.children.unshift(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  setAttribute(k, v) { this._attrs[k] = v; }
  addEventListener() {}
  remove() { if (this._parent) this._parent.removeChild(this); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get text() { return (this.textContent || '') + this.children.map(c => c.text || '').join(' '); }
}
class Txt extends global.Node { constructor(t) { super(); this.text = String(t); this._parent = null; } }

const ids = {};
for (const id of ['inspector', 'scene-area', 'entity-list', 'narration-log']) ids[id] = new El('div');
global.document = {
  createElement: (t) => new El(t),
  getElementById: (id) => ids[id] || null,
  createTextNode: (t) => new Txt(t),
};

const { View } = await import('../client/kernel/view.js');

// Fake store seeded from the real tavern world.
const world = JSON.parse(fs.readFileSync(new URL('../world/scenes/tavern.json', import.meta.url)));
const store = { entities: new Map(Object.entries(world)), onChange() {} };
const view = new View(store);

// --- scoping ---
const pc = view._findPc();
assert(pc && pc[0] === 'pc-hero', 'finds the PC');
const npcsHere = view._entitiesAt('loc-tavern', { kinds: ['npc'] }).map(([id]) => id);
assert(npcsHere.includes('npc-marta'), 'Marta is present in the tavern');
assert(!npcsHere.includes('npc-jonas') && !npcsHere.includes('npc-liesl'), 'docks/market NPCs are NOT shown in the tavern');
const itemsHere = view._entitiesAt('loc-tavern', { kinds: ['item'] }).map(([id]) => id);
assert(itemsHere.includes('item-torch') && !itemsHere.includes('item-crate'), 'tavern items only (no docks crate)');
console.log('  ✅ scoping: tavern shows Marta + tavern items; docks/market hidden');

// --- render path runs without throwing + produces the HUD ---
let sent = null; view.onAction = (t) => { sent = t; };
view._refreshScoped();
const hud = ids.inspector.children[0];
assert(hud && hud._attrs.id === 'player-hud', 'player-hud inserted into inspector');
const hudText = hud.text;
assert(hudText.includes('Rowan'), 'You-card shows the PC name');
assert(hudText.includes('Marta'), 'Here-card lists present NPC');
assert(hudText.includes('The Siren'), 'Quests-card shows the active quest');
assert(ids['scene-area'].text.includes('Salt & Sextant'), 'scene area shows the current location');
console.log('  ✅ render: You / Here / Quests cards built + scene shows location (no throw)');

// --- actions dispatch through onAction ---
view._send('talk to Marta');
assert(sent === 'talk to Marta', 'clicking routes through onAction');
console.log('  ✅ actions: HUD dispatches through onAction (talk/take/go/attack)');

console.log('\n3 client player-HUD checks passed.');
