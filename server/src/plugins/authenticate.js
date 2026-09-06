import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { AppError } from '../lib/errors.js';

/**
 * Registers @fastify/jwt and exposes `fastify.authenticate`, a preHandler that:
 *   - verifies the `Authorization: Bearer <jwt>` header
 *   - attaches `request.agent = { agentId, tenantId, role }`
 *   - responds 401 on a missing / invalid / expired token
 *
 * The JWT payload is minted in routes/auth.js and always contains
 * agentId, tenantId and role.
 */
async function authenticate(fastify) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set — refusing to start with an insecure default');
  }

  fastify.register(fastifyJwt, {
    secret,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? '12h' },
  });

  fastify.decorate('authenticate', async function (request) {
    let payload;
    try {
      payload = await request.jwtVerify();
    } catch {
      throw new AppError(401, 'Missing or invalid authentication token', 'UNAUTHORIZED');
    }

    if (!payload?.agentId || !payload?.tenantId) {
      throw new AppError(401, 'Malformed authentication token', 'UNAUTHORIZED');
    }

    request.agent = {
      agentId: payload.agentId,
      tenantId: payload.tenantId,
      role: payload.role ?? 'AGENT',
    };
  });
}

export default fp(authenticate, { name: 'authenticate' });
