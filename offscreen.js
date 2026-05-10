// Chat Exporter — offscreen document
// Service workers cannot call URL.createObjectURL(). This document runs in a
// real browser context with access to JSZip (loaded in offscreen.html).
// It builds the ZIP blob, creates a URL, and returns it to background.js.
// background.js then calls chrome.downloads.download() — the only context that
// has both Blob support AND the downloads permission.

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.target !== 'offscreen' || request.action !== 'CREATE_ZIP') return;

  (async () => {
    try {
      console.log('[Chatavio] typeof JSZip !== "undefined":', typeof JSZip !== 'undefined');
      console.log('[Chatavio] Received files to ZIP:', request.files?.length);
      const zip = new JSZip();
      const folder = zip.folder('Chatavio');

      const seen = new Map(); // filename → use count (for dedup suffix)
      for (const file of request.files) {
        let filename = file.filename;
        if (seen.has(filename)) {
          const n = seen.get(filename) + 1;
          seen.set(filename, n);
          const dot = filename.lastIndexOf('.');
          filename = dot >= 0
            ? `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`
            : `${filename} (${n})`;
        } else {
          seen.set(filename, 1);
        }
        folder.file(filename, file.content);
      }
      console.log('[Chatavio] Unique filenames in ZIP:', seen.size);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      // URL is revoked by background.js closing this document after a delay.
      sendResponse({ ok: true, url });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // keep message channel open for async sendResponse
});
