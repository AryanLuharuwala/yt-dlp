/**
 * Two-tier cache:
 *
 *  1. Metadata cache (chrome.storage.local)
 *     Stores resolved format lists + video info keyed by videoId.
 *     TTL: 5 hours (YouTube CDN URLs expire in ~6 hours).
 *
 *  2. Video file cache (OPFS – Origin Private File System)
 *     Stores downloaded video/audio bytes keyed by `${videoId}:${itag}`.
 *     Persists until explicitly evicted.
 *     Progress is broadcast via chrome.storage so callers can poll it.
 */

const META_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours

// ── Metadata cache ────────────────────────────────────────────────────────────

export async function getMetadata(videoId) {
  const key = `meta:${videoId}`;
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > META_TTL_MS) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

export async function setMetadata(videoId, data) {
  await chrome.storage.local.set({
    [`meta:${videoId}`]: { data, ts: Date.now() },
  });
}

// ── OPFS video cache ──────────────────────────────────────────────────────────

function cacheKey(videoId, itag) {
  return `${videoId}:${itag}`;
}

function progressKey(videoId, itag) {
  return `progress:${cacheKey(videoId, itag)}`;
}

export async function getCacheStatus(videoId, itag) {
  const key = progressKey(videoId, itag);
  const result = await chrome.storage.local.get(key);
  return result[key] || { status: 'none' };
}

async function setProgress(videoId, itag, payload) {
  await chrome.storage.local.set({ [progressKey(videoId, itag)]: payload });
}

/**
 * Download a format URL into OPFS, broadcasting progress to storage.
 * Returns the OPFS file path (relative to the storage root).
 *
 * @param {string} videoId
 * @param {number|null} itag
 * @param {string} url        – resolved CDN URL
 * @param {string} mimeType
 * @param {function} onProgress  – called with (receivedBytes, totalBytes)
 */
export async function downloadToCache(videoId, itag, url, mimeType, onProgress) {
  const filename = `${cacheKey(videoId, itag)}.bin`;

  await setProgress(videoId, itag, { status: 'downloading', received: 0, total: 0 });

  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();

    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`);

    const total    = parseInt(resp.headers.get('content-length') || '0');
    const reader   = resp.body.getReader();
    let received   = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.length;

      const progress = { status: 'downloading', received, total };
      await setProgress(videoId, itag, progress);
      onProgress?.(received, total);
    }

    await writable.close();
    await setProgress(videoId, itag, { status: 'done', received, total, mimeType, filename });
    return filename;

  } catch (e) {
    await setProgress(videoId, itag, { status: 'error', error: String(e) });
    throw e;
  }
}

/**
 * Read a cached video file from OPFS and return it as a Blob.
 * Returns null if not cached.
 */
export async function getCachedBlob(videoId, itag) {
  const status = await getCacheStatus(videoId, itag);
  if (status.status !== 'done') return null;

  try {
    const root       = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(status.filename);
    const file       = await fileHandle.getFile();
    return new Blob([await file.arrayBuffer()], { type: status.mimeType || 'video/mp4' });
  } catch (_) {
    return null;
  }
}

/**
 * Delete a cached video from OPFS and clear its progress entry.
 */
export async function evictFromCache(videoId, itag) {
  const status = await getCacheStatus(videoId, itag);
  if (status.filename) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(status.filename);
    } catch (_) {}
  }
  await chrome.storage.local.remove(progressKey(videoId, itag));
}

/**
 * List all cached videos (from progress entries in storage).
 */
export async function listCache() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('progress:'))
    .map(([k, v]) => ({ key: k.replace('progress:', ''), ...v }))
    .filter(e => e.status === 'done');
}
