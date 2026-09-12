/**
 * HiveDesk embeddable chat widget.
 *
 * One <script> tag a tenant drops onto any plain HTML page:
 *
 *   <script src="https://cdn.example.com/hivedesk-widget.js"
 *           data-tenant-key="pk_live_xxx"></script>
 *
 * On load it reads its own <script> tag's `data-tenant-key` (alias:
 * `data-api-key`), fetches the tenant's branding from `GET /widget/config`,
 * renders a corner bubble in a Shadow DOM (so no styles leak either way), and
 * opens a Socket.io connection using the Phase 3 visitor flow — start /
 * resume a conversation, send messages, receive AI + agent replies live.
 *
 * Bundle size: ~51 KB raw / ~16 KB gzipped  (run `npm run build && npm run size`).
 * Ceiling: 50 KB gzipped. socket.io-client is bundled into this single IIFE —
 * no CDN, no code-split, no runtime dependency outside the file.
 */
import { io } from 'socket.io-client';

(function () {
  'use strict';

  // --- locate our own <script> tag and read config -------------------------
  var currentScript =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[data-tenant-key],script[data-api-key]');
      return all[all.length - 1] || null;
    })();

  var attr = function (name) {
    return currentScript ? currentScript.getAttribute(name) : null;
  };

  // `data-tenant-key` is canonical; `data-api-key` is kept as an alias.
  var tenantKey = attr('data-tenant-key') || attr('data-api-key');
  var apiUrl = attr('data-api-url') || 'http://localhost:3000';
  apiUrl = apiUrl.replace(/\/+$/, '');

  if (!tenantKey) {
    console.error(
      '[HiveDesk] missing data-tenant-key on the widget <script> tag — not mounting.',
    );
    return;
  }

  if (window.__hivedeskWidgetMounted) return;
  window.__hivedeskWidgetMounted = true;

  // --- fallbacks used until (or if) branding fetch resolves ----------------
  var FALLBACK = {
    displayName: 'Chat',
    welcomeMessage: 'Hi! How can we help?',
    brandColor: '#2563eb',
  };
  var branding = {
    displayName: FALLBACK.displayName,
    welcomeMessage: FALLBACK.welcomeMessage,
    brandColor: FALLBACK.brandColor,
  };

  var STORAGE_KEY = 'hivedesk:session:' + tenantKey;

  // --- safe localStorage (private mode / disabled storage throws) ----------
  function loadSession() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.conversationId && parsed.sessionId) return parsed;
      return null;
    } catch (e) {
      return null;
    }
  }
  function saveSession(data) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      /* non-fatal — resume just won't survive this reload */
    }
  }
  function clearSession() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // --- isolated mount point + Shadow DOM ----------------------------------
  var root = document.createElement('div');
  root.id = 'hivedesk-widget-root';
  // Only positioning lives in the light DOM; everything visual is in the shadow.
  root.style.cssText =
    'position:fixed;bottom:20px;right:20px;z-index:2147483000;';
  document.body.appendChild(root);

  var shadow = root.attachShadow ? root.attachShadow({ mode: 'open' }) : root;

  var style = document.createElement('style');
  style.textContent = css();
  shadow.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'hd-root';
  shadow.appendChild(wrap);

  // --- panel -------------------------------------------------------------
  var panel = document.createElement('div');
  panel.className = 'hd-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Chat');
  panel.hidden = true;
  panel.innerHTML =
    '<div class="hd-header">' +
    '<span class="hd-title"></span>' +
    '<span class="hd-status" hidden></span>' +
    '<button type="button" class="hd-close" aria-label="Close chat">&times;</button>' +
    '</div>' +
    '<div class="hd-messages" aria-live="polite"></div>' +
    '<div class="hd-typing" hidden><span></span><span></span><span></span></div>' +
    '<form class="hd-form">' +
    '<input type="text" class="hd-input" autocomplete="off" ' +
    'placeholder="Type a message…" aria-label="Message" disabled />' +
    '<button type="submit" class="hd-send" aria-label="Send" disabled>&#10148;</button>' +
    '</form>';
  wrap.appendChild(panel);

  var titleEl = panel.querySelector('.hd-title');
  var statusEl = panel.querySelector('.hd-status');
  var messagesEl = panel.querySelector('.hd-messages');
  var typingEl = panel.querySelector('.hd-typing');
  var formEl = panel.querySelector('.hd-form');
  var inputEl = panel.querySelector('.hd-input');
  var sendEl = panel.querySelector('.hd-send');
  var closeEl = panel.querySelector('.hd-close');

  // --- bubble ----------------------------------------------------------
  var bubble = document.createElement('button');
  bubble.type = 'button';
  bubble.className = 'hd-bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = iconChat();
  wrap.appendChild(bubble);

  applyBranding();

  // --- open / close --------------------------------------------------
  var isOpen = false;
  function setOpen(next) {
    isOpen = next;
    panel.hidden = !isOpen;
    bubble.innerHTML = isOpen ? iconClose() : iconChat();
    bubble.setAttribute('aria-label', isOpen ? 'Close chat' : 'Open chat');
    if (isOpen) {
      scrollToBottom();
      if (!inputEl.disabled) inputEl.focus();
    }
  }
  bubble.addEventListener('click', function () {
    setOpen(!isOpen);
  });
  closeEl.addEventListener('click', function () {
    setOpen(false);
  });

  // --- branding fetch ------------------------------------------------
  if (window.fetch) {
    window
      .fetch(apiUrl + '/widget/config', {
        headers: { 'x-widget-api-key': tenantKey },
      })
      .then(function (res) {
        if (!res.ok) throw new Error('config ' + res.status);
        return res.json();
      })
      .then(function (cfg) {
        if (cfg && typeof cfg === 'object') {
          if (cfg.displayName) branding.displayName = cfg.displayName;
          if (cfg.welcomeMessage) branding.welcomeMessage = cfg.welcomeMessage;
          if (cfg.brandColor) branding.brandColor = cfg.brandColor;
          applyBranding();
        }
      })
      .catch(function () {
        /* offline / bad key — widget still renders with fallbacks */
      })
      .finally(seedWelcome);
  } else {
    seedWelcome();
  }

  var welcomeSeeded = false;
  function seedWelcome() {
    if (welcomeSeeded) return;
    welcomeSeeded = true;
    // Only show the canned welcome when we don't already have history to hydrate.
    if (!messagesEl.childElementCount) {
      addMessage('AI', branding.welcomeMessage, 'welcome');
    }
  }

  function applyBranding() {
    titleEl.textContent = branding.displayName;
    wrap.style.setProperty('--hd-brand', branding.brandColor);
  }

  // --- transport (Phase 3 visitor flow) ----------------------------
  var conversationId = null;
  var sessionId = null;
  var stored = loadSession();
  if (stored) {
    conversationId = stored.conversationId;
    sessionId = stored.sessionId;
  }

  var seenIds = Object.create(null);
  var pending = []; // optimistic visitor bubbles awaiting their server echo
  var typingTimer = null;

  var socket = io(apiUrl, {
    auth: { widgetApiKey: tenantKey },
    transports: ['websocket'],
  });

  socket.on('connect', function () {
    setStatus(null);
    bootstrapConversation();
  });

  socket.on('disconnect', function () {
    setStatus('Reconnecting…');
    setComposerEnabled(false);
  });

  socket.on('connect_error', function () {
    setStatus('Reconnecting…');
  });

  socket.on('new-message', function (m) {
    if (!m || !m.conversationId || m.conversationId !== conversationId) return;
    hideTyping();
    ingest(m);
  });

  socket.on('ai-typing', function (m) {
    if (!m || m.conversationId !== conversationId) return;
    showTyping();
  });

  function bootstrapConversation() {
    if (conversationId && sessionId) {
      socket.emit(
        'resume-conversation',
        { conversationId: conversationId, sessionId: sessionId },
        function (res) {
          if (res && res.ok) {
            hydrate(res.messages || []);
            setComposerEnabled(true);
          } else {
            // Stale / rejected — drop it and start clean.
            clearSession();
            conversationId = null;
            sessionId = null;
            startConversation();
          }
        },
      );
    } else {
      startConversation();
    }
  }

  function startConversation() {
    socket.emit('start-conversation', {}, function (res) {
      if (res && res.ok) {
        conversationId = res.conversationId;
        sessionId = res.sessionId;
        saveSession({ conversationId: conversationId, sessionId: sessionId });
        setComposerEnabled(true);
      } else {
        setStatus('Unable to connect');
      }
    });
  }

  function hydrate(list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m && m.id) ingest(m);
    }
  }

  // Render a server message, reconciling an optimistic echo when possible.
  function ingest(m) {
    if (seenIds[m.id]) return;
    if (m.role === 'VISITOR') {
      for (var i = 0; i < pending.length; i++) {
        if (pending[i].content === m.content) {
          var adopted = pending.splice(i, 1)[0];
          adopted.el.classList.remove('hd-pending');
          adopted.el.dataset.id = m.id;
          seenIds[m.id] = true;
          return;
        }
      }
    }
    addMessage(m.role, m.content, m.id);
  }

  function addMessage(role, content, id) {
    if (id && seenIds[id]) return;
    if (id) seenIds[id] = true;
    var side = role === 'VISITOR' ? 'out' : 'in';
    var el = document.createElement('div');
    el.className = 'hd-msg hd-' + side;
    if (id) el.dataset.id = id;
    el.textContent = content;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  // --- sending ---------------------------------------------------
  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text || !conversationId || inputEl.disabled) return;
    inputEl.value = '';

    var el = document.createElement('div');
    el.className = 'hd-msg hd-out hd-pending';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
    var entry = { content: text, el: el };
    pending.push(entry);

    socket.emit(
      'send-message',
      { conversationId: conversationId, content: text },
      function (res) {
        if (!res || !res.ok) {
          var idx = pending.indexOf(entry);
          if (idx !== -1) pending.splice(idx, 1);
          el.classList.remove('hd-pending');
          el.classList.add('hd-failed');
          el.title = 'Not delivered';
        }
      },
    );
  });

  // --- typing indicator ---------------------------------------------
  function showTyping() {
    typingEl.hidden = false;
    scrollToBottom();
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(hideTyping, 15000);
  }
  function hideTyping() {
    typingEl.hidden = true;
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  }

  // --- small helpers ----------------------------------------------
  function setStatus(text) {
    if (text) {
      statusEl.textContent = text;
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }
  function setComposerEnabled(on) {
    inputEl.disabled = !on;
    sendEl.disabled = !on;
    if (on && isOpen) inputEl.focus();
  }
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // --- public API ---------------------------------------------
  window.HiveDeskWidget = {
    tenantKey: tenantKey,
    apiKey: tenantKey, // legacy alias
    apiUrl: apiUrl,
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
  };

  // --- inline SVG icons ---------------------------------------
  function iconChat() {
    return (
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.4 ' +
      '8.5 8.5 0 0 1-3.8-.9L3 20l1.3-5.1a8.38 8.38 0 0 1-.8-3.6 8.5 8.5 0 0 ' +
      '1 8.5-8.4 8.38 8.38 0 0 1 8.5 8.2z"/></svg>'
    );
  }
  function iconClose() {
    return (
      '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/></svg>'
    );
  }

  // --- styles (scoped inside the shadow root) ---------------------
  function css() {
    return [
      '.hd-root{all:initial;position:relative;display:flex;flex-direction:column;',
      'align-items:flex-end;',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
      '--hd-brand:#2563eb;}',
      '.hd-root *,.hd-root *::before,.hd-root *::after{box-sizing:border-box;}',

      '.hd-bubble{width:56px;height:56px;border:0;border-radius:50%;cursor:pointer;',
      'background:var(--hd-brand);color:#fff;display:flex;align-items:center;',
      'justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.22);',
      'transition:transform .12s ease;padding:0;}',
      '.hd-bubble:hover{transform:scale(1.06);}',
      '.hd-bubble svg{display:block;}',

      '.hd-panel{width:340px;max-width:calc(100vw - 40px);height:460px;',
      'max-height:calc(100vh - 120px);background:#fff;border-radius:16px;',
      'box-shadow:0 12px 40px rgba(0,0,0,.18);overflow:hidden;margin-bottom:12px;',
      'display:flex;flex-direction:column;}',
      '.hd-panel[hidden]{display:none;}',

      '.hd-header{background:var(--hd-brand);color:#fff;padding:14px 16px;',
      'font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px;}',
      '.hd-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.hd-status{font-weight:400;font-size:12px;opacity:.85;}',
      '.hd-status[hidden]{display:none;}',
      '.hd-close{background:transparent;border:0;color:#fff;cursor:pointer;',
      'font-size:20px;line-height:1;padding:0 2px;opacity:.9;}',
      '.hd-close:hover{opacity:1;}',

      '.hd-messages{flex:1;padding:16px;overflow-y:auto;display:flex;',
      'flex-direction:column;gap:8px;background:#f8fafc;}',
      '.hd-msg{max-width:80%;padding:9px 12px;border-radius:14px;font-size:14px;',
      'line-height:1.45;white-space:pre-wrap;word-wrap:break-word;}',
      '.hd-in{align-self:flex-start;background:#fff;color:#1e293b;',
      'border:1px solid #e2e8f0;border-bottom-left-radius:4px;}',
      '.hd-out{align-self:flex-end;background:var(--hd-brand);color:#fff;',
      'border-bottom-right-radius:4px;}',
      '.hd-pending{opacity:.6;}',
      '.hd-failed{opacity:.6;background:#dc2626;}',

      '.hd-typing{display:flex;gap:4px;padding:4px 20px 10px;background:#f8fafc;}',
      '.hd-typing[hidden]{display:none;}',
      '.hd-typing span{width:7px;height:7px;border-radius:50%;background:#94a3b8;',
      'animation:hd-blink 1.2s infinite ease-in-out both;}',
      '.hd-typing span:nth-child(2){animation-delay:.2s;}',
      '.hd-typing span:nth-child(3){animation-delay:.4s;}',
      '@keyframes hd-blink{0%,80%,100%{opacity:.3;}40%{opacity:1;}}',

      '.hd-form{display:flex;align-items:center;gap:8px;padding:12px 14px;',
      'border-top:1px solid #e2e8f0;background:#fff;}',
      '.hd-input{flex:1;border:1px solid #cbd5e1;border-radius:20px;',
      'padding:9px 14px;font-size:14px;outline:none;color:#1e293b;background:#fff;}',
      '.hd-input:focus{border-color:var(--hd-brand);}',
      '.hd-input:disabled{background:#f1f5f9;}',
      '.hd-send{border:0;border-radius:50%;width:38px;height:38px;flex:none;',
      'cursor:pointer;background:var(--hd-brand);color:#fff;font-size:16px;',
      'line-height:1;}',
      '.hd-send:disabled{opacity:.5;cursor:default;}',

      '@media (max-width:420px){.hd-panel{width:calc(100vw - 32px);}}',
    ].join('');
  }
})();
