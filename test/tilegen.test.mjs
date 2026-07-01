/**
 * test/tilegen.test.mjs — the walkable world's structural guarantees.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateTiles, backfillTiles, inferStyle, TILE_TAGS, WALKABLE, GRID_W, GRID_H } from '../shared/tilegen.js';

const mkLoc = (over = {}) => ({
  identity: { name: 'The Old Mill', kind: 'location', description: 'a mill by a stream' },
  place: { connections: [{ targetId: 'loc-a', label: 'To A' }, { targetId: 'loc-b', label: 'To B' }] },
  flags: {},
  ...over,
});

/** BFS over walkable tiles from (x,y). */
function reach(tiles, sx, sy) {
  const grid = tiles.rows.map(r => [...r].map(ch => tiles.legend[ch]));
  const seen = new Set([`${sx},${sy}`]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= tiles.w || ny >= tiles.h) continue;
      if (!WALKABLE.has(grid[ny][nx])) continue;
      if (seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      q.push([nx, ny]);
    }
  }
  return seen;
}

describe('tilegen', () => {
  test('grid shape: h rows of w chars, legend maps every char used', () => {
    const t = generateTiles('loc-mill', mkLoc());
    assert.equal(t.rows.length, GRID_H);
    for (const row of t.rows) assert.equal(row.length, GRID_W);
    for (const row of t.rows) for (const ch of row) assert.ok(TILE_TAGS[ch], `unknown char ${ch}`);
  });

  test('every exit exists per connection and reaches the center on foot', () => {
    const t = generateTiles('loc-mill', mkLoc());
    assert.equal(t.exits.length, 2);
    assert.deepEqual(new Set(t.exits.map(e => e.targetId)), new Set(['loc-a', 'loc-b']));
    const cx = GRID_W >> 1, cy = GRID_H >> 1;
    const seen = reach(t, cx, cy);
    for (const e of t.exits) {
      const ix = e.x === 0 ? 1 : e.x === GRID_W - 1 ? GRID_W - 2 : e.x;
      const iy = e.y === 0 ? 1 : e.y === GRID_H - 1 ? GRID_H - 2 : e.y;
      assert.ok(seen.has(`${ix},${iy}`), `exit to ${e.targetId} unreachable`);
    }
  });

  test('deterministic: same id+seed ⇒ identical map; different id ⇒ different', () => {
    const a = generateTiles('loc-mill', mkLoc());
    const b = generateTiles('loc-mill', mkLoc());
    const c = generateTiles('loc-other', mkLoc());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.notEqual(a.rows.join(), c.rows.join());
  });

  test('spawn points land on walkable tiles and never stack', () => {
    const t = generateTiles('loc-mill', mkLoc(), { presentIds: ['npc-1', 'npc-2', 'item-1', 'pc-hero'] });
    const grid = t.rows.map(r => [...r].map(ch => t.legend[ch]));
    const seen = new Set();
    for (const [id, p] of Object.entries(t.spawns)) {
      assert.ok(WALKABLE.has(grid[p.y][p.x]), `${id} on unwalkable ${grid[p.y][p.x]}`);
      const k = `${p.x},${p.y}`;
      assert.ok(!seen.has(k), `${id} stacked at ${k}`);
      seen.add(k);
    }
  });

  test('style inference: flags win, then keywords, wilds as default', () => {
    assert.equal(inferStyle(mkLoc({ flags: { mapStyle: 'dungeon' } })), 'dungeon');
    assert.equal(inferStyle(mkLoc()), 'interior'); // "Mill" is an interior keyword
    assert.equal(inferStyle({ identity: { name: 'The Village Square', description: '' }, flags: {} }), 'settlement');
    assert.equal(inferStyle({ identity: { name: 'Somewhere Odd', description: '' }, flags: {} }), 'wilds');
  });

  test('interiors are walled with door exits', () => {
    const t = generateTiles('loc-inn', mkLoc({ identity: { name: 'The Inn', kind: 'location', description: '' } }));
    assert.equal(t.style, 'interior');
    const grid = t.rows.map(r => [...r].map(ch => t.legend[ch]));
    // border is wall except at exits (doors)
    for (let x = 0; x < GRID_W; x++) {
      const top = grid[0][x], bottom = grid[GRID_H - 1][x];
      assert.ok(top === 'wall' || top === 'door', `top border ${x} is ${top}`);
      assert.ok(bottom === 'wall' || bottom === 'door', `bottom ${x} is ${bottom}`);
    }
    for (const e of t.exits) assert.equal(grid[e.y][e.x], 'door');
  });

  test('backfill: fills every location once, respects authored grids', () => {
    const entities = new Map([
      ['loc-1', mkLoc()],
      ['loc-2', mkLoc({ tiles: { authored: true } })],
      ['npc-1', { identity: { name: 'X', kind: 'npc' }, place: { locationId: 'loc-1' } }],
    ]);
    const n = backfillTiles(entities);
    assert.equal(n, 1);
    assert.ok(entities.get('loc-1').tiles.rows, 'loc-1 got a real grid');
    assert.equal(entities.get('loc-2').tiles.authored, true, 'authored grid untouched');
    assert.ok(entities.get('loc-1').tiles.spawns['npc-1'], 'co-located npc got a spawn');
    assert.equal(backfillTiles(entities), 0, 'idempotent');
  });
});
