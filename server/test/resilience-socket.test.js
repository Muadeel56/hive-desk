import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { buildApp } from '../src/app.js';
import { initSocket } from '../src/realtime/socket.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 8 checkpoint: Postgres-outage error mapping over Socket.io.
 *
 * Split from resilience.test.js because this needs a real listening socket
 * (app.listen()), mirroring the inject-only vs. listening split already
 * established between isolation.test.js and realtime.test.js.
 *
 * As in resilience.test.js, this verifies only the error-mapping layer via
 * a mocked Prisma error — see server/docs/resilience.md for the manual
 * live-outage test. Mocking here is a plain save/reassign/restore rather
 * than node:test's t.mock.method(), since PrismaClient's model methods are
 * Proxy-backed and getOwnPropertyDescriptor() on them (which t.mock.method
 * relies on) returns a fake `{value: undefined}` descriptor.
 */

let app;
let io;
let url;
const suffix = Date.now();
const created = { tenantIds: [] };
const openSockets = new Set();

test.before(async () => {
  app = await buildApp({ loggerInstance: false });
  io = initSocket(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  url = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  for (const s of openSockets) s.disconnect();
  io.close();
  await prisma.tenant.deleteMany({ where: { id: { in: created.tenantIds } } });
  await app.close();
  await prisma.$disconnect();
});

async function signup(label) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      tenantName: `RESS ${label} ${suffix}`,
      agentEmail: `ress-${label}-${suffix}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, widgetApiKey: body.tenant.widgetApiKey };
}

function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = ioc(url, { auth, transports: ['websocket'], reconnection: false });
    openSockets.add(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      openSockets.delete(socket);
      socket.close();
      reject(err);
    });
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('join-conversation acks SERVICE_UNAVAILABLE when Postgres is unreachable', async (t) => {
  const A = await signup('A');

  // forTenant().conversation.findUnique() delegates to the underlying
  // model's findFirst() (see lib/tenantDb.js), so that's what join-conversation
  // actually calls.
  const original = prisma.conversation.findFirst;
  prisma.conversation.findFirst = () => {
    throw Object.assign(new Error('simulated: connection pool timeout'), { code: 'P2024' });
  };
  t.after(() => {
    prisma.conversation.findFirst = original;
  });

  const agent = await connect({ token: A.token });
  const ack = await emit(agent, 'join-conversation', { conversationId: 'irrelevant-mocked-anyway' });

  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'SERVICE_UNAVAILABLE');
});
