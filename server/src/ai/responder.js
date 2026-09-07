/**
 * Phase 4 — AI auto-reply decision logic.
 *
 * When a visitor sends a message and the conversation is still AI-handled
 * (`status === 'AI'`), the responder asks Gemini to answer *only* from that
 * tenant's knowledge base. If the model is confident, its answer is posted back
 * automatically and the conversation stays AI-handled. Otherwise — not
 * confident, malformed output, API error, or no API key — the conversation
 * flips to `WAITING`, connected agent dashboards for the tenant get a
 * `conversation-needs-human` notification, and the visitor sees a short system
 * line so they are never left in silence.
 *
 * Naming: the project doc's `mode = ai / needsHuman / human` maps onto the
 * existing schema as `Conversation.status = AI / WAITING / AGENT`; the doc's
 * `handledByAgentId` is `Conversation.assignedAgentId`. No new columns.
 */
import { forTenant } from '../lib/tenantDb.js';
import { logger } from '../utils/logger.js';
import { conversationRoom, tenantRoom } from '../realtime/socket.js';
import aiClient from './aiClient.js';

const HANDOFF_MESSAGE = 'Thanks — an agent will be with you shortly.';
const HISTORY_LIMIT = 20;

/**
 * The system prompt. Half the phase — iterate here. Instructs the model to
 * answer ONLY from the KB and to emit a single JSON confidence object.
 */
export function buildSystemPrompt({ displayName, kbEntries = [] }) {
  const kb = kbEntries.length
    ? kbEntries.map((e) => `Q: ${e.question}\nA: ${e.answer}\n---`).join('\n')
    : '(The Knowledge Base is empty.)';

  return `You are the automated first-line support assistant for "${displayName}".
Answer ONLY from the Knowledge Base below. Never use outside knowledge. Never guess.

Knowledge Base:
${kb}

Rules:
- If the Knowledge Base clearly answers the visitor's question, reply with a short,
  friendly answer in the visitor's language.
- Otherwise — not covered, unsure, visitor asks for a human, visitor is upset, wants
  to purchase, or has an account-specific problem — do NOT answer.
- Respond with exactly one JSON object and nothing else:
  {"confident": true, "answer": "<your answer>"}
  {"confident": false, "answer": ""}`;
}

/** Strip ```json ... ``` / ``` ... ``` fences the model sometimes adds anyway. */
function stripFences(text) {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Defensive parse of the model output. Anything ambiguous -> not confident.
 * @returns {{ confident: boolean, answer: string }}
 */
export function parseConfidence(text, finishReason) {
  const no = { confident: false, answer: '' };

  if (finishReason === 'MAX_TOKENS' || finishReason === 'SAFETY') return no;

  const raw = (text ?? '').trim();
  if (!raw) return no;
  if (raw === 'NEEDS_HUMAN') return no;

  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return no;
  }

  if (!parsed || parsed.confident !== true) return no;
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (!answer) return no;

  return { confident: true, answer };
}

/** VISITOR -> 'user'; AI/AGENT -> 'model'. */
function toGeminiRole(role) {
  return role === 'VISITOR' ? 'user' : 'model';
}

/**
 * Flip the conversation to WAITING (only from AI), notify the tenant's agents,
 * and drop a visitor-facing system line into the conversation room.
 *
 * `conversation` only needs `{ id, status }`. `lastVisitorMessage` is looked up
 * if not supplied (the socket.js error path has no history in hand).
 */
export async function handoff({ io, tenantId, conversation, reason, lastVisitorMessage }) {
  const db = forTenant(tenantId);

  if (conversation.status === 'AI') {
    try {
      await db.conversation.update({
        where: { id: conversation.id },
        data: { status: 'WAITING' },
      });
    } catch (err) {
      // A concurrent takeover may have moved it past AI — never downgrade.
      logger.warn({ err, conversationId: conversation.id }, 'handoff: WAITING transition skipped');
    }
  }

  let lastMsg = lastVisitorMessage;
  if (lastMsg === undefined) {
    const row = await db.message
      .findFirst({
        where: { conversationId: conversation.id, role: 'VISITOR' },
        orderBy: { createdAt: 'desc' },
      })
      .catch(() => null);
    lastMsg = row?.content ?? null;
  }

  io.to(tenantRoom(tenantId)).emit('conversation-needs-human', {
    conversationId: conversation.id,
    tenantId,
    lastVisitorMessage: lastMsg,
    reason,
  });

  io.to(conversationRoom(conversation.id)).emit('new-message', {
    id: `sys-${Date.now()}`,
    conversationId: conversation.id,
    role: 'AI',
    content: HANDOFF_MESSAGE,
    createdAt: new Date(),
  });

  return { acted: true, mode: 'needsHuman' };
}

/**
 * @param {{ io: import('socket.io').Server, tenantId: string, conversationId: string }} ctx
 * @param {{ client?: typeof aiClient }} [opts]  inject a fake client in tests
 * @returns {Promise<{ acted: boolean, mode?: 'ai'|'needsHuman' }>}
 */
export async function respondToVisitorMessage({ io, tenantId, conversationId }, { client = aiClient } = {}) {
  const db = forTenant(tenantId);

  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.status !== 'AI') {
    return { acted: false };
  }

  const [kbEntries, historyRowsDesc, tenant] = await Promise.all([
    db.knowledgeBaseEntry.findMany({ orderBy: { createdAt: 'asc' } }),
    db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    }),
    db.tenant.get(),
  ]);

  const historyRows = historyRowsDesc.slice().reverse();
  const history = historyRows.map((m) => ({ role: toGeminiRole(m.role), text: m.content }));
  const lastVisitorMessage =
    [...historyRows].reverse().find((m) => m.role === 'VISITOR')?.content ?? null;

  const displayName = tenant?.settings?.displayName ?? tenant?.name ?? 'us';

  if (!client.isConfigured()) {
    return handoff({ io, tenantId, conversation, reason: 'ai-not-configured', lastVisitorMessage });
  }

  const system = buildSystemPrompt({ displayName, kbEntries });

  let result;
  try {
    result = await client.generateReply({ system, history });
  } catch (err) {
    logger.warn(
      { err, conversationId, code: err?.code },
      'aiClient.generateReply failed — handing off',
    );
    return handoff({
      io,
      tenantId,
      conversation,
      reason: err?.code ?? 'ai-error',
      lastVisitorMessage,
    });
  }

  const { confident, answer } = parseConfidence(result.text, result.finishReason);

  if (confident && answer) {
    // A human may have taken over while we were waiting on the model.
    const fresh = await db.conversation.findUnique({ where: { id: conversationId } });
    if (fresh?.status !== 'AI') return { acted: false };

    const message = await db.message.create({
      data: { conversationId, role: 'AI', content: answer },
    });
    await db.conversation.update({ where: { id: conversationId }, data: {} });

    io.to(conversationRoom(conversationId)).emit('new-message', {
      id: message.id,
      conversationId,
      role: 'AI',
      content: message.content,
      createdAt: message.createdAt,
    });

    return { acted: true, mode: 'ai' };
  }

  await handoff({ io, tenantId, conversation, reason: 'ai-not-confident', lastVisitorMessage });
  return { acted: true, mode: 'needsHuman' };
}

export default { respondToVisitorMessage, handoff, buildSystemPrompt, parseConfidence };
