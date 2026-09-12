import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { isPrismaUnavailable } from '../lib/prismaErrors.js';

/**
 * Central error handler. Response shape is always:
 *   { error: { message, code, details? } }
 *
 * - Zod / Fastify validation errors        -> 400 VALIDATION_ERROR (with field detail)
 * - AppError                               -> its own statusCode + code
 * - @fastify/jwt auth errors               -> 401 UNAUTHORIZED
 * - Prisma unique-constraint violation     -> 409 CONFLICT
 * - Prisma connection-level errors         -> 503 SERVICE_UNAVAILABLE (never leak raw message)
 * - everything else                        -> 500 INTERNAL_ERROR (logged, non-leaky)
 */
async function errorHandler(fastify) {
  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    // Fastify's own schema validation
    if (err.validation) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: err.validation },
      });
    }

    if (err instanceof AppError || err.isAppError) {
      return reply.status(err.statusCode).send({
        error: {
          message: err.message,
          code: err.code,
          // Only @fastify/rate-limit's errorResponseBuilder sets this today
          // (see routes/widgetAuth.js) — omitted for every other AppError.
          ...(typeof err.retryAfterMs === 'number' ? { retryAfterMs: err.retryAfterMs } : {}),
        },
      });
    }

    // @fastify/jwt throws errors tagged with a code like FST_JWT_*
    if (typeof err.code === 'string' && err.code.startsWith('FST_JWT')) {
      return reply.status(401).send({
        error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
      });
    }

    // Prisma known request errors
    if (err.code === 'P2002') {
      return reply.status(409).send({
        error: { message: 'Resource already exists', code: 'CONFLICT' },
      });
    }

    // Prisma connection-level errors: the database is unreachable/unresponsive.
    // Never leak the raw Prisma message — respond with a generic 503 and log
    // the real error server-side for diagnosis.
    if (isPrismaUnavailable(err)) {
      request.log.error({ err: err.message, code: err.code }, 'database unavailable');
      return reply.status(503).send({
        error: { message: 'Service temporarily unavailable', code: 'SERVICE_UNAVAILABLE' },
      });
    }

    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        error: { message: err.message || 'Request error', code: err.code || 'REQUEST_ERROR' },
      });
    }

    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { message: 'Internal Server Error', code: 'INTERNAL_ERROR' },
    });
  });
}

export default fp(errorHandler, { name: 'errorHandler' });
