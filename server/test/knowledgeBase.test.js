import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 2: knowledge-base CRUD, tenant-scoped.
 *
 * Requires a migrated database (docker compose up -d && npx prisma migrate dev).
 * Hermetic: mints its own tenants via /auth/signup, cleans them up after
 * (KB entries cascade on tenant delete).
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
      tenantName: `KB ${label} ${suffix}-${seq}`,
      agentEmail: `kb-${label}-${suffix}-${seq}@test.local`,
      agentPassword: 'password123',
      agentName: `Agent ${label}`,
    },
  });
  assert.equal(res.statusCode, 201, `signup ${label} should succeed`);
  const body = res.json();
  created.tenantIds.push(body.tenant.id);
  return { token: body.token, tenantId: body.tenant.id };
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

function createEntry(token, payload) {
  return app.inject({
    method: 'POST',
    url: '/knowledge-base',
    headers: auth(token),
    payload,
  });
}

test('create -> list -> get -> patch -> delete happy path', async () => {
  const A = await signup('A');

  const createRes = await createEntry(A.token, {
    question: 'What are your support hours?',
    answer: 'Monday to Friday, 9am-5pm.',
  });
  assert.equal(createRes.statusCode, 201);
  const { entry } = createRes.json();
  assert.ok(entry.id);
  assert.equal(entry.tenantId, A.tenantId);
  assert.equal(entry.question, 'What are your support hours?');

  const listRes = await app.inject({
    method: 'GET',
    url: '/knowledge-base',
    headers: auth(A.token),
  });
  assert.equal(listRes.statusCode, 200);
  assert.ok(listRes.json().entries.some((e) => e.id === entry.id));

  const getRes = await app.inject({
    method: 'GET',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(A.token),
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json().entry.id, entry.id);

  const patchRes = await app.inject({
    method: 'PATCH',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(A.token),
    payload: { answer: 'Monday to Saturday, 8am-6pm.' },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json().entry.answer, 'Monday to Saturday, 8am-6pm.');
  assert.equal(patchRes.json().entry.question, 'What are your support hours?', 'merge, not replace');

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(A.token),
  });
  assert.equal(deleteRes.statusCode, 204);
  assert.equal(deleteRes.body, '');

  const getGone = await app.inject({
    method: 'GET',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(A.token),
  });
  assert.equal(getGone.statusCode, 404);
  assert.equal(getGone.json().error.code, 'NOT_FOUND');
});

test('POST validation: short question / missing answer -> 400', async () => {
  const A = await signup('A');

  const shortQ = await createEntry(A.token, { question: 'hi', answer: 'a valid answer' });
  assert.equal(shortQ.statusCode, 400);
  assert.equal(shortQ.json().error.code, 'VALIDATION_ERROR');

  const noAnswer = await createEntry(A.token, { question: 'A perfectly valid question?' });
  assert.equal(noAnswer.statusCode, 400);
  assert.equal(noAnswer.json().error.code, 'VALIDATION_ERROR');
});

test('PATCH with an empty body -> 400 EMPTY_UPDATE', async () => {
  const A = await signup('A');
  const { entry } = (await createEntry(A.token, {
    question: 'Do you offer refunds?',
    answer: 'Yes, within 30 days.',
  })).json();

  const res = await app.inject({
    method: 'PATCH',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(A.token),
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'EMPTY_UPDATE');
});

test('pagination: take/skip slice the list and total is the full count', async () => {
  const A = await signup('A');
  for (const n of [1, 2, 3]) {
    const res = await createEntry(A.token, {
      question: `Question number ${n}?`,
      answer: `Answer number ${n}.`,
    });
    assert.equal(res.statusCode, 201);
  }

  const page1 = await app.inject({
    method: 'GET',
    url: '/knowledge-base?take=2&skip=0',
    headers: auth(A.token),
  });
  assert.equal(page1.statusCode, 200);
  assert.equal(page1.json().entries.length, 2);
  assert.equal(page1.json().pagination.total, 3);
  assert.deepEqual(page1.json().pagination, { total: 3, take: 2, skip: 0 });

  const page2 = await app.inject({
    method: 'GET',
    url: '/knowledge-base?take=2&skip=2',
    headers: auth(A.token),
  });
  assert.equal(page2.statusCode, 200);
  assert.equal(page2.json().entries.length, 1);
  assert.equal(page2.json().pagination.total, 3);
});

test('cross-tenant GET/PATCH/DELETE by id -> 404 with no data leak', async () => {
  const A = await signup('A');
  const B = await signup('B');

  const { entry } = (await createEntry(A.token, {
    question: "Tenant A's secret FAQ?",
    answer: "Tenant A's secret answer.",
  })).json();

  const get = await app.inject({
    method: 'GET',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(B.token),
  });
  assert.equal(get.statusCode, 404);
  assert.ok(!JSON.stringify(get.json()).includes('secret answer'));

  const patch = await app.inject({
    method: 'PATCH',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(B.token),
    payload: { answer: 'hijacked' },
  });
  assert.equal(patch.statusCode, 404);

  const del = await app.inject({
    method: 'DELETE',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(B.token),
  });
  assert.equal(del.statusCode, 404);

  // B's list never includes A's entry.
  const bList = await app.inject({
    method: 'GET',
    url: '/knowledge-base',
    headers: auth(B.token),
  });
  assert.ok(!bList.json().entries.some((e) => e.id === entry.id));

  // A's entry is untouched.
  const aGet = await app.inject({
    method: 'GET',
    url: `/knowledge-base/${entry.id}`,
    headers: auth(A.token),
  });
  assert.equal(aGet.statusCode, 200);
  assert.equal(aGet.json().entry.answer, "Tenant A's secret answer.");
});
