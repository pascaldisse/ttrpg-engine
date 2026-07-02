/**
 * client/main.js — Bootstrap.
 * Creates the store, backfills the story from the journal, connects the
 * network, wires the view + header controls (name, new game, connection dot).
 */

import { SessionStore } from './kernel/store.js';
import { NetClient } from './kernel/net.js';
import { View } from './kernel/view.js';
import { MusicEngine } from './kernel/music.js';
import { mountAddons, initAddonSettings } from './kernel/addons.js';

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

// ---- Addons (client plugins) + the ⚙ settings panel ----

initAddonSettings({ button: document.getElementById('settings-toggle'), serverBase: HTTP });
mountAddons({ serverBase: HTTP, store, net, view, who })
  .catch(e => console.error('[main] addon mounting failed:', e));

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

// ---- Mood music (procedural Web Audio — the 🔊 header toggle) ----

const music = new MusicEngine();
const musicBtn = document.getElementById('music-toggle');

function currentMood() {
  // my PC → its location's map style; night darkens; combat overrides; DM knob wins.
  let locStyle = null;
  for (const [, comps] of store.entities) {
    if ((comps.identity || {}).kind === 'pc' && (comps.agent || {}).controller === who) {
      const loc = store.entities.get((comps.place || {}).locationId);
      locStyle = loc && loc.tiles ? loc.tiles.style : null;
      break;
    }
  }
  const ws = store.entities.get('world-state') || {};
  const enc = (store.entities.get('encounter') || {}).encounter || {};
  return music.resolveMood({
    locStyle,
    phase: (ws.clock || {}).phase,
    inCombat: !!enc.active,
    dmMood: (ws.flags || {}).mood || null,
  });
}

if (musicBtn) {
  const paint = () => { musicBtn.textContent = music.enabled ? '🔊' : '🔇'; musicBtn.title = music.enabled ? 'Music on' : 'Music off'; };
  musicBtn.addEventListener('click', () => { music.toggle(); if (music.enabled) music.setMood(currentMood()); paint(); });
  paint();
}
store.onChange(() => { if (music.enabled) music.setMood(currentMood()); });

// ---- Connection dot ----

const connDot = document.getElementById('conn-dot');
setInterval(() => {
  const open = net.ws && net.ws.readyState === 1;
  connDot.className = `w-2 h-2 rounded-full ${open ? 'bg-green-500' : 'bg-red-500'}`;
  connDot.title = open ? `connected as ${who}` : 'disconnected — retrying…';
}, 1000);

net.onConnected(() => console.log('[main] Ready! Connected as', who));
console.log('[main] Booted — waiting for connection…');
