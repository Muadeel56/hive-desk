# Resilience Posture (Phase 8)

## Scope

Single-process v1. This document describes how hive-desk behaves when its
two infrastructure dependencies (Postgres, Redis) are briefly unreachable,
and what was deliberately deferred.

## Postgres

- PrismaClient retries transient connection issues internally on the next
  query; there is no custom connection-pooling or reconnect logic in this
  codebase beyond what Prisma does by default. Once Postgres comes back, the
  next query against the same `PrismaClient` succeeds without restarting the
  Node process.
- Connection-level Prisma error codes (`P1001`, `P1002`, `P1008`, `P1017`,
  `P2024` — see `server/src/lib/prismaErrors.js`) are mapped to a generic
  `503 SERVICE_UNAVAILABLE` at both request boundaries:
  - REST: `server/src/plugins/errorHandler.js`
  - Socket.io: `server/src/realtime/socket.js`'s `guard()` wrapper (every
    handler — `start-conversation`, `resume-conversation`,
    `join-conversation`, `send-message` — is wrapped in `guard()`, so this
    applies uniformly)
  Neither boundary ever leaks the raw Prisma error message to a client; the
  real error is logged server-side.
- `GET /health` remains a pure liveness check (no dependency check, always
  fast). `GET /health/ready` is new: it runs `SELECT 1` against Postgres and
  returns `503` while the database is unreachable, `200` once it recovers —
  intended for orchestrator readiness probes and for the manual outage test
  below.

## Redis

- The previous shared client, `server/src/cache/redisClient.js`, was dead
  code: it was imported exactly once (in `server.js`'s shutdown handler),
  used `lazyConnect: true` so it never actually opened a connection, and
  nothing else in the codebase (no rate limiter, no Socket.io adapter)
  depended on it, despite a comment in that file claiming otherwise. It was
  removed in Phase 8.
- Phase 10 added rate limiting on the public widget surface, which needed
  exactly this: a fresh, dedicated Redis client (`server/src/lib/redisClient.js`,
  also `lazyConnect: true` — importing it must not itself open a socket, since
  it's pulled in transitively by files that never touch rate limiting, e.g.
  `src/ai/responder.js` -> `realtime/socket.js` -> `realtime/rateLimiter.js`)
  wired into `@fastify/rate-limit` for the REST `/widget/session`/`/config`
  routes (registered only inside `routes/widgetAuth.js`'s plugin scope, never
  globally) and into a small Lua-script-backed limiter
  (`server/src/realtime/rateLimiter.js`) for the Socket.io events that carry
  the real widget traffic (`start-conversation`, `send-message`,
  `resume-conversation`, `join-conversation`). Both fail open on a Redis
  error — rate limiting is a defense, not a hard dependency — and the
  connection's lifecycle is tied to `app.close()` via an `onClose` hook so
  neither a graceful production shutdown nor a test's teardown leaks it.

## Socket.io

- Single-process v1: no `@socket.io/redis-adapter`. Socket.io connection
  state (rooms, in-memory maps such as `aiInFlight`) lives entirely in one
  Node process's memory. Horizontal scaling of the realtime layer is out of
  scope for this phase and would require adding a Redis adapter later — this
  is a deliberate, documented choice, not an oversight.

## BullMQ

- `server/src/jobs/queue.js`'s analytics queue uses its own dedicated
  IORedis connection with `maxRetriesPerRequest: null` and
  `enableReadyCheck: false` — BullMQ's documented pattern for offline
  queueing. Jobs enqueued while Redis is briefly down are queued
  client-side and flushed once the connection recovers; no job loss on a
  short Redis blip.
- The analytics rollup is a scheduled/repeatable job only (registered and
  run once eagerly at worker boot); nothing on the request path enqueues
  jobs, so a Redis blip during normal request handling never touches the
  queue.
- `server/src/jobs/worker.js`'s boot sequence is now wrapped in a try/catch
  that logs clearly and calls `process.exit(1)` instead of crashing via an
  unhandled rejection — verified manually with **Postgres** down: Prisma's
  query rejects with `PrismaClientInitializationError`, the catch block logs
  `analytics worker: failed to start` and the process exits 1, letting a
  supervisor (Docker restart policy / systemd / PM2) restart it.
  **With Redis down at boot**, this catch does *not* fire: `queue.js`'s
  connection (`maxRetriesPerRequest: null`, `enableReadyCheck: false`,
  default `enableOfflineQueue: true`) means `analyticsQueue.add(...)`
  queues the command client-side and retries the connection indefinitely
  rather than rejecting — verified manually (`docker compose stop redis`
  then starting the worker logs repeating `bullmq redis connection error`
  warnings and simply waits). The process never crashes and resumes
  automatically once Redis returns, so the intended offline-queueing
  behavior is what actually happens here, not the fail-fast path.

## Manual test plan (live outage)

`node --test` does not attempt to stop/start real Postgres or Redis
containers mid-suite — see `server/test/resilience.test.js` and
`server/test/resilience-socket.test.js` for why (mocked-error unit tests
only; other test suites share the same `docker-compose.yml` Postgres
instance, so bouncing it inside the automated run would risk flaking
unrelated tests). To exercise a real outage/recovery:

1. `docker compose up -d` (both `postgres` and `redis` healthy).
2. `docker compose stop postgres`.
3. `curl localhost:3000/health/ready` — expect `503`.
4. Exercise a live request that hits the DB (e.g. `POST /auth/signup`) —
   expect a clean `503`/`SERVICE_UNAVAILABLE` response, no server crash, no
   raw Prisma error text in the response body.
5. `docker compose start postgres`.
6. `curl localhost:3000/health/ready` — expect `200` again, without
   restarting the Node server process.
7. Confirm the previously-attempted request now succeeds, same process.
8. `docker compose stop redis` — confirm the main app server stays up
   (`/health` and `/health/ready` both still `200`, since it has no Redis
   dependency after `redisClient.js`'s removal).
9. Start `node src/jobs/worker.js` with Redis down — confirm it does not
   crash: it logs repeating `bullmq redis connection error` warnings and
   waits; once Redis is restarted it proceeds and completes its boot rollup
   normally, with no restart needed.
10. Separately, start the worker with **Postgres** down (Redis up) —
    confirm it logs `analytics worker: failed to start` and exits with
    code 1 (no unhandled-rejection stack trace), ready for a supervisor to
    restart it once Postgres is back.

**Verified 2026-09-12** against this branch: steps 1–10 all behaved exactly
as described above.
