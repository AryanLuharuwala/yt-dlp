/**
 * Background service worker (Manifest V3).
 *
 * Internal messages  (from content scripts / popup):
 *   YTDLP_FETCH_PLAYER_JS   – fetch player JS cross-origin
 *   YTDLP_FORMATS_READY     – content script finished processing a tab
 *   YTDLP_NO_DATA           – content script found no video on the page
 *   YTDLP_GET_TAB_STATE     – popup requests active-tab format list
 *   YTDLP_DOWNLOAD          – trigger chrome.downloads for a format URL
 *   YTDLP_VIMEO_FORMATS     – fetch Vimeo CDN config
 *
 * External messages  (from any web page via externally_connectable):
 *   search(query)           – search YouTube, return [{videoId, title, …}]
 *   resolve(videoId|url)    – resolve formats (with caching)
 *   download(videoId, itag) – cache video in OPFS; poll cacheStatus for progress
 *   cacheStatus(videoId, itag) – download progress / done / error
 *   getCachedBlob(videoId, itag) – return cached video as base64 data URL
 *   listCache()             – list all OPFS-cached videos
 *   evict(videoId, itag)    – remove from OPFS cache
 */

import { fetchSearchPage, fetchPlayerJs, resolveVideoId } from './youtube-fetcher.js';
import { parseSearchResults }   from './youtube-search.js';
import {
  getMetadata, setMetadata,
  downloadToCache, getCachedBlob, getCacheStatus, evictFromCache, listCache,
} from './cache-manager.js';

// ── Per-tab state (active page watching via content scripts) ──────────────────
const tabState = new Map();

// ── Internal message router ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'YTDLP_FETCH_PLAYER_JS':
      fetchPlayerJs(msg.playerJsUrl).then(playerJs => sendResponse({ playerJs }));
      return true;

    case 'YTDLP_FORMATS_READY':
      if (sender.tab?.id != null) {
        tabState.set(sender.tab.id, { videoInfo: msg.videoInfo, formats: msg.formats, ts: Date.now() });
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
      getActiveTabState().then(s => sendResponse(s));
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

// ── External message router (from web pages via externally_connectable) ───────
chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  handleExternal(msg).then(sendResponse).catch(e => sendResponse({ error: String(e) }));
  return true; // async
});

async function handleExternal(msg) {
  switch (msg.action) {

    case 'search': {
      if (!msg.query) throw new Error('query is required');
      const initialData = await fetchSearchPage(msg.query);
      const results = parseSearchResults(initialData);
      return { results };
    }

    case 'resolve': {
      const videoId = extractVideoId(msg.videoId || msg.url);
      if (!videoId) throw new Error('videoId or url is required');

      // Return from metadata cache if fresh
      const cached = await getMetadata(videoId);
      if (cached) return { videoId, ...cached, fromCache: true };

      const { videoInfo, formats } = await resolveVideoId(videoId);
      await setMetadata(videoId, { videoInfo, formats });
      return { videoId, videoInfo, formats, fromCache: false };
    }

    case 'download': {
      const videoId = extractVideoId(msg.videoId || msg.url);
      if (!videoId) throw new Error('videoId or url is required');

      // Resolve if needed
      let formats;
      const cached = await getMetadata(videoId);
      if (cached) {
        formats = cached.formats;
      } else {
        const resolved = await resolveVideoId(videoId);
        await setMetadata(videoId, { videoInfo: resolved.videoInfo, formats: resolved.formats });
        formats = resolved.formats;
      }

      // Pick format: prefer requested itag, else best combined, else best video-only
      const itag = msg.itag ?? null;
      const fmt  = itag
        ? formats.find(f => f.itag === itag)
        : (formats.find(f => f.hasVideo && f.hasAudio) || formats.find(f => f.hasVideo));

      if (!fmt) throw new Error('No suitable format found');

      // Start download in background (do NOT await — let caller poll cacheStatus)
      downloadToCache(videoId, fmt.itag, fmt.url, fmt.mimeType).catch(e =>
        console.error('yt-dlp cache error:', e)
      );

      return { videoId, itag: fmt.itag, status: 'started' };
    }

    case 'cacheStatus': {
      const videoId = extractVideoId(msg.videoId || msg.url);
      if (!videoId) throw new Error('videoId is required');
      const status = await getCacheStatus(videoId, msg.itag ?? null);
      return { videoId, itag: msg.itag ?? null, ...status };
    }

    case 'getCachedBlob': {
      const videoId = extractVideoId(msg.videoId || msg.url);
      if (!videoId) throw new Error('videoId is required');
      const blob = await getCachedBlob(videoId, msg.itag ?? null);
      if (!blob) return { videoId, found: false };

      // Convert to base64 data URL so it can cross the message boundary
      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
      const b64 = btoa(binary);
      return {
        videoId,
        found: true,
        dataUrl: `data:${blob.type};base64,${b64}`,
        mimeType: blob.type,
        size: blob.size,
      };
    }

    case 'listCache': {
      const entries = await listCache();
      return { entries };
    }

    case 'evict': {
      const videoId = extractVideoId(msg.videoId || msg.url);
      if (!videoId) throw new Error('videoId is required');
      await evictFromCache(videoId, msg.itag ?? null);
      return { ok: true };
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractVideoId(input) {
  if (!input) return null;
  // Already a bare video ID (11 alphanumeric chars)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input.startsWith('http') ? input : 'https://' + input);
    return url.searchParams.get('v') || url.pathname.replace('/', '') || null;
  } catch (_) {
    return null;
  }
}

async function getActiveTabState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return tabState.get(tab.id) || null;
}

chrome.tabs.onRemoved.addListener(tabId => tabState.delete(tabId));

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const url = tab.url || '';
  if (!isSupportedUrl(url)) return;
  tabState.delete(tabId);
  chrome.tabs.sendMessage(tabId, { type: 'YTDLP_REINJECT' }).catch(() => {});
});

function isSupportedUrl(url) {
  return (
    url.includes('youtube.com/watch') ||
    url.startsWith('https://youtu.be/') ||
    /^https:\/\/vimeo\.com\/\d/.test(url)
  );
}

async function startDownload(url, filename, ext) {
  try {
    return await chrome.downloads.download({
      url,
      filename: sanitizeFilename(filename) + '.' + (ext || 'mp4'),
      saveAs: true,
      conflictAction: 'uniquify',
    });
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
    const resp = await fetch(`https://player.vimeo.com/video/${videoId}/config`, {
      headers: { Referer: 'https://vimeo.com/' },
      credentials: 'omit',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const files = data?.request?.files;
    if (!files) return null;

    const formats = [];
    for (const f of files.progressive || []) {
      formats.push({
        itag: null, url: f.url, ext: 'mp4', mimeType: 'video/mp4',
        quality: String(f.quality || ''), qualityLabel: `${f.height || ''}p`,
        width: f.width || null, height: f.height || null, fps: f.fps || null,
        bitrate: (f.bitrate || 0) * 1000, contentLength: null,
        audioQuality: 'AUDIO_QUALITY_MEDIUM', audioSampleRate: null, audioChannels: 2,
        hasVideo: true, hasAudio: true,
      });
    }
    return formats.length ? formats : null;
  } catch (e) {
    console.error('yt-dlp: Vimeo fetch failed:', e);
    return null;
  }
}
