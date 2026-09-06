import { logger } from '../utils/logger.js';

/**
 * STUB — thin wrapper around the Google Gemini `generateContent` REST API.
 * Wired for real in Phase 4 (AI auto-reply & handoff).
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
 *     "generationConfig": { "temperature": 0.2, "maxOutputTokens": 1024 }
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
 *   Reply text: candidates[0].content.parts[0].text
 *   3.x is a thinking model: `thoughtSignature` per part + `thoughtsTokenCount`
 *   are expected and can be ignored. Thinking tokens count against maxOutputTokens.
 *
 * See server/docs/llm-provider.md for a runnable curl and the real captured
 * request/response (task A2).
 */

const API_URL = process.env.LLM_API_URL ?? 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = process.env.LLM_MODEL ?? 'gemini-3.6-flash';
const API_KEY = process.env.LLM_API_KEY ?? '';

export function isConfigured() {
  return API_KEY.length > 0;
}

/**
 * @param {object} args
 * @param {string} args.system              system prompt (tenant persona + KB context)
 * @param {{role: 'user'|'model', text: string}[]} args.history  conversation so far
 * @returns {Promise<{ text: string, raw: object }>}
 */
// eslint-disable-next-line no-unused-vars
export async function generateReply({ system, history } = {}) {
  logger.warn('aiClient.generateReply() is a stub — implement in Phase 4');
  throw new Error('aiClient.generateReply is not implemented yet (Phase 4)');
}

export default { generateReply, isConfigured };
