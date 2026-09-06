import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 2: tenant widget-settings endpoints.
 *
 * Requires a migrated database (docker compose up -d && npx prisma migrate dev).
 * Hermetic: mints its own tenants via /auth/signup, cleans them up after.
 */

let app;
const suffix = Date.now();
const created = { tenantIds: [] };

test.before(async () => {
  app = await buildApp({ loggerInstance: false });
  await app.ready();
});

test.after(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: created.tenantIds } } });
  await app.close();
  await prisma.$disconnect();
});

let seq = 0;
async function signup(label) {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      tenantName: `SET ${label} ${suffix}-${seq}`,
      agentEmail: `set-${label}-${suffix}-${seq}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id, name: body.tenant.name };
}

function getSettings(token) {
  return app.inject({
    method: 'GET',
    url: '/tenants/me/settings',
    headers: { authorization: `Bearer ${token}` },
  });
}

function patchSettings(token, payload) {
  return app.inject({
    method: 'PATCH',
    url: '/tenants/me/settings',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

test('GET returns the default shape for a fresh tenant', async () => {
  const A = await signup('A');
  const res = await getSettings(A.token);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    displayName: A.name,
    welcomeMessage: 'Hi! How can we help?',
    brandColor: '#2563eb',
  });
});

test('PATCH persists and a follow-up GET reflects it; a later PATCH merges', async () => {
  const A = await signup('A');

  const first = await patchSettings(A.token, {
    welcomeMessage: 'Yo, ask us anything',
    brandColor: '#000000',
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().welcomeMessage, 'Yo, ask us anything');
  assert.equal(first.json().brandColor, '#000000');

  const afterFirst = await getSettings(A.token);
  assert.equal(afterFirst.json().welcomeMessage, 'Yo, ask us anything');
  assert.equal(afterFirst.json().brandColor, '#000000');
  assert.equal(afterFirst.json().displayName, A.name);

  // Second PATCH touches only brandColor — welcomeMessage must survive.
  const second = await patchSettings(A.token, { brandColor: '#ffffff' });
  assert.equal(second.statusCode, 200);

  const afterSecond = await getSettings(A.token);
  assert.equal(afterSecond.json().brandColor, '#ffffff');
  assert.equal(afterSecond.json().welcomeMessage, 'Yo, ask us anything', 'merge, not replace');
});

test('PATCH with a bad hex color is 400 VALIDATION_ERROR', async () => {
  const A = await signup('A');
  const res = await patchSettings(A.token, { brandColor: 'blue' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_ERROR');
});

test('PATCH with an empty body is 400 EMPTY_UPDATE', async () => {
  const A = await signup('A');
  const res = await patchSettings(A.token, {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'EMPTY_UPDATE');
});

test('tenant settings are isolated per tenant', async () => {
  const A = await signup('A');
  const B = await signup('B');

  const patched = await patchSettings(A.token, { displayName: 'Acme Support' });
  assert.equal(patched.statusCode, 200);

  const aView = await getSettings(A.token);
  assert.equal(aView.json().displayName, 'Acme Support');

  const bView = await getSettings(B.token);
  assert.equal(bView.statusCode, 200);
  assert.equal(bView.json().displayName, B.name, "B still sees only its own row");
  assert.notEqual(bView.json().displayName, 'Acme Support');

  // B changing its own settings must not touch A.
  await patchSettings(B.token, { displayName: 'Globex Help' });
  const aViewAgain = await getSettings(A.token);
  assert.equal(aViewAgain.json().displayName, 'Acme Support');
});
