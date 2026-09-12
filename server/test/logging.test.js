import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import pino from 'pino';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 10 — structured logging: redaction + per-request tenantId/route
 * fields (src/plugins/tenantContext.js, src/utils/logger.js).
 *
 * Requires a migrated database. Hermetic: mints its own tenant via
 * /auth/signup, cleans it up after.
 *
 * Uses the same `redact` config as the real logger (utils/logger.js) but
 * pointed at an in-memory stream instead of stdout, so the test can inspect
 * exactly what would have been written.
 */

let app;
let lines;
const suffix = Date.now();
const created = { tenantIds: [] };

function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, chunks };
}

test.before(async () => {
  const { stream, chunks } = captureStream();
  lines = chunks;
  const testLogger = pino(
    {
      level: 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-widget-api-key"]',
          '*.token',
          '*.widgetApiKey',
          '*.passwordHash',
          '*.password',
        ],
        censor: '[redacted]',
      },
    },
    stream,
  );
  app = await buildApp({ loggerInstance: testLogger });
  await app.ready();
});

test.after(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: created.tenantIds } } });
  await app.close();
  await prisma.$disconnect();
});

async function signup() {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      tenantName: `LOG ${suffix}`,
      agentEmail: `log-${suffix}@test.local`,
      agentPassword: 'password123',
      agentName: 'Agent Log',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, widgetApiKey: body.tenant.widgetApiKey };
}

function parsedLines() {
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

test('a tenant-scoped request logs a structured tenantId + route field', async () => {
  lines.length = 0;
  const A = await signup();

  const res = await app.inject({
    method: 'GET',
    url: '/conversations',
    headers: { authorization: `Bearer ${A.token}` },
  });
  assert.equal(res.statusCode, 200);

  const withTenant = parsedLines().filter((l) => l.tenantId === A.tenantId);
  assert.ok(withTenant.length > 0, 'at least one log line should carry the resolved tenantId');
  assert.ok(
    withTenant.some((l) => l.route === '/conversations'),
    'the templated route should be logged, not just the raw path',
  );
});

test('an Authorization header and a widget API key never appear verbatim in logs', async () => {
  lines.length = 0;
  const A = await signup();

  await app.inject({
    method: 'GET',
    url: '/conversations',
    headers: { authorization: `Bearer ${A.token}` },
  });
  await app.inject({
    method: 'POST',
    url: '/widget/session',
    headers: { 'x-widget-api-key': A.widgetApiKey },
    payload: {},
  });

  const raw = lines.join('');
  assert.ok(!raw.includes(A.token), 'JWT must never appear verbatim in logs');
  assert.ok(!raw.includes(A.widgetApiKey), 'widget API key must never appear verbatim in logs');
});
