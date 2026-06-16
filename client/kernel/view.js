/**
 * client/kernel/view.js — Reconcile store events to DOM.
 *
 * One-directional: store.onChange → view.handle(event).
 * Granular, no diffing. Switches on event kind + component name.
 *
 * P2: 4-lane transcript — narration, dialogue, system, player actions.
 * Generalizes streaming accumulation to any event with streamId.
 *
 * EXTENSION SEAM: add new component rendering in renderComponent().
 * New event kinds in handle().
 *
 * Based on GAIA's client/kernel/view.js reconciler pattern.
 */

import { el, clear } from './dom.js';

export class View {
  /**
   * @param {object} store — SessionStore instance
   */
  constructor(store) {
    this.store = store;

    // DOM refs
    this.entityListEl = document.getElementById('entity-list');
    this.transcriptEl = document.getElementById('transcript-entries');
    this.sceneAreaEl = document.getElementById('scene-area');
    this.narrationEntriesEl = document.getElementById('narration-entries'); // legacy back-compat

    // Track rendered entity elements for granular updates
    this._entityEls = new Map(); // id → DOM element
    this._entityDetailEls = new Map(); // id → detail panel element

    // Stream-aware event rendering: map streamId → {element, text}
    this._streamEls = new Map();

    // P6: quest tracker container (lazy-created)
    this._questTrackerEl = null;

    // Subscribe to store
    store.onChange((event) => this.handle(event));
  }

  /** Entry point for all store events. */
  handle(event) {
    switch (event.kind) {
      case 'snapshot':
        this._rebuildAll();
        break;
      case 'spawn':
        this._addEntity(event.id);
        break;
      case 'set':
      case 'merge':
        this._updateEntity(event.id, event.component);
        if (event.id === 'encounter') {
          this._renderEncounterHud();
        } else {
          const enc = this.store.entities.get('encounter');
          if (enc && enc.encounter && enc.encounter.active) {
            const allCombatants = new Set([...(enc.encounter.order || [])]);
            if (allCombatants.has(event.id)) {
              this._renderEncounterHud();
            }
          }
        }
        // P6: refresh quest tracker when quest or PC changes
        {
          const ent = this.store.entities.get(event.id);
          if (ent && ent.identity && (ent.identity.kind === 'quest' || ent.identity.kind === 'pc')) {
            this._renderQuestTracker();
          }
        }
        break;
      case 'despawn':
        this._removeEntity(event.id);
        break;
      case 'event':
        this._handleEvent(event);
        break;
      case 'action':
        this._handleAction(event);
        break;
      case 'reset':
        this._rebuildAll();
        break;
    }
  }

  // ---- Full rebuild (on snapshot/reset) ----

  _rebuildAll() {
    clear(this.entityListEl);
    this._entityEls.clear();
    this._entityDetailEls.clear();

    for (const [id, comps] of this.store.entities) {
      this._addEntity(id);
    }

    this._renderEncounterHud();
    this._renderQuestTracker();
  }

  // ---- Entity list ----

  _addEntity(id) {
    const comps = this.store.entities.get(id);
    if (!comps) return;

    // Skip presence entities in the entity list
    if (comps.presence) return;

    const identity = comps.identity || {};
    const status = comps.status || {};

    const name = identity.name || id;
    const kind = identity.kind || '?';
    const aliveBadge = status.alive === false
      ? ' ☠'
      : (comps.status ? ' ♥' : '');

    const row = el('div', {
      className: 'flex items-center gap-2 p-1 rounded hover:bg-gray-800 cursor-pointer transition-colors text-gray-300',
      'data-entity-id': id,
    }, [
      el('span', { className: 'text-xs text-gray-500 w-16 shrink-0' }, [kind]),
      el('span', { className: 'font-medium' }, [name + aliveBadge]),
    ]);

    row.addEventListener('click', () => this._toggleDetail(id, row));

    this.entityListEl.appendChild(row);
    this._entityEls.set(id, row);
  }

  _updateEntity(id, component) {
    // Re-render this entity's row
    const row = this._entityEls.get(id);
    if (!row) return;

    const comps = this.store.entities.get(id);
    if (!comps) { this._removeEntity(id); return; }

    const identity = comps.identity || {};
    const status = comps.status || {};
    const name = identity.name || id;
    const kind = identity.kind || '?';
    const aliveBadge = status.alive === false
      ? ' ☠'
      : (comps.status ? ' ♥' : '');

    const spans = row.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[0].textContent = kind;
      spans[1].textContent = name + aliveBadge;
    }

    const detail = this._entityDetailEls.get(id);
    if (detail) {
      this._renderDetail(id, detail);
    }
  }

  _removeEntity(id) {
    const row = this._entityEls.get(id);
    if (row) {
      row.remove();
      this._entityEls.delete(id);
    }
    const detail = this._entityDetailEls.get(id);
    if (detail) {
      detail.remove();
      this._entityDetailEls.delete(id);
    }
  }

  // ---- Detail panel (component inspector) ----

  _toggleDetail(id, row) {
    const existing = this._entityDetailEls.get(id);
    if (existing) {
      existing.remove();
      this._entityDetailEls.delete(id);
      return;
    }

    const detail = el('div', {
      className: 'ml-6 mb-2 text-xs bg-gray-800 rounded p-2 space-y-1 border border-gray-700',
    });

    this._renderDetail(id, detail);

    row.after(detail);
    this._entityDetailEls.set(id, detail);
  }

  _renderDetail(id, detailEl) {
    const comps = this.store.entities.get(id);
    if (!comps) return;

    clear(detailEl);

    for (const [compName, compValue] of Object.entries(comps)) {
      if (compName === 'persist') continue;
      this._renderComponent(detailEl, compName, compValue);
    }
  }

  /** EXTENSION SEAM: add rendering for new components here. */
  _renderComponent(parent, name, value) {
    const container = el('div', { className: 'mt-1' });

    const header = el('div', {
      className: 'text-gray-500 uppercase tracking-wider font-semibold mb-0.5',
      textContent: name,
    });
    container.appendChild(header);

    switch (name) {
      case 'identity': container.appendChild(this._renderIdentity(value)); break;
      case 'status': container.appendChild(this._renderStatus(value)); break;
      case 'stats': container.appendChild(this._renderStats(value)); break;
      case 'place': container.appendChild(this._renderPlace(value)); break;
      case 'persona': container.appendChild(this._renderPersona(value)); break;
      case 'inventory': container.appendChild(this._renderInventory(value)); break;
      case 'quest': container.appendChild(this._renderQuest(value)); break;
      case 'presence': container.appendChild(this._renderPresence(value)); break;
      case 'knowledge': container.appendChild(this._renderKnowledge(value)); break;
      case 'agent': container.appendChild(this._renderAgent(value)); break;
      case 'encounter': container.appendChild(this._renderEncounter(value)); break;
      default:
        container.appendChild(el('div', { className: 'text-gray-400 italic' }, [
          typeof value === 'object' ? JSON.stringify(value).slice(0, 100) : String(value),
        ]));
    }

    parent.appendChild(container);
  }

  _renderIdentity(v) {
    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      el('div', {}, [`Name: ${v.name || '?'}`]),
      el('div', {}, [`Kind: ${v.kind || '?'}`]),
      v.description ? el('div', {}, [`"${v.description}"`]) : '',
    ].filter(Boolean));
  }

  _renderStatus(v) {
    return el('div', { className: 'text-gray-300' }, [
      `Alive: ${v.alive !== false ? 'yes' : 'no'}`,
      v.conditions && v.conditions.length > 0 ? ` · ${v.conditions.join(', ')}` : '',
    ].join(''));
  }

  _renderStats(v) {
    return el('div', { className: 'text-gray-300' }, [
      `HP: ${v.hp ?? '?'} / ${v.maxHp ?? '?'}`,
    ].join(''));
  }

  _renderPlace(v) {
    const loc = v.locationId || '(none)';
    const conns = (v.connections || []).map(c => c.targetId || c.label || '?').join(', ');
    return el('div', { className: 'text-gray-300' }, [
      `Location: ${loc}`,
      conns ? ` · Exits: ${conns}` : '',
    ].join(''));
  }

  _renderPersona(v) {
    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      v.personality ? el('div', {}, [`Personality: ${v.personality}`]) : '',
      v.backstory ? el('div', {}, [`Backstory: ${v.backstory}`]) : '',
      v.voice ? el('div', {}, [`Voice: ${v.voice}`]) : '',
    ].filter(Boolean));
  }

  _renderInventory(v) {
    const items = (v.items || []).map(i => i.id || i.name || '?').join(', ') || '(empty)';
    return el('div', { className: 'text-gray-300' }, [`Items: ${items}`]);
  }

  _renderQuest(v) {
    return el('div', { className: 'text-gray-300' }, [
      `Phase: ${v.phase || '?'} · Step: ${v.currentStep ?? 0}/${(v.steps || []).length}`,
    ].join(''));
  }

  _renderPresence(v) {
    return el('div', { className: 'text-gray-300' }, [
      `${v.who || '?'} (${v.seat || '?'} / ${v.mode || '?'})`,
    ].join(''));
  }

  _renderKnowledge(v) {
    const facts = (v.facts || []).map(f => el('li', {}, [`F: ${f}`]));
    const secrets = (v.secrets || []).map(s => el('li', {}, [`S: ${s}`]));
    return el('div', { className: 'text-gray-300' }, [
      el('ul', { className: 'list-disc list-inside' }, [...facts, ...secrets]),
    ]);
  }

  _renderAgent(v) {
    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      el('div', {}, [`Enabled: ${v.enabled !== false ? 'yes' : 'no'}`]),
      v.accent ? el('div', {}, [`Accent: ${v.accent}`]) : '',
      v.model ? el('div', {}, [`Model: ${v.model}`]) : '',
    ].filter(Boolean));
  }

  // ---- Events: 4-lane transcript ----

  /**
   * Handle an event op from the store.
   * Routes to the appropriate renderer based on event name.
   */
  _handleEvent(event) {
    switch (event.name) {
      case 'narration':
        this._handleStreamingEvent(event.data, 'narration');
        break;
      case 'dialogue':
        this._handleStreamingEvent(event.data, 'dialogue');
        break;
      case 'system':
        // P3: system events may be rolls (kind:'roll') or generic messages
        if (event.data && event.data.kind === 'roll') {
          this._handleRollEvent(event.data);
        } else {
          this._handleStreamingEvent(event.data, 'system');
        }
        break;
      default:
        break;
    }
  }

  /**
   * Handle an action from the player (broadcast from server after journaling).
   */
  _handleAction(event) {
    const text = event.text || '';
    const by = event.by || 'You';
    this._appendTranscriptEntry('action', {
      by,
      text,
      done: true,
    });
  }

  /**
   * P3: render dice roll result as a centered, muted line.
   */
  _handleRollEvent(data) {
    const text = data.text || 'Unknown roll';
    const detail = data.detail || {};
    const success = detail.success !== undefined ? detail.success : null;

    const entry = el('div', { className: 'py-1 text-center' }, [
      el('span', {
        className: 'text-xs px-2 py-0.5 rounded ' + (success === true
          ? 'text-green-400/70 bg-green-900/20'
          : success === false
          ? 'text-red-400/70 bg-red-900/20'
          : 'text-gray-500 bg-gray-800/50 italic'),
        textContent: text,
      }),
    ]);

    this._getTranscriptContainer().appendChild(entry);
    this._scrollToBottom();
  }

  /**
   * Generalized streaming event handler — works for narration, dialogue, system.
   * - delta events with streamId: find/create entry, accumulate text
   * - done:true events with streamId: finalize entry
   * - events without streamId: render as single complete entry
   */
  _handleStreamingEvent(data, eventName) {
    if (!data) return;

    const streamId = data.streamId;

    if (streamId) {
      const existing = this._streamEls.get(streamId);

      if (data.done) {
        // Finalize — render as complete entry
        const finalText = data.text || (existing ? existing.text : '');
        const mergedData = { ...data, text: finalText, done: true };
        this._appendTranscriptEntry(eventName, mergedData);

        // Remove streaming element if it exists
        if (existing) {
          existing.element.remove();
          this._streamEls.delete(streamId);
        }
        return;
      }

      if (data.delta) {
        if (existing) {
          // Append delta to existing streaming entry
          existing.text += data.delta;
          this._updateStreamingEntry(existing, eventName, data);
        } else {
          // Create new streaming entry
          const entryEl = this._createStreamingEntry(eventName, data);
          this._getTranscriptContainer().appendChild(entryEl);
          this._streamEls.set(streamId, { element: entryEl, text: data.delta });
        }
      }
    } else {
      // No streamId — render as single complete entry
      this._appendTranscriptEntry(eventName, data);
    }

    this._scrollToBottom();
  }

  /**
   * Append a completed transcript entry (non-streaming).
   */
  _appendTranscriptEntry(eventName, data) {
    const container = this._getTranscriptContainer();
    const entryEl = this._renderTranscriptEntry(eventName, data, true);
    container.appendChild(entryEl);
    this._scrollToBottom();
  }

  /**
   * Create a streaming entry (delta-only, will be updated via _updateStreamingEntry).
   */
  _createStreamingEntry(eventName, data) {
    return this._renderTranscriptEntry(eventName, data, false);
  }

  /**
   * Update an existing streaming entry's text content.
   */
  _updateStreamingEntry(existing, eventName, data) {
    // Simple approach: replace inner content of the text area
    const textEl = existing.element.querySelector('[data-transcript-text]');
    if (textEl) {
      textEl.textContent = existing.text;
    }
  }

  /**
   * Render a single transcript entry element based on event name.
   * 4 lanes:
   *   - narration (by:'dm'): full-width prose, muted-gold "narrator" styling
   *   - dialogue: speaker chip with accent color, bubble styling
   *   - system: compact, muted, centered
   *   - action: right-aligned "You: <text>"
   *
   * @param {string} eventName — 'narration', 'dialogue', 'system', 'action'
   * @param {object} data — event data {text, delta, done, by, speaker, name, accent, ...}
   * @param {boolean} done — whether this is the finalized entry
   * @returns {HTMLElement}
   */
  _renderTranscriptEntry(eventName, data, done) {
    switch (eventName) {
      case 'narration':
        return this._renderNarrationEntry(data, done);
      case 'dialogue':
        return this._renderDialogueEntry(data, done);
      case 'system':
        return this._renderSystemEntry(data, done);
      case 'action':
        return this._renderActionEntry(data, done);
      default:
        return this._renderGenericEntry(data, eventName, done);
    }
  }

  /**
   * DM narration lane: full-width prose, muted-gold styling, no chip.
   */
  _renderNarrationEntry(data, done) {
    const text = data.delta || data.text || '';
    const isStreaming = !done && !!data.streamId;

    const classes = 'py-2 border-b border-gray-800 last:border-0';
    const textClasses = 'text-amber-200/80 italic leading-relaxed';

    const entry = el('div', { className: classes }, [
      el('div', { className: 'flex items-start gap-2' }, [
        el('span', {
          className: 'text-xs text-amber-600/60 uppercase tracking-wider shrink-0 mt-0.5 w-16 text-right',
          textContent: 'narrator',
        }),
        el('span', {
          className: textClasses + (isStreaming ? '' : ''),
          'data-transcript-text': '',
          textContent: isStreaming ? text : text,
        }),
      ]),
    ]);

    return entry;
  }

  /**
   * NPC dialogue lane: speaker chip (name) with accent color, quote/bubble styling.
   */
  _renderDialogueEntry(data, done) {
    const text = data.delta || data.text || '';
    const speaker = data.name || data.speaker || 'NPC';
    const accent = data.accent || '#4a9eff';
    const isStreaming = !done && !!data.streamId;

    const entry = el('div', { className: 'py-2 border-b border-gray-800 last:border-0' }, [
      el('div', { className: 'flex items-start gap-2' }, [
        // Portrait slot (empty box for now — P4 fills it)
        el('div', {
          className: 'w-8 h-8 rounded-full shrink-0 border border-dashed flex items-center justify-center text-xs',
          style: `border-color:${accent}66; color:${accent}`,
          textContent: speaker.charAt(0).toUpperCase(),
        }),
        // Speaker chip + text
        el('div', { className: 'flex-1 min-w-0' }, [
          el('span', {
            className: 'inline-block text-xs font-semibold px-2 py-0.5 rounded-full mb-1',
            style: `background:${accent}22; color:${accent}; border:1px solid ${accent}44`,
            textContent: speaker,
          }),
          el('div', {
            className: 'text-gray-200 leading-relaxed',
            'data-transcript-text': '',
            textContent: isStreaming ? text : `"${text}"`,
          }),
        ]),
      ]),
    ]);

    return entry;
  }

  /**
   * System lane: compact, muted, centered.
   */
  _renderSystemEntry(data, done) {
    const text = data.delta || data.text || '';
    const isStreaming = !done && !!data.streamId;

    const entry = el('div', { className: 'py-1 text-center' }, [
      el('span', {
        className: 'text-xs text-gray-600 italic',
        'data-transcript-text': '',
        textContent: isStreaming ? text : text,
      }),
    ]);

    return entry;
  }

  /**
   * Player action lane: right-aligned "You: <text>".
   */
  _renderActionEntry(data, done) {
    const text = data.text || '';
    const by = data.by || 'You';

    const entry = el('div', { className: 'py-1 text-right' }, [
      el('span', { className: 'text-xs text-blue-400/60 mr-1' }, [`${by}:`]),
      el('span', { className: 'text-blue-200' }, [text]),
    ]);

    return entry;
  }

  /**
   * Generic fallback for unknown event types.
   */
  _renderGenericEntry(data, eventName, done) {
    const text = data.delta || data.text || JSON.stringify(data);
    const entry = el('div', { className: 'py-1 border-b border-gray-800 last:border-0' }, [
      el('span', { className: 'text-xs text-gray-500 mr-2' }, [eventName]),
      el('span', { className: 'text-gray-400' }, [text]),
    ]);
    return entry;
  }

  // ---- Legacy narration (back-compat for P0/P1 if they use narration-entries) ----

  _handleNarration(data) {
    if (!this.narrationEntriesEl) return;
    // Forward to the new streaming handler
    this._handleStreamingEvent(data, 'narration');
  }

  // ---- Helpers ----

  /**
   * Get the transcript container element (create if missing).
   */
  _getTranscriptContainer() {
    if (this.transcriptEl) return this.transcriptEl;

    // Fall back to narration-entries div for back-compat
    if (this.narrationEntriesEl) {
      this.transcriptEl = this.narrationEntriesEl;
      return this.narrationEntriesEl;
    }

    // Create a new transcript area
    const narrationLogEl = document.getElementById('narration-log');
    if (narrationLogEl) {
      this.transcriptEl = el('div', { id: 'transcript-entries', className: 'text-sm space-y-0' });
      // Replace or append
      const existing = narrationLogEl.querySelector('#transcript-entries');
      if (existing) {
        this.transcriptEl = existing;
      } else {
        // Remove the placeholder, add transcript
        const placeholder = narrationLogEl.querySelector('.text-gray-600');
        if (placeholder) placeholder.remove();
        narrationLogEl.appendChild(this.transcriptEl);
      }
      return this.transcriptEl;
    }

    // Ultimate fallback
    console.warn('[view] No transcript container found');
    return document.body;
  }

  _scrollToBottom() {
    const log = document.getElementById('narration-log');
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }

  // ---- Combat HUD (P5) ----

  _renderEncounterHud() {
    const entity = this.store.entities.get('encounter');
    const enc = entity && entity.encounter ? entity.encounter : null;

    if (!enc || !enc.active) {
      // Restore placeholder
      clear(this.sceneAreaEl);
      this.sceneAreaEl.className = 'col-span-8 bg-gray-900 rounded-lg border border-gray-700 flex items-center justify-center min-h-[200px]';
      this.sceneAreaEl.appendChild(el('span', { className: 'text-gray-600 text-sm' }, ['[ scene image — P4 ]']));
      return;
    }

    const round = enc.round;
    const order = enc.order || [];
    const turnIndex = enc.turnIndex;
    const enemies = new Set(enc.enemies || []);

    clear(this.sceneAreaEl);
    this.sceneAreaEl.className = 'col-span-8 bg-gray-900 rounded-lg border border-gray-700 p-3 min-h-[200px] overflow-y-auto';

    // Round header
    this.sceneAreaEl.appendChild(
      el('div', { className: 'text-center mb-3' }, [
        el('span', { className: 'text-lg font-bold text-yellow-400' }, [`⚔ Round ${round}`]),
      ])
    );

    // Initiative order rows
    const orderContainer = el('div', { className: 'space-y-1' });

    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const comps = this.store.entities.get(id);
      if (!comps) continue;

      const identity = comps.identity || {};
      const stats = comps.stats || {};
      const status = comps.status || {};
      const name = identity.name || id;
      const hp = stats.hp ?? '?';
      const maxHp = stats.maxHp ?? '?';
      const alive = status.alive !== false;
      const isCurrent = i === turnIndex;
      const isEnemy = enemies.has(id);

      const hpPercent = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 100;
      const barColor = hpPercent > 50 ? 'bg-green-500' : hpPercent > 25 ? 'bg-yellow-500' : 'bg-red-500';

      const row = el('div', {
        className: `flex items-center gap-2 p-2 rounded ${isCurrent ? 'bg-gray-700 border border-yellow-600' : ''} ${!alive ? 'opacity-50' : ''}`,
      }, [
        el('span', { className: 'text-xs text-gray-500 w-6 shrink-0' }, [String(i + 1)]),
        el('span', {
          className: `font-medium text-sm ${alive ? (isEnemy ? 'text-red-300' : 'text-blue-300') : 'text-gray-500 line-through'}`,
          textContent: name + (isCurrent ? ' ◀' : ''),
        }),
        el('div', { className: 'flex-1 h-4 bg-gray-800 rounded overflow-hidden ml-2' }, [
          el('div', {
            className: `h-full ${barColor} rounded transition-all`,
            style: `width:${hpPercent}%`,
          }),
        ]),
        el('span', { className: 'text-xs text-gray-400 w-16 text-right shrink-0' }, [
          `${hp}/${maxHp}`,
        ]),
      ]);

      orderContainer.appendChild(row);
    }

    this.sceneAreaEl.appendChild(orderContainer);
  }

  // ---- Quest tracker (P6) ----

  _renderQuestTracker() {
    // Ensure container exists in the inspector, above the entity list
    if (!this._questTrackerEl || !this._questTrackerEl.parentNode) {
      const inspector = document.getElementById('inspector');
      const entityList = document.getElementById('entity-list');
      if (!inspector || !entityList) return;

      this._questTrackerEl = el('div', {
        className: 'mb-3 p-2 bg-gray-800 rounded border border-gray-700 text-xs',
      });
      inspector.insertBefore(this._questTrackerEl, entityList);
    }

    clear(this._questTrackerEl);

    // --- PC: level + XP ---
    let pc = null;
    for (const [, comps] of this.store.entities) {
      if (comps.identity && comps.identity.kind === 'pc') {
        pc = comps;
        break;
      }
    }

    if (pc && pc.stats) {
      const level = pc.stats.level || 1;
      const xp = pc.stats.xp || 0;
      this._questTrackerEl.appendChild(
        el('div', { className: 'flex items-center gap-2 mb-2' }, [
          el('span', { className: 'text-yellow-400 font-bold' }, [`Lv ${level}`]),
          el('span', { className: 'text-gray-400' }, [`· XP ${xp}`]),
        ]),
      );
    }

    // --- Quests ---
    const quests = [];
    for (const [, comps] of this.store.entities) {
      if (comps.identity && comps.identity.kind === 'quest') {
        quests.push(comps);
      }
    }

    if (quests.length === 0) return;

    // Divider
    this._questTrackerEl.appendChild(
      el('div', { className: 'border-t border-gray-700 my-1.5' }),
    );

    // Header
    this._questTrackerEl.appendChild(
      el('div', { className: 'text-gray-500 uppercase tracking-wider mb-1 text-[10px]' }, ['Quests']),
    );

    for (const q of quests) {
      const qc = q.quest;
      if (!qc) continue;

      const name = (q.identity && q.identity.name) || '?';
      const phase = qc.phase;
      const steps = qc.steps || [];
      const cur = qc.currentStep ?? 0;

      if (phase === 'completed') {
        this._questTrackerEl.appendChild(
          el('div', { className: 'text-gray-600 line-through' }, [`✓ ${name} — Complete`]),
        );
      } else if (phase === 'active') {
        const stepData = steps[cur];
        const stepText = typeof stepData === 'string'
          ? stepData
          : (stepData && stepData.text ? stepData.text : `Step ${cur + 1}`);
        this._questTrackerEl.appendChild(
          el('div', { className: 'mb-1' }, [
            el('div', { className: 'text-gray-300 font-medium' }, [name]),
            el('div', { className: 'text-gray-500' }, [`${cur + 1}/${steps.length} — ${stepText}`]),
          ]),
        );
      }
    }
  }

  _renderEncounter(v) {
    const orderPreview = (v.order || []).map(id => {
      const comps = this.store.entities.get(id);
      return comps && comps.identity ? comps.identity.name : id;
    }).join(' → ');

    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      el('div', {}, [`Active: ${v.active ? 'yes' : 'no'}`]),
      el('div', {}, [`Round: ${v.round} · Turn: ${v.turnIndex}`]),
      el('div', {}, [`Mode: ${v.mode}`]),
      el('div', {}, [`Allies: ${(v.allies || []).join(', ')}`]),
      el('div', {}, [`Enemies: ${(v.enemies || []).join(', ')}`]),
      el('div', {}, [`Order: ${orderPreview}`]),
    ].filter(Boolean));
  }
}
