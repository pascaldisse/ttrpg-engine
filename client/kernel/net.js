/**
 * client/kernel/net.js — WebSocket connection manager.
 *
 * Connects to the server, handles snapshot + ops messages,
 * routes into the SessionStore. Auto-reconnects with backoff.
 *
 * Based on GAIA's client/kernel/net.js pattern.
 */

export class NetClient {
  /**
   * @param {object} store — SessionStore instance
   * @param {string} [who] — player name
   */
  constructor(store, who = 'player') {
    this.store = store;
    this.who = who;
    this.ws = null;
    this._reconnectDelay = 500;
    this._presenceId = `presence-${Math.random().toString(36).slice(2, 8)}`;
    this._connected = false;
    this._onConnectedCallbacks = [];
  }

  /** Called once when connection is established (or re-established). */
  onConnected(fn) {
    this._onConnectedCallbacks.push(fn);
  }

  connect() {
    const port = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';
    const url = `ws://${location.hostname}:${port}`;
    console.log(`[net] Connecting to ${url}`);

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error('[net] WebSocket construction failed:', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[net] Connected');
      this._reconnectDelay = 500;
      this._connected = true;
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'snapshot') {
        console.log('[net] Received snapshot —', Object.keys(msg.entities || {}).length, 'entities');
        this.store.applySnapshot(msg.entities);
        // Send hello after snapshot is applied
        this._sendHello();
        return;
      }

      if (msg.type === 'ops') {
        this.store.applyOps(msg.ops || []);
        return;
      }

      if (msg.type === 'error') {
        console.error('[net] Server error:', msg.error);
        return;
      }
    };

    this.ws.onclose = () => {
      console.log('[net] Disconnected');
      this._connected = false;
      this._scheduleReconnect();
    };

    this.ws.onerror = (e) => {
      console.error('[net] WebSocket error');
    };
  }

  _sendHello() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const hello = {
      type: 'hello',
      presence: {
        seat: 'player',
        who: this.who,
        mode: 'play',
      },
      presenceId: this._presenceId,
    };
    this.ws.send(JSON.stringify(hello));

    // Fire onConnected callbacks
    for (const fn of this._onConnectedCallbacks) {
      try { fn(); } catch (_) {}
    }
    this._onConnectedCallbacks = [];
  }

  /**
   * Send ops to the server.
   * @param {object[]} ops
   */
  sendOps(ops) {
    if (!this.ws || this.ws.readyState !== 1) {
      console.warn('[net] Not connected, cannot send ops');
      return;
    }
    this.ws.send(JSON.stringify({
      type: 'ops',
      ops,
      from: this.who,
    }));
  }

  /**
   * Send an action op.
   * @param {string} text
   */
  sendAction(text) {
    this.sendOps([{
      op: 'action',
      text,
      by: this.who,
      mode: 'narration',
    }]);
  }

  _scheduleReconnect() {
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
    console.log(`[net] Reconnecting in ${delay}ms…`);
    setTimeout(() => this.connect(), delay);
  }
}
