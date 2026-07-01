/**
 * server/art.js — scene-art engine: ImageProvider seam + disk cache.
 *
 * EXTENSION SEAM: add providers by implementing generate(prompt) → {bytes, mime}
 * and adding a branch in createArtEngine(). The engine never names a provider
 * elsewhere; the client only ever fetches GET /art/<entityId>.
 *
 * Providers:
 *  - 'pollinations' (default) — free, keyless, URL-based generation.
 *  - 'mock'                   — deterministic offline SVG (prompt-hashed gradient).
 *  - 'openai'                 — gpt-image-1 when OPENAI_API_KEY is set.
 *
 * Images are generated ONCE per prompt and cached on disk under
 * <worldDir>/cache/art/<sha1(prompt)>.<ext> (gitignored). A changed prompt is
 * a new hash → regenerates naturally.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SIZE = { width: 896, height: 512 };
const TILE_SIZE = { width: 256, height: 256 };

// ---- Tile-texture prompts (the AI-painted default tileset, "gloom") --------
// One seamless top-down texture per SEMANTIC TAG (see shared/tilegen.js).
// The client's tileset skin fetches GET /art/tile/<tag> and falls back to
// procedural canvas patterns offline — swapping skins never touches the world.

const TILE_STYLE = 'seamless tileable top-down game texture, dark fantasy oil painting, muted gloomy palette, no text, no border';
const TILE_PROMPTS = {
  floor:  `worn stone floor slabs, ${TILE_STYLE}`,
  grass:  `dark moorland grass with patches of moss, ${TILE_STYLE}`,
  sand:   `wet grey sand with pebbles, ${TILE_STYLE}`,
  wall:   `rough mortared stone wall seen from above, ${TILE_STYLE}`,
  rock:   `jagged dark bedrock, ${TILE_STYLE}`,
  tree:   `dense dark forest canopy from above, single gnarled treetop, ${TILE_STYLE}`,
  water:  `deep dark water with faint ripples, ${TILE_STYLE}`,
  road:   `muddy cart road with wheel ruts, ${TILE_STYLE}`,
  rubble: `broken masonry and debris on stone, ${TILE_STYLE}`,
  door:   `heavy wooden double door seen from above, iron bands, ${TILE_STYLE}`,
  void:   `pitch black abyss, ${TILE_STYLE}`,
};

/** Fallback colors per tag (mock tiles + the client's offline pattern skin). */
const TILE_COLORS = {
  floor: '#4a4440', grass: '#2e4230', sand: '#5a5343', wall: '#2b2b31',
  rock: '#33302e', tree: '#1d3020', water: '#1d2f45', road: '#54483a',
  rubble: '#3e3a37', door: '#5e4426', void: '#0a0a0c',
};

// ---- Providers ----

const providers = {
  async pollinations(prompt, size = SIZE) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      `?width=${size.width}&height=${size.height}&nologo=true&seed=42`;
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`pollinations HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1024) throw new Error('pollinations returned a suspiciously small body');
    return { bytes, mime: res.headers.get('content-type') || 'image/jpeg', ext: 'jpg' };
  },

  async openai(prompt) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.images.generate({
      model: 'gpt-image-1', prompt, size: '1536x1024', quality: 'low', n: 1,
    });
    const bytes = Buffer.from(res.data[0].b64_json, 'base64');
    return { bytes, mime: 'image/png', ext: 'png' };
  },

  /** Offline: a deterministic moody SVG gradient derived from the prompt hash. */
  async mock(prompt, size = SIZE) {
    const h = crypto.createHash('sha1').update(prompt).digest();
    const hue1 = h[0] * 360 / 255, hue2 = h[1] * 360 / 255;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE.width}" height="${SIZE.height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="hsl(${hue1.toFixed(0)},45%,18%)"/>
    <stop offset="100%" stop-color="hsl(${hue2.toFixed(0)},60%,8%)"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="24" y="${SIZE.height - 24}" fill="rgba(255,255,255,0.35)" font-family="Georgia,serif" font-size="18" font-style="italic">${escapeXml(prompt.slice(0, 80))}</text>
</svg>`;
    return { bytes: Buffer.from(svg, 'utf-8'), mime: 'image/svg+xml', ext: 'svg' };
  },
};

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/**
 * @param {object} opts
 * @param {string} opts.worldDir — campaign directory (cache lives inside it)
 * @param {string} [opts.provider] — 'pollinations' | 'mock' | 'openai' (default: env ART_PROVIDER, else pollinations)
 * @returns {{artFor: (entityId:string, entities:Map)=>Promise<{bytes:Buffer,mime:string}|null>}}
 */
export function createArtEngine({ worldDir, provider }) {
  // Explicit ART_PROVIDER wins; the default is pollinations (free, keyless).
  // 'openai' is opt-in only — a present OPENAI_API_KEY may not have image access.
  const name = provider || process.env.ART_PROVIDER || 'pollinations';
  const generate = providers[name] || providers.pollinations;
  const cacheDir = path.join(worldDir, 'cache', 'art');
  const inflight = new Map(); // promptHash → Promise (dedupe concurrent requests)

  console.log(`[art] Provider: ${name} (cache: ${cacheDir})`);

  function cached(hash) {
    for (const ext of ['jpg', 'png', 'svg']) {
      const p = path.join(cacheDir, `${hash}.${ext}`);
      if (fs.existsSync(p)) {
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'image/jpeg';
        return { bytes: fs.readFileSync(p), mime };
      }
    }
    return null;
  }

  /**
   * The art for an entity: its art.prompt rendered (cache-first).
   * Returns null when the entity has no prompt or generation fails.
   */
  async function artFor(entityId, entities) {
    const comps = entities.get(entityId);
    const prompt = comps && comps.art && comps.art.prompt;
    if (!prompt) return null;

    const hash = crypto.createHash('sha1').update(`${name}:${prompt}`).digest('hex').slice(0, 16);
    const hit = cached(hash);
    if (hit) return hit;

    if (!inflight.has(hash)) {
      inflight.set(hash, (async () => {
        try {
          const { bytes, mime, ext } = await generate(prompt);
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(path.join(cacheDir, `${hash}.${ext}`), bytes);
          console.log(`[art] Generated ${entityId} (${bytes.length} bytes, ${name})`);
          return { bytes, mime };
        } catch (err) {
          console.warn(`[art] Generation failed for ${entityId}: ${err.message}`);
          return null;
        } finally {
          setTimeout(() => inflight.delete(hash), 0);
        }
      })());
    }
    return inflight.get(hash);
  }

  // Tile textures generate through a SERIAL queue with backoff — a location
  // requests ~6 tags at once and pollinations rate-limits bursts (HTTP 429).
  let tileQueue = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function generateTileWithRetry(prompt, tag) {
    for (const delay of [0, 7000, 15000]) {
      if (delay) await sleep(delay);
      try {
        return await generate(prompt, TILE_SIZE);
      } catch (err) {
        if (!/429/.test(err.message)) throw err;
        console.warn(`[art] Tile "${tag}" rate-limited — retrying`);
      }
    }
    throw new Error('rate-limited after retries');
  }

  /**
   * A tile texture for a semantic tag (the AI-painted "gloom" tileset).
   * Cache-first like artFor; mock provider yields a flat-color SVG so the
   * walkable world works fully offline.
   */
  async function tileFor(tag) {
    const prompt = TILE_PROMPTS[tag];
    if (!prompt) return null;

    const hash = crypto.createHash('sha1').update(`${name}:tile:${prompt}`).digest('hex').slice(0, 16);
    const hit = cached(hash);
    if (hit) return hit;

    if (!inflight.has(hash)) {
      const job = tileQueue.then(async () => {
        try {
          const again = cached(hash);
          if (again) return again;
          let out;
          if (name === 'mock') {
            const c = TILE_COLORS[tag] || '#333';
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${c}"/></svg>`;
            out = { bytes: Buffer.from(svg, 'utf-8'), mime: 'image/svg+xml', ext: 'svg' };
          } else {
            out = await generateTileWithRetry(prompt, tag);
          }
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(path.join(cacheDir, `${hash}.${out.ext}`), out.bytes);
          console.log(`[art] Generated tile "${tag}" (${out.bytes.length} bytes, ${name})`);
          return { bytes: out.bytes, mime: out.mime };
        } catch (err) {
          console.warn(`[art] Tile generation failed for "${tag}": ${err.message}`);
          return null;
        } finally {
          setTimeout(() => inflight.delete(hash), 0);
        }
      });
      inflight.set(hash, job);
      tileQueue = job.catch(() => {});
    }
    return inflight.get(hash);
  }

  return { artFor, tileFor, provider: name };
}
