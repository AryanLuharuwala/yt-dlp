/**
 * Fetches a YouTube page directly from the service worker and extracts
 * ytInitialPlayerResponse + playerJsUrl without needing a content script.
 * HTML parsing is delegated to the offscreen document (needs DOMParser).
 */

import { ensureOffscreen, sendToOffscreen } from './offscreen-bridge.js';

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Player JS in-memory cache (keyed by full URL)
const _playerJsCache = new Map();

export async function fetchPlayerJs(playerJsUrl) {
  const fullUrl = playerJsUrl.startsWith('http')
    ? playerJsUrl
    : 'https://www.youtube.com' + playerJsUrl;
  if (_playerJsCache.has(fullUrl)) return _playerJsCache.get(fullUrl);
  const resp = await fetch(fullUrl, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`Player JS fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();
  _playerJsCache.set(fullUrl, text);
  return text;
}

/**
 * Fetch a YouTube video page and return { playerResponse, playerJsUrl }.
 */
export async function fetchVideoPage(videoId) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  const html = await fetchHtml(url);
  const { playerResponse, playerJsUrl } = await parsePage(html);
  return { playerResponse, playerJsUrl };
}

/**
 * Fetch a YouTube search results page and return raw ytInitialData.
 */
export async function fetchSearchPage(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`;
  const html = await fetchHtml(url);
  const { initialData } = await parsePage(html);
  return initialData;
}

async function fetchHtml(url) {
  const resp = await fetch(url, { headers: FETCH_HEADERS, credentials: 'omit' });
  if (!resp.ok) throw new Error(`YouTube fetch failed: HTTP ${resp.status}`);
  return resp.text();
}

async function parsePage(html) {
  await ensureOffscreen();
  const resp = await sendToOffscreen({ target: 'offscreen:domparse', html });
  if (!resp.ok) throw new Error(`DOM parse failed: ${resp.error}`);
  return resp.result;
}

/**
 * Full resolve pipeline for a video ID:
 *  fetch page → extract player response + player JS → solve challenges → return formats
 */
export async function resolveVideoId(videoId) {
  const { playerResponse, playerJsUrl } = await fetchVideoPage(videoId);

  if (!playerResponse?.streamingData) {
    throw new Error(`No streaming data found for ${videoId}`);
  }

  const rawFormats = [
    ...(playerResponse.streamingData.formats || []),
    ...(playerResponse.streamingData.adaptiveFormats || []),
  ];

  const videoDetails = playerResponse.videoDetails || {};
  const videoInfo = {
    videoId:       videoDetails.videoId || videoId,
    title:         videoDetails.title || 'Untitled',
    author:        videoDetails.author || '',
    lengthSeconds: parseInt(videoDetails.lengthSeconds || '0'),
    thumbnail:     (videoDetails.thumbnail?.thumbnails || []).slice(-1)[0]?.url || '',
    site:          'youtube',
  };

  // Collect challenges
  const sigChallenges = [];
  const nChallenges   = [];

  for (const fmt of rawFormats) {
    if (fmt.signatureCipher || fmt.cipher) {
      const p = new URLSearchParams(fmt.signatureCipher || fmt.cipher);
      const s = p.get('s');
      if (s && !sigChallenges.includes(s)) sigChallenges.push(s);
    }
    const fmtUrl = fmt.url;
    if (fmtUrl) {
      try {
        const n = new URL(fmtUrl).searchParams.get('n');
        if (n && !nChallenges.includes(n)) nChallenges.push(n);
      } catch (_) {}
    }
  }

  // Solve via offscreen document
  const solvedSig = {};
  const solvedN   = {};

  if (playerJsUrl && (sigChallenges.length || nChallenges.length)) {
    const playerJs = await fetchPlayerJs(playerJsUrl);
    if (playerJs) {
      await ensureOffscreen();
      const requests = [];
      if (sigChallenges.length) requests.push({ type: 'sig', challenges: sigChallenges });
      if (nChallenges.length)   requests.push({ type: 'n',   challenges: nChallenges });

      const resp = await sendToOffscreen({ target: 'offscreen:solve', playerJs, requests });
      if (resp.ok && resp.result?.type === 'result') {
        for (const [req, res] of zip(requests, resp.result.responses)) {
          if (res.type !== 'result') continue;
          if (req.type === 'sig') Object.assign(solvedSig, res.data);
          if (req.type === 'n')   Object.assign(solvedN,   res.data);
        }
      }
    }
  }

  // Build final format list
  const formats = [];
  for (const fmt of rawFormats) {
    let url = fmt.url || null;

    if (!url && (fmt.signatureCipher || fmt.cipher)) {
      const p   = new URLSearchParams(fmt.signatureCipher || fmt.cipher);
      const s   = p.get('s');
      const sp  = p.get('sp') || 'signature';
      const base = p.get('url');
      if (s && base && solvedSig[s]) {
        url = `${base}&${sp}=${encodeURIComponent(solvedSig[s])}`;
      } else {
        continue; // cannot decrypt
      }
    }

    if (!url) continue;

    try {
      const u = new URL(url);
      const n = u.searchParams.get('n');
      if (n && solvedN[n]) {
        u.searchParams.set('n', solvedN[n]);
        url = u.toString();
      }
    } catch (_) {}

    const [mimeRaw] = (fmt.mimeType || '').split(';');
    const [kind, container] = mimeRaw.split('/');

    formats.push({
      itag:            fmt.itag,
      url,
      ext:             container || 'mp4',
      mimeType:        fmt.mimeType || '',
      quality:         fmt.quality || '',
      qualityLabel:    fmt.qualityLabel || '',
      width:           fmt.width  || null,
      height:          fmt.height || null,
      fps:             fmt.fps    || null,
      bitrate:         fmt.bitrate || 0,
      contentLength:   fmt.contentLength ? parseInt(fmt.contentLength) : null,
      audioQuality:    fmt.audioQuality || null,
      audioSampleRate: fmt.audioSampleRate || null,
      audioChannels:   fmt.audioChannels || null,
      hasVideo:        kind === 'video',
      hasAudio:        !!fmt.audioQuality || kind === 'audio',
    });
  }

  return { videoInfo, formats };
}

function zip(a, b) { return a.map((v, i) => [v, b[i]]); }
