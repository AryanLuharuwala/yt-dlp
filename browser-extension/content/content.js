/**
 * Content script – runs in the extension's isolated world on supported video pages.
 *
 * Flow:
 *  1. Inject page-script.js into the real page context so it can read
 *     window.ytInitialPlayerResponse and ytcfg.
 *  2. Receive page data via postMessage.
 *  3. Request the player JS from the background service worker (which can fetch
 *     cross-origin without CORS issues).
 *  4. Load solver.bundle.js (which exposes globalThis.ytdlpJsc) and solve
 *     sig + n challenges. Content scripts may use new Function() / eval().
 *  5. Decode all streaming URLs and send the finished format list to background.
 */

let solverReady = false;

function injectPageScript() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected/page-script.js');
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();
}

async function loadSolver() {
  if (solverReady) return;
  try {
    // Fetch the solver bundle and execute it in the content script's isolated world
    // using new Function().  Content scripts allow eval/new Function; service workers do not.
    // Running it here (not via <script> injection) keeps globalThis.ytdlpJsc accessible
    // from this isolated world rather than leaking into the page context.
    const url  = chrome.runtime.getURL('solver/solver.bundle.js');
    const resp = await fetch(url);
    const code = await resp.text();
    // eslint-disable-next-line no-new-func
    new Function(code)();
    solverReady = !!globalThis.ytdlpJsc;
  } catch (e) {
    console.error('yt-dlp: failed to load solver:', e);
  }
}

// ── YouTube ──────────────────────────────────────────────────────────────────

async function processYouTube(pageData) {
  const { playerResponse, playerJsUrl } = pageData;
  if (!playerResponse?.streamingData) {
    sendToBackground({ type: 'YTDLP_NO_DATA' });
    return;
  }

  const rawFormats = [
    ...(playerResponse.streamingData.formats || []),
    ...(playerResponse.streamingData.adaptiveFormats || []),
  ];

  const videoDetails = playerResponse.videoDetails || {};
  const videoInfo = {
    title:   videoDetails.title || 'Untitled',
    author:  videoDetails.author || '',
    videoId: videoDetails.videoId || '',
    lengthSeconds: parseInt(videoDetails.lengthSeconds || '0'),
    thumbnail: (videoDetails.thumbnail?.thumbnails || []).slice(-1)[0]?.url || '',
    site: 'youtube',
  };

  // Fetch player JS from background (service worker can do cross-origin fetch)
  let playerJs = null;
  if (playerJsUrl) {
    playerJs = await new Promise(resolve =>
      chrome.runtime.sendMessage(
        { type: 'YTDLP_FETCH_PLAYER_JS', playerJsUrl },
        resp => resolve(resp?.playerJs || null)
      )
    );
  }

  // Collect all sig + n challenges
  const sigChallenges = [];
  const nChallenges   = [];

  for (const fmt of rawFormats) {
    if (fmt.signatureCipher || fmt.cipher) {
      const params = new URLSearchParams(fmt.signatureCipher || fmt.cipher);
      const s = params.get('s');
      if (s && !sigChallenges.includes(s)) sigChallenges.push(s);
    }
    const url = fmt.url;
    if (url) {
      try {
        const n = new URL(url).searchParams.get('n');
        if (n && !nChallenges.includes(n)) nChallenges.push(n);
      } catch (_) {}
    }
  }

  // Solve challenges with the bundled JS solver (uses new Function internally)
  const solvedSig = {};
  const solvedN   = {};

  if (playerJs && (sigChallenges.length || nChallenges.length)) {
    await loadSolver();
    if (typeof globalThis.ytdlpJsc === 'function') {
      try {
        const requests = [];
        if (sigChallenges.length) requests.push({ type: 'sig', challenges: sigChallenges });
        if (nChallenges.length)   requests.push({ type: 'n',   challenges: nChallenges });

        const result = globalThis.ytdlpJsc({
          type: 'player',
          player: playerJs,
          requests,
          output_preprocessed: false,
        });

        if (result.type === 'result') {
          for (const [req, resp] of zip(requests, result.responses)) {
            if (resp.type !== 'result') continue;
            if (req.type === 'sig') Object.assign(solvedSig, resp.data);
            if (req.type === 'n')   Object.assign(solvedN,   resp.data);
          }
        }
      } catch (e) {
        console.warn('yt-dlp: solver error:', e);
      }
    }
  }

  // Build final format list with decoded URLs
  const formats = [];
  for (const fmt of rawFormats) {
    let url = fmt.url || null;
    let sigParam = 'signature';

    if (!url && (fmt.signatureCipher || fmt.cipher)) {
      const params = new URLSearchParams(fmt.signatureCipher || fmt.cipher);
      const s  = params.get('s');
      sigParam  = params.get('sp') || 'signature';
      const base = params.get('url');
      if (s && base) {
        const decrypted = solvedSig[s];
        if (decrypted) {
          url = base + '&' + sigParam + '=' + encodeURIComponent(decrypted);
        } else {
          // Cannot decrypt – skip this format
          continue;
        }
      }
    }

    if (!url) continue;

    // Apply n-param transformation to defeat throttling
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
      itag:         fmt.itag,
      url,
      ext:          container || 'mp4',
      mimeType:     fmt.mimeType || '',
      quality:      fmt.quality || '',
      qualityLabel: fmt.qualityLabel || '',
      width:        fmt.width  || null,
      height:       fmt.height || null,
      fps:          fmt.fps    || null,
      bitrate:      fmt.bitrate || 0,
      contentLength: fmt.contentLength ? parseInt(fmt.contentLength) : null,
      audioQuality:  fmt.audioQuality || null,
      audioSampleRate: fmt.audioSampleRate || null,
      audioChannels: fmt.audioChannels || null,
      hasVideo: kind === 'video',
      hasAudio: !!fmt.audioQuality || kind === 'audio',
    });
  }

  sendToBackground({ type: 'YTDLP_FORMATS_READY', videoInfo, formats });
}

// ── Vimeo ────────────────────────────────────────────────────────────────────

async function processVimeo(pageData) {
  const { config, videoId } = pageData;

  // Vimeo embeds its config in __NEXT_DATA__ under props.pageProps.clip
  const clip =
    config?.props?.pageProps?.clip ||
    config?.props?.pageProps?.videoData?.video ||
    null;

  if (!clip) {
    sendToBackground({ type: 'YTDLP_NO_DATA' });
    return;
  }

  const videoInfo = {
    title:  clip.title || clip.name || 'Untitled',
    author: clip.owner?.name || clip.user?.name || '',
    videoId: String(videoId || clip.id || ''),
    lengthSeconds: clip.duration || 0,
    thumbnail: (clip.pictures?.sizes || []).slice(-1)[0]?.link || '',
    site: 'vimeo',
  };

  // Vimeo requires an API call to get the actual CDN URLs – fetch from background
  const apiFormats = await new Promise(resolve =>
    chrome.runtime.sendMessage(
      { type: 'YTDLP_VIMEO_FORMATS', videoId: videoInfo.videoId },
      resp => resolve(resp?.formats || null)
    )
  );

  if (!apiFormats) {
    sendToBackground({ type: 'YTDLP_NO_DATA' });
    return;
  }

  sendToBackground({ type: 'YTDLP_FORMATS_READY', videoInfo, formats: apiFormats });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function zip(a, b) {
  return a.map((v, i) => [v, b[i]]);
}

function sendToBackground(msg) {
  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {
      // Background not yet ready – retry once after short delay
      setTimeout(() => chrome.runtime.sendMessage(msg), 500);
    }
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'YTDLP_PAGE_DATA') return;

  const { site, data } = event.data;
  if (site === 'youtube') await processYouTube(data);
  if (site === 'vimeo')   await processVimeo(data);
});

// Listen for popup requesting formats when content script was already done
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'YTDLP_REINJECT') {
    injectPageScript();
    sendResponse({ ok: true });
  }
});

injectPageScript();
