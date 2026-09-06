import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { signupSchema, loginSchema } from '../schemas/auth.js';

const BCRYPT_ROUNDS = 10;

/** 43-char url-safe token (256 bits of entropy). Public — embedded in the widget script. */
function generateWidgetApiKey() {
  return crypto.randomBytes(32).toString('base64url');
}

export default async function authRoutes(fastify) {
  /**
   * POST /auth/signup — onboarding. Creates a Tenant + its first ADMIN Agent
   * in a single transaction. Returns a JWT plus the new tenant's public info.
   */
  fastify.post('/signup', async (request, reply) => {
    const { tenantName, agentEmail, agentPassword, agentName } = signupSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(agentPassword, BCRYPT_ROUNDS);

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { name: tenantName, widgetApiKey: generateWidgetApiKey() },
        });
        const agent = await tx.agent.create({
          data: {
            tenantId: tenant.id,
            email: agentEmail,
            passwordHash,
            name: agentName,
            role: 'ADMIN',
          },
        });
        return { tenant, agent };
      });
    } catch (err) {
      if (err.code === 'P2002') {
        throw new AppError(409, 'An account with that email already exists', 'EMAIL_TAKEN');
      }
      throw err;
    }

    const token = fastify.jwt.sign({
      agentId: result.agent.id,
      tenantId: result.tenant.id,
      role: result.agent.role,
    });

    return reply.status(201).send({
      token,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        widgetApiKey: result.tenant.widgetApiKey,
      },
    });
  });

  /**
   * POST /auth/login — agent login. Generic error on any failure (no user
   * enumeration). Never returns the password hash.
   */
  fastify.post('/login', async (request, reply) => {
    const { email, password } = loginSchema.parse(request.body);

    // email is unique per tenant, not globally; findFirst is acceptable for v1.
    const agent = await prisma.agent.findFirst({ where: { email } });

    const ok = agent ? await bcrypt.compare(password, agent.passwordHash) : false;
    if (!agent || !ok) {
      throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const token = fastify.jwt.sign({
      agentId: agent.id,
      tenantId: agent.tenantId,
      role: agent.role,
    });

    return reply.send({ token });
  });
}
