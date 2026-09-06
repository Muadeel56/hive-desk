# HiveDesk widget

Embeddable chat bubble. Builds to a single self-contained IIFE bundle
(`dist/hivedesk-widget.js`) that a tenant drops onto any plain HTML page:

```html
<script src="https://your-cdn/hivedesk-widget.js" data-api-key="pk_live_xxx"></script>
```

`data-api-key` is the tenant's public `widgetApiKey`. `data-api-url` (optional)
overrides the API base, default `http://localhost:3000`.

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
genuinely embeddable. Current gzipped size is noted at the top of `src/index.js`
(ceiling: 50 KB).
