// Chatavio — popup.js
'use strict';

// State
const state = {
  site: null,
  threads: [],
  selected: new Set(),
  searchQuery: '',
};

// Screen management
const screens = {
  disclaimer: document.getElementById('screen-disclaimer'),
  loading: document.getElementById('screen-loading'),
  selection: document.getElementById('screen-selection'),
  exporting: document.getElementById('screen-exporting'),
  done: document.getElementById('screen-done'),
  error: document.getElementById('screen-error'),
};

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    if (!el) continue;
    if (key === name) {
      el.removeAttribute('hidden');
      el.style.display = '';
    } else {
      el.setAttribute('hidden', '');
      el.style.display = 'none';
    }
  }
}

function showError(message) {
  const errorText = document.getElementById('error-text');
  if (errorText) errorText.textContent = message;
  showScreen('error');
}

function initApp() {
  localStorage.setItem('chatavio_terms_v1', '1');
  showScreen('selection');
  loadThreads();
}

// Initialize
document.addEventListener('DOMContentLoaded', function() {
  if (!localStorage.getItem('chatavio_terms_v1')) {
    document.getElementById('accept-disclaimer-btn')
      ?.addEventListener('click', initApp);
    showScreen('disclaimer');
    return;
  }

  showScreen('selection');
  loadThreads();
  console.log('Chatavio popup loaded successfully');
});

// Load threads from current tab
async function loadThreads() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.log('[Chatavio] No active tab found');
      return;
    }

    console.log('[Chatavio] Active tab:', tab.url);

    // Detect site
    if (tab.url.includes('claude.ai')) state.site = 'claude';
    else if (tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com')) state.site = 'chatgpt';
    else if (tab.url.includes('perplexity.ai')) state.site = 'perplexity';
    else if (tab.url.includes('gemini.google.com')) state.site = 'gemini';
    else if (tab.url.includes('notebooklm.google.com')) state.site = 'notebooklm';
    else {
      console.log('[Chatavio] Unsupported site:', tab.url);
      return;
    }

    console.log('[Chatavio] Detected site:', state.site);

    if (state.site === 'notebooklm') {
      const url = tab.url || '';
      const isHomepage = !url.includes('/notebook/');
      if (!isHomepage) {
        showScreen('error');
        const errorText = document.getElementById('error-text');
        if (errorText) {
          errorText.textContent =
            'Go to the NotebookLM home page to export your notebooks.';
        }
        const retryBtn = document.getElementById('retry-btn');
        if (retryBtn) {
          retryBtn.onclick = () => {
            // Navigating the active tab always closes the popup (Chrome behaviour).
            // The user lands on the homepage; clicking the extension icon reopens the popup there.
            chrome.tabs.update(tab.id, { url: 'https://notebooklm.google.com/' });
          };
        }
        return;
      }
    }

    // Update site badge
    const siteBadge = document.getElementById('site-badge');
    if (siteBadge) {
      siteBadge.textContent = state.site.toUpperCase();
      siteBadge.style.display = 'block';
    }

    // Show loading placeholder in the thread list so Perplexity's live count has
    // somewhere to appear while the scroll loop runs.
    const threadListEl = document.getElementById('thread-list');
    if (threadListEl) {
      threadListEl.innerHTML = '<p class="loading-hint">Loading threads…</p>';
    }

    // Try to ping first - if content script is already loaded, no need to inject
    try {
      console.log('[Chatavio] Pinging content script...');
      const pingResponse = await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
      console.log('[Chatavio] Content script already loaded');
      
      // Get threads directly
      console.log('[Chatavio] Requesting threads...');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'listThreads' });
      console.log('[Chatavio] Threads response:', response);

      if (!response || response.error) {
        showError(response?.error || 'Failed to load threads');
        return;
      }
      if (response.threads) {
        state.threads = response.threads;
        console.log('[Chatavio] Loaded threads:', state.threads.length);
        displayThreads();
        maybeShowTabExportNotice(state.site);
        updateExportQuota(state.site);
        return;
      }
    } catch (pingError) {
      console.log('[Chatavio] Content script not loaded, injecting...');
    }

    // Only inject if ping failed
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      console.log('[Chatavio] Content script injected');
    } catch (injectError) {
      console.log('[Chatavio] Injection failed:', injectError.message);
      return;
    }

    // Wait for the message listener to register before sending listThreads
    await new Promise(resolve => setTimeout(resolve, 300));

    // Get threads after injection
    try {
      console.log('[Chatavio] Requesting threads after injection...');
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'listThreads' });
      console.log('[Chatavio] Threads response:', response);

      if (!response || response.error) {
        showError(response?.error || 'Failed to load threads');
        return;
      }
      if (response.threads) {
        state.threads = response.threads;
        console.log('[Chatavio] Loaded threads:', state.threads.length);
        displayThreads();
        maybeShowTabExportNotice(state.site);
        updateExportQuota(state.site);
      }
    } catch (error) {
      console.error('[Chatavio] Failed to get threads after injection:', error);
      showError('Failed to load threads: ' + error.message);
    }
  } catch (error) {
    console.error('[Chatavio] Failed to load threads:', error);
  }
}

// Display threads in the list
function displayThreads() {
  const threadList = document.getElementById('thread-list');
  if (!threadList) return;

  threadList.innerHTML = '';
  
  const filteredThreads = state.searchQuery 
    ? state.threads.filter(thread => 
        thread.title && thread.title.toLowerCase().includes(state.searchQuery.toLowerCase())
      )
    : state.threads;
  
  filteredThreads.forEach(thread => {
    const item = createThreadItem(thread);
    threadList.appendChild(item);
  });
  
  updateSelectionUI();
}

// Create thread item element
function createThreadItem(thread) {
  const div = document.createElement('div');
  div.className = 'thread-item';
  div.style.cssText = `
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border: 1px solid #333;
    border-radius: 6px;
    margin-bottom: 6px;
    cursor: pointer;
    background: #2a2a2a;
  `;
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'thread-checkbox';
  checkbox.dataset.threadId = thread.id;
  checkbox.checked = state.selected.has(thread.id);
  checkbox.style.cssText = `
    margin-right: 10px;
    flex-shrink: 0;
  `;
  
  const content = document.createElement('div');
  content.style.cssText = `
    flex: 1;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    min-width: 0;
  `;

  const title = document.createElement('div');
  title.className = 'thread-title';
  title.style.cssText = 'flex: 1; min-width: 0;';

  const titleText = document.createElement('span');
  titleText.textContent = thread.title || 'Untitled';
  title.appendChild(titleText);

  if (thread.date) {
    const dateEl = document.createElement('span');
    dateEl.className = 'thread-date';
    const parsed = new Date(thread.date);
    dateEl.textContent = isNaN(parsed)
      ? thread.date
      : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    title.appendChild(dateEl);
  }

  const meta = document.createElement('div');
  const dateStr = thread.date || '';
  meta.textContent = dateStr
    ? `${dateStr} • ${thread.messageCount || 0} msgs`
    : (thread.messageCount ? `${thread.messageCount} msgs` : '');
  if (!dateStr && !thread.messageCount) meta.style.display = 'none';
  meta.style.cssText = `
    font-size: 11px;
    color: #999;
    margin-left: 10px;
    flex-shrink: 0;
    padding-top: 1px;
  `;
  
  content.appendChild(title);
  content.appendChild(meta);
  
  div.appendChild(checkbox);
  div.appendChild(content);
  
  div.onclick = (e) => {
    if (e.target === checkbox) return; // natural change event handles it
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  };
  
  return div;
}

function showSelectionLimitWarning() {
  const quotaEl = document.getElementById('export-quota');
  if (!quotaEl) return;
  const prev = quotaEl.textContent;
  quotaEl.textContent = 'Maximum 20 chats selected.';
  quotaEl.classList.add('quota-low');
  setTimeout(() => {
    quotaEl.textContent = prev;
    quotaEl.classList.remove('quota-low');
  }, 2000);
}

// Update all selection-related UI — called after any state change
function updateSelectionUI() {
  const FREE_THREAD_LIMIT = 20;
  const count = state.selected.size;

  const summary = document.getElementById('selection-summary');
  if (summary) {
    summary.textContent = count === 0 ? '' : `${count} / 20 selected`;
  }

  const exportBtn = document.getElementById('export-selected-btn');
  if (exportBtn) {
    if (count === 0) {
      exportBtn.textContent = 'Export Chats';
      exportBtn.disabled = true;
    } else if (count === 1) {
      exportBtn.textContent = 'Export 1 Chat';
      exportBtn.disabled = false;
    } else {
      exportBtn.textContent = `Export ${count} Chats`;
      exportBtn.disabled = false;
    }
  }

  // Select All is capped by total thread count, never by the current search filter
  const selectAllBtn = document.getElementById('select-all-btn');
  const selectAllHint = document.getElementById('select-all-hint');
  const overLimit = state.threads.length > FREE_THREAD_LIMIT;
  if (selectAllBtn) selectAllBtn.disabled = overLimit;
  if (selectAllHint) selectAllHint.hidden = !overLimit;
}

// Export functionality

async function exportSelectedThreads() {
  if (state.selected.size === 0) return;
  await startExport();
}

async function updateExportQuota(site) {
  const key = `dailyExports_${site}`;
  const today = new Date().toISOString().slice(0, 10);
  const data = await chrome.storage.local.get(key);
  const record = data[key];
  const used = (record?.date === today) ? record.count : 0;
  const remaining = Math.max(0, 20 - used);

  const quotaEl = document.getElementById('export-quota');
  if (!quotaEl) return;

  quotaEl.classList.remove('quota-low', 'quota-exhausted');
  if (remaining === 20) {
    quotaEl.textContent = 'Select up to 20 chats to export today.';
  } else if (remaining === 0) {
    quotaEl.textContent = 'Daily limit reached. Come back tomorrow.';
    quotaEl.classList.add('quota-exhausted');
  } else {
    quotaEl.textContent = `${remaining} of 20 exports remaining today.`;
    if (remaining <= 5) quotaEl.classList.add('quota-low');
  }
}

function updateExportProgress(completed, total, currentTitle) {
  const circumference = 427; // 2 * PI * 68
  const rProg = document.getElementById('r-prog');
  if (rProg && total > 0) {
    const offset = circumference - (completed / total) * circumference;
    rProg.style.strokeDashoffset = offset;
  }

  const ringCompleted = document.getElementById('ring-completed');
  const ringTotal = document.getElementById('ring-total');
  if (ringCompleted) ringCompleted.textContent = completed;
  if (ringTotal) ringTotal.textContent = `/ ${total}`;

  const titleEl = document.getElementById('current-title');
  if (titleEl && currentTitle) titleEl.textContent = currentTitle;
}

async function maybeShowTabExportNotice(site) {
  if (site !== 'perplexity' && site !== 'gemini' && site !== 'notebooklm') return;
  const key = `noticeShown_${site}`;
  const data = await chrome.storage.local.get(key);
  if (data[key]) return;
  const notice = document.getElementById('tab-export-notice');
  const text = document.querySelector('#tab-export-notice .notice-text');
  if (!notice || !text) return;
  const platformName = site === 'gemini' ? 'Gemini' : site === 'notebooklm' ? 'NotebookLM' : 'Perplexity';
  text.textContent = `${platformName} exports open each notebook briefly in the background — fully automatic.`;
  notice.removeAttribute('hidden');
}

async function startExport() {
  try {
    const selectedThreads = Array.from(state.selected)
      .map(id => state.threads.find(t => t.id === id))
      .filter(Boolean)
      .slice(0, 20); // hard cap — never send more than 20
    const format = document.getElementById('format-select')?.value || 'markdown';

    const freeTierNoticeEl = document.getElementById('free-tier-notice');
    if (freeTierNoticeEl) freeTierNoticeEl.hidden = true;

    console.log('[Chatavio] Exporting', selectedThreads.length, 'threads in', format, 'format');

    if (state.site === 'perplexity' || state.site === 'gemini' || state.site === 'notebooklm') {
      chrome.storage.local.set({ [`noticeShown_${state.site}`]: true });
    }

    // Reset progress UI before showing the exporting screen
    updateExportProgress(0, selectedThreads.length, 'Preparing…');

    const cancelBtnEl = document.getElementById('cancel-btn');
    if (cancelBtnEl) { cancelBtnEl.disabled = false; cancelBtnEl.textContent = 'Cancel Export'; }
    showScreen('exporting');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const exportData = {
      action: 'START_EXPORT',
      threads: selectedThreads,
      format: format,
      site: state.site,
      tabId: tab.id,
      yamlFrontmatter: false,
    };

    const response = await chrome.runtime.sendMessage(exportData);

    if (response && response.ok) {
      console.log('[Chatavio] Export started successfully');
    } else {
      throw new Error(response?.error || 'Failed to start export');
    }

  } catch (error) {
    console.error('[Chatavio] Export failed:', error);
    showError('Export failed: ' + error.message);
  }
}

// Event listeners
document.addEventListener('DOMContentLoaded', function() {
  // Delegated checkbox handler — one listener survives re-renders of the thread list
  const threadListEl = document.getElementById('thread-list');
  if (threadListEl) {
    threadListEl.addEventListener('change', (e) => {
      if (!e.target.matches('.thread-checkbox')) return;
      const FREE_LIMIT = 20;
      const threadId = e.target.dataset.threadId;

      if (e.target.checked) {
        if (state.selected.size >= FREE_LIMIT) {
          e.target.checked = false;
          showSelectionLimitWarning();
          return;
        }
        state.selected.add(threadId);
      } else {
        state.selected.delete(threadId);
      }
      updateSelectionUI();
    });
  }

  // Search functionality
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      displayThreads();
    });
  }

  // Select All button
  const selectAllBtn = document.getElementById('select-all-btn');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const allSelected = state.selected.size === state.threads.length;
      state.threads.forEach(thread => {
        if (allSelected) {
          state.selected.delete(thread.id);
        } else {
          state.selected.add(thread.id);
        }
      });
      displayThreads();
    });
  }
  
  // Export Selected button
  const exportBtn = document.getElementById('export-selected-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportSelectedThreads);
  }

  // Export Current button
  const exportCurrentBtn = document.getElementById('export-current-btn');
  if (exportCurrentBtn) {
    exportCurrentBtn.addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeCurrentThread' });
        
        if (response && response.messages) {
          const format = document.getElementById('format-select')?.value || 'markdown';

          const cancelBtnEl = document.getElementById('cancel-btn');
          if (cancelBtnEl) { cancelBtnEl.disabled = false; cancelBtnEl.textContent = 'Cancel Export'; }
          showScreen('exporting');

          const exportData = {
            action: 'START_EXPORT',
            threads: [response],
            format: format,
            site: state.site,
            tabId: tab.id,
            yamlFrontmatter: false,
          };
          
          await chrome.runtime.sendMessage(exportData);
        } else {
          showError('No current thread found');
        }
      } catch (error) {
        console.error('[Chatavio] Current export failed:', error);
        showError('Export current chat failed: ' + error.message);
      }
    });
  }
  
  // Cancel button
  const cancelBtn = document.getElementById('cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      // Update UI immediately — don't wait for background confirmation
      const subtitle = document.querySelector('.export-subtitle, #export-subtitle');
      if (subtitle) subtitle.textContent = 'Cancelling — finishing current thread…';
      try {
        await chrome.runtime.sendMessage({ action: 'CANCEL_EXPORT' });
      } catch (e) {
        console.error('[Chatavio] Cancel send failed:', e);
      }
    });
  }

  // Post-export / error screen buttons
  const startOverBtn = document.getElementById('start-over-btn');
  if (startOverBtn) {
    startOverBtn.addEventListener('click', () => {
      state.selected = new Set();
      showScreen('selection');
      loadThreads();
    });
  }

  const exitBtn = document.getElementById('exit-btn');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      window.close();
    });
  }

  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      showScreen('selection');
    });
  }

  // Listen for export progress updates from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'EXPORT_PROGRESS') {
      const { completed, total, currentTitle } = message;
      updateExportProgress(completed, total, currentTitle);
      
    } else if (message.action === 'EXPORT_DONE') {
      // Show done screen
      const doneText = document.getElementById('done-text');
      if (doneText) doneText.textContent = `Exported ${message.count} chats to ${message.filename}`;
      showScreen('done');
      
    } else if (message.action === 'EXPORT_ERROR' && message.error === 'daily_limit_reached') {
      showError("You've reached your 20 export limit for today. Come back tomorrow for more free exports.");

    } else if (message.action === 'EXPORT_TRIMMED') {
      const subtitle = document.getElementById('export-subtitle') || document.querySelector('.export-subtitle');
      if (subtitle) subtitle.textContent = `Free plan: exporting ${message.allowed} of ${message.requested} selected chats.`;

    } else if (message.action === 'EXPORT_ERROR') {
      showError('Export failed: ' + message.message);
      const detailsEl = document.getElementById('error-details');
      if (detailsEl) {
        detailsEl.innerHTML = '';
        (message.errors || []).slice(0, 3).forEach(err => {
          const li = document.createElement('li');
          li.textContent = `${err.title}: ${err.error}`;
          detailsEl.appendChild(li);
        });
      }

    } else if (message.action === 'EXPORT_CANCELLED') {
      showScreen('selection');

    } else if (message.action === 'THREAD_COUNT_UPDATE') {
      const hint = document.querySelector('.loading-hint');
      if (hint) hint.textContent = `Loading… ${message.count} threads found`;
    }
  });
});
