/**
 * yt-dlp Web – client library
 *
 * Include this in any web page that needs to talk to the extension.
 * The extension must have the page's origin listed in externally_connectable
 * (or you can use "<all_urls>" during development).
 *
 * Quick start
 * -----------
 *
 *   <script src="yt-dlp-web-client.js"></script>
 *   <script>
 *     const yt = new YtDlpWebClient('YOUR_EXTENSION_ID');
 *
 *     // Search
 *     const { results } = await yt.search('lofi hip hop');
 *
 *     // Resolve format list (cached 5 h)
 *     const { formats } = await yt.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
 *
 *     // Download a format into the browser's OPFS (background, poll for progress)
 *     await yt.download('dQw4w9WgXcQ', { itag: 22 });
 *     const status = await yt.cacheStatus('dQw4w9WgXcQ', 22);
 *     // status.status: 'downloading' | 'done' | 'error' | 'none'
 *     // status.received / status.total: bytes
 *
 *     // Get the cached video as a Blob URL you can pass to <video src="...">
 *     const { dataUrl } = await yt.getCachedBlob('dQw4w9WgXcQ', 22);
 *     videoEl.src = dataUrl;
 *
 *     // Or just get the direct CDN stream URL (no download)
 *     const best = formats.find(f => f.hasVideo && f.hasAudio);
 *     videoEl.src = best.url;
 *   </script>
 */

class YtDlpWebClient {
  /**
   * @param {string} extensionId – Chrome extension ID
   *   (shown in chrome://extensions after loading the extension)
   */
  constructor(extensionId) {
    if (!extensionId) throw new Error('YtDlpWebClient: extensionId is required');
    this._id = extensionId;
  }

  /**
   * Search YouTube.
   * @param {string} query
   * @returns {Promise<{results: SearchResult[]}>}
   */
  search(query) {
    return this._send({ action: 'search', query });
  }

  /**
   * Resolve a YouTube video's streaming URLs (format list).
   * Results are cached for 5 hours inside the extension.
   *
   * @param {string} videoIdOrUrl – e.g. 'dQw4w9WgXcQ' or full YouTube URL
   * @returns {Promise<{videoId, videoInfo, formats: Format[], fromCache: boolean}>}
   */
  resolve(videoIdOrUrl) {
    return this._send({ action: 'resolve', url: videoIdOrUrl });
  }

  /**
   * Download a video format into the browser's OPFS cache.
   * Returns immediately; use cacheStatus() to poll progress.
   *
   * @param {string} videoIdOrUrl
   * @param {{ itag?: number }} [options]
   * @returns {Promise<{videoId, itag, status: 'started'}>}
   */
  download(videoIdOrUrl, options = {}) {
    return this._send({ action: 'download', url: videoIdOrUrl, itag: options.itag ?? null });
  }

  /**
   * Check the download / cache status for a video.
   * @param {string} videoIdOrUrl
   * @param {number|null} [itag]
   * @returns {Promise<CacheStatus>}
   */
  cacheStatus(videoIdOrUrl, itag = null) {
    return this._send({ action: 'cacheStatus', url: videoIdOrUrl, itag });
  }

  /**
   * Wait for a download to complete, polling every `intervalMs`.
   * Rejects if the download errors out.
   *
   * @param {string} videoIdOrUrl
   * @param {number|null} [itag]
   * @param {{ intervalMs?: number, onProgress?: (received, total) => void }} [options]
   * @returns {Promise<CacheStatus>}
   */
  async waitForDownload(videoIdOrUrl, itag = null, { intervalMs = 500, onProgress } = {}) {
    while (true) {
      const status = await this.cacheStatus(videoIdOrUrl, itag);
      if (status.status === 'done')  return status;
      if (status.status === 'error') throw new Error(status.error || 'Download failed');
      onProgress?.(status.received || 0, status.total || 0);
      await sleep(intervalMs);
    }
  }

  /**
   * Retrieve a cached video as a base64 data URL.
   * Use the returned dataUrl directly as a <video> src.
   * NOTE: Large videos (> ~200 MB) will be slow; consider streaming instead.
   *
   * @param {string} videoIdOrUrl
   * @param {number|null} [itag]
   * @returns {Promise<{found: boolean, dataUrl?: string, mimeType?: string, size?: number}>}
   */
  getCachedBlob(videoIdOrUrl, itag = null) {
    return this._send({ action: 'getCachedBlob', url: videoIdOrUrl, itag });
  }

  /**
   * Convenience: download + wait + return data URL in one call.
   *
   * @param {string} videoIdOrUrl
   * @param {{ itag?: number, onProgress?: (recv, total) => void }} [options]
   * @returns {Promise<string>} data URL
   */
  async fetch(videoIdOrUrl, { itag, onProgress } = {}) {
    await this.download(videoIdOrUrl, { itag });
    const status = await this.waitForDownload(videoIdOrUrl, itag ?? null, { onProgress });
    const result = await this.getCachedBlob(videoIdOrUrl, status.itag ?? itag ?? null);
    if (!result.found) throw new Error('Video not found in cache after download');
    return result.dataUrl;
  }

  /**
   * List all videos currently stored in the OPFS cache.
   * @returns {Promise<{entries: CacheEntry[]}>}
   */
  listCache() {
    return this._send({ action: 'listCache' });
  }

  /**
   * Remove a video from the OPFS cache.
   * @param {string} videoIdOrUrl
   * @param {number|null} [itag]
   */
  evict(videoIdOrUrl, itag = null) {
    return this._send({ action: 'evict', url: videoIdOrUrl, itag });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _send(msg) {
    return new Promise((resolve, reject) => {
      // chrome.runtime is injected by the browser when the extension is installed
      if (typeof chrome === 'undefined' || !chrome.runtime) {
        reject(new Error('chrome.runtime is not available – are you in a browser?'));
        return;
      }
      chrome.runtime.sendMessage(this._id, msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// CommonJS + ESM + browser global
if (typeof module !== 'undefined') module.exports = { YtDlpWebClient };
if (typeof window !== 'undefined') window.YtDlpWebClient = YtDlpWebClient;

/**
 * @typedef {{ videoId: string, title: string, author: string, duration: string,
 *             viewCount: string, thumbnail: string, url: string, isLive: boolean }} SearchResult
 *
 * @typedef {{ itag: number|null, url: string, ext: string, mimeType: string,
 *             quality: string, qualityLabel: string, width: number|null,
 *             height: number|null, fps: number|null, bitrate: number,
 *             contentLength: number|null, hasVideo: boolean, hasAudio: boolean }} Format
 *
 * @typedef {{ status: 'none'|'downloading'|'done'|'error',
 *             received?: number, total?: number,
 *             mimeType?: string, error?: string }} CacheStatus
 *
 * @typedef {{ key: string, status: string, received: number, total: number,
 *             mimeType: string, filename: string }} CacheEntry
 */
