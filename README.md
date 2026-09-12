# HiveDesk

Multi-tenant, AI-assisted live chat platform. Three independent projects:

| Path         | What it is                                            | Stack                          |
| ------------ | ----------------------------------------------------- | ------------------------------ |
| `server/`    | REST + (later) realtime API, multi-tenant, tenant-scoped at the query layer | Fastify 5, Prisma 6, Postgres, Redis, ESM |
| `dashboard/` | Agent/admin web app                                   | Vite 6, React 19, TypeScript   |
| `widget/`    | Embeddable chat bubble — one `<script>` tag, no framework shipped | Vite library mode, vanilla JS  |

They share **no build tooling**. Install and run each on its own.

## Fresh clone quickstart

Backend fully containerized (API + worker + Postgres + Redis), dashboard/widget
built standalone against it:

```bash
git clone <repo-url> && cd hive-desk
cp server/.env.example server/.env   # compose's env_file needs this to exist
docker compose up --build            # postgres, redis, server, worker — migrated & healthy
curl localhost:3000/health           # -> {"status":"ok",...}

cd dashboard && npm install && npm run dev     # http://localhost:5173, talks to :3000
cd ../widget && npm install && npm run build   # dist/hivedesk-widget.js, talks to :3000
```

## 1. Infrastructure

```bash
cp server/.env.example server/.env   # if you haven't already
docker compose up --build   # postgres, redis, server (API), worker (analytics rollup)
docker compose ps           # all four should be "healthy" / running
curl localhost:3000/health  # -> {"status":"ok","service":"hivedesk-server"}
```

`server` and `worker` build from the same image (`server/Dockerfile`) — the
entrypoint (`server/docker-entrypoint.sh`) waits for Postgres, then runs
`prisma migrate deploy` before either process starts, so the schema is always
migrated on `docker compose up`. `worker` just overrides the container
`command:` to run `node src/jobs/worker.js` (BullMQ hourly analytics rollup)
instead of the API.

Only want the databases (for host-side `npm run dev`, see below)?

```bash
docker compose up -d postgres redis   # Postgres 16 on host :5442, Redis 7 on host :6379
```

> Host port for Postgres is **5442** (`5442 -> 5432`) because a local Postgres
> usually already owns 5432. `server/.env.example` matches this.
>
> **Container vs. host env vars:** inside the compose network, `server`/`worker`
> get `DATABASE_URL`/`REDIS_URL` pointed at `postgres:5432`/`redis:6379` via an
> `environment:` override in `docker-compose.yml` — everything else (JWT_SECRET,
> LLM_*, PORT, ...) still comes from `server/.env`. Running `npm run dev` on the
> host uses `server/.env` unmodified, i.e. `localhost:5442`/`localhost:6379`.

## 2. server/

Run it in Docker (above), or on the host against the same Postgres/Redis:

```bash
cd server
npm install
cp .env.example .env               # real .env is gitignored
npx prisma migrate dev --name init # create schema in the Docker DB
npm run seed                       # 2 isolated demo tenants + agents + conversations
npm run dev                        # http://localhost:3000
curl localhost:3000/health         # -> {"status":"ok",...}
npm test                           # tenant-isolation checks (needs the DB up)
```

`npm test` works the same way whether Postgres came from `docker compose up
--build` or `docker compose up -d postgres redis` — both expose it on host
`:5442`, matching `server/.env`.

Key endpoints in this phase:

- `POST /auth/signup` `{ tenantName, agentEmail, agentPassword, agentName }` → `{ token, tenant: { id, name, widgetApiKey } }`
- `POST /auth/login` `{ email, password }` → `{ token }`
- `GET /conversations` — agent JWT, tenant-scoped → `{ conversations, pagination: { total, take, skip } }`
- `GET /conversations/:id` — agent JWT, tenant-scoped
- `GET /tenants/me/settings` — agent JWT → `{ displayName, welcomeMessage, brandColor }` (stored JSON merged over defaults; never leaks `widgetApiKey`)
- `PATCH /tenants/me/settings` `{ displayName?, welcomeMessage?, brandColor? }` — merges into the stored JSON; empty body → `400 EMPTY_UPDATE`, bad hex → `400 VALIDATION_ERROR`
- `POST /knowledge-base` `{ question, answer }` → `201 { entry }`
- `GET /knowledge-base?take=&skip=` → `{ entries, pagination: { total, take, skip } }` (newest first)
- `GET /knowledge-base/:id` → `{ entry }`; cross-tenant/unknown id → `404 NOT_FOUND`
- `PATCH /knowledge-base/:id` — partial update; empty body → `400 EMPTY_UPDATE`; cross-tenant id → `404`
- `DELETE /knowledge-base/:id` → `204` no body; cross-tenant id → `404`
- `POST /widget/session` — header `x-widget-api-key: <tenant.widgetApiKey>` → `{ sessionId, conversationId }`
- Everything else returns `501 NOT_IMPLEMENTED` until later phases.

All errors use the shape `{ error: { message, code } }`. Common codes:
`VALIDATION_ERROR`, `EMPTY_UPDATE`, `NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, `INTERNAL_ERROR`.

**Tenant isolation rule:** all tenant data access goes through `forTenant(tenantId)`
in `src/lib/tenantDb.js`. `tenantId` is resolved only from the JWT or the widget
API key (`src/plugins/tenantContext.js`) — never from a request body/query/param.
Reviewers: reject any route that queries a tenant-owned model without `forTenant()`.

### LLM provider

Google Gemini (`gemini-3.6-flash`), free tier. See `server/docs/llm-provider.md`
for the request/response shape and `server/scripts/llm-smoke.sh` for a manual call:

```bash
cd server && LLM_API_KEY=your-key ./scripts/llm-smoke.sh
```

## 3. dashboard/ — build & test standalone

A static SPA; served on its own and just needs a running API to point at
(`VITE_API_URL`) — the containerized one from `docker compose up --build`, or
a host-side `npm run dev` server, either works identically:

```bash
cd dashboard
npm install
cp .env.example .env    # VITE_API_URL=http://localhost:3000
npm run dev             # http://localhost:5173  (placeholder /, /login)
npm run build           # type-checks + production build
npm run preview         # serve the production build locally
```

## 4. widget/ — build & test standalone

Also a static bundle — no `.env`; the API URL is set at embed time via the
`data-api-url` attribute, so it can point at the containerized API or a
host-side one with no rebuild:

```bash
cd widget
npm install
npm run build          # -> dist/hivedesk-widget.js  (single IIFE bundle)
npm run size           # gzipped byte count (currently ~1.2 KB; ceiling 50 KB)
```

Test embeddability in a page with **no tooling**:

```bash
# use a port other than :3000 if the containerized API is already running there
cd widget && npx serve . -l 5000        # open http://localhost:5000/demo.html
# or just open widget/demo.html via file://
```

`demo.html` is a bare `<html><body>` plus one line — point `data-api-url` at
whichever API is running (containerized `:3000` by default), and set
`data-tenant-key` to a real `widgetApiKey` from `npm run seed` in `server/`
(a placeholder key 401s against `/widget/config`):

```html
<script src="./dist/hivedesk-widget.js" data-tenant-key="<a-seeded-widgetApiKey>" data-api-url="http://localhost:3000"></script>
```

## Verifying tenant isolation by hand

```bash
cd server && npm run seed          # note the two widgetApiKeys + conversationIds
npm run dev
# login as tenant A
TOKEN_A=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@tenant-a.test","password":"password123"}' | jq -r .token)
# fetch tenant B's conversation with A's token -> 404, no data
curl -i localhost:3000/conversations/<TENANT_B_CONVERSATION_ID> -H "authorization: Bearer $TOKEN_A"
# list -> only tenant A rows
curl -s localhost:3000/conversations -H "authorization: Bearer $TOKEN_A"
# widget session with a bad key -> 401
curl -i -X POST localhost:3000/widget/session -H 'x-widget-api-key: garbage'
```

`npm test` in `server/` automates exactly these checks.
