/**
 * Prisma "known request error" codes that mean the database itself is
 * unreachable/unresponsive right now, as opposed to a query/data problem
 * (e.g. P2002 unique-constraint violation, which is a client error and is
 * handled separately as 409 CONFLICT).
 *
 *   P1001 - Can't reach database server
 *   P1002 - Database server was reached but timed out
 *   P1008 - Operations timed out
 *   P1017 - Server has closed the connection
 *   P2024 - Timed out fetching a connection from the connection pool
 *
 * Both the REST error handler and the Socket.io guard() map these to a
 * generic "SERVICE_UNAVAILABLE" response instead of leaking the raw Prisma
 * error message to the client.
 */
const UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

export function isPrismaUnavailable(err) {
  return typeof err?.code === 'string' && UNAVAILABLE_CODES.has(err.code);
}
