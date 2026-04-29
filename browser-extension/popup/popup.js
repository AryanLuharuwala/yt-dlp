/**
 * Popup script for yt-dlp Web.
 * Queries the background service worker for the current tab's video formats
 * and renders the format picker.
 */

let state = null;   // { videoInfo, formats }
let activeTab = 'combined';

const $ = id => document.getElementById(id);

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  showPanel('loading');

  // Listen for background → popup updates (data just became ready)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'YTDLP_DATA_UPDATED') loadState();
  });

  await loadState();

  // If still on loading panel after 4 s, the page is probably not supported
  setTimeout(() => {
    if ($('state-loading') && !$('state-loading').classList.contains('hidden')) {
      showPanel('unsupported');
    }
  }, 4000);
}

async function loadState() {
  const s = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'YTDLP_GET_TAB_STATE' }, resolve)
  );

  if (!s) {
    // Not yet ready – the content script hasn't finished yet.
    // Stay on loading panel; the DATA_UPDATED event will trigger loadState() again.
    return;
  }

  state = s;

  if (!state.formats || !state.formats.length) {
    showPanel('unsupported');
    return;
  }

  render();
  showPanel('video');
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  const { videoInfo, formats } = state;

  // Thumbnail
  if (videoInfo.thumbnail) {
    const img = $('video-thumb');
    img.src = videoInfo.thumbnail;
    img.classList.remove('hidden');
  }

  $('video-title').textContent  = videoInfo.title  || 'Untitled';
  $('video-author').textContent = videoInfo.author || '';

  renderFormats(formats);
  setupTabs(formats);
}

function renderFormats(allFormats) {
  const list    = $('format-list');
  const formats = filter(allFormats, activeTab);

  if (!formats.length) {
    list.innerHTML = `<p class="fmt-empty">No ${activeTab} formats available</p>`;
    return;
  }

  list.innerHTML = formats.map(fmt => `
    <div class="fmt-row" data-itag="${fmt.itag ?? fmt.url}">
      <div class="fmt-main">
        <span class="fmt-quality">${qualityLabel(fmt)}</span>
        <span class="fmt-badge">${fmt.ext.toUpperCase()}</span>
        ${fmt.contentLength ? `<span class="fmt-size">${fmtBytes(fmt.contentLength)}</span>` : ''}
      </div>
      <span class="fmt-meta">${metaLine(fmt)}</span>
      <button class="dl-btn" data-url="${esc(fmt.url)}" data-ext="${esc(fmt.ext)}" data-key="${fmt.itag ?? fmt.url}">
        ↓
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.dl-btn').forEach(btn => {
    btn.addEventListener('click', () => download(btn));
  });
}

function setupTabs(formats) {
  $('tab-bar').querySelectorAll('.tab').forEach(tab => {
    // Hide tabs with no formats
    const count = filter(formats, tab.dataset.tab).length;
    tab.style.display = count ? '' : 'none';

    tab.addEventListener('click', () => {
      $('tab-bar').querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      renderFormats(formats);
    });
  });
}

// ── Download ──────────────────────────────────────────────────────────────────

async function download(btn) {
  btn.classList.add('loading');
  btn.textContent = '…';

  const url  = btn.dataset.url;
  const ext  = btn.dataset.ext;
  const name = state.videoInfo?.title || 'video';

  chrome.runtime.sendMessage({ type: 'YTDLP_DOWNLOAD', url, filename: name, ext }, () => {
    // Close popup after triggering download (the download dialog will open)
    window.close();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function filter(formats, tab) {
  if (tab === 'combined') return formats.filter(f => f.hasVideo && f.hasAudio);
  if (tab === 'video')    return formats.filter(f => f.hasVideo && !f.hasAudio);
  if (tab === 'audio')    return formats.filter(f => f.hasAudio && !f.hasVideo);
  return formats;
}

function qualityLabel(fmt) {
  if (fmt.qualityLabel) return fmt.qualityLabel;
  if (fmt.quality)      return fmt.quality;
  if (fmt.audioSampleRate) return `${fmt.audioSampleRate} Hz`;
  return '?';
}

function metaLine(fmt) {
  const parts = [];
  if (fmt.fps && fmt.fps > 0) parts.push(`${fmt.fps}fps`);
  if (fmt.audioQuality) parts.push(fmt.audioQuality.replace('AUDIO_QUALITY_', '').toLowerCase());
  if (fmt.audioChannels === 2) parts.push('stereo');
  return parts.join(' · ');
}

function fmtBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function esc(s) { return String(s || '').replace(/"/g, '&quot;'); }

function showPanel(name) {
  ['loading', 'unsupported', 'video'].forEach(n => {
    const el = $(`state-${n}`);
    if (el) el.classList.toggle('hidden', n !== name);
  });
}

init();
