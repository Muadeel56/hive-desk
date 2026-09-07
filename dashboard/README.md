# HiveDesk — Agent Dashboard

React SPA where support agents sign in, watch conversations arrive live over
Socket.io, take one over from the AI, and reply in real time. Also wraps the
Phase 2 REST endpoints in a settings UI (widget customization + knowledge base).

Vite + React 19 + react-router-dom v7 + TypeScript. State is React Context +
`useReducer` (no Redux). One app-scoped Socket.io connection.

## Run

```bash
# 1. Start the server (separate terminal, repo root /server)
cd ../server
npm install
npm run seed        # prints seeded agent logins + widget API keys
npm run dev         # http://localhost:3000

# 2. Start the dashboard
cd ../dashboard
npm install
npm run dev         # http://localhost:5173
```

Seeded logins (from `server/prisma/seed.js`):

| Tenant | Email                 | Password      |
| ------ | --------------------- | ------------- |
| A      | `admin@tenant-a.test` | `password123` |
| B      | `admin@tenant-b.test` | `password123` |

To see a conversation appear live, open `server/test/manual/widget.html`, paste
the tenant's `widgetApiKey` (printed by `npm run seed`), connect, and start a
conversation.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint
- `npm run preview` — serve the production build

## Environment

| Var            | Default                 | Purpose                                        |
| -------------- | ----------------------- | --------------------------------------------- |
| `VITE_API_URL` | `http://localhost:3000` | Base URL for both REST calls and the socket.  |

Copy `.env.example` to `.env` to override. The server must send CORS headers for
this origin — it now registers `@fastify/cors`; set `CORS_ORIGIN` there in
production (e.g. `https://app.example.com`).

## Token storage — why not localStorage

`POST /auth/login` returns a bare JWT in the response body (12h expiry). There is
**no** refresh-token endpoint and **no** auth cookie. Given that:

- The token lives in memory (React context / `AuthProvider`) as the source of
  truth for rendering.
- It is mirrored to **`sessionStorage` only** (`src/lib/token.ts`). That survives
  a page reload but not a tab close, and has a smaller XSS blast radius than
  `localStorage` (not shared across tabs, gone when the tab dies).
- `exp` is decoded client-side (`decodeToken` / `isExpired`, 30s skew). A
  near-expiry token is treated as logged out and a logout is pre-scheduled for
  `exp - skew`.
- Any REST `401` or a permanent Socket.io `connect_error` clears the token,
  disconnects the socket, and redirects to `/login`.

A real refresh-token flow (short-lived access token + httpOnly refresh cookie) is
a deliberate follow-up — it needs a server endpoint that does not exist yet.

## Architecture

```
src/
  lib/api.ts           fetch wrapper: base URL, bearer header, { error } envelope
                       -> typed ApiError, 401 handler
  lib/token.ts         sessionStorage token + client-side JWT decode/expiry
  lib/time.ts          relative-time helpers
  realtime/socket.ts   single io() instance; connectSocket/disconnectSocket,
                       subscribe(), emit() (ack as promise), status store
  auth/                AuthProvider (context), RequireAuth (route guard)
  state/conversationsReducer.ts   list = "patch in place + re-sort" on every event
  layout/AppLayout     responsive sidebar/topbar + "reconnecting…" banner
  pages/Login, ConversationsView (+ detail Outlet), ConversationDetail, Settings
```

Live events consumed (all Socket.io, no polling):

| Event                     | Effect on the UI                                              |
| ------------------------- | ------------------------------------------------------------ |
| `conversation-created`    | prepend to the list if it matches the active filter          |
| `conversation-needs-human`| flag the row + toast; flip it to WAITING                     |
| `conversation-updated`    | patch status / assignee in place, re-sort, re-filter         |
| `new-message`             | list: bump `updatedAt` + re-sort. detail: append (dedupe id) |
| `ai-typing`               | transient "AI is typing…" in the open conversation           |

Agent replies go out via the `send-message` socket event (optimistic append,
reconciled against the echoed `new-message` by id). "Take over" calls
`POST /conversations/:id/takeover`.

## Follow-ups / out of scope

- Refresh-token infrastructure (see above).
- Analytics page (Phase 7) and the embeddable widget (Phase 6).
- Multi-agent presence / assignment beyond "take over"; agent-side read receipts
  and typing indicators.
- `oxlint` emits a few `react(set-state-in-effect)` warnings on the standard
  fetch-on-mount effects; they are benign (`npm run lint` still exits 0).
