/**
 * server/session.js — Session class.
 * Owns the canonical entity store (Map<id, components>), journal, and counter.
 * Handles op application, save/load, seed from campaign files.
 *
 * Based on GAIA's world.js pattern.
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyOp, isCanonOp } from '../shared/ops.js';

const JOURNAL_CAP = 2000;

export class Session {
  entities = new Map();       // id → { componentName: value }
  counter = 0;               // auto-increment entity id counter
  journal = [];              // [{seq, t, from, ...op}]
  listeners = new Set();     // callbacks called with (journalEntry) after each op
  _seq = 0;
  _savePath = null;
  _saveTimer = null;
  _seedDir = null;

  /**
   * @param {string} seedDir — path to world/ (campaign directory)
   * @param {string} saveSlot — TTRPG_SAVE env value (default "default")
   */
  constructor(seedDir, saveSlot = 'default') {
    this._seedDir = seedDir;
    const savesDir = path.join(seedDir, 'saves');
    if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir, { recursive: true });
    this._savePath = path.join(savesDir, `session_${saveSlot}.json`);
  }

  // ---- Listeners ----

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(entry) {
    for (const fn of this.listeners) {
      try { fn(entry); } catch (_) { /* ignore listener errors */ }
    }
  }

  // ---- Snapshot ----

  snapshot() {
    const entities = {};
    for (const [id, comps] of this.entities) {
      entities[id] = JSON.parse(JSON.stringify(comps));
    }
    return {
      type: 'snapshot',
      time: Date.now(),
      counter: this.counter,
      entities,
      world: this._seedDir,
      ruleset: null, // P1+
    };
  }

  // ---- Events / journal ----

  /** Return journal entries since seq (exclusive), up to limit. */
  eventsSince(seq, limit = 200) {
    const start = this.journal.findIndex(e => e.seq > seq);
    if (start === -1) return { latest: this._seq, events: [] };
    const events = this.journal.slice(start, start + limit);
    return { latest: this._seq, events };
  }

  // ---- Apply ops ----

  /**
   * Apply a batch of ops.
   * @param {object[]} ops
   * @param {string} from — who sent the ops
   * @param {number} [t] — timestamp (default Date.now())
   * @returns {{ok:boolean, applied:object[], error?:string}}
   */
  applyOps(ops, from, t = Date.now()) {
    const counterRef = { value: this.counter };
    const applied = [];
    const broadcast = [];   // full ops (with payload) to send to clients
    let resnapshot = false; // set true after a reset → server re-sends a snapshot

    for (const op of ops) {
      // Reset re-seeds from disk; handled here and surfaced via a fresh snapshot.
      if (op.op === 'reset') {
        this.reset(op.scene || null);
        resnapshot = true;
        applied.push({ ...op });
        continue;
      }

      const result = applyOp(this.entities, op, counterRef);
      if (!result.ok) {
        return { ok: false, error: result.error, applied, broadcast, resnapshot };
      }
      this.counter = counterRef.value;

      this._journal(op, from, t, result);

      // Broadcast the FULL op so clients can reconcile — never the compact journal entry.
      if (result.broadcast) {
        if (op.op === 'spawn') {
          broadcast.push({ op: 'spawn', id: result.id, components: op.components || {} });
        } else {
          broadcast.push(op);
        }
      }

      applied.push({ ...op, _result: result });
    }

    if (applied.some(a => isCanonOp(a))) this._debounceSave();

    return { ok: true, applied, broadcast, resnapshot };
  }

  /**
   * Append a journal entry = op + {seq,t,from}. Carries the full op payload
   * (components/value/data) so /events can replay state — GAIA's journal model.
   */
  _journal(op, from, t, result) {
    const full = { ...op };
    if (op.op === 'spawn' && !full.id && result && result.id) full.id = result.id;
    const entry = { seq: ++this._seq, t, from, ...full };
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_CAP) {
      this.journal = this.journal.slice(-JOURNAL_CAP);
    }
    this._notify(entry);
    return entry;
  }

  // ---- Seed from world directory ----

  /** Load campaign.json + scenes/*.json into entities. */
  seedFromWorld(dir) {
    this._seedDir = dir;
    this.entities.clear();
    this.counter = 0;

    // Load campaign.json (superscene — just validate existence for P0)
    const campaignPath = path.join(dir, 'campaign.json');
    let campaign = {};
    if (fs.existsSync(campaignPath)) {
      campaign = JSON.parse(fs.readFileSync(campaignPath, 'utf-8'));
    }

    // Load all scene files
    const scenesDir = path.join(dir, 'scenes');
    if (fs.existsSync(scenesDir)) {
      for (const file of fs.readdirSync(scenesDir)) {
        if (!file.endsWith('.json')) continue;
        const sceneData = JSON.parse(fs.readFileSync(path.join(scenesDir, file), 'utf-8'));
        for (const [id, comps] of Object.entries(sceneData)) {
          this.entities.set(id, JSON.parse(JSON.stringify(comps)));
          // Track counter from numeric ids like "e42"
          const match = id.match(/^e(\d+)$/);
          if (match) {
            const n = parseInt(match[1], 10);
            if (n > this.counter) this.counter = n;
          }
        }
      }
    }

    return campaign;
  }

  // ---- Reset ----

  /**
   * Reset: re-seed from campaign files, preserving persist/presence entities.
   * @param {string} [scene] — specific scene to reset (null = full reset)
   */
  reset(scene = null) {
    // Collect persist + presence entities
    const preserved = new Map();
    for (const [id, comps] of this.entities) {
      if (comps.persist || comps.presence) {
        preserved.set(id, JSON.parse(JSON.stringify(comps)));
      }
    }

    // Re-seed
    this.seedFromWorld(this._seedDir);

    // Restore preserved
    for (const [id, comps] of preserved) {
      this.entities.set(id, comps);
    }

    // Notify full reset via journal
    const entry = {
      seq: ++this._seq,
      t: Date.now(),
      from: 'system',
      op: 'reset',
      scene: scene || null,
    };
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_CAP) {
      this.journal = this.journal.slice(-JOURNAL_CAP);
    }
    this._notify(entry);
  }

  // ---- Save / Load ----

  /** Save canon entities to session save file. */
  save() {
    if (!this._savePath) return;
    const data = {
      savedAt: new Date().toISOString(),
      counter: this.counter,
      entities: {},
    };
    for (const [id, comps] of this.entities) {
      data.entities[id] = JSON.parse(JSON.stringify(comps));
    }
    fs.writeFileSync(this._savePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Load canon overlay from session save. Overlays on top of seeded entities. */
  load() {
    if (!this._savePath || !fs.existsSync(this._savePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._savePath, 'utf-8'));
      if (data.counter > this.counter) this.counter = data.counter;
      for (const [id, comps] of Object.entries(data.entities || {})) {
        this.entities.set(id, JSON.parse(JSON.stringify(comps)));
      }
    } catch (e) {
      console.error('Session load error:', e.message);
    }
  }

  /** Debounced save (300ms). */
  _debounceSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.save();
      this._saveTimer = null;
    }, 300);
  }

  /** Flush any pending save immediately. */
  flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.save();
    }
  }
}
