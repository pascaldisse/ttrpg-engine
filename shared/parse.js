/**
 * shared/parse.js — lenient model-output parser.
 *
 * Tries strict JSON.parse, strips ```json fences, extracts first balanced {…},
 * then validates the basic shape (narration + ops + checks).
 * Reuses validateOpBatch from ops.js for op validation.
 *
 * PURE — no imports from server/ or client/.
 */

import { validateOpBatch } from './ops.js';

/**
 * Parse raw model output into a structured result.
 * Never throws — always returns {ok, value?, error?, raw}.
 *
 * @param {string} raw — the raw text from the LLM
 * @returns {{ok:boolean, value?:{narration?:string,ops?:object[],checks?:any[]}, error?:string, raw:string}}
 */
export function parseModelOutput(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty model output', raw: '' };
  }

  let parsed;

  // 1. Try strict JSON.parse
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    // 2. Strip ```json fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch (_2) {
        // continue to regex extract
      }
    }

    // 3. Extract first balanced {…} object
    if (!parsed) {
      const objStart = trimmed.indexOf('{');
      if (objStart !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = objStart; i < trimmed.length; i++) {
          const ch = trimmed[i];
          if (escape) { escape = false; continue; }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const candidate = trimmed.slice(objStart, i + 1);
              try {
                parsed = JSON.parse(candidate);
              } catch (_3) {
                // last resort failed
              }
              break;
            }
          }
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Model output not parseable as JSON', raw: trimmed };
  }

  // Validate shape
  const narration = typeof parsed.narration === 'string' ? parsed.narration : undefined;
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  let ops = Array.isArray(parsed.ops) ? parsed.ops : [];

  // Validate ops using the shared op validator
  if (ops.length > 0) {
    const validation = validateOpBatch(ops);
    if (validation.ok) {
      ops = validation.ops;
    } else {
      // Keep raw ops but flag the error
      return {
        ok: false,
        error: `Op validation failed: ${validation.error}`,
        raw: trimmed,
        value: { narration, ops, checks },
      };
    }
  }

  return {
    ok: true,
    value: { narration, ops, checks },
    raw: trimmed,
  };
}
