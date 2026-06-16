#!/usr/bin/env node
/**
 * tools/patch.mjs — CLI to mutate session state via HTTP POST /op.
 *
 * Usage:
 *   node tools/patch.mjs spawn '<json-components>' [id]
 *   node tools/patch.mjs set <id> <component> '<json>'
 *   node tools/patch.mjs merge <id> <component> '<json>'
 *   node tools/patch.mjs despawn <id>
 *   node tools/patch.mjs reset [scene]
 *   node tools/patch.mjs snapshot
 *   node tools/patch.mjs events [since]
 *
 * Based on GAIA's tools/patch.mjs pattern.
 */

const PORT = process.env.TTRPG_PORT || '8420';
const BASE = `http://localhost:${PORT}`;

const [,, cmd, ...args] = process.argv;

if (!cmd) {
  console.log(`Usage: node tools/patch.mjs <command> [args]

Commands:
  spawn '<json-components>' [id]   Create an entity
  set <id> <component> '<json>'    Replace a component (json = null to remove)
  merge <id> <component> '<json>'  Shallow-merge into a component
  despawn <id>                     Remove an entity
  reset [scene]                    Re-seed from campaign files
  snapshot                         GET full state snapshot
  events [since]                   GET journal entries` );
  process.exit(0);
}

async function main() {
  try {
    switch (cmd) {
      case 'spawn': {
        const components = JSON.parse(args[0] || '{}');
        const id = args[1] || undefined;
        const body = { ops: [{ op: 'spawn', components, ...(id ? { id } : {}) }] };
        const res = await fetch(`${BASE}/op`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        printResponse(await res.json());
        break;
      }

      case 'set': {
        const id = args[0];
        const component = args[1];
        const value = args[2] === 'null' ? null : JSON.parse(args[2]);
        const body = { ops: [{ op: 'set', id, component, value }] };
        const res = await fetch(`${BASE}/op`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        printResponse(await res.json());
        break;
      }

      case 'merge': {
        const id = args[0];
        const component = args[1];
        const value = JSON.parse(args[2]);
        const body = { ops: [{ op: 'merge', id, component, value }] };
        const res = await fetch(`${BASE}/op`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        printResponse(await res.json());
        break;
      }

      case 'despawn': {
        const id = args[0];
        const body = { ops: [{ op: 'despawn', id }] };
        const res = await fetch(`${BASE}/op`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        printResponse(await res.json());
        break;
      }

      case 'reset': {
        const scene = args[0] || null;
        const body = { ops: [{ op: 'reset', ...(scene ? { scene } : {}) }] };
        const res = await fetch(`${BASE}/op`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        printResponse(await res.json());
        break;
      }

      case 'snapshot': {
        const res = await fetch(`${BASE}/events?since=0&limit=1`);
        printResponse(await res.json());
        // Also fetch schema for completeness
        const schemaRes = await fetch(`${BASE}/schema`);
        console.log('\nSchema:');
        printResponse(await schemaRes.json());
        break;
      }

      case 'events': {
        const since = args[0] || '0';
        const res = await fetch(`${BASE}/events?since=${since}`);
        printResponse(await res.json());
        break;
      }

      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

function printResponse(data) {
  console.log(JSON.stringify(data, null, 2));
}

main();
