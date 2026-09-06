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
