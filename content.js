// Chat Exporter — content script
// Injected into Claude.ai, ChatGPT, and Perplexity to scrape conversations
// and expose a chrome.runtime.onMessage API to popup.js.

if (!window.__chatExporterLoaded) {
  window.__chatExporterLoaded = true;

  // Register the message listener immediately. handleMessage is a function
  // *declaration* so it is hoisted to the top of this IIFE — the listener is
  // live before any const initialisers below have run, which guarantees a PONG
  // is available the instant chrome.scripting.executeScript() resolves.
  chrome.runtime.onMessage.addListener(handleMessage);

// ── Site detection ──────────────────────────────────────────────────────────

  function detectSite() {
    const h = location.hostname;
    if (h.includes('claude.ai')) return 'claude';
    if (h.includes('openai.com') || h.includes('chatgpt.com')) return 'chatgpt';
    if (h.includes('perplexity.ai')) return 'perplexity';
    if (h.includes('gemini.google.com') || h.includes('aistudio.google.com')) return 'gemini';
    if (h.includes('notebooklm.google.com')) return 'notebooklm';
    return null;
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  function formatIsoDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  // ── Claude scraper ──────────────────────────────────────────────────────────

  // Simple rate limiter to prevent API abuse
  const rateLimiter = {
    lastCall: 0,
    minDelay: 100, // 100ms between requests
    
    async wait() {
      const now = Date.now();
      const timeSinceLastCall = now - this.lastCall;
      if (timeSinceLastCall < this.minDelay) {
        await new Promise(resolve => setTimeout(resolve, this.minDelay - timeSinceLastCall));
      }
      this.lastCall = Date.now();
    }
  };

  const claudeScraper = {
    _orgId: null,

    async _getOrgId() {
      if (this._orgId) return this._orgId;
      await rateLimiter.wait();

      const candidates = [
        { url: '/api/organizations',     extract: (d) => Array.isArray(d) ? d[0]?.uuid : d?.organizations?.[0]?.uuid },
        { url: '/api/bootstrap',         extract: (d) => d?.account?.memberships?.[0]?.organization?.uuid || d?.organization?.uuid },
        { url: '/api/auth/current_user', extract: (d) => d?.organization_memberships?.[0]?.organization?.uuid },
      ];

      for (const { url, extract } of candidates) {
        try {
          const resp = await fetch(url, { credentials: 'include' });
          console.log('[ChatExporter] Claude', url, 'status:', resp.status);
          if (!resp.ok) continue;
          const data = await resp.json();
          console.log('[ChatExporter] Claude', url, 'data:', JSON.stringify(data).slice(0, 400));
          const id = extract(data);
          if (id) { this._orgId = id; return id; }
        } catch (e) {
          console.warn('[ChatExporter] Claude endpoint failed:', url, e.message);
        }
      }

      // DOM fallback: extract org ID from cookie or Next.js hydration data
      const orgFromDom =
        document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1] ||
        window?.__NEXT_DATA__?.props?.pageProps?.account?.memberships?.[0]?.organization?.uuid;
      if (orgFromDom) { this._orgId = orgFromDom; return orgFromDom; }

      throw new Error('Claude: could not determine org ID — check console for API response shapes');
    },

    async listThreads() {
      console.log('[ChatExporter] Claude listThreads start');
      const threads = [];

      // ── API path ──────────────────────────────────────────────────────────────
      let orgId = null;
      try {
        orgId = await this._getOrgId();
        console.log('[ChatExporter] Claude orgId:', orgId);
      } catch (e) {
        console.warn('[ChatExporter] Claude _getOrgId failed:', e.message);
      }

      if (orgId) {
        let offset = 0;
        const pageSize = 100;
        let apiSuccess = false;

        while (true) {
          await rateLimiter.wait();

          // Try the primary endpoint, then the alternate path on first failure
          const primaryUrl = `/api/organizations/${orgId}/chat_conversations?limit=${pageSize}&offset=${offset}&sort_field=updated_at&sort_order=desc`;
          const alternateUrl = `/api/organizations/${orgId}/conversations?limit=${pageSize}&offset=${offset}&sort_field=updated_at&sort_order=desc`;

          let resp = await fetch(primaryUrl, { credentials: 'include' });
          console.log('[ChatExporter] Claude conversations primary status:', resp.status);

          if (!resp.ok) {
            resp = await fetch(alternateUrl, { credentials: 'include' });
            console.log('[ChatExporter] Claude conversations alternate status:', resp.status);
          }

          if (!resp.ok) {
            console.warn('[ChatExporter] Claude both conversation endpoints failed — falling back to DOM');
            break;
          }

          const data = await resp.json();
          console.log('[ChatExporter] Claude API response:', JSON.stringify(data).slice(0, 300));

          const items = Array.isArray(data) ? data
            : Array.isArray(data.conversations) ? data.conversations
            : Array.isArray(data.chats) ? data.chats
            : [];
          console.log('[ChatExporter] Claude items extracted:', items.length,
            items[0] ? `first keys: ${Object.keys(items[0]).join(', ')}` : '(none)');

          for (const item of items) {
            threads.push({
              id: item.uuid,
              title: item.name || 'Untitled',
              date: formatIsoDate(item.updated_at || item.created_at),
              messageCount: item.chat_messages ? item.chat_messages.length : 0,
            });
          }

          apiSuccess = true;
          if (items.length < pageSize) break;
          offset += pageSize;
        }

        if (apiSuccess) {
          console.log('[ChatExporter] Claude total threads fetched via API:', threads.length);
          return { threads };
        }
      }

      // ── DOM fallback ──────────────────────────────────────────────────────────
      const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
      console.log('[ChatExporter] Claude DOM fallback: found', links.length, 'links');
      if (links[0]) console.log('[ChatExporter] Claude first link:', links[0].outerHTML);

      const seen = new Set();
      for (const link of links) {
        const match = link.getAttribute('href')?.match(/\/chat\/([^/?#]+)/);
        if (!match) continue;
        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const title = link.querySelector('[class*="truncat"], span, p')?.innerText?.trim()
          || link.innerText?.trim()
          || 'Untitled';
        threads.push({ id, title, date: '', messageCount: 0, href: link.getAttribute('href') });
      }

      console.log('[ChatExporter] Claude total threads fetched via DOM:', threads.length);
      return { threads };
    },

    async scrapeThread(id) {
      const orgId = await this._getOrgId();
      await rateLimiter.wait();
      const url = `/api/organizations/${orgId}/chat_conversations/${id}`;
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`Claude: failed to fetch conversation ${id} (${resp.status})`);
      const data = await resp.json();

      const messages = (data.chat_messages || []).map(msg => ({
        role: msg.sender === 'human' ? 'user' : 'assistant',
        content: msg.text || '',
      })).filter(m => m.content.trim());

      return {
        id: data.uuid,
        title: data.name || 'Untitled',
        date: formatIsoDate(data.updated_at || data.created_at),
        messages,
      };
    },

    scrapeCurrentThread() {
      const messages = [];
      const els = document.querySelectorAll('[data-testid="user-message"], .font-claude-message');

      if (els.length === 0) {
        // fallback: broader class selectors
        document.querySelectorAll('[class*="human-bubble"], [class*="claude-message"]').forEach(el => {
          const isUser = /human/i.test(el.className);
          const text = el.innerText.trim();
          if (text) messages.push({ role: isUser ? 'user' : 'assistant', content: text });
        });
      } else {
        els.forEach(el => {
          const isUser = el.matches('[data-testid="user-message"]');
          const text = el.innerText.trim();
          if (text) messages.push({ role: isUser ? 'user' : 'assistant', content: text });
        });
      }

      if (!messages.length) throw new Error('No messages found on page');

      return {
        id: 'current',
        title: document.title || 'Current Chat',
        date: formatIsoDate(new Date().toISOString()),
        messages,
      };
    },
  };

  // ── ChatGPT scraper ─────────────────────────────────────────────────────────

  const chatgptScraper = {
    async listThreads() {
      const threads = [];
      const seen = new Set();

      // Find the scrollable panel that actually holds conversation links, not the top nav
      const sidebar =
        document.querySelector('nav[aria-label="Chat history"]') ||
        document.querySelector('[data-testid="conversation-list"]') ||
        (() => Array.from(document.querySelectorAll('nav, [role="navigation"], main > div'))
          .find(el => el.querySelector('a[href^="/c/"], a[href^="/g/"]')))();

      console.log('[ChatExporter] ChatGPT sidebar found:', !!sidebar, sidebar?.tagName, sidebar?.className?.slice(0, 80));
      if (!sidebar) {
        document.querySelectorAll('nav').forEach((n, i) =>
          console.log('[ChatExporter] nav[' + i + ']:', n.getAttribute('aria-label'), n.className?.slice(0, 80))
        );
      }

      // Scroll to trigger lazy-loading of older conversations
      if (sidebar) {
        const countLinks = () => document.querySelectorAll('a[href^="/c/"], a[href^="/g/"]').length;
        let previousCount = countLinks();
        let stableCount = 0;
        let attempts = 0;
        while (attempts < 30) {
          sidebar.scrollTop = sidebar.scrollHeight;
          await new Promise(r => setTimeout(r, 500));
          const currentCount = countLinks();
          console.log('[ChatExporter] ChatGPT scroll attempt', attempts, '— links:', currentCount);
          if (currentCount === previousCount) {
            if (++stableCount >= 2) break;
          } else {
            stableCount = 0;
            previousCount = currentCount;
          }
          attempts++;
        }
        sidebar.scrollTop = 0;
      }

      // Try selectors in priority order — /c/ first, then /g/, then data-testid variants
      const selectors = [
        'a[href^="/c/"]',
        'a[href^="/g/"]',
        '[data-testid="conversation-list-item"] a',
        '[data-testid*="conversation"] a[href]',
        'li a[href*="/c/"]',
      ];

      let links = [];
      for (const sel of selectors) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) {
          console.log('[ChatExporter] ChatGPT selector hit:', sel, 'count:', found.length);
          links = found;
          break;
        }
      }

      if (links.length === 0) {
        const sample = Array.from(document.querySelectorAll('a[href]')).slice(0, 20);
        console.log('[ChatExporter] ChatGPT no links found. Sample hrefs:', sample.map(a => a.getAttribute('href')));
      } else {
        console.log('[ChatExporter] ChatGPT first link outerHTML:', links[0].outerHTML);
      }

      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/[cg]\/([^/?#\s]+)/);
        const id = match?.[1]?.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);

        if (threads.length === 0) {
          const li = link.closest('li, [class*="item"], [class*="group"]');
          console.log('[ChatExporter] ChatGPT first link outerHTML:', link.outerHTML);
          console.log('[ChatExporter] ChatGPT first li outerHTML:', li?.outerHTML?.slice(0, 600));
          let sib = li?.previousElementSibling;
          let sibCount = 0;
          while (sib && sibCount < 5) {
            console.log('[ChatExporter] ChatGPT prev sibling:', sib.outerHTML?.slice(0, 200));
            sib = sib.previousElementSibling;
            sibCount++;
          }
        }

        const title = link.querySelector('div, span, p')?.innerText?.trim()
          || link.innerText?.trim()
          || link.textContent?.trim()
          || 'Untitled';

        // ChatGPT groups chats under text headers: "Today", "Yesterday",
        // "Previous 7 Days", "Previous 30 Days", month names
        // Walk up the DOM then backwards through siblings to find the header
        let date = '';
        // Start at the link itself so we catch headers that are direct siblings
        // of the link, not just siblings of ancestor containers.
        let searchEl = link.closest('li') || link;
        let attempts = 0;
        while (searchEl && attempts < 8) {
          let sib = searchEl.previousElementSibling;
          while (sib) {
            const txt = sib.innerText?.trim();
            if (txt && txt.length < 60 && (
              txt.startsWith('Today') || txt.startsWith('Yesterday') ||
              txt.includes('Days') || txt.includes('January') ||
              txt.includes('February') || txt.includes('March') ||
              txt.includes('April') || txt.includes('May') ||
              txt.includes('June') || txt.includes('July') ||
              txt.includes('August') || txt.includes('September') ||
              txt.includes('October') || txt.includes('November') ||
              txt.includes('December')
            )) {
              date = txt;
              break;
            }
            sib = sib.previousElementSibling;
          }
          if (date) break;
          searchEl = searchEl.parentElement;
          attempts++;
        }

        threads.push({ id, title, date, messageCount: 0, href });
      }

      // Enrich thread dates via the conversations API — more reliable than DOM section headers
      try {
        const token = await this._getAccessToken();
        const resp = await fetch('/backend-api/conversations?offset=0&limit=100&order=updated', {
          credentials: 'include',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          const dateMap = {};
          for (const item of (data.items || [])) {
            const ts = item.update_time || item.create_time;
            if (item.id && ts) dateMap[item.id] = new Date(ts * 1000).toISOString();
          }
          for (const t of threads) {
            if (dateMap[t.id]) t.date = formatIsoDate(dateMap[t.id]);
          }
          console.log('[ChatExporter] ChatGPT API enriched dates for', Object.keys(dateMap).length, 'conversations');
        } else {
          console.warn('[ChatExporter] ChatGPT conversations API returned', resp.status, '— dates will fall back to DOM section headers');
        }
      } catch (e) {
        console.warn('[ChatExporter] ChatGPT API date enrichment failed:', e.message);
      }

      console.log('[ChatExporter] ChatGPT threads collected:', threads.length);
      return { threads };
    },

    _accessToken: null,

    async _getAccessToken() {
      if (this._accessToken) return this._accessToken;
      const resp = await fetch('/api/auth/session', { credentials: 'include' });
      console.log('[Chatavio] session fetch status:', resp.status);
      if (!resp.ok) {
        const text = await resp.text();
        console.log('[Chatavio] session error body:', text.slice(0, 200));
        throw new Error(`ChatGPT: failed to fetch session (${resp.status})`);
      }
      const data = await resp.json();
      if (!data.accessToken) throw new Error('ChatGPT: no accessToken in session response');
      this._accessToken = data.accessToken;
      return this._accessToken;
    },

    async scrapeThread(id) {
      const token = await this._getAccessToken();
      const url = `/backend-api/conversation/${id}`;
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      console.log('[Chatavio] conversation fetch status:', resp.status, url);
      if (!resp.ok) {
        const text = await resp.text();
        console.log('[Chatavio] conversation error body:', text.slice(0, 200));
        throw new Error(`ChatGPT: failed to fetch conversation ${id} (${resp.status})`);
      }
      const data = await resp.json();

      // Walk backwards from current_node using parent pointers
      const mapping = data.mapping || {};
      const path = [];
      let nodeId = data.current_node;

      while (nodeId && mapping[nodeId]) {
        path.push(nodeId);
        nodeId = mapping[nodeId].parent;
      }

      path.reverse();

      const messages = [];
      for (const nid of path) {
        const node = mapping[nid];
        if (!node || !node.message) continue;
        const msg = node.message;
        const role = msg.author && msg.author.role;
        if (!role || role === 'system' || role === 'tool') continue;
        const parts = (msg.content && msg.content.parts) || [];
        const text = parts.filter(p => typeof p === 'string').join('').trim();
        if (!text) continue;
        messages.push({ role: role === 'user' ? 'user' : 'assistant', content: text });
      }

      return {
        id,
        title: data.title || 'Untitled',
        date: formatIsoDate(data.create_time ? new Date(data.create_time * 1000).toISOString() : null),
        messages,
      };
    },

    _waitForHydration(timeoutMs = 10_000) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        function check() {
          if (document.querySelector('[data-message-author-role]') || Date.now() >= deadline) {
            resolve();
          } else {
            setTimeout(check, 400);
          }
        }
        check();
      });
    },

    scrapeCurrentThread() {
      const messages = [];
      const els = document.querySelectorAll('[data-message-author-role]');

      els.forEach(el => {
        const role = el.getAttribute('data-message-author-role');
        if (!role || role === 'system' || role === 'tool') return;
        const text = el.innerText.trim();
        if (text) messages.push({ role: role === 'user' ? 'user' : 'assistant', content: text });
      });

      if (!messages.length) throw new Error('No messages found on page');

      return {
        id: 'current',
        title: document.title || 'Current Chat',
        date: formatIsoDate(new Date().toISOString()),
        messages,
      };
    },
  };

  // ── Perplexity scraper ──────────────────────────────────────────────────────

  const perplexityScraper = {
    _stripCitations(text) {
      return text
        // Remove inline citation markers like [1] [1,2] [1, 2, 3]
        .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
        // Remove "example.com +2" style source references
        .replace(/[\w.-]+\.[a-z]{2,6}\s*\+\d+/g, '')
        // Remove bare URLs
        .replace(/https?:\/\/\S+/g, '')
        // Remove footnote lines like "[1] Some source"
        .replace(/^\[\d+\].*$/gm, '')
        // Normalize multiple blank lines
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    _mergeConsecutive(messages) {
      const merged = [];
      for (const msg of messages) {
        if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
          merged[merged.length - 1].content += '\n\n' + msg.content;
        } else {
          merged.push({ ...msg });
        }
      }
      return merged;
    },

    _extractFromDocument(doc) {
      const messages = [];

      const queryEls = doc.querySelectorAll(
        '[data-testid="query-text"], h1[class*="query"], [class*="queryText"], [class*="QueryText"]'
      );
      const answerEls = doc.querySelectorAll(
        '[class*="prose"], [class*="answer"], [class*="Answer"], [class*="markdown"]'
      );

      const maxPairs = Math.max(queryEls.length, answerEls.length);

      for (let i = 0; i < maxPairs; i++) {
        if (queryEls[i]) {
          const text = queryEls[i].innerText ? queryEls[i].innerText.trim() : queryEls[i].textContent.trim();
          if (text) messages.push({ role: 'user', content: text });
        }
        if (answerEls[i]) {
          const raw = answerEls[i].innerText ? answerEls[i].innerText.trim() : answerEls[i].textContent.trim();
          const text = this._stripCitations(raw);
          if (text) messages.push({ role: 'assistant', content: text });
        }
      }

      return this._mergeConsecutive(messages);
    },

    async listThreads() {
      const sidebar = document.querySelector(
        'nav, [class*="sidebar"], [class*="Sidebar"], [class*="history"], [class*="History"]'
      );

      // Report immediately visible threads before scrolling so the popup shows
      // something right away rather than waiting for the first scroll iteration.
      const initialCount = document.querySelectorAll('a[href*="/search/"]').length;
      if (initialCount > 0) {
        chrome.runtime.sendMessage({ action: 'THREAD_COUNT_UPDATE', count: initialCount }).catch(() => {});
      }

      if (sidebar) {
        let previousCount = initialCount;
        let stableCount = 0;
        let attempts = 0;
        let lastScrollHeight = 0;

        while (attempts < 15) {
          sidebar.scrollTo({ top: sidebar.scrollHeight, behavior: 'instant' });
          if (sidebar.scrollHeight === lastScrollHeight) {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
          }
          lastScrollHeight = sidebar.scrollHeight;

          await new Promise(r => setTimeout(r, 400));

          const currentCount = sidebar.querySelectorAll('a[href*="/search/"]').length;
          chrome.runtime.sendMessage({ action: 'THREAD_COUNT_UPDATE', count: currentCount }).catch(() => {});

          if (currentCount === previousCount) {
            stableCount++;
            if (stableCount >= 2) break;
          } else {
            stableCount = 0;
            previousCount = currentCount;
          }

          attempts++;
        }

        sidebar.scrollTo({ top: 0, behavior: 'instant' });
      }

      const seen = new Set();
      const threads = [];

      // Re-query after scroll so any newly rendered links are included
      const links = Array.from(document.querySelectorAll('a[href*="/search/"], a[href*="/collections/"]'));

      const titleSelectors = [
        '[class*="truncat"]', '[class*="ellipsis"]', '[class*="label"]',
        'p', 'span', 'div[class*="title"]', 'div[class*="Title"]',
      ];

      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);

        const searchMatch = href.match(/\/search\/([^/?#]+)/);
        const collectionMatch = href.match(/\/collections\/([^/?#]+)/);
        const id = (searchMatch && searchMatch[1]) || (collectionMatch && collectionMatch[1]);
        if (!id) continue;

        if (threads.length === 0) {
          const parent = link.closest('li, [class*="item"], [class*="thread"], [class*="row"]');
          console.log('[ChatExporter] Perplexity first link outerHTML:', link.outerHTML);
          console.log('[ChatExporter] Perplexity first parent outerHTML:', parent?.outerHTML?.slice(0, 600));
        }

        // Walk: the link itself, its parent, then the closest item/li ancestor
        let title = '';
        const itemAncestor = link.closest('[class*="item"], [class*="thread"], li');
        const containers = [link, link.parentElement, itemAncestor].filter(Boolean);
        outer: for (const container of containers) {
          for (const sel of titleSelectors) {
            const el = container.querySelector(sel);
            if (el) {
              const text = (el.innerText || el.textContent || '').trim();
              if (text) { title = text; break outer; }
            }
          }
        }
        if (!title) title = (link.innerText || link.textContent || '').trim() || 'Untitled';

        threads.push({ id, title, date: '', messageCount: 0, href });
      }

      return { threads };
    },

    async scrapeThread() {
      // Perplexity is a CSR Next.js app — raw HTML fetching yields an empty shell.
      // Bulk export opens each thread in a real tab (handled by popup.js).
      throw new Error('Perplexity bulk export must be driven by popup.js via tab navigation.');
    },

    // Polls this page's live DOM until Perplexity's React tree has hydrated.
    // Used when a background tab is opened specifically for bulk export.
    _waitForHydration(timeoutMs = 5_000) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        function check() {
          const found = document.querySelector(
            '[class*="prose"], [class*="answer"], [class*="Answer"], [class*="markdown"],' +
            '[data-testid="query-text"], [class*="queryText"], [class*="QueryText"]'
          );
          if (found || Date.now() >= deadline) {
            resolve();
          } else {
            setTimeout(check, 400);
          }
        }
        check();
      });
    },

    scrapeCurrentThread() {
      const messages = this._extractFromDocument(document);
      if (!messages.length) throw new Error('No messages found on page');

      const title = (messages.find(m => m.role === 'user')?.content?.split('\n')[0]) ||
        document.title ||
        'Current Chat';

      return {
        id: 'current',
        title,
        date: formatIsoDate(new Date().toISOString()),
        messages,
      };
    },
  };

  // ── Gemini scraper ───────────────────────────────────────────────────────────

  const geminiScraper = {
    async listThreads() {
      const threads = [];
      const seen = new Set();

      // Expand the sidebar by clicking "Show more" until all threads are loaded
      let attempts = 0;
      while (attempts < 30) {
        const btn = document.querySelector('button[data-test-id="show-more-button"]');
        if (!btn) break;
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        attempts++;
      }

      // Items are div[role="button"] or <a> elements, both carry data-test-id="conversation"
      const items = Array.from(document.querySelectorAll('[data-test-id="conversation"]'));
      console.log('[ChatExporter] Gemini first item outerHTML:', items[0]?.outerHTML);

      for (const item of items) {
        // Use item.href (always absolute) so relative paths like /app/abc are normalised.
        // Only accept hrefs that contain /app/ — other gemini.google.com links (e.g. the
        // current page root) are not conversation links.
        let id = null;
        let fullHref = '';
        const absoluteHref = item.href || '';
        if (absoluteHref.includes('/app/')) {
          const hrefMatch = absoluteHref.match(/\/app\/([^/?#\s]+)/);
          if (hrefMatch) {
            id = hrefMatch[1];
            fullHref = absoluteHref;
          }
        }
        if (!id) {
          const jslog = item.getAttribute('jslog') || '';
          // jslog encodes the chat ID in a position-encoded metadata array
          const jslogMatch = jslog.match(/BardVeMetadataKey:\[(?:[^,\]]*?,){7}\s*\["(?:c_)?([a-zA-Z0-9]+)"/);
          if (jslogMatch) {
            id = jslogMatch[1];
            fullHref = `https://gemini.google.com/app/${id}`;
          }
        }
        if (!id || seen.has(id)) continue;
        seen.add(id);

        if (threads.length === 0) {
          console.log('[ChatExporter] Gemini first item outerHTML:', item.outerHTML);
          const parent = item.closest('li, mat-list-item, [class*="item"], [class*="conversation"]');
          console.log('[ChatExporter] Gemini first parent outerHTML:', parent?.outerHTML?.slice(0, 800));
          console.log('[ChatExporter] Gemini parent next sibling:', parent?.nextElementSibling?.outerHTML?.slice(0, 300));
          console.log('[ChatExporter] Gemini parent prev sibling:', parent?.previousElementSibling?.outerHTML?.slice(0, 300));
        }

        // Priority chain: aria-label → title-class child → first non-trivial span/div → innerText
        let title = item.getAttribute('aria-label')?.trim();
        if (!title) title = item.querySelector('[class*="title"], [class*="label"], [class*="name"]')?.textContent?.trim();
        if (!title) {
          for (const child of item.querySelectorAll('span, div')) {
            const t = child.innerText?.trim();
            if (t && t.length > 1 && t.length < 120) { title = t; break; }
          }
        }
        if (!title) title = item.innerText?.trim() || 'Untitled';

        threads.push({ id, title, date: '', messageCount: 0, href: fullHref });
      }

      return { threads };
    },

    async scrapeThread() {
      // Gemini is a CSR SPA — the content script can't navigate between threads.
      // Bulk export opens each thread in a background tab (handled by background.js).
      throw new Error('Gemini bulk export must be driven by background.js via background tab.');
    },

    _waitForHydration(timeoutMs = 10_000) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        function check() {
          if (document.querySelector('model-response') || Date.now() >= deadline) {
            resolve();
          } else {
            setTimeout(check, 400);
          }
        }
        check();
      });
    },

    scrapeCurrentThread() {
      const messages = [];
      const turns = document.querySelectorAll('user-query, model-response');

      for (const el of turns) {
        const isUser = el.tagName.toLowerCase() === 'user-query';
        const role = isUser ? 'user' : 'assistant';

        let text = '';
        if (isUser) {
          // Angular web component — try known sub-selectors in order of specificity
          text = el.querySelector('.query-text-line')?.innerText
              || el.querySelector('div.query-content')?.innerText
              || el.querySelector('.query-text')?.innerText
              || el.innerText;
        } else {
          text = el.querySelector('message-content .markdown')?.innerText
              || el.querySelector('.model-response-text .markdown')?.innerText
              || el.querySelector('message-content')?.innerText
              || el.querySelector('.response-container-content')?.innerText
              || el.innerText;
        }
        text = text?.trim() || '';
        if (text) messages.push({ role, content: text });
      }

      if (!messages.length) throw new Error('No messages found on Gemini page');

      const title = messages.find(m => m.role === 'user')?.content?.split('\n')[0]?.slice(0, 80)
        || document.title
        || 'Gemini Chat';

      return {
        id: location.pathname.match(/\/app\/([^/?#]+)/)?.[1] || 'current',
        title,
        date: formatIsoDate(new Date().toISOString()),
        messages,
      };
    },
  };

  // ── NotebookLM scraper ───────────────────────────────────────────────────────

  const notebookLMScraper = {

    async listThreads() {
      console.log('[ChatExporter] NotebookLM listThreads started');
      const threads = [];
      const seen = new Set();

      // Try API first — NotebookLM may have an internal notebooks endpoint
      try {
        const apiResp = await fetch('/api/notebooks', { credentials: 'include' });
        console.log('[ChatExporter] NotebookLM /api/notebooks status:', apiResp.status);
        if (apiResp.ok) {
          const data = await apiResp.json();
          console.log('[ChatExporter] NotebookLM API response:', JSON.stringify(data).slice(0, 400));
        }
      } catch (e) {
        console.log('[ChatExporter] NotebookLM API not available, falling back to DOM');
      }

      // DOM scrape: find notebook cards on the home/dashboard page.
      // NotebookLM uses Angular Material — try several selector strategies.
      const cardSelectors = [
        '[data-testid="notebook-card"]',
        '[class*="notebook-card"]',
        '[class*="NotebookCard"]',
        'a[href*="notebooklm#"]',
        'a[href*="/notebook/"]',
        '[role="listitem"] a[href]',
        'mat-card a[href]',
      ];

      let cards = [];
      for (const sel of cardSelectors) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) {
          console.log('[ChatExporter] NotebookLM matched selector:', sel, 'count:', found.length);
          cards = found;
          break;
        }
      }

      // Remove cards that live inside a "Featured Notebooks" section.
      // Walk up from each heading that contains "featured" to find the ancestor
      // that contains notebook links, then exclude every card inside it.
      const featuredContainers = Array.from(
        document.querySelectorAll('h1, h2, h3, h4, [class*="section-title"], [class*="sectionTitle"], [class*="section-header"]')
      )
        .filter(el => /featured/i.test(el.innerText || el.textContent || ''))
        .map(el => {
          let node = el.parentElement;
          while (node && node !== document.body) {
            if (node.querySelector('a[href*="/notebook/"]')) return node;
            node = node.parentElement;
          }
          return null;
        })
        .filter(Boolean);

      if (featuredContainers.length) {
        const before = cards.length;
        cards = cards.filter(card => !featuredContainers.some(c => c.contains(card)));
        console.log('[ChatExporter] NotebookLM removed featured notebooks:', before - cards.length, '→', cards.length, 'remaining');
      }

      if (cards[0]) {
        // Log full outerHTML of first 3 cards so we can see the real structure
        cards.slice(0, 3).forEach((card, i) => {
          console.log(`[ChatExporter] NotebookLM card[${i}] outerHTML:`, card.outerHTML);
        });

        const h1s = Array.from(document.querySelectorAll('h1, h2, h3'));
        console.log('[ChatExporter] NotebookLM headings:', h1s.map(h => ({ tag: h.tagName, text: h.innerText?.trim()?.slice(0, 80), class: h.className?.slice(0, 60) })));
      } else {
        console.log('[ChatExporter] NotebookLM no cards found');
        console.log('[ChatExporter] NotebookLM body snippet:', document.body.innerHTML.slice(0, 1000));
      }

      let cardIndex = 0;
      for (const card of cards) {
        if (cardIndex < 2) {
          console.log(`[ChatExporter] NotebookLM card[${cardIndex}] outerHTML:`, card.outerHTML?.slice(0, 600));
        }

        const href = card.href || card.querySelector('a')?.href || '';

        // The link's aria-labelledby points to "project-<uuid>-title"
        // Extract the UUID from the href and look up the title element by ID
        const notebookId = href.match(/\/notebook\/([^/?#\s]+)/)?.[1];
        const id = notebookId || Math.random().toString(36).slice(2);

        if (!id || seen.has(id)) continue;
        seen.add(id);

        let title = 'Untitled Notebook';

        if (notebookId) {
          const titleEl = document.getElementById(`project-${notebookId}-title`);
          if (titleEl) {
            title = titleEl.innerText?.trim() || titleEl.textContent?.trim() || 'Untitled Notebook';
            console.log('[ChatExporter] NotebookLM title found via ID:', title);
          } else {
            // Fallback: parse aria-labelledby attribute and look up each referenced ID
            const labelledBy = card.getAttribute('aria-labelledby') || '';
            const titleId = labelledBy.split(' ').find(refId => refId.endsWith('-title'));
            if (titleId) {
              const el = document.getElementById(titleId);
              title = el?.innerText?.trim() || 'Untitled Notebook';
            }
          }
        }

        const dateCandidates = [
          'time',
          '[datetime]',
          'mat-card-subtitle',
          '[class*="subtitle"]',
          '[class*="modified"]',
          '[class*="updated"]',
          '[class*="date"]',
        ];
        let date = '';
        for (const sel of dateCandidates) {
          const el = card.querySelector(sel);
          const val = el?.getAttribute('datetime') || el?.innerText?.trim() || '';
          if (val) { date = val; break; }
        }

        const fullHref = `https://notebooklm.google.com/notebook/${notebookId}`;
        threads.push({
          id,
          title: title.slice(0, 100),
          date: date ? formatIsoDate(date) : '',
          messageCount: 0,
          href: fullHref,
        });
        cardIndex++;
      }

      console.log('[ChatExporter] NotebookLM found notebooks:', threads.length);
      return { threads };
    },

    async scrapeThread(id, href) {
      // NotebookLM is a CSR SPA — background.js opens each notebook in a
      // background tab (same pattern as Gemini) and calls SCRAPE_THREAD with
      // domMode: true, which routes here via scrapeCurrentThread().
      console.log('[ChatExporter] NotebookLM scrapeThread called, id:', id);
      const thread = this.scrapeCurrentThread();
      return { success: true, thread };
    },

    _waitForHydration(timeoutMs = 10_000) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        function check() {
          const found = document.querySelector(
            '[data-testid="user-message"], [data-testid="model-response"], ' +
            '[class*="query-text"], [class*="response-text"], ' +
            '[class*="UserMessage"], [class*="ModelMessage"], ' +
            '[class*="chat-message"], [class*="ChatMessage"]'
          );
          if (found || Date.now() >= deadline) {
            resolve();
          } else {
            setTimeout(check, 400);
          }
        }
        check();
      });
    },

    scrapeCurrentThread() {
      const messages = [];

      const userSel =
        '[data-testid="user-message"], [class*="user-query"], [class*="UserQuery"], [class*="human-turn"]';
      const assistantSel =
        '[data-testid="model-response"], [class*="model-response"], [class*="ModelResponse"], [class*="ai-response"]';

      const allMessages = Array.from(document.querySelectorAll(
        '[data-testid="user-message"], [data-testid="model-response"], ' +
        '[class*="query-text"], [class*="response-text"], ' +
        '[class*="UserMessage"], [class*="ModelMessage"], ' +
        '[class*="chat-message"], [class*="ChatMessage"]'
      ));

      console.log('[ChatExporter] NotebookLM found message elements:', allMessages.length);
      if (allMessages[0]) {
        console.log('[ChatExporter] NotebookLM first message HTML:', allMessages[0].outerHTML?.slice(0, 300));
      }

      for (const el of allMessages) {
        const isUser = el.matches(userSel) ||
          el.className?.includes('user') ||
          el.className?.includes('query') ||
          el.getAttribute('data-role') === 'user';

        const content = el.innerText?.trim();
        if (!content) continue;

        messages.push({
          role: isUser ? 'user' : 'assistant',
          content,
        });
      }

      // Fallback: if no structured messages found, look for the chat panel text
      if (messages.length === 0) {
        const chatPanel = document.querySelector(
          '[class*="chat-panel"], [class*="ChatPanel"], ' +
          '[data-testid="chat-panel"], [aria-label*="chat"], [aria-label*="Chat"]'
        );
        if (chatPanel) {
          console.log('[ChatExporter] NotebookLM using chat panel fallback');
          messages.push({ role: 'user', content: '[Chat content — see notebook]' });
          messages.push({ role: 'assistant', content: chatPanel.innerText?.trim() || '' });
        }
      }

      if (!messages.length) throw new Error('No NotebookLM chat messages found on page');

      const title = document.querySelector(
        '[class*="notebook-title"], [data-testid="notebook-title"], h1'
      )?.innerText?.trim() || document.title || 'NotebookLM Chat';

      return {
        id: 'current',
        title,
        date: formatIsoDate(new Date().toISOString()),
        messages,
      };
    },
  };

// ── Message handler (declaration — hoisted so addListener above works) ────────

function handleMessage(request, _sender, sendResponse) {
  const site = detectSite();
    const scrapers = { claude: claudeScraper, chatgpt: chatgptScraper, perplexity: perplexityScraper, gemini: geminiScraper, notebooklm: notebookLMScraper };
    const scraper = scrapers[site];

    // PING — used by popup.js to confirm the content script is alive.
    // Uppercase variant is the current handshake; lowercase kept for compat.
    if (request.action === 'PING' || request.action === 'ping') {
      console.log('[ChatExporter] content script alive, site =', site);
      sendResponse({ action: 'PONG', ok: true, site });
      return true;
    }

    if (!scraper) {
      sendResponse({ error: 'unsupported_site' });
      return;
    }

    if (request.action === 'listThreads') {
      scraper.listThreads()
        .then(result => sendResponse(result))
        .catch(e => sendResponse({ error: e.message }));
      return true; // async
    }

    // SCRAPE_THREAD — used by background.js for bulk export.
    // For Perplexity: the service worker opens a real tab at the thread URL,
    //   injects this script, then sends SCRAPE_THREAD. We wait for hydration
    //   on the current page and scrape it directly.
    // For Claude / ChatGPT: we call the REST API to fetch any thread by ID.
    if (request.action === 'SCRAPE_THREAD') {
      // domMode: background.js opened a real tab and wants DOM scraping, not API
      if (site === 'perplexity' || site === 'notebooklm' || request.domMode) {
        scraper._waitForHydration()
          .then(() => {
            try {
              const thread = scraper.scrapeCurrentThread();
              sendResponse({ success: true, thread });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          });
        return true; // async
      }
      // Claude / ChatGPT — API-based
      scraper.scrapeThread(request.id, request.href)
        .then(thread => sendResponse({ success: true, thread }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true; // async
    }

    // Legacy action kept for "Export current chat" flow in popup.js
    if (request.action === 'scrapeCurrentThread') {
      try {
        sendResponse(scraper.scrapeCurrentThread());
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return;
    }

  sendResponse({ error: 'unknown_action' });
}
}
