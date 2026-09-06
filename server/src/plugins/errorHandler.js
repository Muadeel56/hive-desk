import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * Central error handler. Response shape is always:
 *   { error: { message, code, details? } }
 *
 * - Zod / Fastify validation errors        -> 400 VALIDATION_ERROR (with field detail)
 * - AppError                               -> its own statusCode + code
 * - @fastify/jwt auth errors               -> 401 UNAUTHORIZED
 * - Prisma unique-constraint violation     -> 409 CONFLICT
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
        error: { message: err.message, code: err.code },
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
