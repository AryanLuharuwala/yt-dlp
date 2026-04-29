/**
 * Offscreen document script.
 * Receives tasks from the service worker that require eval() / DOMParser.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.target) {
    case 'offscreen:solve':   handleSolve(msg, sendResponse);   return true;
    case 'offscreen:domparse': handleDomParse(msg, sendResponse); return true;
    default: break;
  }
});

// ── JS challenge solver ───────────────────────────────────────────────────────

function handleSolve(msg, sendResponse) {
  if (typeof ytdlpJsc !== 'function') {
    sendResponse({ ok: false, error: 'solver not loaded' });
    return;
  }
  try {
    const result = ytdlpJsc({
      type: 'player',
      player: msg.playerJs,
      requests: msg.requests,
      output_preprocessed: false,
    });
    sendResponse({ ok: true, result });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
}

// ── DOM parser for extracting JSON blobs from YouTube page HTML ──────────────

function handleDomParse(msg, sendResponse) {
  try {
    const doc = new DOMParser().parseFromString(msg.html, 'text/html');
    const result = {};

    for (const script of doc.querySelectorAll('script')) {
      const text = script.textContent || '';

      if (!result.playerResponse) {
        const m = text.match(/var ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;(?=\s*(?:var|const|let|<\/|if|window))/);
        if (m) {
          try { result.playerResponse = JSON.parse(m[1]); } catch (_) {}
        }
      }

      if (!result.initialData) {
        const m = text.match(/var ytInitialData\s*=\s*(\{[\s\S]+?\})\s*;(?=\s*(?:var|const|let|<\/|if|window))/);
        if (m) {
          try { result.initialData = JSON.parse(m[1]); } catch (_) {}
        }
      }

      if (!result.playerJsUrl) {
        const m = text.match(/"PLAYER_JS_URL"\s*:\s*"([^"]+)"/);
        if (m) result.playerJsUrl = m[1];
      }

      if (!result.playerJsUrl) {
        const m = text.match(/"jsUrl"\s*:\s*"([^"]+\/s\/player\/[^"]+)"/);
        if (m) result.playerJsUrl = m[1];
      }
    }

    sendResponse({ ok: true, result });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
}
