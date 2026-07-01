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

// ---- Providers ----

const providers = {
  async pollinations(prompt) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      `?width=${SIZE.width}&height=${SIZE.height}&nologo=true&seed=42`;
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
  async mock(prompt) {
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

  return { artFor };
}
