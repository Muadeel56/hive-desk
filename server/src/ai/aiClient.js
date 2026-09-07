import { logger } from '../utils/logger.js';

/**
 * Thin, transport-only wrapper around the Google Gemini `generateContent` REST
 * API. No prompt building, no DB — that lives in src/ai/responder.js. This file
 * stays unit-testable in isolation.
 *
 * Endpoint:
 *   POST {LLM_API_URL}/{LLM_MODEL}:generateContent?key={LLM_API_KEY}
 *   e.g. https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=...
 *
 * Request body shape:
 *   {
 *     "system_instruction": { "parts": [{ "text": "<system prompt>" }] },
 *     "contents": [
 *       { "role": "user",  "parts": [{ "text": "..." }] },
 *       { "role": "model", "parts": [{ "text": "..." }] }
 *     ],
 *     "generationConfig": {
 *       "temperature": 0.2, "maxOutputTokens": 800,
 *       "responseMimeType": "application/json"
 *     }
 *   }
 *   (role is "user" | "model"; there is no "assistant" or "system" role in `contents`.)
 *
 * Response body shape (success):
 *   {
 *     "candidates": [
 *       {
 *         "content": { "role": "model", "parts": [{ "text": "<reply>", "thoughtSignature": "<opaque, ignore>" }] },
 *         "finishReason": "STOP"
 *       }
 *     ],
 *     "usageMetadata": { "promptTokenCount": N, "candidatesTokenCount": N, "thoughtsTokenCount": N, "totalTokenCount": N }
 *   }
 *   Reply text: candidates[0].content.parts.find(p => p.text)?.text
 *   3.x is a thinking model: `thoughtSignature` per part + `thoughtsTokenCount`
 *   are expected and can be ignored. Thinking tokens count against maxOutputTokens.
 *
 * See server/docs/llm-provider.md for a runnable curl and the real captured
 * request/response.
 *
 * Resilience (same shape as PitchPulse's cricket API client): per-attempt
 * AbortController timeout, bounded retry with exponential backoff + jitter on
 * transient failures (network error, HTTP 429, HTTP >= 500), and a typed
 * `AiError` the responder can branch on. Everything else -> the responder hands
 * off to a human.
 */

const DEFAULT_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.6-flash';

// Read env at call time (not module load) so tests can point LLM_API_URL at a
// local stub and flip LLM_API_KEY without re-importing the module.
function config() {
  return {
    apiUrl: process.env.LLM_API_URL || DEFAULT_API_URL,
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    apiKey: process.env.LLM_API_KEY ?? '',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 8000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 2),
    backoffMs: Number(process.env.LLM_BACKOFF_MS ?? 300),
  };
}

/**
 * Typed error for every failure mode of a Gemini call.
 * @property {'NOT_CONFIGURED'|'TIMEOUT'|'RATE_LIMIT'|'HTTP_ERROR'|'MALFORMED'} code
 * @property {number} [status] HTTP status, when relevant
 */
export class AiError extends Error {
  constructor(message, code, { status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
    this.isAiError = true;
  }
}

export function isConfigured() {
  return (process.env.LLM_API_KEY ?? '').length > 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter: ~300ms, ~900ms, ... for base 300. */
function backoffDelay(attempt, base) {
  return base * 2 ** attempt + Math.random() * base * 0.3;
}

/**
 * One HTTP attempt with its own timeout. Throws `{ retryable, error }`-ish:
 * a plain AiError for terminal failures, or an Error tagged `.retryable = true`.
 */
async function attempt({ apiUrl, model, apiKey, body, timeoutMs, callerSignal }) {
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${apiUrl}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted && !(callerSignal && callerSignal.aborted)) {
      throw new AiError(`request timed out after ${timeoutMs}ms`, 'TIMEOUT', { cause: err });
    }
    if (callerSignal && callerSignal.aborted) {
      throw new AiError('request aborted by caller', 'TIMEOUT', { cause: err });
    }
    // Network / DNS / connection reset — retryable.
    const e = new Error(`network error: ${err.message}`);
    e.retryable = true;
    e.cause = err;
    throw e;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }

  if (res.status === 429) {
    const e = new Error('rate limited (429)');
    e.retryable = true;
    e.status = 429;
    throw e;
  }
  if (res.status >= 500) {
    const e = new Error(`upstream ${res.status}`);
    e.retryable = true;
    e.status = res.status;
    throw e;
  }
  if (!res.ok) {
    // Other 4xx — not retryable.
    throw new AiError(`HTTP ${res.status}`, 'HTTP_ERROR', { status: res.status });
  }

  let raw;
  try {
    raw = await res.json();
  } catch (err) {
    throw new AiError('response body was not JSON', 'MALFORMED', { cause: err });
  }
  if (!raw || !Array.isArray(raw.candidates)) {
    throw new AiError('response had no candidates[]', 'MALFORMED');
  }
  return raw;
}

/**
 * @param {object} args
 * @param {string} args.system   system prompt (tenant persona + KB context)
 * @param {{role: 'user'|'model', text: string}[]} args.history  conversation so far
 * @param {AbortSignal} [args.signal]  caller cancellation
 * @returns {Promise<{ text: string, raw: object, finishReason: string|undefined }>}
 */
export async function generateReply({ system, history = [], signal } = {}) {
  const cfg = config();
  if (!isConfigured()) {
    throw new AiError('LLM_API_KEY is not set', 'NOT_CONFIGURED');
  }

  const body = {
    system_instruction: { parts: [{ text: system ?? '' }] },
    contents: history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 800,
      responseMimeType: 'application/json',
    },
  };

  let lastRetryable;
  for (let i = 0; i <= cfg.maxRetries; i += 1) {
    try {
      const raw = await attempt({
        apiUrl: cfg.apiUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
        body,
        timeoutMs: cfg.timeoutMs,
        callerSignal: signal,
      });
      const parts = raw.candidates?.[0]?.content?.parts ?? [];
      const text = parts.find((p) => typeof p.text === 'string')?.text ?? '';
      return { text, raw, finishReason: raw.candidates?.[0]?.finishReason };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (!err?.retryable) throw err;
      lastRetryable = err;
      if (i < cfg.maxRetries) {
        const delay = backoffDelay(i, cfg.backoffMs);
        logger.warn(
          { attempt: i + 1, status: err.status, delay: Math.round(delay) },
          'aiClient.generateReply retrying after transient failure',
        );
        await sleep(delay);
      }
    }
  }

  if (lastRetryable?.status === 429) {
    throw new AiError('rate limited after retries', 'RATE_LIMIT', {
      status: 429,
      cause: lastRetryable,
    });
  }
  throw new AiError(
    `transient failure after ${cfg.maxRetries + 1} attempts: ${lastRetryable?.message}`,
    'HTTP_ERROR',
    { status: lastRetryable?.status, cause: lastRetryable },
  );
}

export default { generateReply, isConfigured, AiError };
