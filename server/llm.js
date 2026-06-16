/**
 * server/llm.js — LlmClient interface + DeepSeek adapter + Mock client.
 *
 * EXTENSION SEAM: add new providers by implementing the LlmClient interface
 * and adding a branch in createLlmClient(). The engine never references
 * a specific provider.
 *
 * SECURITY: API key is read ONLY from process.env, never logged, never
 * written to any file, never sent to the client.
 */

import OpenAI from 'openai';

// ---- LlmClient interface (documentation, not enforced) ----
//
// class LlmClient {
//   async *stream(messages, opts) → yields {delta}
//   async complete(messages, opts) → {text, usage}
//   async structured(messages, zodSchema, opts) → Zod-validated object
// }

// ---- DeepSeek client ----

export class DeepSeekClient {
  #client;
  #model;
  #sessionId;

  /**
   * @param {object} opts
   * @param {string} opts.apiKey       — DeepSeek API key (from env)
   * @param {string} [opts.baseURL]    — default https://api.deepseek.com
   * @param {string} [opts.model]      — default deepseek-v4-flash
   * @param {string} [opts.sessionId]  — passed as user_id for cache isolation
   */
  constructor({ apiKey, baseURL, model, sessionId }) {
    if (!apiKey) {
      throw new Error('DeepSeekClient requires an apiKey');
    }
    this.#client = new OpenAI({
      apiKey,
      baseURL: baseURL || 'https://api.deepseek.com',
      timeout: 120_000,
    });
    this.#model = model || 'deepseek-v4-flash';
    this.#sessionId = sessionId || 'default';
  }

  /**
   * Stream narration tokens for live broadcast.
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} [opts]
   * @param {number} [opts.maxTokens]  — default 4096
   * @returns {AsyncIterable<{delta:string}>}
   */
  async *stream(messages, opts = {}) {
    const maxTokens = opts.maxTokens || 4096;
    const stream = await this.#callWithRetry(() =>
      this.#client.chat.completions.create({
        model: this.#model,
        messages,
        stream: true,
        max_tokens: maxTokens,
        ...this.#extraBody(),
      })
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        yield { delta };
      }
    }
  }

  /**
   * Non-streaming completion call.
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} [opts]
   * @param {number} [opts.maxTokens] — default 4096
   * @returns {Promise<{text:string, usage:object}>}
   */
  async complete(messages, opts = {}) {
    const maxTokens = opts.maxTokens || 4096;
    const response = await this.#callWithRetry(() =>
      this.#client.chat.completions.create({
        model: this.#model,
        messages,
        max_tokens: maxTokens,
        ...this.#extraBody(),
      })
    );

    const text = response.choices?.[0]?.message?.content || '';
    return { text, usage: response.usage || {} };
  }

  /**
   * Structured output call — JSON mode + lenient parse + Zod validation.
   * @param {Array<{role:string,content:string}>} messages
   * @param {import('zod').ZodSchema} schema — Zod schema to validate against
   * @param {object} [opts]
   * @param {number} [opts.maxTokens] — default 4096
   * @returns {Promise<{parsed:object, raw:string, usage:object}>}
   */
  async structured(messages, schema, opts = {}) {
    const maxTokens = opts.maxTokens || 4096;

    // JSON mode requires the word "json" in the prompt and response_format
    const jsonMessages = [...messages];
    // Ensure the last message mentions JSON
    const last = jsonMessages[jsonMessages.length - 1];
    if (last && last.role === 'user') {
      last.content = `${last.content}\n\nYou must respond with valid JSON only.`;
    } else {
      jsonMessages.push({ role: 'user', content: 'You must respond with valid JSON only.' });
    }

    const response = await this.#callWithRetry(() =>
      this.#client.chat.completions.create({
        model: this.#model,
        messages: jsonMessages,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...this.#extraBody(),
      })
    );

    const raw = response.choices?.[0]?.message?.content || '';
    const usage = response.usage || {};

    // Lenient parse
    const { parseModelOutput } = await import('../shared/parse.js');
    const parseResult = parseModelOutput(raw);

    if (!parseResult.ok || !parseResult.value) {
      throw new LlmParseError('Failed to parse structured output', raw, parseResult.error);
    }

    // Zod validate
    const zodResult = schema.safeParse(parseResult.value);
    if (!zodResult.success) {
      throw new LlmParseError(
        'Structured output failed schema validation',
        raw,
        zodResult.error.errors.map(e => `[${e.path.join('.')}] ${e.message}`).join('; ')
      );
    }

    return { parsed: zodResult.data, raw, usage };
  }

  // ---- internals ----

  #extraBody() {
    return {
      thinking: { type: 'disabled' },
      user_id: `session-${this.#sessionId}`,
    };
  }

  async #callWithRetry(fn) {
    let attempt = 0;
    const maxAttempts = 3;
    while (true) {
      try {
        return await fn();
      } catch (e) {
        attempt++;
        const status = e.status || e.code;
        // 429, 500, 503 → retry with backoff
        if ((status === 429 || status === 500 || status === 503 || status === 'rate_limit_exceeded')
            && attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          console.warn(`[llm] API error ${status}, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
  }
}

// ---- Mock client (no network, deterministic) ----

export class MockLlmClient {
  #sessionId;

  constructor({ sessionId } = {}) {
    this.#sessionId = sessionId || 'mock';
  }

  /**
   * Yields canned text branching on opts.role:
   *   - 'dm' → narrative world-voice prose
   *   - 'npc' → short in-character quoted line echoing input
   *   - default → legacy P1 narration
   */
  async *stream(messages, opts = {}) {
    const actionText = this.#extractActionText(messages);
    const role = opts.role || 'dm';

    let parts;
    if (role === 'npc') {
      const snippet = (actionText || 'hello').slice(0, 40);
      parts = [
        `"Ah, `,
        `'${snippet}'`,
        ` you say? `,
        `Aye, I've heard stranger things in this tavern."`,
      ];
    } else {
      parts = [
        `You ${actionText || 'act'}. `,
        `The world responds to your action. `,
        `The air is thick with possibility. `,
        `The scene shifts subtly around you. `,
        `What will you do next?`,
      ];
    }

    for (const part of parts) {
      await new Promise(r => setTimeout(r, 50));
      yield { delta: part };
    }
  }

  async complete(messages, _opts = {}) {
    const actionText = this.#extractActionText(messages);
    return {
      text: `You ${actionText || 'act'}. The world responds.`,
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    };
  }

  /**
   * Returns a deterministic result branching on opts.role:
   *   - 'routing' → returns {targets:[<first present npc>], note:''}
   *   - default → legacy P1 op batch
   */
  async structured(messages, _schema, opts = {}) {
    const actionText = this.#extractActionText(messages);

    // Routing mode: return JSON routing result
    if (opts.role === 'routing') {
      // Extract first NPC id from the present NPCs list in the prompt
      const npcIdMatch = (actionText || '').match(/"(npc-[^"]+)"/) || [];
      return {
        parsed: {
          targets: npcIdMatch[1] ? [npcIdMatch[1]] : [],
          note: '',
        },
        raw: JSON.stringify({ targets: npcIdMatch[1] ? [npcIdMatch[1]] : [], note: '' }),
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };
    }

    const truncated = (actionText || 'acted').slice(0, 80);

    return {
      parsed: {
        narration: `You ${actionText || 'act'}. The world responds to your action. The air is thick with possibility. The scene shifts subtly around you. What will you do next?`,
        ops: [
          {
            op: 'merge',
            id: 'world-state',
            component: 'flags',
            value: { lastAction: truncated },
          },
        ],
        checks: [],
      },
      raw: JSON.stringify({
        narration: `You ${actionText || 'act'}. The world responds...`,
        ops: [{ op: 'merge', id: 'world-state', component: 'flags', value: { lastAction: truncated } }],
        checks: [],
      }),
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
  }

  #extractActionText(messages) {
    // Find the last user message that is NOT a JSON instruction
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && !m.content.startsWith('Now output')) {
        return m.content || '';
      }
    }
    return '';
  }
}

// ---- Factory ----

/**
 * Create an LlmClient based on LLM_PROVIDER env var.
 *
 * - 'mock' → MockLlmClient (no key needed)
 * - 'deepseek' (default) → DeepSeekClient (requires DEEPSEEK_API_KEY)
 * - Falls back to MockLlmClient if deepseek is selected but no key is set
 *
 * @returns {DeepSeekClient|MockLlmClient}
 */
export function createLlmClient() {
  const provider = process.env.LLM_PROVIDER || 'deepseek';

  if (provider === 'mock') {
    console.log('[llm] Using MockLlmClient (no network calls)');
    return new MockLlmClient({ sessionId: process.env.TTRPG_SAVE || 'default' });
  }

  if (provider === 'deepseek') {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.warn('[llm] DEEPSEEK_API_KEY not set — falling back to MockLlmClient');
      return new MockLlmClient({ sessionId: process.env.TTRPG_SAVE || 'default' });
    }
    console.log(`[llm] Using DeepSeekClient (model: ${process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'})`);
    return new DeepSeekClient({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      sessionId: process.env.TTRPG_SAVE || 'default',
    });
  }

  console.warn(`[llm] Unknown LLM_PROVIDER "${provider}" — falling back to MockLlmClient`);
  return new MockLlmClient({ sessionId: process.env.TTRPG_SAVE || 'default' });
}

// ---- Custom error ----

export class LlmParseError extends Error {
  constructor(message, raw, parseError) {
    super(message);
    this.name = 'LlmParseError';
    this.raw = raw;
    this.parseError = parseError;
  }
}
