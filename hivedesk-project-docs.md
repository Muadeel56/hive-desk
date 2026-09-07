# HiveDesk — Project Build Docs

**Concept:** A multi-tenant, AI-assisted live chat platform — like Intercom/Tawk.to/ChatArm. Companies (tenants) embed a small chat widget on their own website. Visitors chat live; an AI tries to answer first using that tenant's own FAQ/knowledge base; if it can't help, the conversation is flagged and a human agent takes over from a dashboard. Every tenant's data, conversations, and settings stay fully isolated from every other tenant.

**Goal:** Master multi-tenant architecture, real-time chat systems, and practical LLM API integration — the exact shape of product a UAE SaaS/agency company (like AMJ Technology Solutions' ChatArm) actually builds and sells.

**Estimated time:** 10–14 focused days (this is your most ambitious project yet — bigger than PitchPulse)
**Tech stack:** Fastify, Prisma, PostgreSQL, Redis, Socket.io, an LLM API (OpenAI or Anthropic), React (dashboard), a small vanilla-JS/React embeddable widget build, Zod, JWT, Docker Compose

---

## Phase 0 — Setup & Planning

### Steps
1. Pick your LLM provider (OpenAI or Anthropic API) and get an API key. Read their docs for a basic chat completion call before writing any code.
2. Decide the widget build approach: a small bundled JS file (via esbuild or Vite in "library mode") that a tenant loads with a `<script>` tag — not a full React app shipped to every visitor's browser. Keep it lean.
3. `npm init -y` in the backend, set `"type": "module"`.
4. Scaffold two separate frontend pieces from the start (don't mix them):
   - `dashboard/` — the full React app agents/admins log into
   - `widget/` — the tiny embeddable chat bubble script

### Folder structure
```
hivedesk/
├── server/
│   ├── src/
│   │   ├── server.js
│   │   ├── routes/
│   │   │   ├── auth.js              # agent signup/login (per tenant)
│   │   │   ├── tenants.js           # tenant settings, widget config
│   │   │   ├── conversations.js     # list/get conversations, takeover
│   │   │   ├── knowledgeBase.js     # FAQ/KB entries per tenant
│   │   │   └── widgetAuth.js        # lightweight public "start session" endpoint
│   │   ├── plugins/
│   │   │   ├── authenticate.js      # JWT auth for agents
│   │   │   ├── tenantContext.js     # resolves tenant from API key / JWT, attaches to request
│   │   │   └── errorHandler.js
│   │   ├── realtime/
│   │   │   └── socket.js            # Socket.io, tenant-scoped rooms
│   │   ├── ai/
│   │   │   ├── aiClient.js          # LLM API wrapper
│   │   │   └── responder.js         # decides: AI answer vs handoff
│   │   ├── jobs/
│   │   │   └── analyticsRollup.js   # background job, daily/hourly stats
│   │   ├── cache/
│   │   │   └── redisClient.js
│   │   ├── lib/
│   │   │   └── prisma.js
│   │   ├── schemas/                 # zod schemas
│   │   └── utils/
│   │       └── logger.js
│   ├── prisma/
│   │   └── schema.prisma
│   ├── Dockerfile
│   └── package.json
├── dashboard/                        # React admin/agent app
│   └── src/...
├── widget/                           # embeddable chat widget (small bundle)
│   └── src/...
├── docker-compose.yml
└── README.md
```

### Todos
- [ ] LLM API key obtained, one manual test call made (curl or a tiny script) — confirm you understand the request/response shape
- [ ] Backend, dashboard, and widget scaffolded as separate projects (not one tangled app)
- [ ] `docker-compose.yml`: Postgres + Redis running
- [ ] `.env` with `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `LLM_API_KEY`

**Checkpoint:** All three projects (`server`, `dashboard`, `widget`) run independently (even if empty/placeholder) and `docker compose up -d` gives you Postgres + Redis.

---

## Phase 1 — Multi-Tenant Database Schema & Auth

This is the conceptual heart of the whole project. Get this right before building anything else.

### Steps
1. Design the schema so **every tenant-owned table has a `tenantId` column**, and every query is scoped by it. This is the core discipline of multi-tenancy — there is no "forgetting" to filter by tenant.
2. Models: `Tenant`, `Agent` (belongs to a Tenant), `Conversation` (belongs to a Tenant), `Message` (belongs to a Conversation), `KnowledgeBaseEntry` (belongs to a Tenant).
3. Two different "identities" exist in this system — keep them conceptually separate:
   - **Agents** log in with email/password → JWT (like your previous projects)
   - **Widget visitors** don't log in at all — they're identified by a tenant's public API key (embedded in the widget script) plus a generated anonymous session id
4. Build a `tenantContext` plugin: given a request (JWT for agents, API key for widget calls), resolve which tenant it belongs to and attach `request.tenantId`. Every subsequent route trusts this and only this — never a `tenantId` read from the request body.

### Todos
- [ ] `prisma/schema.prisma`: `Tenant`, `Agent`, `Conversation`, `Message`, `KnowledgeBaseEntry` — all tenant-owned models carry `tenantId`
- [ ] `Tenant` model includes a public `widgetApiKey` (safe to expose in embedded scripts) and separate internal settings
- [ ] `POST /auth/signup` — creates a Tenant + first Agent together (onboarding flow)
- [ ] `POST /auth/login` — agent login, JWT includes `tenantId` in the payload
- [ ] `tenantContext` plugin: resolves tenant from JWT (agent routes) or `widgetApiKey` header (widget routes)
- [ ] Every Prisma query in every route goes through a helper that force-injects `where: { tenantId }` — never trust a client-supplied tenant id anywhere

**Checkpoint:** Create two tenants manually, each with an agent. Confirm — deliberately try to fetch Tenant A's conversation using Tenant B's token — and get a 403/404, never real data.

---

## Phase 2 — Core REST: Tenant Settings & Knowledge Base

### Steps
1. Build simple CRUD for a tenant's widget settings (name, welcome message, brand color) and knowledge base entries (question/answer pairs the AI will draw from).
2. This is intentionally the "easy" phase — standard REST CRUD, scoped by tenant, validated with Zod. Good warm-up before the harder real-time/AI phases.

### Todos
- [ ] `GET/PATCH /tenants/me/settings` — widget welcome message, brand color, display name
- [ ] `POST/GET/PATCH/DELETE /knowledge-base` — FAQ entries, scoped to the calling agent's tenant
- [ ] All list endpoints support basic pagination
- [ ] Centralized error handler (same pattern as PitchPulse) — consistent `{ error: { message, code } }` shape

**Checkpoint:** An agent can log in, update their widget's welcome message and color, and add a few FAQ entries — all confirmed isolated per tenant.

---

## Phase 3 — Real-Time Chat Core (Socket.io, Tenant-Scoped Rooms)

### Steps
1. Set up Socket.io. This time, rooms are scoped **per conversation**, and conversations belong to a tenant — so a visitor's socket only ever joins their own conversation's room, never anything else.
2. Widget connects anonymously (no login) using the tenant's public API key, starts a new `Conversation`, gets a `conversationId` back, joins that room.
3. Agent dashboard connects authenticated (JWT), and can join any conversation room **belonging to their own tenant** — join must be tenant-checked server-side, not just trusted from the client.
4. Every message sent (by visitor or agent) is saved to the `Message` table AND broadcast live to everyone in that conversation's room.

### Todos
- [ ] `src/realtime/socket.js`: widget connection flow (`start-conversation` → creates `Conversation`, returns id, joins room)
- [ ] Agent connection flow (`join-conversation` with a conversation id → server verifies it belongs to the agent's tenant before joining)
- [ ] `send-message` event (from either side) → saved to DB, broadcast to the room as `new-message`
- [ ] Disconnect handling — Socket.io's automatic room cleanup (same as PitchPulse), no manual leak-prone registry
- [ ] Minimal test: two plain HTML/JS test pages (one pretending to be the widget, one pretending to be the agent) — confirm messages flow both ways live

**Checkpoint:** Open your "visitor" test page and "agent" test page side by side. Type in one, see it appear instantly in the other. Confirm a second tenant's conversation is completely invisible from the first tenant's agent view.

---

## Phase 4 — AI Auto-Reply & Handoff Logic

The most genuinely new concept in this project.

### Steps
1. When a visitor sends a message, **before** broadcasting it to any human agent, first ask the AI to attempt an answer — using that tenant's knowledge base entries as context (a simple version of what's called "retrieval-augmented generation," though yours can start simple: just include the relevant FAQ text directly in the prompt).
2. The AI response includes some signal of confidence — either the model says explicitly "I don't know" / "I need a human," or you detect this by prompting it to output a structured signal (e.g., asking it to respond with a small JSON flag alongside its answer).
3. If AI is confident → send AI's reply back to the visitor automatically, conversation stays "AI-handled."
4. If AI is not confident → mark the conversation `needsHuman`, notify connected agents (a dashboard notification, or just a visible "unhandled" badge), and stop auto-replying until a human takes over.
5. Once a human agent sends a message in a conversation, that conversation locks into "human-handled" mode — the AI shouldn't butt back in.

### Todos
- [x] `src/ai/aiClient.js`: wraps the LLM API call — `generateReply({ system, history, signal })` (transport only; Gemini `generateContent`)
- [x] Prompt design: `buildSystemPrompt()` injects the tenant's KB entries and forces a single JSON confidence object; `parseConfidence()` is defensive
- [x] `src/ai/responder.js`: the decision logic — call AI, parse confidence signal, either auto-reply or hand off to a human
- [x] `Conversation` model: no new columns — the existing `status` enum + `assignedAgentId` already cover it (see mapping below)
- [x] Once an agent sends any message in a conversation, flip `status` to `AGENT` permanently for that conversation (`src/realtime/socket.js` send-message)
- [x] Handle AI API failures gracefully (timeout, rate limit, malformed response) — per-attempt `AbortController` timeout + bounded retry/backoff in `aiClient`, typed `AiError`; the responder catches everything and hands off rather than leave the visitor hanging

> **Naming:** this doc's `mode = ai / needsHuman / human` is implemented with the
> existing schema — `Conversation.status = AI / WAITING / AGENT` — and this doc's
> `handledByAgentId` is `Conversation.assignedAgentId`. No `mode` column was added.

**Checkpoint:** Ask your test widget a question that's in the knowledge base — AI answers automatically. Ask something completely unrelated — conversation flips to `WAITING`, and your agent test page shows it needs attention.

---

## Phase 5 — Agent Dashboard (React)

### Steps
1. Build the actual dashboard app now that the backend logic is proven via test pages.
2. Login screen → conversation list (filterable: all / needs human / AI-handled / mine) → conversation view with live messages → reply box.
3. Real-time updates in the dashboard: new conversations and new messages should appear live via the same Socket.io connection, not by refreshing/polling.
4. A settings page for widget customization + knowledge base management (wraps Phase 2's endpoints).

### Todos
- [ ] Login page (JWT stored appropriately, e.g. httpOnly cookie or in-memory + refresh strategy — think about this rather than defaulting to localStorage blindly)
- [ ] Conversation list view with status filters and live updates (new conversation appears without refresh)
- [ ] Conversation detail view: message history + live incoming messages + reply input
- [ ] "Take over" button — explicitly claims a `needsHuman` conversation for the current agent
- [ ] Settings page: widget welcome message/color, knowledge base CRUD (reuses Phase 2 endpoints)
- [ ] Basic responsive layout — doesn't need to be fancy, needs to be clean and usable

**Checkpoint:** Log in as an agent, watch a new conversation appear live when your test widget starts one, take it over, and chat back and forth in real time from the actual dashboard UI (not test pages anymore).

---

## Phase 6 — The Embeddable Widget (Real One)

### Steps
1. Build the actual widget as a small, self-contained bundle — a `<script>` tag a tenant pastes on their site, which renders a chat bubble in the corner and expands into a chat window.
2. It must work when dropped into **any** plain HTML page — no assumptions about the host site's build tools, CSS, or frameworks. This is a genuinely different constraint than building a normal React app.
3. Loads the tenant's public `widgetApiKey` from a data attribute on the script tag, connects to your Socket.io server, uses the Phase 3 visitor flow.
4. Pulls the tenant's configured welcome message/brand color from your API on load.

### Todos
- [ ] Widget entry point reads its own `<script>` tag's `data-tenant-key` attribute
- [ ] Renders a floating chat bubble + expandable window, scoped CSS that won't clash with the host site's styles (careful with global selectors)
- [ ] Connects via Socket.io using the visitor flow from Phase 3
- [ ] Fetches and applies tenant branding (welcome message, color) on load
- [ ] Bundled into a single small JS file (esbuild/Vite library mode), tested by dropping the `<script>` tag into a completely separate plain HTML file with no other tooling

**Checkpoint:** Create a bare-bones HTML file (no React, no build tools, just `<html><body>`), drop in your widget's script tag, and have a fully working chat bubble talking to your real backend — proving it's genuinely embeddable, not just "another page in your app."

---

## Phase 7 — Analytics (Background Job)

### Steps
1. Reuse your BullMQ muscle from PitchPulse — a repeatable job that periodically rolls up stats: conversations per day, AI resolution rate (% handled without human takeover), average time-to-human-response.
2. Store rollups in a simple `AnalyticsSnapshot` table (or just compute on-demand for a v1 if you want to keep scope tighter — your call, but note the trade-off).

### Todos
- [ ] `src/jobs/analyticsRollup.js`: BullMQ repeatable job (e.g. hourly), scoped per tenant
- [ ] Compute: total conversations, AI-resolved %, avg first-response time, active agents
- [ ] `GET /analytics/summary` — tenant-scoped, feeds a simple chart/stats view in the dashboard
- [ ] Dashboard: a basic analytics page showing these numbers (a couple of `chart_display` style visuals, nothing elaborate needed)

**Checkpoint:** After a handful of test conversations, the analytics page shows real, correct numbers reflecting what actually happened.

---

## Phase 8 — Error Handling, Resilience & Tenant Isolation Audit

Go back through everything with a specifically adversarial mindset: **try to break tenant isolation.**

### Todos
- [ ] Attempt to access another tenant's conversation by guessing/reusing a conversation id — must fail
- [ ] Attempt to use Tenant A's `widgetApiKey` to read Tenant B's settings — must fail
- [ ] LLM API down/rate-limited → conversation falls back to `needsHuman` cleanly, never crashes, never leaves visitor with silence and no explanation (show a "an agent will be with you shortly" message)
- [ ] Redis down → Socket.io falls back gracefully or logs clearly (note: if you later add the Socket.io Redis adapter for scaling, this matters more — for a single-process v1 it's less critical, but log the dependency clearly)
- [ ] Postgres drops mid-conversation → clean 503s, no crash, reconnects automatically
- [ ] Malformed widget requests (bad/missing API key) → clean 401/403, never a stack trace reaching the visitor's browser

---

## Phase 9 — Dockerize Everything

### Todos
- [ ] `Dockerfile` for the backend (multi-stage build)
- [ ] `docker-compose.yml`: `server`, `postgres`, `redis` — dashboard and widget are built separately (they're static bundles, not long-running services) but document how to build and serve them
- [ ] Migrations run automatically on container start (same pattern as PitchPulse's entrypoint script)
- [ ] README covers: full stack startup, plus a clearly separate "how to build and test the widget standalone" section

**Checkpoint:** Fresh clone, `docker compose up --build`, backend fully functional; dashboard and widget build and run against it correctly.

---

## Phase 10 — Polish & Stretch Goals

### Todos
- [ ] Rate limiting on public widget endpoints specifically (an unauthenticated-ish surface — protect it more carefully than agent routes)
- [ ] Structured logging (pino), same pattern as PitchPulse
- [ ] Tests: at minimum, tenant-isolation tests (the most important tests in this entire project — prove Tenant A can never touch Tenant B's data) plus AI-handoff logic tests
- [ ] Conversation transcript export (a real feature agencies ask for)
- [ ] Typing indicators, read receipts (nice real-time polish, reuses Socket.io events)
- [ ] Stretch: proper RAG — instead of stuffing all KB entries into every prompt, embed them (vector search) and retrieve only the relevant ones. Worth doing only after the simple version works — don't start here.

---

## Definition of Done

A fully running stack where:
1. Two independent tenants can sign up, each fully isolated from the other
2. A tenant customizes their widget (welcome message, branding) and adds knowledge base entries
3. Dropping the widget's script tag into a plain HTML file gives a working chat bubble
4. A visitor's question gets an AI answer when it's in the knowledge base, and cleanly hands off to a human agent (visible live in the dashboard) when it isn't
5. The agent dashboard shows live conversations, lets an agent take over and reply in real time
6. Basic analytics reflect real usage
7. The entire system survives AI API failures, Redis drops, and Postgres drops without crashing or leaking data across tenants

---

## What You Should Walk Away Understanding

- **Multi-tenancy** as a real architectural discipline — not a checkbox, a constant discipline enforced at the schema and query level
- Two different identity models coexisting in one system (authenticated agents vs anonymous widget visitors)
- Practical LLM API integration with a real decision boundary (confident vs not), not just "call the API and show the response"
- Building something genuinely embeddable — constraints totally different from a normal SPA
- Everything from PitchPulse (Socket.io, BullMQ, resilience patterns) applied to a second, different domain — proving those skills transfer, not just memorized for one project
- Why this project maps directly onto what a UAE software agency actually sells to clients — multi-tenant SaaS with AI features bolted on
