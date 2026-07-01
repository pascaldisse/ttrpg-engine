/**
 * client/main.js — Bootstrap.
 * Creates the store, backfills the story from the journal, connects the
 * network, wires the view + header controls (name, new game, connection dot).
 */

import { SessionStore } from './kernel/store.js';
import { NetClient } from './kernel/net.js';
import { View } from './kernel/view.js';

const PORT = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';
const HTTP = `http://${location.hostname}:${PORT}`;

// ---- Player identity (drives which PC is yours — multiplayer) ----

const who = localStorage.getItem('ttrpg_who') || ('Adventurer-' + Math.random().toString(36).slice(2, 5));
localStorage.setItem('ttrpg_who', who);

const nameInput = document.getElementById('player-name');
nameInput.value = who;
nameInput.addEventListener('change', () => {
  const next = nameInput.value.trim();
  if (!next || next === who) return;
  localStorage.setItem('ttrpg_who', next);
  location.reload(); // rejoin as the new player — server rebinds the PC
});

// ---- Store + view ----

const store = new SessionStore();
const view = new View(store);
view.myName = who;

// ---- Story backfill (refresh keeps the story), then connect ----

const net = new NetClient(store, who);
view.onAction = (text, move, target, zone) => net.sendAction(text, move, target, zone);

try {
  const res = await fetch(`${HTTP}/events?since=0&limit=1000`);
  const { events } = await res.json();
  view.backfill(events || []);
} catch (_) {
  // Server not up yet or no history — the live stream still works.
}

net.connect();

// ---- Action input ----

const actionInput = document.getElementById('action-input');
const actionSend = document.getElementById('action-send');

function sendAction() {
  const text = actionInput.value.trim();
  if (!text) return;
  net.sendAction(text);
  actionInput.value = '';
  actionInput.focus();
}

actionSend.addEventListener('click', sendAction);
actionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAction();
  }
});

// ---- New game (reset to the campaign start) ----

document.getElementById('new-game').addEventListener('click', () => {
  if (!confirm('Start a new game? The current world state will be reset to the campaign start.')) return;
  net.sendOps([{ op: 'reset' }]);
});

// ---- Connection dot ----

const connDot = document.getElementById('conn-dot');
setInterval(() => {
  const open = net.ws && net.ws.readyState === 1;
  connDot.className = `w-2 h-2 rounded-full ${open ? 'bg-green-500' : 'bg-red-500'}`;
  connDot.title = open ? `connected as ${who}` : 'disconnected — retrying…';
}, 1000);

net.onConnected(() => console.log('[main] Ready! Connected as', who));
console.log('[main] Booted — waiting for connection…');
