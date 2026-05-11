// Chat Exporter — background service worker (Manifest V3)
// Owns the bulk-export lifecycle so it survives the popup closing.
//
// Message API (received):
//   START_EXPORT    { threads, format, site, tabId }  → { ok: true } or { ok: false, error }
//   GET_EXPORT_STATE                                   → { exportJob }
//   CLEAR_EXPORT_STATE                                 → { ok: true }
//
// Message API (broadcast to all extension contexts):
//   EXPORT_PROGRESS { completed, total, currentTitle }
//   EXPORT_DONE     { filename, count }
//   EXPORT_ERROR    { message }

'use strict';

// ── In-memory job (also persisted to chrome.storage.session) ──────────────────
// Shape:
// {
//   status:       'running' | 'done' | 'error',
//   site:         string,
//   format:       'markdown' | 'json' | 'plaintext',
//   total:        number,
//   completed:    number,
//   currentTitle: string,
//   results:      Array<{ id, title, date, messages: [{role, content}] }>,
//   errors:       Array<{ title, error }>,
//   filename:     string | null,   // set on success
//   errorMessage: string | null,   // set on error
// }

const _devModePromise = Promise.resolve(false);

let exportJob = null;

// Tracks every background tab opened during an export so onSuspend can close
// any that weren't cleaned up by their per-thread finally blocks.
const openedTabs = new Set();

async function persistJob() {
  if (!exportJob) {
    await chrome.storage.session.remove('exportJob').catch(() => {});
    return;
  }
  // Store only scalar metadata — omit full conversation content so the 10MB
  // session-storage quota is never hit on large exports.
  const { results, ...metadata } = exportJob;
  await chrome.storage.session.set({
    exportJob: { ...metadata, resultCount: results?.length ?? 0 },
  }).catch(() => {});
}

// ── Daily export tracking (free tier cap: 20 threads/day) ────────────────────

async function getDailyExportCount(site) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `dailyExports_${site}`;
  const data = await chrome.storage.local.get(key);
  const record = data[key] || { date: '', count: 0 };
  if (record.date !== today) return { date: today, count: 0 };
  return record;
}

async function incrementDailyExportCount(site, count) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `dailyExports_${site}`;
  const record = await getDailyExportCount(site);
  record.date = today;
  record.count += count;
  await chrome.storage.local.set({ [key]: record });
  return record.count;
}

// ── Broadcast to popup (ignore errors when popup is closed) ───────────────────

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ── Tab / scripting helpers ───────────────────────────────────────────────────

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      resolve(chrome.runtime.lastError ? null : response);
    });
  });
}

function waitForTabLoad(tabId, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let settled = false;
    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    const timer = setTimeout(done, timeoutMs);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') done();
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Warm-cache tabs (threads 2+) can reach 'complete' before the listener
    // above is registered. Check the current status immediately as a fallback.
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab?.status === 'complete') done();
    });
  });
}

// Polls the tab until Perplexity's React tree has hydrated answer elements.
async function waitForHydration(tabId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!(
          document.querySelector('[class*="prose"], [class*="answer"], [class*="markdown"]') ||
          document.querySelector('[data-testid="query-text"], [class*="queryText"], [class*="QueryText"]')
        ),
      });
      if (result) return;
    } catch {
      // tab still initialising
    }
    await new Promise(r => setTimeout(r, 500));
  }
  // Timed out — proceed and let the content script's own check handle it
}

// Polls the tab until ChatGPT's message elements are present in the DOM.
async function waitForChatGPTHydration(tabId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!document.querySelector('[data-message-author-role]'),
      });
      if (result) return;
    } catch {
      // tab still initialising
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// Polls the tab until Gemini's model-response custom elements are present.
async function waitForGeminiHydration(tabId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!document.querySelector('model-response'),
      });
      if (result) return;
    } catch {
      // tab still initialising
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── Perplexity: open real tab per thread, hydrate, scrape, close ──────────────

async function scrapePerplexityThread(thread) {
  const href = thread.href || `/search/${thread.id}`;
  const url = href.startsWith('http') ? href : `https://www.perplexity.ai${href}`;

  let tab;
  try {
    console.log('[Chatavio] Opening tab:', url);
    tab = await chrome.tabs.create({ url, active: false });
    openedTabs.add(tab.id);
    console.log('[Chatavio] Opened Perplexity tab', tab.id, 'for:', thread.title);
    // Store so CANCEL_EXPORT can close this tab immediately during hydration
    if (exportJob) { exportJob.currentTabId = tab.id; await persistJob(); }
  } catch (e) {
    return { success: false, error: `Could not open tab: ${e.message}` };
  }

  try {
    await waitForTabLoad(tab.id);
    await waitForHydration(tab.id);

    // Inject content script (guard at top of content.js prevents double-registration)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 500)); // let the listener register

    const result = await sendToTab(tab.id, { action: 'SCRAPE_THREAD', site: 'perplexity' });
    if (!result) return { success: false, error: 'No response from content script in temporary tab' };
    if (!result.success) return result;

    // Prefer the sidebar title when the scraper only got a generic fallback
    if (thread.title && (!result.thread.title || result.thread.title === 'Current Chat')) {
      result.thread.title = thread.title;
    }
    result.thread.date = result.thread.date || thread.date || '';
    return result;
  } finally {
    if (exportJob) exportJob.currentTabId = null;
    console.log('[Chatavio] Closing Perplexity tab:', tab.id, 'for:', thread.title);
    openedTabs.delete(tab.id);
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

// ── ChatGPT: open a real tab, hydrate, scrape DOM, close ─────────────────────
// Used as a fallback when the /backend-api/conversation/{id} endpoint returns 404.

async function scrapeChatGPTThreadViaTab(thread) {
  const url = `https://chatgpt.com/c/${thread.id}`;
  let tab;
  try {
    console.log('[Chatavio] Opening tab:', url);
    tab = await chrome.tabs.create({ url, active: false });
    openedTabs.add(tab.id);
    console.log('[Chatavio] Opened ChatGPT tab', tab.id, 'for:', thread.title);
  } catch (e) {
    return { success: false, error: `Could not open tab: ${e.message}` };
  }

  try {
    await waitForTabLoad(tab.id);
    await waitForChatGPTHydration(tab.id);

    const [{ result: isRateLimited }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body?.innerText?.includes('Too many requests') ||
                  document.body?.innerText?.includes('temporarily limited'),
    });
    if (isRateLimited) {
      console.warn('[Chatavio] Rate limited — waiting 30s');
      await new Promise(r => setTimeout(r, 30000));
    }

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 500));

    const result = await sendToTab(tab.id, { action: 'SCRAPE_THREAD', domMode: true });
    if (!result) return { success: false, error: 'No response from content script in temporary tab' };
    if (!result.success) return result;

    // Always use the sidebar title — document.title in a background tab often
    // returns the generic "ChatGPT" string before the conversation title loads,
    // which would cause all files to share the same name and overwrite each other in the ZIP.
    if (thread.title) result.thread.title = thread.title;
    result.thread.date = thread.date || result.thread.date || '';
    return result;
  } finally {
    console.log('[Chatavio] Closing ChatGPT tab:', tab.id, 'for:', thread.title);
    openedTabs.delete(tab.id);
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

// ── NotebookLM: open a background tab per notebook, hydrate, scrape DOM, close ─

async function waitForNotebookLMHydration(tabId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!(
          document.querySelector(
            '[data-testid="user-message"], [data-testid="model-response"], ' +
            '[class*="query-text"], [class*="response-text"], ' +
            '[class*="chat-message"], [class*="ChatMessage"]'
          )
        ),
      });
      if (result) return;
    } catch {
      // tab still initialising
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

async function scrapeNotebookLMThread(thread) {
  console.log('[Chatavio] scrapeNotebookLMThread called for:', thread.title);
  const href = thread.href || '';
  const url = href.startsWith('http') ? href : `https://notebooklm.google.com/notebook/${thread.id}`;
  let tab;
  try {
    console.log('[Chatavio] Opening tab:', url);
    tab = await chrome.tabs.create({ url, active: false });
    openedTabs.add(tab.id);
    console.log('[Chatavio] Opened NotebookLM tab', tab.id, 'for:', thread.title);
  } catch (e) {
    return { success: false, error: `Could not open tab: ${e.message}` };
  }

  try {
    await waitForTabLoad(tab.id);
    await waitForNotebookLMHydration(tab.id);

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 500));

    const result = await sendToTab(tab.id, { action: 'SCRAPE_THREAD', domMode: true });
    if (!result) return { success: false, error: 'No response from content script in temporary tab' };
    if (!result.success) return result;

    if (thread.title) result.thread.title = thread.title;
    result.thread.date = thread.date || result.thread.date || '';
    return result;
  } finally {
    console.log('[Chatavio] Closing NotebookLM tab:', tab.id, 'for:', thread.title);
    openedTabs.delete(tab.id);
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

// ── Gemini: open a background tab per thread, hydrate, scrape DOM, close ──────
// Gemini is a CSR SPA; the content script cannot navigate between threads.
// We mirror the Perplexity approach: one real tab per conversation.

async function scrapeGeminiThread(thread) {
  console.log('[Chatavio] scrapeGeminiThread called for:', thread.title);
  const url = `https://gemini.google.com/app/${thread.id}`;
  let tab;
  try {
    console.log('[Chatavio] Opening tab:', url);
    tab = await chrome.tabs.create({ url, active: false });
    openedTabs.add(tab.id);
    console.log('[Chatavio] Opened Gemini tab', tab.id, 'for:', thread.title);
  } catch (e) {
    return { success: false, error: `Could not open tab: ${e.message}` };
  }

  try {
    await waitForTabLoad(tab.id);

    // Wait for Angular to render — Gemini needs more time than other SPAs
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) {
      console.log('[Chatavio] Gemini content script injection:', e.message);
    }

    await new Promise(resolve => setTimeout(resolve, 800));

    const result = await sendToTab(tab.id, { action: 'SCRAPE_THREAD', domMode: true });

    // If scrape returned empty messages, wait longer and retry once
    if (result?.thread?.messages?.length === 0) {
      console.log('[Chatavio] Gemini scrape returned empty — retrying after delay');
      await new Promise(resolve => setTimeout(resolve, 3000));
      const retry = await sendToTab(tab.id, { action: 'SCRAPE_THREAD', domMode: true });
      if (retry?.thread?.messages?.length > 0) {
        if (thread.title) retry.thread.title = thread.title;
        retry.thread.date = thread.date || retry.thread.date || '';
        return retry;
      }
    }

    console.log('[Chatavio] Gemini scrape result:', result?.success,
      'messages:', result?.thread?.messages?.length);

    if (!result) return { success: false, error: 'No response from Gemini tab' };
    if (!result.success) return result;

    // Always prefer the sidebar title — document.title in a background tab may
    // not reflect the conversation title before the Angular app fully boots.
    if (thread.title) result.thread.title = thread.title;
    result.thread.date = thread.date || result.thread.date || '';
    return result;
  } finally {
    console.log('[Chatavio] Closing Gemini tab:', tab.id, 'for:', thread.title);
    openedTabs.delete(tab.id);
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

// ── Claude / ChatGPT: send SCRAPE_THREAD to the original tab ─────────────────
// The content script uses the site's REST API to fetch any thread by ID.

async function scrapeApiThread(tabId, thread) {
  const result = await sendToTab(tabId, {
    action: 'SCRAPE_THREAD',
    id: thread.id,
    href: thread.href || null,
  });
  if (!result) return { success: false, error: 'Content script did not respond — page may have navigated away' };
  return result;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function sanitizeTitle(title) {
  return (title || 'Untitled')
    .replace(/[/\\:*?"<>|]/g, '')  // remove chars illegal in filenames
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim()
    .slice(0, 80)
    .trim()
    || 'Untitled';
}

function buildFilename(conv, format) {
  const ext = format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'txt';
  const safeTitle = sanitizeTitle(conv.title);
  let datePrefix = new Date().toISOString().slice(0, 10); // fallback: today
  if (conv.date) {
    try {
      const parsed = new Date(conv.date);
      if (!isNaN(parsed.getTime())) datePrefix = parsed.toISOString().slice(0, 10);
    } catch {}
  }
  return `${datePrefix} - ${safeTitle}.${ext}`;
}

function buildYamlFrontmatter(conv, site, msgCount) {
  let dateStr = new Date().toISOString().slice(0, 10);
  if (conv.date) {
    try {
      const parsed = new Date(conv.date);
      if (!isNaN(parsed.getTime())) dateStr = parsed.toISOString().slice(0, 10);
    } catch {}
  }
  const escapedTitle = (conv.title || 'Untitled').replace(/"/g, '\\"');
  return [
    '---',
    `title: "${escapedTitle}"`,
    `date: "${dateStr}"`,
    `source: "${site}"`,
    `exported: "${new Date().toISOString()}"`,
    'tags:',
    '  - ai-chat',
    `  - ${site}`,
    `messages: ${msgCount}`,
    '---',
  ].join('\n');
}

function formatOneConversation(conv, format, site, yamlFrontmatter = false) {
  const msgs = conv.messages || conv.turns || [];

  if (format === 'json') {
    return JSON.stringify({ site, exported_at: new Date().toISOString(), conversation: conv }, null, 2);
  }

  if (format === 'markdown') {
    const header = `## ${conv.title || 'Untitled'}\n**Date:** ${conv.date || 'Unknown'}`;
    const body = msgs.map(m => {
      const label = m.role === 'user' ? '**You:**' : '**Assistant:**';
      return `${label}\n\n${m.content}`;
    }).join('\n\n');
    const md = `${header}\n\n${body}`;
    return yamlFrontmatter ? `${buildYamlFrontmatter(conv, site, msgs.length)}\n\n${md}` : md;
  }

  // plaintext
  const header = `${conv.title || 'Untitled'}\nDate: ${conv.date || 'Unknown'}`;
  const body = msgs.map(m => {
    const label = m.role === 'user' ? 'You:' : 'Assistant:';
    return `${label}\n\n${m.content}`;
  }).join('\n\n────────────────────\n\n');
  return `${header}\n\n${body}`;
}

// ── Download via offscreen document ──────────────────────────────────────────
// Service workers have no DOM, so they can't create Blob URLs.
// We delegate to an offscreen document which CAN create Blobs.

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  }).catch(() => []);
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: 'Generate Blob URL for export file download',
  });
}

// ── ZIP builder — called exactly once, after all threads are scraped ──────────

async function buildAndDownloadZip(files, site) {
  const date = new Date().toISOString().slice(0, 10);
  const zipFilename = `Chatavio-${site}-${date}.zip`;

  console.log('[Chatavio] Phase 2 — building ZIP:', zipFilename);
  console.log('[Chatavio] Files to ZIP:', files.length, files.map(f => f.filename));
  const _payload = JSON.stringify({ action: 'CREATE_ZIP', files });
  console.log('[Chatavio] Payload size:', _payload.length, 'bytes');

  try {
    await ensureOffscreenDocument();
    await new Promise(r => setTimeout(r, 100)); // let the offscreen listener register

    const blobResp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { target: 'offscreen', action: 'CREATE_ZIP', files },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response?.ok) {
            reject(new Error(response?.error || 'ZIP creation failed'));
          } else {
            resolve(response);
          }
        }
      );
    });

    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: blobResp.url, filename: zipFilename, saveAs: true },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            reject(new Error(chrome.runtime.lastError?.message || 'Download failed'));
          } else {
            resolve();
          }
        }
      );
    });

    return { ok: true, filename: zipFilename };
  } finally {
    await new Promise(r => setTimeout(r, 3_000));
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

// ── Main export runner ────────────────────────────────────────────────────────

async function runExport({ threads, format, site, tabId, yamlFrontmatter }) {
  exportJob = {
    status: 'running',
    site,
    format,
    total: threads.length,
    completed: 0,
    currentTitle: '',
    results: [],
    errors: [],
    filename: null,
    errorMessage: null,
    cancelRequested: false,
  };
  await persistJob();

  // ── Daily export cap (free tier: 20 threads/day) ─────────────────────────
  const isDev = await _devModePromise;
  const FREE_DAILY_LIMIT = 20;

  if (!isDev) {
    const dailyRecord = await getDailyExportCount(site);
    const remaining = FREE_DAILY_LIMIT - dailyRecord.count;

    if (remaining <= 0) {
      exportJob.status = 'error';
      exportJob.errorMessage = 'daily_limit_reached';
      await persistJob();
      broadcast({ action: 'EXPORT_ERROR', error: 'daily_limit_reached' });
      return;
    }

    const originalCount = threads.length;
    if (threads.length > remaining) {
      threads = threads.slice(0, remaining);
      exportJob.total = threads.length;
      broadcast({ action: 'EXPORT_TRIMMED', requested: originalCount, allowed: threads.length });
    }
  }

  // ── Phase 1: scrape every thread — collect { filename, content } for the ZIP

  const threadCount = threads.length; // captured here, after trimming, before any failures
  const files = [];

  for (const thread of threads) {
    if (exportJob.cancelRequested) {
      exportJob.status = 'cancelled';
      exportJob.errorMessage = 'Export cancelled by user.';
      broadcast({ action: 'EXPORT_CANCELLED', message: exportJob.errorMessage });
      await persistJob();
      return;
    }

    // Broadcast current thread title before scraping (completed not yet incremented)
    exportJob.currentTitle = thread.title || '';
    broadcast({
      action: 'EXPORT_PROGRESS',
      completed: exportJob.completed,
      total: exportJob.total,
      currentTitle: thread.title || '',
    });

    try {
      console.log('[Chatavio] Export site:', site, 'thread:', thread.title);
      let result;
      if (site === 'perplexity') {
        result = await scrapePerplexityThread(thread);
        if (exportJob.cancelRequested) break;
      } else if (site === 'gemini') {
        result = await scrapeGeminiThread(thread);
        if (exportJob.cancelRequested) break;
      } else if (site === 'notebooklm') {
        result = await scrapeNotebookLMThread(thread);
        if (exportJob.cancelRequested) break;
      } else {
        result = await scrapeApiThread(tabId, thread);
        if (exportJob.cancelRequested) break;
        // ChatGPT API auth/not-found errors → fall back to opening a real tab and scraping DOM
        const shouldFallback = (err) =>
          err?.includes('404') || err?.includes('401') || err?.includes('403') ||
          err?.includes('session') || err?.includes('accessToken');
        if (site === 'chatgpt' && result && !result.success && shouldFallback(result.error)) {
          console.log('[Chatavio] ChatGPT API error, switching to tab-based DOM scraping for:', thread.title, '| error:', result.error);
          broadcast({ action: 'CHATGPT_TAB_SCRAPE' });
          result = await scrapeChatGPTThreadViaTab(thread);
          if (exportJob.cancelRequested) break;
        }
      }

      if (result?.success) {
        console.log('[Chatavio] Success:', thread.title);
        const conv = result.thread;
        exportJob.results.push(conv);
        files.push({
          filename: buildFilename(conv, format),
          content:  formatOneConversation(conv, format, site, yamlFrontmatter),
        });
      } else {
        console.warn('[Chatavio] Failed:', thread.title, result?.error);
        exportJob.errors.push({ title: thread.title, error: result?.error || 'Unknown error' });
      }
    } catch (e) {
      console.error('[Chatavio] Exception:', thread.title, e.message);
      exportJob.errors.push({ title: thread.title, error: e.message });
    }

    // Increment after scrape completes (success or failure)
    exportJob.completed++;
    await persistJob();

    const baseDelay = (site === 'perplexity' || site === 'gemini' || site === 'notebooklm') ? 1000 : 2000;
    const jitter = Math.random() * 1000;
    await new Promise(r => setTimeout(r, baseDelay + jitter));
  }

  console.log('[Chatavio] Phase 1 complete —', files.length, 'of', threads.length, 'threads collected');

  // Break out of the loop above lands here — EXPORT_CANCELLED was already
  // broadcast from the CANCEL_EXPORT handler, so just update state and return.
  if (exportJob.cancelRequested) {
    exportJob.status = 'cancelled';
    exportJob.errorMessage = 'Export cancelled by user.';
    await persistJob();
    return;
  }

  if (exportJob.results.length === 0) {
    exportJob.status = 'error';
    exportJob.errorMessage = 'No conversations could be exported. Sessions may have expired or the page structure has changed.';
    broadcast({ action: 'EXPORT_ERROR', message: exportJob.errorMessage, errors: exportJob.errors });
    await persistJob();
    return;
  }

  // ── Phase 2: build one ZIP from all collected files and download it once ─────

  try {
    const { filename: zipFilename } = await buildAndDownloadZip(files, site);
    await incrementDailyExportCount(site, threadCount);
    exportJob.status = 'done';
    exportJob.filename = zipFilename;
    broadcast({ action: 'EXPORT_DONE', filename: zipFilename, count: exportJob.results.length });
  } catch (e) {
    exportJob.status = 'error';
    exportJob.errorMessage = `Export failed: ${e.message}`;
    broadcast({ action: 'EXPORT_ERROR', message: exportJob.errorMessage });
  }

  await persistJob();
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // Ignore offscreen-targeted messages that bubble up here
  if (request.target === 'offscreen') return;

  if (request.action === 'START_EXPORT') {
    if (exportJob?.status === 'running') {
      sendResponse({ ok: false, error: 'An export is already in progress.' });
      return;
    }
    runExport(request).catch((e) => {
      console.error('[Chat Exporter] Unexpected error in runExport:', e);
      broadcast({ action: 'EXPORT_ERROR', message: e.message });
    });
    sendResponse({ ok: true });
    return;
  }

  if (request.action === 'CANCEL_EXPORT') {
    if (!exportJob || exportJob.status !== 'running') {
      sendResponse({ ok: false, error: 'No export is currently running.' });
      return;
    }
    exportJob.cancelRequested = true;
    sendResponse({ ok: true });
    // Close any tab currently mid-hydration so the export loop unblocks immediately
    if (exportJob.currentTabId) {
      chrome.tabs.remove(exportJob.currentTabId).catch(() => {});
      exportJob.currentTabId = null;
    }
    broadcast({ action: 'EXPORT_CANCELLED' });
    return;
  }

  if (request.action === 'GET_EXPORT_STATE') {
    chrome.storage.session.get('exportJob').then(({ exportJob: stored }) => {
      // If stored state says 'running' but the in-memory job is gone, the
      // service worker was terminated mid-export — surface that as an error.
      if (stored?.status === 'running' && !exportJob) {
        stored.status = 'error';
        stored.errorMessage = 'Export was interrupted because the browser terminated the background worker. Please try again.';
        chrome.storage.session.set({ exportJob: stored }).catch(() => {});
      }
      sendResponse({ exportJob: stored || null });
    }).catch(() => sendResponse({ exportJob: null }));
    return true; // async
  }

  if (request.action === 'CLEAR_EXPORT_STATE') {
    exportJob = null;
    chrome.storage.session.remove('exportJob').catch(() => {});
    sendResponse({ ok: true });
    return;
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[Chatavio] Installed.');
  } else if (reason === 'update') {
    console.log('[Chatavio] Updated to', chrome.runtime.getManifest().version);
  }
});

// On browser startup the in-memory openedTabs Set is always empty (the service
// worker is freshly initialised), so this is a no-op in practice. It acts as a
// belt-and-suspenders guard for any future persistent tab tracking.
chrome.runtime.onStartup.addListener(() => {
  openedTabs.forEach(id => chrome.tabs.remove(id).catch(() => {}));
  openedTabs.clear();
});

// Close any background tabs that weren't cleaned up if the service worker is
// terminated mid-export (e.g. browser killed the worker after 5 minutes idle).
chrome.runtime.onSuspend.addListener(async () => {
  if (openedTabs.size === 0) return;
  console.log('[Chatavio] Service worker suspending — closing', openedTabs.size, 'leaked tab(s):', [...openedTabs]);
  for (const tabId of openedTabs) {
    try { await chrome.tabs.remove(tabId); } catch {}
  }
  openedTabs.clear();
});
