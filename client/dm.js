/**
 * client/dm.js — DMView bootstrap.
 * Same store + WS kernel as the player client, but joins as the `dm` seat and
 * renders the DM control surface.
 */

import { SessionStore } from './kernel/store.js';
import { NetClient } from './kernel/net.js';
import { DMView } from './kernel/dm-view.js';

const store = new SessionStore();
const view = new DMView(store);

const who = localStorage.getItem('ttrpg_dm_who') || ('dm-' + Math.random().toString(36).slice(2, 6));
localStorage.setItem('ttrpg_dm_who', who);

const net = new NetClient(store, who, { seat: 'dm' });
view.net = net;
net.onServerMessage((msg) => view.handleServer(msg));
net.connect();

net.onConnected(() => {
  console.log('[dm] Connected as', who, '(seat: dm)');
});

console.log('[dm] DMView booting…');
