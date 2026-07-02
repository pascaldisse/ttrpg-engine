/**
 * test/addons.test.mjs — the addon/plugin system.
 *
 * Unit: manifest reading + discovery (addons.json / TTRPG_ADDONS / world pick).
 * Integration (real server): /addons listing, static serving + traversal guard,
 * server hooks (custom routes), runtime enable/disable via POST /addons/config,
 * DM-prompt extension, and an addon-shipped world becoming the campaign.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readManifest, loadAddons, addonWorldOf, readSystemAppends } from '../server/addons.js';
import { bootServer, sleep } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'test', 'fixtures', 'addon-demo');
const WORLD_ADDON = path.join(ROOT, 'test', 'fixtures', 'addon-world');

describe('addon loader (unit)', () => {
  test('readManifest loads a manifest; bad dirs return null', () => {
    const m = readManifest(DEMO);
    assert.equal(m.id, 'addon-demo');
    assert.equal(m.client, 'client/index.js');
    assert.equal(m.world, null);
    assert.equal(readManifest('/nonexistent/nowhere'), null);
  });

  test('loadAddons merges addons.json + TTRPG_ADDONS; env entries are enabled', () => {
    const cfg = path.join(os.tmpdir(), `addons-test-${Date.now()}.json`);
    fs.writeFileSync(cfg, JSON.stringify([{ path: WORLD_ADDON, enabled: false }]));
    const { addons } = loadAddons({ rootDir: ROOT, env: { TTRPG_ADDONS: DEMO, TTRPG_ADDONS_CONFIG: cfg } });
    fs.rmSync(cfg, { force: true });
    assert.equal(addons.length, 2);
    assert.equal(addons.find(a => a.id === 'addon-world').enabled, false);
    assert.equal(addons.find(a => a.id === 'addon-demo').enabled, true);
  });

  test('addonWorldOf picks the first ENABLED world-shipping addon', () => {
    const none = addonWorldOf([readManifest(DEMO)]);
    assert.equal(none, null);
    const disabled = addonWorldOf([readManifest(WORLD_ADDON, false)]);
    assert.equal(disabled, null);
    const aw = addonWorldOf([readManifest(WORLD_ADDON)]);
    assert.equal(aw.id, 'addon-world');
    assert.ok(aw.world.endsWith(path.join('addon-world', 'world')));
  });

  test('readSystemAppends concatenates prompt files, skipping missing ones', () => {
    const m = readManifest(DEMO);
    assert.match(readSystemAppends(m), /DEMO-ADDON-PROMPT-MARKER/);
    assert.equal(readSystemAppends({ ...m, systemAppend: ['nope.md'] }), '');
  });
});

describe('addon system (integration, real server)', () => {
  let srv;
  let cfg;
  before(async () => {
    cfg = path.join(os.tmpdir(), `addons-int-${Date.now()}.json`);
    srv = await bootServer({ TTRPG_ADDONS: 'test/fixtures/addon-demo', TTRPG_ADDONS_CONFIG: cfg });
  });
  after(async () => {
    await srv.stop();
    fs.rmSync(cfg, { force: true });
  });

  test('GET /addons lists the installed addon with public fields', async () => {
    const { addons } = await (await fetch(`http://localhost:${srv.port}/addons`)).json();
    const demo = addons.find(a => a.id === 'addon-demo');
    assert.ok(demo, 'addon-demo listed');
    assert.equal(demo.enabled, true);
    assert.equal(demo.client, 'client/index.js');
    assert.equal(demo.server, true);
  });

  test('static serving works; path traversal is refused', async () => {
    const ok = await fetch(`http://localhost:${srv.port}/addons/addon-demo/client/index.js`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /javascript/);
    assert.match(await ok.text(), /mount/);

    const evil = await fetch(`http://localhost:${srv.port}/addons/addon-demo/%2e%2e/%2e%2e/package.json`);
    assert.equal(evil.status, 404, 'dot-dot escape refused');
  });

  test('the server hook registered a live custom route', async () => {
    const res = await fetch(`http://localhost:${srv.port}/demo/ping`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pong, true);
    assert.equal(body.addon, 'addon-demo');
    assert.ok(body.entities > 0, 'hook sees the live session');
  });

  test('the systemAppend prompt extension was loaded at boot', () => {
    assert.match(srv.getLog(), /System prompt extended by 1 addon file set/);
  });

  test('POST /addons/config disables an addon (static goes 404) and re-enables it', async () => {
    let out = await (await fetch(`http://localhost:${srv.port}/addons/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'addon-demo', enabled: false }),
    })).json();
    assert.equal(out.ok, true);
    assert.equal(out.addon.enabled, false);

    const gone = await fetch(`http://localhost:${srv.port}/addons/addon-demo/client/index.js`);
    assert.equal(gone.status, 404);
    assert.ok(fs.existsSync(cfg), 'config persisted');

    out = await (await fetch(`http://localhost:${srv.port}/addons/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'addon-demo', enabled: true }),
    })).json();
    assert.equal(out.addon.enabled, true);
    const back = await fetch(`http://localhost:${srv.port}/addons/addon-demo/client/index.js`);
    assert.equal(back.status, 200);
  });

  test('POST /addons/config installs a NEW addon by path at runtime', async () => {
    const out = await (await fetch(`http://localhost:${srv.port}/addons/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/fixtures/addon-world', enabled: true }),
    })).json();
    assert.equal(out.ok, true);
    assert.equal(out.addon.id, 'addon-world');
    assert.match(out.note || '', /restart/i, 'world addons announce the reboot requirement');

    const { addons } = await (await fetch(`http://localhost:${srv.port}/addons`)).json();
    assert.ok(addons.some(a => a.id === 'addon-world'));
  });
});

describe('addon-shipped world (integration)', () => {
  let srv;
  after(async () => {
    if (srv) await srv.stop();
    // bootServer's cleanup assumes the necrotopia world — sweep the fixture saves.
    fs.rmSync(path.join(WORLD_ADDON, 'world', 'saves'), { recursive: true, force: true });
  });

  test('with TTRPG_WORLD unset, the addon world becomes the campaign', async () => {
    srv = await bootServer({ TTRPG_WORLD: '', TTRPG_RULESET: '', TTRPG_ADDONS: 'test/fixtures/addon-world' });
    const health = await (await fetch(`http://localhost:${srv.port}/health`)).json();
    assert.ok(health.entities >= 3, 'fixture world seeded');
    const desc = await (await fetch(`http://localhost:${srv.port}/sense/describe?id=loc-fixture`)).json();
    assert.match(JSON.stringify(desc), /Fixture Room/);
  });
});
