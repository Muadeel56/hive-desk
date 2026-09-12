# HiveDesk widget

Embeddable chat bubble. Builds to a single self-contained IIFE bundle
(`dist/hivedesk-widget.js`, socket.io-client included) that a tenant drops onto
any plain HTML page:

```html
<script src="https://your-cdn/hivedesk-widget.js" data-tenant-key="pk_live_xxx"></script>
```

`data-tenant-key` is the tenant's public `widgetApiKey` (the legacy
`data-api-key` still works as an alias). `data-api-url` (optional) overrides the
API base, default `http://localhost:3000`.

On load the widget:

- fetches branding (`displayName`, `welcomeMessage`, `brandColor`) from
  `GET /widget/config`, falling back to sensible defaults if that call fails;
- renders a corner bubble + chat window inside a **Shadow DOM**, so widget CSS
  and host-page CSS can't affect each other;
- connects over Socket.io with the Phase 3 visitor flow, persisting the session
  in `localStorage` so a reload resumes the same conversation
  (`window.HiveDeskWidget.open()` / `.close()` toggle it programmatically).

## Commands

```bash
npm install
npm run dev      # http://localhost:5173 — loads src/index.js directly
npm run build    # -> dist/hivedesk-widget.js
npm run size     # gzipped byte count of the built bundle
```

## Standalone test

```bash
npm run build
npx serve .      # then open http://localhost:3000/demo.html
# or just open demo.html via file://
```

`demo.html` is a bare `<html><body>` page with no tooling — proof the bundle is
genuinely embeddable. Set its `data-tenant-key` to a real seeded `widgetApiKey`
(run `npm run seed` in `../server`) before testing against a live backend.
Current gzipped size is noted at the top of `src/index.js` (ceiling: 50 KB).
