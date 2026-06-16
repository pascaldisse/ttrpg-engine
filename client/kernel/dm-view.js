/**
 * client/kernel/dm-view.js — the DMView surface (DM seat).
 *
 * Renders the DM control panels from the same store + WS the player client uses:
 *   - Autopilot toggle (pause/run the propose→commit gate)
 *   - Proposals: pending LLM beats with approve / reject / regenerate + reveal-detail
 *   - Agent activity: DM-only trace events (decisions / tool calls), reveal-detail
 *   - Turn order: combat initiative with reorder / set-current overrides
 *   - Entities (full): the god-mode inspector — the DM is who SHOULD see everything
 *
 * Store events drive the autopilot/turn-order/entity panels; non-store WS messages
 * (proposal / trace / proposal-resolved) arrive via handleServer().
 */

import { el, clear } from './dom.js';

export class DMView {
  constructor(store) {
    this.store = store;
    this.net = null; // set by dm.js — used to send control messages + ops

    this.proposals = new Map(); // id → {id, actionText, summary, ruling}
    this.traces = [];           // recent trace events (capped)

    this.autopilotEl = document.getElementById('dm-autopilot');
    this.proposalsEl = document.getElementById('dm-proposals');
    this.tracesEl = document.getElementById('dm-traces');
    this.turnOrderEl = document.getElementById('dm-turnorder');
    this.entitiesEl = document.getElementById('dm-entities');

    if (this.autopilotEl) {
      this.autopilotEl.addEventListener('click', () => {
        if (this.net) this.net.sendControl({ action: 'setAutopilot', value: !this._autopilotOn() });
      });
    }

    store.onChange(() => this._renderStorePanels());
  }

  // ---- Server (non-store) messages ----

  handleServer(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'proposal':
        this.proposals.set(msg.proposal.id, msg.proposal);
        this._renderProposals();
        break;
      case 'proposal-resolved':
        this.proposals.delete(msg.id);
        this._renderProposals();
        break;
      case 'trace':
        this.traces.push(msg.trace);
        if (this.traces.length > 60) this.traces = this.traces.slice(-60);
        this._renderTraces();
        break;
    }
  }

  _renderStorePanels() {
    this._renderAutopilot();
    this._renderTurnOrder();
    this._renderEntities();
    const conn = document.getElementById('dm-conn');
    if (conn) conn.textContent = `${this.store.entities.size} entities`;
  }

  // ---- Autopilot ----

  _autopilotOn() {
    const ctrl = this.store.entities.get('dm-control');
    // Absent or autopilot!==false → on (default).
    return !ctrl || !ctrl.dmControl || ctrl.dmControl.autopilot !== false;
  }

  _renderAutopilot() {
    if (!this.autopilotEl) return;
    const on = this._autopilotOn();
    this.autopilotEl.textContent = on ? 'Autopilot: ON' : 'Autopilot: OFF (you gate beats)';
    this.autopilotEl.className = 'text-sm font-medium py-1.5 px-4 rounded transition-colors '
      + (on ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-amber-600 hover:bg-amber-500 text-white');
  }

  // ---- Proposals ----

  _renderProposals() {
    if (!this.proposalsEl) return;
    clear(this.proposalsEl);

    if (!this.proposals.size) {
      this.proposalsEl.appendChild(el('div', { className: 'text-sm text-gray-600 italic' }, [
        this._autopilotOn() ? 'Autopilot on — beats apply automatically. Turn it off to review each one.' : 'No pending proposals.',
      ]));
      return;
    }

    for (const p of this.proposals.values()) {
      const card = el('div', { className: 'p-2 bg-gray-800 rounded border border-amber-700/50' }, [
        el('div', { className: 'text-xs text-blue-300/80 mb-0.5' }, [`Player: "${p.actionText}"`]),
        el('div', { className: 'text-sm text-gray-100 mb-2' }, [p.summary || '(beat)']),
        el('div', { className: 'flex gap-2 mb-1' }, [
          this._btn('Approve', 'bg-emerald-700 hover:bg-emerald-600', () => this._resolve(p.id, 'approve')),
          this._btn('Reject', 'bg-red-800 hover:bg-red-700', () => this._resolve(p.id, 'reject')),
          this._btn('Regenerate', 'bg-gray-700 hover:bg-gray-600', () => this._resolve(p.id, 'regenerate')),
        ]),
        this._detail('ruling', p.ruling),
      ]);
      this.proposalsEl.appendChild(card);
    }
  }

  _resolve(id, action) {
    if (this.net) this.net.sendControl({ action, proposalId: id });
  }

  // ---- Trace feed ----

  _renderTraces() {
    if (!this.tracesEl) return;
    clear(this.tracesEl);
    // newest first
    for (const t of [...this.traces].reverse()) {
      const row = el('div', { className: 'border-b border-gray-800 pb-1' }, [
        el('div', { className: 'flex items-baseline gap-2' }, [
          el('span', { className: 'text-[10px] uppercase tracking-wider text-purple-300/70 w-24 shrink-0' }, [`${t.agent || '?'} · ${t.phase || ''}`]),
          el('span', { className: 'text-gray-300' }, [t.summary || '']),
        ]),
        t.detail !== undefined ? this._detail('detail', t.detail) : '',
      ].filter(Boolean));
      this.tracesEl.appendChild(row);
    }
  }

  // ---- Turn order (combat) ----

  _renderTurnOrder() {
    if (!this.turnOrderEl) return;
    clear(this.turnOrderEl);

    const enc = this.store.entities.get('encounter');
    const e = enc && enc.encounter;
    if (!e || !e.active || !(e.order || []).length) {
      this.turnOrderEl.appendChild(el('div', { className: 'text-sm text-gray-600 italic' }, ['No active combat.']));
      return;
    }

    const order = e.order || [];
    const enemies = new Set(e.enemies || []);
    order.forEach((id, i) => {
      const comps = this.store.entities.get(id) || {};
      const name = (comps.identity || {}).name || id;
      const cur = i === e.turnIndex;
      const isEnemy = enemies.has(id);
      const row = el('div', { className: `flex items-center gap-2 p-1 rounded ${cur ? 'bg-gray-700 border border-yellow-600' : ''}` }, [
        el('span', { className: 'text-xs text-gray-500 w-5' }, [String(i + 1)]),
        el('span', { className: `flex-1 ${isEnemy ? 'text-red-300' : 'text-blue-300'}` }, [name + (cur ? ' ◀' : '')]),
        this._miniBtn('▲', () => this._reorder(order, i, i - 1)),
        this._miniBtn('▼', () => this._reorder(order, i, i + 1)),
        this._miniBtn('▶', () => this._setCurrent(i)),
      ]);
      this.turnOrderEl.appendChild(row);
    });
  }

  _reorder(order, i, j) {
    if (j < 0 || j >= order.length || !this.net) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    this.net.sendOps([{ op: 'merge', id: 'encounter', component: 'encounter', value: { order: next } }]);
  }

  _setCurrent(i) {
    if (this.net) this.net.sendOps([{ op: 'merge', id: 'encounter', component: 'encounter', value: { turnIndex: i } }]);
  }

  // ---- Entity inspector (full store) ----

  _renderEntities() {
    if (!this.entitiesEl) return;
    clear(this.entitiesEl);
    const ids = [...this.store.entities.keys()].sort();
    for (const id of ids) {
      const comps = this.store.entities.get(id);
      if (comps.presence) continue;
      const identity = comps.identity || {};
      const dead = (comps.status || {}).alive === false;
      const row = el('div', {}, [
        el('div', {
          className: 'flex items-center gap-2 py-0.5 cursor-pointer hover:bg-gray-800 rounded px-1',
          onclick: (ev) => this._toggleEntity(id, ev.currentTarget),
        }, [
          el('span', { className: 'text-[10px] text-gray-500 w-16 shrink-0' }, [identity.kind || '?']),
          el('span', { className: dead ? 'text-gray-600 line-through' : 'text-gray-300' }, [identity.name || id]),
        ]),
      ]);
      this.entitiesEl.appendChild(row);
    }
  }

  _toggleEntity(id, rowEl) {
    const existing = rowEl.parentNode.querySelector('[data-detail]');
    if (existing) { existing.remove(); return; }
    const comps = this.store.entities.get(id) || {};
    const det = el('pre', {
      'data-detail': '',
      className: 'text-[11px] text-gray-400 bg-gray-950 rounded p-2 ml-4 my-1 overflow-x-auto whitespace-pre-wrap',
    }, [JSON.stringify(comps, null, 2)]);
    rowEl.parentNode.appendChild(det);
  }

  // ---- helpers ----

  _btn(label, color, onClick) {
    return el('button', { className: `text-xs font-medium py-1 px-3 rounded text-white ${color}`, onclick: onClick }, [label]);
  }

  _miniBtn(label, onClick) {
    return el('button', { className: 'text-xs px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200', onclick: onClick }, [label]);
  }

  _detail(label, value) {
    const summary = el('summary', { className: 'text-[11px] text-gray-500 cursor-pointer hover:text-gray-300 select-none' }, [`reveal ${label}`]);
    const pre = el('pre', { className: 'text-[11px] text-gray-400 bg-gray-950 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap' },
      [typeof value === 'string' ? value : JSON.stringify(value, null, 2)]);
    return el('details', { className: 'mt-1' }, [summary, pre]);
  }
}
