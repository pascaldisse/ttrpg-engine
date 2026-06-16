#!/usr/bin/env node
/**
 * tools/worldgen.mjs — P8 world-generation CLI.
 *
 * Generates a brand-new world (procgen skeleton + LLM "charge with meaning"),
 * validates it, and writes a scene JSON in the exact shape the engine seeds from.
 * Run ONCE; the output is fixed data you can hand-edit, commit, and play.
 *
 *   npm run worldgen -- --theme "haunted salt marsh" --size small --out world/scenes/marsh.json
 *   node --env-file-if-exists=.env tools/worldgen.mjs --provider deepseek --seed 7
 *
 * Flags:
 *   --theme "<text>"     flavor seed for names/descriptions (default: low-fantasy)
 *   --size small|medium|large   world scale (default: small)
 *   --locations <n>      explicit location count (overrides --size's count)
 *   --seed <n>           PRNG seed for the skeleton (default: 42; same seed ⇒ same bones)
 *   --provider mock|deepseek    LLM provider (default: respects LLM_PROVIDER, else deepseek)
 *   --out <path>         output scene JSON (default: world/scenes/generated.json)
 *
 * SECURITY: the API key lives only in env (load via --env-file-if-exists=.env);
 * it is never printed. Any sk-* token in error output is redacted.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from '../server/llm.js';
import { generateWorld, writeWorld } from '../server/worldgen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9]+/g, 'sk-***');

function parseArgs(argv) {
  const out = { size: 'small', seed: 42, theme: '', outPath: 'world/scenes/generated.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--theme') out.theme = next();
    else if (a === '--size') out.size = next();
    else if (a === '--locations') out.locations = parseInt(next(), 10);
    else if (a === '--seed') out.seed = parseInt(next(), 10);
    else if (a === '--provider') { process.env.LLM_PROVIDER = next(); }
    else if (a === '--out') out.outPath = next();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `worldgen — generate a TTRPG world as data.

  node --env-file-if-exists=.env tools/worldgen.mjs [flags]

  --theme "<text>"   flavor seed (e.g. "haunted salt marsh")
  --size small|medium|large    default small
  --locations <n>    explicit location count
  --seed <n>         skeleton PRNG seed (default 42)
  --provider mock|deepseek   default: env LLM_PROVIDER, else deepseek
  --out <path>       output scene JSON (default world/scenes/generated.json)
`;

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  const outPath = path.isAbsolute(opts.outPath) ? opts.outPath : path.join(root, opts.outPath);
  const llm = createLlmClient();

  console.log(`[worldgen] theme="${opts.theme || '(default low-fantasy)'}" size=${opts.size} seed=${opts.seed}`);
  const { entities, meta, charged, failed } = await generateWorld({
    size: opts.size,
    locations: opts.locations,
    seed: opts.seed,
    theme: opts.theme,
    llm,
    sessionId: 'worldgen-cli',
    log: (m) => console.log(`[worldgen] ${m}`),
  });

  writeWorld(entities, outPath);
  const counts = {};
  for (const c of Object.values(entities)) {
    const k = c.identity?.kind || 'other';
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log(`[worldgen] charged ${charged} locations (${failed} fell back), wrote ${Object.keys(entities).length} entities → ${path.relative(root, outPath)}`);
  console.log(`[worldgen] by kind: ${Object.entries(counts).map(([k, n]) => `${k}:${n}`).join(', ')}`);
  console.log(`[worldgen] play it:  TTRPG_WORLD=<dir containing scenes/> npm run server`);
  process.exit(0);
})().catch((err) => {
  console.error('[worldgen] FAILED:', redact(err.message));
  process.exit(1);
});
