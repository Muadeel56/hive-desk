/**
 * HiveDesk embeddable chat widget — Phase 0 placeholder.
 *
 * Bundle size: 2.25 KB raw / 1.2 KB gzipped  (run `npm run build && npm run size`)
 * Target ceiling: 50 KB gzipped. The real widget (Phase 6) adds the chat
 * transport (Socket.io client) and tenant branding fetch.
 *
 * Usage on a host page:
 *   <script src="https://cdn.example.com/hivedesk-widget.js" data-api-key="pk_live_xxx"></script>
 *
 * On load it reads its own <script> tag's `data-api-key`, mounts an isolated
 * container in the corner, and renders a chat bubble that toggles a panel.
 */
(function () {
  'use strict';

  // --- locate our own <script> tag and read config -------------------------
  var currentScript =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[data-api-key]');
      return all[all.length - 1] || null;
    })();

  var apiKey = currentScript ? currentScript.getAttribute('data-api-key') : null;
  var apiUrl =
    (currentScript && currentScript.getAttribute('data-api-url')) || 'http://localhost:3000';

  if (!apiKey) {
    console.error('[HiveDesk] missing data-api-key on the widget <script> tag — not mounting.');
    return;
  }

  if (window.__hivedeskWidgetMounted) return;
  window.__hivedeskWidgetMounted = true;

  // --- isolated mount point ----------------------------------------------------
  var root = document.createElement('div');
  root.id = 'hivedesk-widget-root';
  root.style.cssText =
    'position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:' +
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  document.body.appendChild(root);

  var brandColor = '#2563eb';

  // --- chat panel (hidden until the bubble is clicked) -----------------------
  var panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Chat');
  panel.style.cssText =
    'display:none;width:320px;max-width:calc(100vw - 40px);height:420px;max-height:calc(100vh - 120px);' +
    'background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.18);overflow:hidden;' +
    'margin-bottom:12px;flex-direction:column;';
  panel.innerHTML =
    '<div style="background:' +
    brandColor +
    ';color:#fff;padding:14px 16px;font-weight:600;">Chat with us</div>' +
    '<div style="flex:1;padding:16px;color:#475569;font-size:14px;line-height:1.5;overflow:auto;">' +
    "Hi! 👋 This is a placeholder widget. Real-time chat lands in Phase 6." +
    '</div>' +
    '<div style="padding:12px 16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">' +
    'key: ' +
    apiKey.slice(0, 6) +
    '… · api: ' +
    apiUrl +
    '</div>';

  // --- bubble ----------------------------------------------------------------
  var bubble = document.createElement('button');
  bubble.type = 'button';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.style.cssText =
    'width:56px;height:56px;border:0;border-radius:50%;cursor:pointer;background:' +
    brandColor +
    ';color:#fff;font-size:24px;line-height:56px;box-shadow:0 6px 20px rgba(0,0,0,.22);' +
    'display:block;margin-left:auto;transition:transform .12s ease;';
  bubble.textContent = '💬';
  bubble.onmouseenter = function () {
    bubble.style.transform = 'scale(1.06)';
  };
  bubble.onmouseleave = function () {
    bubble.style.transform = 'scale(1)';
  };

  var open = false;
  bubble.addEventListener('click', function () {
    open = !open;
    panel.style.display = open ? 'flex' : 'none';
    bubble.textContent = open ? '✕' : '💬';
    bubble.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
  });

  root.appendChild(panel);
  root.appendChild(bubble);

  window.HiveDeskWidget = {
    apiKey: apiKey,
    apiUrl: apiUrl,
    open: function () {
      if (!open) bubble.click();
    },
    close: function () {
      if (open) bubble.click();
    },
  };
})();
