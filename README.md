# HiveDesk

Multi-tenant, AI-assisted live chat platform. Three independent projects:

| Path         | What it is                                            | Stack                          |
| ------------ | ----------------------------------------------------- | ------------------------------ |
| `server/`    | REST + (later) realtime API, multi-tenant, tenant-scoped at the query layer | Fastify 5, Prisma 6, Postgres, Redis, ESM |
| `dashboard/` | Agent/admin web app                                   | Vite 6, React 19, TypeScript   |
| `widget/`    | Embeddable chat bubble — one `<script>` tag, no framework shipped | Vite library mode, vanilla JS  |

They share **no build tooling**. Install and run each on its own.

## 1. Infrastructure

```bash
docker compose up -d      # Postgres 16 on host :5442, Redis 7 on host :6379
docker compose ps         # both should be "healthy"
```

> Host port for Postgres is **5442** (`5442 -> 5432`) because a local Postgres
> usually already owns 5432. `server/.env.example` matches this.

## 2. server/

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

## 3. dashboard/

```bash
cd dashboard
npm install
cp .env.example .env    # VITE_API_URL=http://localhost:3000
npm run dev             # http://localhost:5173  (placeholder /, /login)
npm run build           # type-checks + production build
```

## 4. widget/ — build & test standalone

```bash
cd widget
npm install
npm run build          # -> dist/hivedesk-widget.js  (single IIFE bundle)
npm run size           # gzipped byte count (currently ~1.2 KB; ceiling 50 KB)
```

Test embeddability in a page with **no tooling**:

```bash
cd widget && npx serve .        # open http://localhost:3000/demo.html
# or just open widget/demo.html via file://
```

`demo.html` is a bare `<html><body>` plus one line:

```html
<script src="./dist/hivedesk-widget.js" data-api-key="test" data-api-url="http://localhost:3000"></script>
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
