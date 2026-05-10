# Chat Exporter

**Created:** April 30, 2026  
**Vibe coding tool:** [Claude Code](https://claude.ai/code) by Anthropic  
**Assisted by:** Claude (claude.ai) for architecture, debugging, and prompts  

> Name is **Chat Exporter** until a better name comes along. Kept generic intentionally — the goal is cross-browser support (Chrome, Firefox, Edge, Safari).

---

## What it does

A browser extension (Manifest V3) that scrapes live conversations from Claude.ai, ChatGPT, Perplexity, and Gemini and exports them as a ZIP file — no manual platform export required.

### Key features
- Browse and select individual threads via a checklist UI
- Search and filter threads by keyword
- Configurable limit: 20 / 50 / 100 / 200 / All threads
- Export formats: Markdown, JSON, Plain Text
- Bulk export packaged as a single ZIP file
- One file per chat: `YYYY-MM-DD - Chat Title.md`
- Export runs in background — safe to close the popup
- Works on Claude.ai, ChatGPT, Perplexity, and Gemini

---

## Browser support

| Browser | Status | Notes |
|---|---|---|
| Chrome | ✅ Working | Primary development target |
| Edge | 🔲 Untested | Chromium-based, MV3 compatible — likely works |
| Firefox | 🔲 Untested | Requires MV2 or Firefox MV3 adapter — needs testing |
| Safari | 🔲 Untested | Requires Xcode + Safari Web Extension wrapper |
| Brave | 🔲 Untested | Chromium-based — likely works |
| Arc | 🔲 Untested | Chromium-based — likely works |

---

## How to load (development)

### Chrome / Edge / Brave / Arc
1. Go to `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `Chat Exporter` project folder
5. Navigate to any chat on Claude.ai, ChatGPT, Perplexity, or Gemini
6. Click the extension icon

### Firefox
1. Go to `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on**
3. Select `manifest.json` from the project folder

---

## File structure

| File | Role |
|---|---|
| `manifest.json` | MV3 — permissions, host rules, content script registration, service worker |
| `background.js` | Owns bulk export lifecycle — survives popup closing |
| `content.js` | Scrapers for all 4 sites (Claude, ChatGPT, Perplexity, Gemini) + PING/PONG connection handshake |
| `popup.html` | Extension popup shell |
| `popup.js` | UI state machine — thread list, search, format/limit selectors, progress |
| `offscreen.html` | Offscreen document shell for download context |
| `offscreen.js` | Creates ZIP via JSZip, triggers `chrome.downloads.download()` |
| `jszip.min.js` | Bundled locally (CDN blocked by extension CSP) |
| `styles.css` | Dark theme, spinner, progress bar, site-colored badges |

---

## Architecture notes

### Why background.js owns the export
MV3 popup pages are destroyed when closed. All scraping and ZIP creation is driven by `background.js` (service worker) so exports survive popup close. Popup reconnects via `chrome.storage.session` if reopened mid-export.

### Why offscreen.js exists
MV3 service workers cannot create Blob URLs. `offscreen.js` runs in a minimal offscreen document that has DOM access, creates the ZIP Blob, and calls `chrome.downloads.download()`.

### Perplexity scraping approach
Perplexity is a CSR Next.js app — raw HTML fetching returns an empty shell. Bulk export opens each thread in a real background tab, waits for React hydration (polls for answer elements, max 8s), scrapes the live DOM, then closes the tab.

---

## Known limitations

- **Perplexity bulk export:** background tab hydration can occasionally time out on slow connections
- **Claude/ChatGPT:** use internal APIs — stable as of April 2026 but subject to change if endpoints rotate
- **Thread limit:** configurable up to "All" — large exports (200+) may take several minutes
- **Keep popup open** for "Export Current Chat" — single chat export uses popup context directly

---

## Updating the extension

### Local development
1. Edit files in the project folder
2. Go to `chrome://extensions` → click **Reload** on the extension card
3. Bump the `version` field in `manifest.json` for each meaningful change

### Publishing to Chrome Web Store
1. Zip the project folder (exclude `.git`, `node_modules`)
2. Go to [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
3. Upload zip → fill listing details → submit for review (1–3 business days)
4. Users receive updates automatically

### Version convention
```
1.0.0 → bug fix → 1.0.1
1.0.1 → new feature → 1.1.0
1.1.0 → major change → 2.0.0
```

---

## Roadmap

- [ ] Fix Perplexity infinite scroll to load beyond initial visible threads
- [ ] Test Claude.ai and ChatGPT bulk export end-to-end
- [ ] Add Nexus-compatible YAML frontmatter to exported files
- [ ] Settings screen for Obsidian vault path (direct vault export)
- [ ] Post to Nexus AI Chat Importer forum as companion tool

---

## Related Obsidian notes

- [[2026-04-30 - Chat Exporter Chrome Extension]] — dev log and current status
- [[Nexus AI Chat Importer]] — the Obsidian plugin this tool complements

---

## Origin story

Built in a single session on April 30, 2026 using [[Claude Code]] as the primary vibe coding tool, with [[Claude]] (claude.ai) providing architecture decisions, debugging prompts, and UX design including the interactive popup preview.

The original goal was a simple chat exporter. During the session it evolved into a companion tool for [[Nexus AI Chat Importer]], targeting Obsidian power users who want zero-friction live chat import without the manual ZIP export workflow.
