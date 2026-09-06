/**
 * STUB — Phase 4. Decides whether the AI answers a visitor message or the
 * conversation is flagged for a human (`WAITING`). Will call aiClient.generateReply,
 * parse a confidence signal, and either auto-reply or mark the conversation.
 */
// eslint-disable-next-line no-unused-vars
export async function respondToVisitorMessage({ conversationId, tenantId } = {}) {
  throw new Error('responder.respondToVisitorMessage is not implemented yet (Phase 4)');
}

export default { respondToVisitorMessage };
