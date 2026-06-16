/**
 * client/main.js — Bootstrap.
 * Creates the store, connects the network, wires the view.
 *
 * Based on GAIA's client/main.js bootstrap pattern.
 */

import { SessionStore } from './kernel/store.js';
import { NetClient } from './kernel/net.js';
import { View } from './kernel/view.js';

// Create the client-side store mirror
const store = new SessionStore();

// Create the view (subscribes to store)
const view = new View(store);

// Create network client
const who = localStorage.getItem('ttrpg_who') || ('player-' + Math.random().toString(36).slice(2, 6));
localStorage.setItem('ttrpg_who', who);

const net = new NetClient(store, who);
net.connect();

// Let the scoped player HUD send actions (clickable NPCs / items / exits).
view.onAction = (text) => net.sendAction(text);

// ---- Wire action input ----

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

// ---- Connection indicator ----

net.onConnected(() => {
  console.log('[main] Ready! Connected as', who);
});

console.log('[main] Booted — waiting for connection…');
