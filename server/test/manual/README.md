# Manual real-time chat test pages

Throwaway pages for eyeballing the Phase 3 Socket.io flow. Not part of `npm test`.

## 1. Start the stack

```bash
docker compose up -d                 # Postgres + Redis
cd server
cp .env.example .env                 # if you haven't already
npx prisma migrate deploy
npm run dev                          # server on http://localhost:3000
```

## 2. Get a widget key + an agent JWT

```bash
curl -s -X POST http://localhost:3000/auth/signup \
  -H 'content-type: application/json' \
  -d '{"tenantName":"Manual Test","agentEmail":"me@test.local","agentPassword":"password123","agentName":"Me"}'
```

The response contains:

- `token` — the agent JWT (paste into **agent.html**)
- `tenant.widgetApiKey` — the public widget key (paste into **widget.html**)

(Use `POST /auth/login` with the same email/password later to mint a fresh token.)

## 3. Open both pages side by side

Open `widget.html` and `agent.html` directly from disk (`file://` is fine — the
server allows `origin: '*'` by default via `SOCKET_CORS_ORIGIN`).

1. **widget.html** — paste the widget API key → **Connect** → **Start conversation**.
   Copy the `conversationId` it shows.
2. **agent.html** — paste the JWT and that `conversationId` → **Connect** → **Join**.
3. Type in either page and press Enter. Messages appear live in the other page,
   both directions. Every delivered message is also written to the `Message`
   table (`role` = `VISITOR` or `AGENT`).

A JWT for a *different* tenant will fail **Join** with `NOT_FOUND` and receive no
messages — tenant isolation is enforced server-side.

## 4. Phase 4 checkpoint — AI auto-reply & human handoff

Add a couple of knowledge-base entries first (Bearer = the `token` from step 2):

```bash
curl -s -X POST http://localhost:3000/knowledge-base \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"What are your opening hours?","answer":"We are open 9am–5pm, Monday to Friday."}'
```

With `LLM_API_KEY` set in `server/.env`, open `widget.html` and `agent.html` side by
side. The agent page no longer needs to **Join** a specific conversation to see
handoffs — on connect it auto-joins its tenant room and listens for
`conversation-needs-human` / `conversation-updated`.

- **In-KB question** (e.g. "what time do you open?") → the AI answers automatically in
  the widget (purple `AI` line), the conversation stays AI-handled, and the agent page
  shows no notification.
- **Off-topic question** ("do you sell dog food?", "I want to talk to a person") → the
  conversation flips to `WAITING`, the agent page logs `⚠ NEEDS HUMAN` and shows the
  banner, and the visitor sees "Thanks — an agent will be with you shortly."
- **Agent replies** in that `WAITING` conversation (Join it, then type) → it locks to
  `AGENT` permanently (`conversation-updated` clears the banner); further visitor
  messages get **no** AI reply.
- **No `LLM_API_KEY`** (or `LLM_API_URL` pointed at a dead host) → every visitor
  message hands off cleanly and immediately — no crash, no silent visitor.
