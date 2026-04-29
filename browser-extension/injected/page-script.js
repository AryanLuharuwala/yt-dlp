/**
 * Injected into the page's JavaScript context (not the extension isolated world).
 * Can access window.ytInitialPlayerResponse, ytcfg, etc.
 * Communicates back to the content script via window.postMessage.
 */
(function () {
  const site = detectSite();
  if (!site) return;

  const data = extractPageData(site);
  window.postMessage({ type: 'YTDLP_PAGE_DATA', site, data }, '*');

  function detectSite() {
    const host = location.hostname;
    if (host === 'www.youtube.com' || host === 'youtu.be') return 'youtube';
    if (host === 'vimeo.com') return 'vimeo';
    return null;
  }

  function extractPageData(site) {
    if (site === 'youtube') return extractYouTube();
    if (site === 'vimeo') return extractVimeo();
    return null;
  }

  function extractYouTube() {
    const playerResponse = window.ytInitialPlayerResponse || null;

    // Player JS URL – needed to solve sig/n challenges
    let playerJsUrl = null;
    try {
      const cfgData = window.ytcfg && window.ytcfg.data_;
      if (cfgData) {
        playerJsUrl =
          cfgData.PLAYER_JS_URL ||
          (cfgData.WEB_PLAYER_CONTEXT_CONFIGS &&
            Object.values(cfgData.WEB_PLAYER_CONTEXT_CONFIGS)[0]?.jsUrl) ||
          null;
      }
    } catch (_) {}

    // Fallback: scrape player JS URL from page source
    if (!playerJsUrl) {
      const scripts = document.querySelectorAll('script[src]');
      for (const s of scripts) {
        if (s.src && s.src.includes('/s/player/')) {
          try {
            const url = new URL(s.src);
            playerJsUrl = url.pathname + url.search;
            break;
          } catch (_) {}
        }
      }
    }

    const videoId = new URLSearchParams(location.search).get('v') ||
      location.pathname.replace('/', '');

    return { playerResponse, playerJsUrl, videoId };
  }

  function extractVimeo() {
    // Vimeo embeds config in a script tag as window.vimeo.clip_page_config
    // or in a JSON blob with id="__NEXT_DATA__"
    let config = null;
    try {
      config = window.__NEXT_DATA__ || null;
    } catch (_) {}

    const videoId = location.pathname.split('/').filter(Boolean).find(s => /^\d+$/.test(s)) || null;
    return { config, videoId };
  }
})();
