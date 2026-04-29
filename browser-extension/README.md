# yt-dlp Web – Browser Extension

A client-side browser port of [yt-dlp](https://github.com/yt-dlp/yt-dlp) that runs entirely in your browser — no server required.

## Supported Sites

| Site | Combined A/V | Video-only | Audio-only |
|------|:---:|:---:|:---:|
| YouTube | ✓ | ✓ | ✓ |
| Vimeo | ✓ | – | – |

## How It Works

```
Browser Extension
    │
    ├─ content.js  ─── reads ytInitialPlayerResponse from page DOM
    │                   ↓
    │               fetches YouTube player JS (via background, cross-origin)
    │                   ↓
    │               runs yt-dlp's EJS solver (meriyah AST parser) to
    │               decrypt sig-cipher + transform n-parameter
    │                   ↓
    │               sends processed format list → background
    │
    ├─ service-worker.js  ─── stores format state per tab
    │                          triggers chrome.downloads on user request
    │
    └─ popup.html  ─── format picker UI
```

### Why a browser extension?

Browsers block cross-origin requests (CORS). A plain web page cannot fetch
`https://www.youtube.com/watch?…` because YouTube doesn't set permissive CORS
headers. A browser extension with declared `host_permissions` bypasses this.

The **JS challenge solver** (`solver/solver.bundle.js`) is bundled directly from
yt-dlp's vendored `yt.solver.core.js`, which uses a real AST parser (meriyah)
to extract YouTube's signature-decrypt and n-parameter-transform functions from
the player JS. This is the same logic yt-dlp uses on the CLI.

## Installation (unpacked / developer mode)

1. **Build the solver bundle** (only needed once, already committed):
   ```bash
   cd browser-extension
   npm install
   npm run build
   ```

2. **Load into Chrome / Edge:**
   - Open `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked** → select this `browser-extension/` folder

3. **Load into Firefox:**
   - Open `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on** → select `manifest.json`

## Usage

1. Navigate to a YouTube or Vimeo video page.
2. Click the **yt-dlp Web** toolbar icon.
3. Select a format from the **Combined / Video only / Audio only** tabs.
4. Click **↓** to download.

## Notes

- **YouTube throttling:** Downloads are only full-speed when the n-parameter
  challenge is solved. If the solver can't parse a new player version, downloads
  fall back to throttled speed (~50 KB/s). Re-building the solver bundle after a
  yt-dlp update will fix this.
- **Merging streams:** YouTube's highest-quality streams (1080p+) are
  video-only + audio-only. The browser extension downloads them separately.
  Use [ffmpeg](https://ffmpeg.org/) locally to merge:
  ```
  ffmpeg -i video.webm -i audio.webm -c copy output.mkv
  ```
- **Vimeo:** Only public videos are supported. Private/password-protected videos
  require cookie forwarding (not yet implemented).

## Architecture

```
browser-extension/
├── manifest.json              MV3 extension manifest
├── background/
│   └── service-worker.js      Cross-origin fetch, download trigger, tab state
├── content/
│   └── content.js             Page data extraction, JS challenge solving
├── injected/
│   └── page-script.js         Runs in page context, reads window.ytInitialPlayerResponse
├── popup/
│   ├── popup.html             Format picker UI
│   ├── popup.js
│   └── popup.css
├── solver/
│   └── solver.bundle.js       Bundled: meriyah + astring + yt.solver.core.js
├── icons/
│   └── icon{16,48,128}.png
├── build.mjs                  Build script (generates solver.bundle.js)
└── package.json
```
