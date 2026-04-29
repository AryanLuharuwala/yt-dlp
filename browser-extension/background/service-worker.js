/**
 * Background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - Fetch player JS cross-origin (background scripts bypass CORS for declared host_permissions)
 *  - Receive processed formats from content scripts and store per-tab
 *  - Serve format data to the popup
 *  - Trigger file downloads via chrome.downloads
 *  - Handle Vimeo CDN URL resolution (requires a signed config URL from the page)
 *
 * NOTE: Service workers in MV3 cannot use eval() or new Function().
 *       All JS challenge solving happens in content.js instead.
 */

// In-memory tab state.  Keyed by tab id.
const tabState = new Map();

// ── Message routing ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'YTDLP_FETCH_PLAYER_JS':
      fetchPlayerJs(msg.playerJsUrl).then(playerJs => sendResponse({ playerJs }));
      return true; // keep channel open for async response

    case 'YTDLP_FORMATS_READY':
      if (sender.tab?.id != null) {
        tabState.set(sender.tab.id, {
          videoInfo: msg.videoInfo,
          formats:   msg.formats,
          ts:        Date.now(),
        });
        // Notify any open popup that data arrived
        chrome.runtime.sendMessage({ type: 'YTDLP_DATA_UPDATED', tabId: sender.tab.id }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;

    case 'YTDLP_NO_DATA':
      if (sender.tab?.id != null) {
        tabState.set(sender.tab.id, { videoInfo: null, formats: null, ts: Date.now() });
        chrome.runtime.sendMessage({ type: 'YTDLP_DATA_UPDATED', tabId: sender.tab.id }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;

    case 'YTDLP_GET_TAB_STATE':
      // Called by the popup to retrieve data for the currently active tab
      getActiveTabState().then(state => sendResponse(state));
      return true;

    case 'YTDLP_DOWNLOAD':
      startDownload(msg.url, msg.filename, msg.ext).then(id => sendResponse({ downloadId: id }));
      return true;

    case 'YTDLP_VIMEO_FORMATS':
      fetchVimeoFormats(msg.videoId).then(formats => sendResponse({ formats }));
      return true;

    default:
      break;
  }
});

// ── Player JS fetching ────────────────────────────────────────────────────────

const playerJsCache = new Map(); // url → js text

async function fetchPlayerJs(playerJsUrl) {
  // playerJsUrl is typically a path like /s/player/HASH/player_ias.vflset/en_US/base.js
  const fullUrl = playerJsUrl.startsWith('http')
    ? playerJsUrl
    : 'https://www.youtube.com' + playerJsUrl;

  if (playerJsCache.has(fullUrl)) return playerJsCache.get(fullUrl);

  try {
    const resp = await fetch(fullUrl, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    playerJsCache.set(fullUrl, text);
    return text;
  } catch (e) {
    console.error('yt-dlp: player JS fetch failed:', e);
    return null;
  }
}

// ── Tab state ─────────────────────────────────────────────────────────────────

async function getActiveTabState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return tabState.get(tab.id) || null;
}

// Clean up state when a tab is closed
chrome.tabs.onRemoved.addListener(tabId => tabState.delete(tabId));

// Reinject when a tab navigates to a new video page
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab.url || '';
  if (!isSupportedUrl(url)) return;

  // Clear stale state and ask content script to reinject
  tabState.delete(tabId);
  chrome.tabs.sendMessage(tabId, { type: 'YTDLP_REINJECT' }).catch(() => {
    // Content script not loaded yet – it will inject automatically when ready
  });
});

function isSupportedUrl(url) {
  return (
    url.includes('youtube.com/watch') ||
    url.startsWith('https://youtu.be/') ||
    /^https:\/\/vimeo\.com\/\d/.test(url)
  );
}

// ── Downloads ─────────────────────────────────────────────────────────────────

async function startDownload(url, filename, ext) {
  const safeName = sanitizeFilename(filename) + '.' + (ext || 'mp4');
  try {
    const id = await chrome.downloads.download({
      url,
      filename: safeName,
      saveAs: true,
      conflictAction: 'uniquify',
    });
    return id;
  } catch (e) {
    console.error('yt-dlp: download failed:', e);
    return null;
  }
}

function sanitizeFilename(name) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

// ── Vimeo ─────────────────────────────────────────────────────────────────────

async function fetchVimeoFormats(videoId) {
  if (!videoId) return null;
  try {
    // Vimeo's public player config endpoint (no auth required for public videos)
    const resp = await fetch(`https://player.vimeo.com/video/${videoId}/config`, {
      headers: { Referer: 'https://vimeo.com/' },
      credentials: 'omit',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const files = data?.request?.files;
    if (!files) return null;

    const formats = [];

    // Progressive (combined audio+video) streams
    for (const f of files.progressive || []) {
      formats.push({
        itag: null,
        url: f.url,
        ext: 'mp4',
        mimeType: 'video/mp4',
        quality: String(f.quality || ''),
        qualityLabel: `${f.height || ''}p`,
        width: f.width || null,
        height: f.height || null,
        fps: f.fps || null,
        bitrate: (f.bitrate || 0) * 1000,
        contentLength: null,
        audioQuality: 'AUDIO_QUALITY_MEDIUM',
        audioSampleRate: null,
        audioChannels: 2,
        hasVideo: true,
        hasAudio: true,
      });
    }

    // HLS / DASH adaptive (video-only + audio-only) – provide as separate entries
    const dash = files.dash?.cdns;
    if (dash) {
      for (const [, cdn] of Object.entries(dash)) {
        if (cdn.url) {
          formats.push({
            itag: null,
            url: cdn.url,
            ext: 'mpd',
            mimeType: 'application/dash+xml',
            quality: 'dash',
            qualityLabel: 'DASH (adaptive)',
            width: null,
            height: null,
            fps: null,
            bitrate: 0,
            contentLength: null,
            audioQuality: null,
            audioSampleRate: null,
            audioChannels: null,
            hasVideo: true,
            hasAudio: true,
          });
          break; // one DASH manifest is enough
        }
      }
    }

    return formats.length ? formats : null;
  } catch (e) {
    console.error('yt-dlp: Vimeo fetch failed:', e);
    return null;
  }
}
