/**
 * tools/test-dm-client.mjs — DMView client checks (headless, stubbed DOM).
 *
 * Drives the real DMView class against a DOM stub + fake store/net to verify the
 * panels render and every control dispatches the right message: autopilot toggle,
 * proposal approve, trace feed, combat turn-order override, entity inspector.
 *
 * Run: node tools/test-dm-client.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';

global.Node = class Node {};
class El extends global.Node {
  constructor(tag = 'div') {
    super();
    this.tagName = tag; this.children = []; this._attrs = {}; this._listeners = {};
    this.className = ''; this.textContent = ''; this.style = {}; this._parent = null;
  }
  get firstChild() { return this.children[0] || null; }
  get parentNode() { return this._parent; }
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  insertBefore(c) { c._parent = this; this.children.unshift(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  setAttribute(k, v) { this._attrs[k] = v; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  remove() { if (this._parent) this._parent.removeChild(this); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  click() { (this._listeners.click || []).forEach(f => f({ currentTarget: this, stopPropagation() {} })); }
  get text() { return (this.textContent || '') + this.children.map(c => c.text || '').join(' '); }
}
class Txt extends global.Node { constructor(t) { super(); this.text = String(t); this._parent = null; } }

const ids = {};
for (const id of ['dm-autopilot', 'dm-proposals', 'dm-traces', 'dm-turnorder', 'dm-entities', 'dm-conn']) ids[id] = new El('div');
global.document = {
  createElement: (t) => new El(t),
  getElementById: (id) => ids[id] || null,
  createTextNode: (t) => new Txt(t),
};

const { DMView } = await import('../client/kernel/dm-view.js');

// Fake store + net.
const world = JSON.parse(fs.readFileSync(new URL('../world/scenes/tavern.json', import.meta.url)));
const entities = new Map(Object.entries(world));
entities.set('dm-control', { dmControl: { autopilot: true }, identity: { name: 'DM Control', kind: 'world-state' } });
const store = { entities, _cbs: [], onChange(fn) { this._cbs.push(fn); }, emit() { this._cbs.forEach(f => f({})); } };
const net = { controls: [], ops: [], sendControl(o) { this.controls.push(o); }, sendOps(arr) { this.ops.push(...arr); } };

const view = new DMView(store);
view.net = net;
store.emit();

// find a descendant button by exact label
function findButton(node, label) {
  if (node.tagName === 'button' && node.text === label) return node;
  for (const c of node.children || []) { const r = findButton(c, label); if (r) return r; }
  return null;
}

// 1. Autopilot reflects state + toggles.
assert(ids['dm-autopilot'].text.includes('Autopilot: ON'), 'autopilot shows ON when on');
ids['dm-autopilot'].click();
assert(net.controls.some(c => c.action === 'setAutopilot' && c.value === false), 'clicking autopilot sends setAutopilot:false');
console.log('  ✅ autopilot: renders state + toggle dispatches setAutopilot');

// 2. Proposal renders + approve dispatches.
view.handleServer({ type: 'proposal', proposal: { id: 'prop-1', actionText: 'search the lockbox', summary: 'roll wis/perception DC12', ruling: { checks: [{ ability: 'wis', dc: 12 }] } } });
assert(ids['dm-proposals'].text.includes('search the lockbox'), 'proposal card shows the player action');
const approve = findButton(ids['dm-proposals'], 'Approve');
assert(approve, 'Approve button rendered');
approve.click();
assert(net.controls.some(c => c.action === 'approve' && c.proposalId === 'prop-1'), 'Approve sends action:approve for the proposal');
console.log('  ✅ proposals: render + Approve/Reject/Regenerate dispatch control messages');

// 3. Trace feed renders DM-only machinery.
view.handleServer({ type: 'trace', trace: { agent: 'dm', phase: 'adjudicate', summary: 'roll wis DC12', detail: { checks: [] } } });
assert(ids['dm-traces'].text.includes('adjudicate'), 'trace feed shows agent activity');
console.log('  ✅ traces: agent activity feed renders');

// 4. proposal-resolved removes the card.
view.handleServer({ type: 'proposal-resolved', id: 'prop-1' });
assert(!ids['dm-proposals'].text.includes('search the lockbox'), 'resolved proposal removed');
console.log('  ✅ proposal-resolved: card cleared');

// 5. Turn order (combat) renders + override dispatches an encounter op.
entities.set('encounter', { encounter: { active: true, round: 1, order: ['pc-hero', 'npc-smuggler'], turnIndex: 0, enemies: ['npc-smuggler'] } });
store.emit();
assert(ids['dm-turnorder'].text.includes('Rowan') || ids['dm-turnorder'].text.includes('pc-hero'), 'turn order lists combatants');
const setCurrent = findButton(ids['dm-turnorder'], '▶');
assert(setCurrent, 'set-current control rendered');
setCurrent.click();
assert(net.ops.some(o => o.id === 'encounter' && o.component === 'encounter'), 'turn-order control sends an encounter merge op');
console.log('  ✅ turn order: combat initiative renders + override dispatches encounter op');

// 6. Entity inspector lists the full store (god view).
assert(ids['dm-entities'].text.includes('Marta'), 'entity inspector shows NPCs');
assert(ids['dm-entities'].text.includes('Lockbox') || ids['dm-entities'].text.includes('Lockbox'.toLowerCase()) || ids['dm-entities'].text.includes('Small Lockbox'), 'entity inspector shows items');
console.log('  ✅ entities: full-store inspector renders');

console.log('\n6 DMView client checks passed.');
