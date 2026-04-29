/**
 * Manages the extension's offscreen document lifecycle and provides a
 * typed sendMessage wrapper so service-worker code stays clean.
 */

let creating = null; // Promise while document is being created

export async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  // Older Chrome versions lack hasDocument – fall back gracefully
  if (existing) return;

  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen.createDocument({
    url:           chrome.runtime.getURL('offscreen/offscreen.html'),
    reasons:       ['DOM_SCRAPING'],
    justification: 'Parse YouTube page HTML and run JS challenge solver',
  }).catch(() => {
    // Document may already exist (race condition) – ignore
  }).finally(() => {
    creating = null;
  });

  await creating;
}

/**
 * Send a message to the offscreen document and await its response.
 * @param {object} msg – must include a `target` field (e.g. 'offscreen:solve')
 * @returns {Promise<any>}
 */
export function sendToOffscreen(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}
