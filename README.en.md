<div align="center">

<img src="ins-download/icons/icon128.png" width="88" alt="download everything">

# download everything

**Download images and videos from websites** — a Chrome extension for Instagram, Weibo and X (Twitter) that saves the original image / source-best video in one silent click

[中文](README.md) ｜ **English** ｜ [日本語](README.ja.md) ｜ [한국어](README.ko.md)

A round download button is injected next to every feed card. One click saves the original image or video silently into the folder you chose — no "Save as" dialog, no redirects, no interruption.
Images and videos are saved as the **original / source-best** by default (Weibo `large`, X `name=orig`, Instagram's largest tier, and the highest-bitrate mp4 for video).
All three sites show a **real-byte progress ring**, and clicking again while loading **cancels** the download. The settings page and popup are available in **Chinese / English / Japanese / Korean**.

![Manifest](https://img.shields.io/badge/Manifest-V3-405DE6?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-111%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-3.0.0-2ECC71?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)

</div>

---

## Supported sites

| Site | Images | Video | Multi-item zip | Progress ring | Cancel | Per-site folder / quality |
| --- | --- | --- | --- | --- | --- | --- |
| **Instagram** `instagram.com` | ✅ incl. all carousel items | ✅ Reels and video posts | ✅ | ✅ | ✅ | ✅ |
| **Weibo** `weibo.com` | ✅ all grid images | ✅ original + 480P–2K | ✅ | ✅ | ✅ | ✅ |
| **X (Twitter)** `x.com` · `twitter.com` | ✅ all grid images, originals | ✅ highest-bitrate mp4 and GIFs | ✅ | ✅ | ✅ | ✅ |

The three sites are implemented **completely independently**: separate DOM adapters, separate URL-resolution chains, separate button styles, separate storage keys. A redesign or a bug on one site cannot affect the other.

> The extension still loads from a folder named `ins-download` (a leftover from when it only handled Instagram). Pick that folder when loading — the name has no effect on behaviour.

## The problem it solves

Instagram's web UI has no download button. "Save image as" only gives you a compressed thumbnail, and videos are unreachable — the player streams a `blob:` URL, so `video.src` cannot be copied.

Weibo is a different story: images can be saved with the context menu, but you get the `orj360` (360px wide) compressed version; videos are blob streams too, and a nine-image grid has to be clicked one by one.

**download everything** works around both: it asks the site's own internal API for the post data, gets **every media item of that post** plus the **real CDN URL of every quality tier**, then downloads at the resolution you configured.

## Feature overview

### Shared

| Feature | Details |
| --- | --- |
| 🖼 **Image download** | Single image, carousel, nine-grid — picks the tier matching your resolution setting |
| 🎬 **Video download** | Resolves the real mp4 URL (not a blob) for Reels, video posts and Weibo videos |
| 🎠 **Full carousel / grid** | A 10-image post yields all 10 items, independent of lazy loading (the DOM usually renders only 2–3) |
| 📦 **Zip packaging** | Bundle everything into one zip instead of clicking "Save as" ten times |
| 📁 **Custom folder** | Pick a folder once, everything is written silently afterwards; images and videos can use different folders |
| ⚙️ **Resolution** | All three sites share **one seven-tier ladder**: **original (default)** / 240P / 480P / 720P / 1080P / 2K / 4K. **Downloads follow your setting; if the source tops out lower, its highest tier is used** |
| 🎚 **Video quality** | Same five tiers on all three sites: **original (default)** / SD 480P / HD 720P / FHD 1080P / Ultra HD 2K, each mapping to an explicit technical standard |
| 🎛 **Per-site switches** | Instagram and Weibo have separate toggles in the popup |
| 🧩 **Zero dependencies** | Plain JS, no build step, no npm — clone and load |

### Instagram

- **Button injection**: one round button to the **right of** every feed `article`, `position: fixed`, following the card. Scroll / zoom / feed re-layout triggers a batched `requestAnimationFrame` reposition, so it never lags behind or overlaps.
- **Five-level URL fallback**: internal media API → `?__a=1` → embed page → post page HTML → DOM fallback (see *How it works*).
- **Full carousel**: the API returns every carousel item at once, so lazy loading is irrelevant.
- **Quality**: images are picked from `image_versions2.candidates` / `srcset` (original = the largest one; a specific tier = the smallest tier not below it, 240P–4K); videos follow the same rule on `video_versions[].width` (original / 480P / 720P / 1080P / 2K).
- **Multi-item menu**: `Download this one (current)` / `Download all N items (as zip)`.
- **Bytes first**: the offscreen document fetches the real bytes and hands them over, so the extension decides the extension from the actual file header — the CDN can no longer rename your file via an error page.
- **Progress ring**: the button's outer ring fills clockwise with real bytes (time-based ramp while resolving, byte-ratio once downloading), synced with the save dialog.
- **Cancel**: click again while loading to stop it — aborts the fetch, closes an already-open save dialog, finishes silently.
- **Naming**: `ins_image_20261119T201500.jpg` / `ins_video_….mp4`; zip entries are numbered.

### Weibo

- **Card detection**: no brittle class names. Nearest ancestor matching `article.woo-panel-main` / `div.card-wrap` / `[action-type=feed_list_item]` / `[mid]` / `[data-mid]` — works on the new home feed and search pages.
- **Post id, two paths**: use `mid` / `data-mid` if present; otherwise extract `mblogid` from the in-card link (`/{uid}/{mblogid}`, `/detail/xxx`, `/status/xxx`).
- **Media resolution**: `/ajax/statuses/show` → video component API → DOM fallback; supports nine-grid, text+video mixes (original order preserved) and reposts.
- **Image quality**: rewrites the first path segment on `sinaimg.cn` (`orj360` / `mw690` / `orj1080` / `large` original); falls back automatically when a tier does not exist.
- **Video quality**: original / SD 480P / HD 720P / FHD 1080P / Ultra HD 2K, straight from the component API's resolution list, tiered by `quality_label` (falling back to `mp4_720p` / `label=mp4_hd` hints) before ordering by your setting.
- **Bytes first**: the offscreen document fetches real bytes before delivery, which permanently fixes the "downloaded file is `.htm`" bug.
- **Referer injection**: a `declarativeNetRequest` session rule adds `Referer: https://weibo.com/` for the image host and video CDN only (never for `weibo.com` itself) to avoid 403s.
- **Button placement**: vertically centred on the card avatar; hidden when the avatar leaves the viewport or the card slides under the sticky header, so it never floats over the nav bar; clamped horizontally into the viewport.
- **Progress ring**: real bytes, clockwise, synced with the save dialog.
- **Cancel**: click again while loading — aborts the fetch and cancels an open save dialog.
- **Multi-item menu**: `Download first item only` / `Download all N items (as zip)`.
- **Naming**: `weibo_image_20261119T201500.jpg` / `weibo_video_….mp4` / `weibo_images_….zip`.

### Diagnostics

Both content scripts ship console commands (`__insDl.*` / `__wbDl.*`) plus `[download-everything]` prefixed logs, so after a site redesign you can tell "card not detected" from "URL resolution failed" without reading the source. See [Debugging](#debugging).

## Installation

Not on the Chrome Web Store — load it in developer mode:

1. Clone the repo
   ```bash
   git clone https://github.com/LE-Nan/download-everything.git
   ```
2. Open `chrome://extensions` (`edge://extensions` on Edge)
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the **`ins-download`** folder
5. Open [instagram.com](https://www.instagram.com) or [weibo.com](https://weibo.com); a download button appears next to every feed item

> Requires Chrome 109+ (`chrome.offscreen` and the File System Access API). Older browsers fall back — see *Degraded behaviour*.
>
> The extension uses `declarativeNetRequestWithHostAccess` (to add the Referer header for Weibo's CDN). After upgrading, Chrome asks you to accept the new permission — reload and accept.

## Usage

### Instagram

Hover any feed card: a round button appears to the **right of** it. Click it.

- Single image / video post → starts downloading immediately; the button turns green on success, red on failure
- Carousel post → two options:
  - **Download this one (current)** — only the slide currently visible
  - **Download all N items (as zip)** — everything in one zip
- After the click the **progress ring** starts filling; clicking again while loading **cancels** (the icon becomes a filled square and turns red on hover)

### Weibo

Identical interaction: a round button to the **right of** every card (turns Weibo orange on hover).

- Single image / video → downloads immediately
- Nine-grid / multi-image → **Download first item only** or **Download all N items (as zip)**

The button is **vertically centred on the card avatar**, i.e. "the download button of this post". It hides when the avatar scrolls out of view, and **also hides when the card slides under Weibo's sticky header** — it never floats over the nav bar. Horizontally it is clamped into the viewport, so it never drifts onto the right sidebar. If a post has no button, run `__wbDl.debug()` in the console (see [Debugging](#debugging)).

### Progress ring

Video downloads usually take 5–15 seconds before the save dialog appears. Previously the only feedback was a semi-transparent state. Now **the button's outer ring is the progress bar** (identical on both sites):

```
click ──▶ resolve media (0→12%, time-based ramp)
      ──▶ fetch bytes (clockwise green fill by bytes / Content-Length)
      ──▶ fills to 100%  ← save dialog opens here
      ──▶ click "Save"   ← button restores, fill cleared
```

- Fetched portion **green**, remainder **empty**, clockwise
- Without `Content-Length` it ramps by time and stops at 92% — it never pretends to be done
- The ring stays full while the save dialog is open; it only resets after the download reaches `complete`
- Cancelling also restores the button, without an error or a second save dialog

### Cancel

**Clicking the button again while loading cancels the download.** The button becomes a filled square, turns red on hover, and its tooltip changes to "Downloading, click to cancel" — all of which makes "click again" self-explanatory.

Cancelling stops three layers, not just the UI:

| Stage | What cancel does |
| --- | --- |
| Resolving media (waiting for the API) | Marked locally; when the API returns, nothing is sent — no menu, no download request |
| Fetching bytes / zipping (the 5–15 s) | `AbortController` aborts the `fetch`, the read loop exits, dozens of MB are not wasted |
| Save dialog already open | `chrome.downloads.cancel()` closes that download |

Cancelling is silent: no red flash, no retry, no second save dialog, just a neutral "Cancelled" toast. Only **the button that started the download** can cancel it — clicking another card's button only shows "Downloading another item, please wait", so nobody thinks they cancelled someone else's job.

### Settings page: Save location / Display

Click the toolbar icon → **Open settings**. The page is a two-column layout (navigation on the left, content on the right) modelled on Chrome's own settings:

| Section | Contents |
| --- | --- |
| **Save location** | Download folders and quality for both sites |
| **Display** | Interface language (Chinese / English / Japanese / Korean) |

"Save location" is split per site — **Instagram / Weibo / X download settings**, one card each, with the site title outside the card frame and clickable inside the parentheses. Each card is a three-column table with **one setting per row**: name on the left, control (folder box / dropdown) in the middle, action button on the right; the columns are shared by the whole card, so rows and cards line up. Longer explanations (how folders work, how quality is picked) live in the label tooltip. Each card has an image group and a video group, and the groups are independent. The active section lives in the URL hash, so `options.html#display` opens Display directly.

| Setting | Values | Default |
| --- | --- | --- |
| Instagram image folder / resolution | custom folder; original (default) / 240P–4K | `Downloads\ins-download\images` |
| Instagram video folder / quality | custom folder; original (default) / 480P / 720P / 1080P / 2K | `Downloads\ins-download\videos` |
| Weibo image folder | custom / default | `Downloads\weibo-download\images` |
| Weibo image resolution | original (default) / 240P / 480P / 720P / 1080P / 2K / 4K (same ladder as Instagram) | swapped in the URL path, mapped to `orj360` / `orj480` / `mw690` / `mw1024` / `orj1080` / `mw2000` / `large` (original) |
| Weibo video folder | custom / default | `Downloads\weibo-download\videos` |
| Weibo video quality | original (default) / 480P / 720P / 1080P / 2K | tiered by the API's quality label; unlabelled URLs come last as a fallback |
| X image folder | custom / default | `Downloads\twitter-download\images` |
| X image resolution | original (default) / 240P / 480P / 720P / 1080P / 2K / 4K (same ladder as Instagram) | mapped onto pbs `name`: `small` (680) / `medium` (1200) / `large` (2048) / `4096x4096` / `orig` (original) |
| X video folder | custom / default | `Downloads\twitter-download\videos` |
| X video quality | original (default) / 480P / 720P / 1080P / 2K | mp4 variants only carry a bitrate, so it is mapped to a tier (≈360P / 720P / 1080P) before selection |

**How quality is chosen**: all sites follow one rule — **original** means "the source's best tier" with no downscaling; picking a concrete tier (480P / 720P / 1080P / 2K) takes the **smallest tier not below it**; if that piece of media tops out below your setting (old posts, small images, single-bitrate videos), its highest available version is used instead. No refresh needed: the next click picks up the new value.

**About custom folders**: the system picker lets you choose any directory; afterwards every download is written silently, with no confirmation dialog. The directory handle is kept in IndexedDB.

> ⚠️ **Authorization expires after a browser restart** (an inherent limit of the File System Access API). The settings page then shows "needs re-authorization" — click **Re-authorize** and pick the same folder again. Already downloaded files are unaffected.

### Interface language

**Display → Interface language** switches between Chinese / English / Japanese / Korean. All four cover the settings page, the toolbar popup, and the tooltips, menus and error toasts of the on-page button.

- The switch applies **immediately**: this page and the popup update in place, and buttons already injected into a page swap their tooltips without a reload
- If you never picked one, it is guessed once from the browser language (`zh*` → Chinese, `ja` → Japanese, `ko` → Korean, otherwise English) — display only, nothing is written
- The choice lives in the `chrome.storage.sync` key `uiLang` and survives updates and sync
- The dictionary is `i18n.js`; `test-i18n.js` keeps all four languages at the same key set, so a missing translation turns the suite red

### Degraded behaviour

Without a custom folder the extension uses `chrome.downloads` and writes into a subfolder of your browser's download directory. Depending on your browser settings this path may still show one save dialog — that is browser behaviour, not something an extension can bypass.

## Project layout

```
ins-download/                 ← select this folder when loading the extension
├── manifest.json             MV3 manifest
├── content.js                Instagram: button injection, media resolution, progress ring / cancel, menu
├── content.css               Instagram button / menu / ring / toast styles
├── weibo.js                  Weibo: same role, fully independent selectors and resolution chain
├── weibo.css                 Weibo button / menu / ring styles (.wb-dl-*, no overlap)
├── background.js             service worker: routing, download dispatch, progress relay, cancel, Referer rule
├── offscreen.html            offscreen document (DOM + cross-origin fetch)
├── offscreen.js              byte fetching (abortable), disk writes, zipping
├── zip.js                    zip writer (store mode, zero dependencies)
├── idb.js                    IndexedDB helper (directory handles)
├── i18n.js                   UI strings (zh / en / ja / ko) and language switching
├── options.html / options.js settings page (left rail: Save location / Display)
├── popup.html / popup.js     toolbar popup (two independent switches)
├── icons/                    16 / 48 / 128 icons
└── (repo root) test/         regression tests, plain node, no dependencies
```

## How it works

### Architecture

```
Instagram page                    Weibo page
content.js (isolated world)       weibo.js (isolated world)
   │  chrome.runtime.sendMessage     │
   ▼                                 ▼
background service worker  ←──────  │   (routes by msg.site)
   │  ensureOffscreen()              │
   ▼                                 ▼
offscreen document: fetch real bytes (abortable) → blob / dataUrl / disk write
   │
   ▼
chrome.downloads.download()  →  file lands in your folder
```

- content scripts never touch network bodies; they only read the page and draw UI
- the offscreen document does the heavy lifting because it has a DOM **and** host permissions (no CORS)
- the service worker holds no long-lived state — everything is keyed by `progressId` and lives in maps that are pruned after 30 s

### Media resolution: five-level fallback (Instagram)

1. `/api/v1/media/{media_id}/info/` with `X-IG-App-ID` — the most stable, returns all carousel items and every quality tier
2. `/p/{shortcode}/?__a=1&__d=dis`
3. `/p/{shortcode}/embed/captioned/` HTML, regex-extracted
4. `/p/{shortcode}/` HTML, regex-extracted
5. DOM fallback: `srcset` / `video.src`, filtered by visibility and overlap with the video layer

### Weibo media resolution

`/ajax/statuses/show?id=…` → video component API (`Component_Play_Playinfo`) → DOM fallback. Image URLs are rewritten per quality tier; unavailable tiers fall back to the original.

### Why bytes first instead of handing the URL to the downloader

If the downloader fetches the URL itself, the request carries the `chrome-extension://` origin and no page Referer. Weibo's CDNs answer with a **200 HTML error page**, which Chrome then saves as `.htm` — that was the root cause of the "my download is a `.htm` file" reports. Fetching the bytes first and letting the extension decide the name and MIME type removes the possibility entirely; if a Chrome build rejects `blob:` URLs from an offscreen document, it automatically retries with a `dataUrl`.

For Instagram this also brings the byte stream the progress ring needs, and if byte fetching fails for any reason the extension **falls back to the old direct download** so a temporary CDN rejection never turns a working download into a broken one.

### Progress ring and cancel data path

```
content.js / weibo.js creates a progressId
   │
   ├─▶ background records sender.tab.id in progressTabs
   │
   ├─▶ offscreen save-media: getReader() streams, reports {loaded,total} every 120 ms
   │        └─▶ background ─▶ tabs.sendMessage(type:"wb-dl-progress") ─▶ paint ring
   │
   ├─▶ before calling chrome.downloads, send phase:"save" (=100%): the dialog opens now
   │
   └─▶ user clicks again ─▶ action:"cancel" ─▶ offscreen abort (AbortController)
                                            └▶ chrome.downloads.cancel(downloadId)
```

One `progressId` spans the whole lifecycle. A cancel that arrives **before** the download request is still recorded (double-click scenario) and checked when the task starts. All three stages normalize to `canceled`, so callers only ever see success / canceled / failure.

> Both sites share one progress channel (the message type keeps the historical name `wb-dl-progress`); each content script paints only its own ring. `progressId` prefixes differ (`ig…` / `wb…`), and both the legacy `wb-cancel` and the new `cancel` action are accepted.

### Why the button lives on `body`

An earlier version put the button inside `article`, positioned at the media's top-right. Two problems:

1. **The video's transparent overlay swallowed the click** — Instagram covers videos with a full-size `<div>`; no `z-index` helps inside that stacking context.
2. It overlapped Instagram's own `···` menu button.

Final approach: the button is a child of `document.body`, `position: fixed`, `z-index: 2147483647`, positioned from `getBoundingClientRect()` and repositioned in batches via `requestAnimationFrame` on `scroll` / `resize` / mutations. It sits **outside** the card, clear of every interactive element inside it.

### How the two sites stay independent

| Isolation | Instagram | Weibo |
| --- | --- | --- |
| Content script | `content.js` | `weibo.js` |
| Style prefix | `.ins-dl-*` | `.wb-dl-*` |
| Toggle key | `enabled` | `weiboEnabled` |
| Directory keys | `imageDir` / `videoDir` / … | `weiboImageDir` / `weiboVideoDir` / … |
| Filename prefix | `ins_image_` / `ins_video_` | `weibo_image_` / `weibo_video_` |
| Default folder | `ins-download/` | `weibo-download/` |

The only meeting point in `background.js` is the single `if (msg.site === "weibo")` line at the top of each handler.

## Debugging

Open DevTools → Console, **switch the context to this extension** (pick `download-everything` in the dropdown), then per site:

| Site | Command | Purpose |
| --- | --- | --- |
| Instagram | `__insDl.debug()` | List every detected post: shortcode, button count, media count |
| Instagram | `__insDl.media(0)` | Run the full resolution chain for post 0 and print all candidates |
| Instagram | `__insDl.ring()` | Progress ring state: progressId, current percent, whether total is known |
| Instagram | `__insDl.cancel()` | Cancel the current download (same as clicking the loading button) |
| Instagram | `__insDl.clearCache()` | Drop the post API cache |
| Weibo | `__wbDl.debug()` | List every detected card: matched selector, post id, media count |
| Weibo | `__wbDl.inspect(0)` | Full resolution chain for card 0 with all candidate URLs — fastest way to debug "no button / cannot download" |
| Weibo | `__wbDl.resolve("post id")` | Call the API directly and print the parsed result |
| Weibo | `__wbDl.checkImage("url")` | Whether a URL is treated as a body image, plus every quality tier and candidate order |
| Weibo | `__wbDl.ring()` | Same as Instagram |
| Weibo | `__wbDl.cancel()` | Same as Instagram |
| Weibo | `__wbDl.occlusion()` | Recognised bottom edge of the sticky header; `0` means the nav container was not detected |
| Weibo | `__wbDl.clearCache()` | Clear API and video-component caches |
| Shared | `chrome://extensions` → this extension → **Inspect views: service worker** | Download dispatch, cancellation and offscreen errors |

Weibo also logs with a `[weibo download]` prefix, printing how many media items each post yielded and which chain was used. **Check this first after a redesign**: if it repeatedly says "API returned nothing, falling back to DOM" or `media 0`, adjust `SEL` at the top of `weibo.js` or the parse functions — the rest of the logic stays untouched.

For `.htm`-style problems, open **Inspect views: offscreen.html**: every failed candidate (status / Content-Type) is logged during byte fetching, so you can tell 404 from 403 from an HTML error page. If you see "Weibo refused this URL", all candidates were rejected — run `__wbDl.inspect(0)` and share the list.

## Known limitations

An honest list of what does not work well:

1. **Instagram only covers feed `article`s.** Post detail pages `/p/xxx/`, standalone Reels pages, Stories, DMs and profile grids have **no button yet**.
2. **Instagram falls back to direct download when byte fetching fails** (no ring, cancel cannot stop it). This is deliberate: a temporary CDN rejection should not break a download that used to work. The log shows `ins 取字节失败，退回直拉`.
3. **Carousels containing video are zipped into the image folder** (Instagram only). `handleZip` only reads `imageDir`; Weibo already routes by content type.
4. **Very large zips risk memory.** In default-folder mode the zip is passed across contexts as a dataUrl; beyond ~100 MB this easily fails.
5. **Video quality selection is imprecise** (Instagram only). `video_versions[].width` is often `0`, so it degenerates to the last array item.
6. **Instagram animated posts / Stories media** are not supported.
7. **Weibo selectors were derived from publicly maintained sibling scripts** (owendswang / firo1603's downloader) and the API fields follow the real shapes of `pic_infos` / `playback_list` / `Component_Play_Playinfo`, but they have not been exhaustively verified under a logged-in session. If a card has no button, run `__wbDl.debug()`; it usually needs a `SEL` tweak.
8. **Weibo only covers feeds and list pages.** The image lightbox, standalone video pages, headline articles and DMs are not wired up.
9. **Weibo reposts** yield the reposted post's media (some layouts also include the reposter's own images).
10. **Cancelling exactly when the save dialog opens** depends on how Chrome handles `downloads.cancel`; some versions leave a "cancelled" entry in the download list (no file is written).
11. A site redesign can break the resolution chain: fix `content.js` for Instagram, `weibo.js` for Weibo.

## Compliance and disclaimer

- The extension **only reads public content already rendered in your own browser**. It does not bypass logins, crack paid content, or run bulk crawls.
- Downloaded content **belongs to its original author**. Use it for personal offline viewing or backing up your own work; **do not redistribute, sell, or repost it**.
- Using this extension may violate Instagram's or Weibo's terms of service. **You assume the risk.** Keep the frequency reasonable; do not use it for bulk collection.
- This project is not affiliated with, endorsed by, or authorized by Instagram / Meta or Weibo / Sina Weibo.

## Development

No build step. After editing, click the **refresh** icon on the extension card in `chrome://extensions`, then reload the site.

**Debug entry points**:

- Instagram content script → page DevTools Console (isolated world, `[download-everything]` logs)
- Weibo content script → same, plus `__wbDl.*` commands
- X content script → same, plus `__xdl.*` commands (`twitter-hook.js` logs nothing by default)
- service worker → `chrome://extensions` → this extension → **Inspect views: service worker**
- offscreen → **Inspect views: offscreen.html**

**Regression tests** (Node 18+, no dependencies):

```bash
node test/test-weibo.js       # card detection / post id / API parsing / candidates / resolution & quality tiers / loading & cancel — 72 assertions
node test/test-content.js     # Instagram progress ring / cancel state machine / button states / tier picking — 40 assertions
node test/test-offscreen.js   # header sniffing / candidate retries / HTML rejection / streaming progress / abort / zip — 66 assertions
node test/test-background.js  # routing isolation / byte delivery / progress relay / three-stage cancel / header rule — 110 assertions
node test/test-i18n.js        # four-language key sets / placeholders / switching and notify — 43 assertions
node test/test-twitter.js     # X: tweet id / image tiers / video tier picking / normalising / ring — 62 assertions
node test/test-twitter-hook.js# X hook: GraphQL parsing / cross-world Q&A / untouched responses — 14 assertions
```

Seven plain-Node suites, 407 assertions in total:

- `test-background.js` simulates both a download without `site` (Instagram path) and `site: "weibo"`, asserting folders, prefixes and `saveAs` never cross over — run it after touching background to confirm Instagram is unaffected;
- `test-content.js` stubs only the button and messaging layer and focuses on the Instagram ring: 12% cap while resolving, byte-ratio up to 98, and late progress must not repaint a cancelled ring;
- `test-offscreen.js` guards the old "HTML error page saved as .htm" bug: it asserts the downloader receives `blob:` / `data:` rather than a network URL, and that an abort stops further candidates;
- `test-weibo.js` keeps a minimal DOM stub implementing only what detection and parsing touch, running the real code;
- `test-i18n.js` asserts all four languages carry exactly the same keys and keep the `{n}` / `{msg}` / `{name}` / `{path}` placeholders — one missing translation would leak a raw key or silently fall back to Chinese.

## Changelog

### v3.0.0 (2026-11-22)

The first stable release with all three sites merged; the version moves from 2.3.2 to **3.0.0**:

- **Scope settled**: images, videos, multi-image zip, progress ring, cancel, per-site folders and per-site quality are all in place for Instagram, Weibo and X (Twitter). The three implementations are independent — separate DOM adapters, separate URL resolution, separate storage keys — so a redesign on one site only affects that site
- **One ladder everywhere**: seven image tiers (original by default → 4K) and five video tiers (source-best by default → 2K), with the same tier standard and the same picking rule on all three sites (the smallest tier not below your setting)
- **Four UI languages**: Chinese / English / Japanese / Korean, switching instantly in the settings page and popup, with in-page button tooltips, multi-image menus and failure messages updated in place
- **README rewritten**: the first line now states plainly that the extension downloads images and videos from the web, then walks through each site; every changelog entry carries its **publish date to the repository**
- Why the major bump: three sites, one standard for tiers and copy — the feature boundary is stable, so the 2.x line closes here

### v2.3.2(2026-11-22)

The **image resolution** dropdown now uses Instagram's ladder on all three sites, so Weibo and X got new sub-options:

- **One seven-tier ladder everywhere**: original (default, first) / 240P / 480P / 720P / 1080P / 2K / 4K
- Weibo: option values no longer expose `large` / `orj1080` / `mw690` / `orj360`; `weibo.js` translates a tier into the size path (`orj360` / `orj480` / `mw690` / `mw1024` / `orj1080` / `mw2000` / `large`), original = `large`
- X: option values no longer expose `4096x4096` / `large` / `medium` / `small`; `twitter.js` translates a tier into pbs `name` (`small` 680 / `medium` 1200 / `large` 2048 / `4096x4096` / `orig`), original = `orig`
- **Same picking rule as Instagram**: the smallest tier not below your setting, falling back to the source maximum, and walking upwards when the chosen tier does not exist
- **Legacy values migrate in place**: stored `large` / `mw690` / `4096x4096` / `medium` are folded onto the new tiers, so no blank dropdown and no failed download
- Four languages updated (dropped `q.orj1080` / `q.mw690` / `q.orj360` / `q.xOrig` / `q.x4096` / `q.xLarge` / `q.xMedium` / `q.xSmall`); Weibo and X image tooltips now say "one shared ladder"
- Tests: `test-weibo.js` 68 → 72, `test-twitter.js` 56 → 62; total 397 → **407 assertions**

### v2.3.1(2026-11-22)

The resolution / quality dropdowns were re-aligned to one standard, and every option now really drives the download chain:

- **Resolution defaults to "original" and sits first**: Instagram gains an `orig` tier (the largest item in `image_versions2.candidates` / `srcset`); Weibo (`large`) and X (`orig`) were already original, so their options and order are untouched
- **Video quality is now five tiers everywhere**: **original (default)** / SD 480P / HD 720P / FHD 1080P / Ultra HD 2K; Instagram video drops 240P / 4K, and Weibo's and X's old HD / SD fold into the new ladder
- **Each tier maps to an explicit technical standard**: Instagram uses `video_versions[].width`; Weibo uses the `playback_list` quality label (`quality_label` and friends, falling back to `mp4_720p` / `label=mp4_hd` hints); X's mp4 variants only carry a bitrate, which is mapped to a tier. All three take "the smallest tier not below the setting", fall back to the source maximum, and `original` always means the source maximum
- **Legacy values are migrated**: stored `hd` / `sd` / `240` / `4k` map onto the new tiers, so the options page never shows an empty dropdown and downloads never fail on a missing tier
- All four languages updated (new `q.vOrig` / `q.v480` / `q.v720` / `q.v1080` / `q.v2k`, removed `q.hd` / `q.sd`); video quality tooltips now say "original = the source's best"
- Tests: `test-weibo.js` 61 → 68, `test-content.js` 36 → 40, `test-twitter.js` 54 → 56; total 384 → **397 assertions**

### v2.3.0(2026-11-22)

X (Twitter) image / video download, built the same way as Instagram and Weibo but fully independent:

- New `twitter.js` / `twitter.css` / `twitter-hook.js`: tweet detection, three-tier URL resolution, button / menu / progress ring / cancel, isolated `.x-dl-*` styles
- **Highest quality by default**: images use `name=orig` (the uploaded original), videos use the highest-bitrate mp4 (`video_info.variants` sorted by `bitrate`); GIF posts download as mp4; HLS (`.m3u8`) is never saved as a file
- `twitter-hook.js` runs in `world: "MAIN"` at `document_start` and listens to the page's own GraphQL responses, caching media per tweet id (max 200). Content script queries it over `window.postMessage`. Listen-only — responses are never modified
- Second tier: official embed endpoint `cdn.syndication.twimg.com/tweet-result`, proxied through background → offscreen to dodge CORS; the `x-api` proxy only allows that one host
- background gains `site: "twitter"` routing: own folder `twitter-download/`, own prefix `twitter_`, own storage keys
- Settings page gets a third card (folders + quality, defaults `orig` / HD), popup gets an X toggle, all four UI languages updated
- Manifest adds `x.com` / `twitter.com` / `*.twimg.com` host permissions and content scripts; version 2.2.0 → **2.3.0**, minimum Chrome 111+
- New tests: `test-twitter.js` (54) and `test-twitter-hook.js` (14); background X routing added (91 → 110). Total 285 → **384 assertions**

### v2.2.0(2026-11-20)

The settings page now uses Chrome-settings-style two-column navigation, and the whole UI speaks four languages:

- **Split settings page**: left rail (Save location / Display, rounded pill for the active item) with content on the right. The two site blocks moved into "Save location" untouched — same fields, same `id`s, same storage keys
- **Display → Interface language**: Chinese / English / Japanese / Korean, applied instantly. Covers the settings page, the popup, and the on-page button tooltip, multi-item menu and error toasts
- New `i18n.js`: one dictionary plus `t()` / `ready` / `applyDom` / `onChange`; content scripts load it first per the manifest order, and already-injected buttons re-label in place when the language changes
- With no explicit choice the language is guessed from the browser once, read-only; the choice is stored under `chrome.storage.sync.uiLang`
- Extension version 2.1.0 → **2.2.0**, `manifest.description` mentions the languages
- New `test/test-i18n.js` (43 assertions); regression tests 242 → **285**

### v2.1.0(2026-11-20)

Brings Weibo's "visible progress + always cancellable" experience to Instagram, plus this README in four languages:

- **Instagram now has a progress ring**: 0→12% time-based ramp while resolving, clockwise fill by `bytes fetched / Content-Length` while fetching, 100% the moment the save dialog opens, reset only when it closes. Data still flows through the offscreen streaming report on the shared `progressId` channel.
- **Instagram can now be cancelled**: clicking again while loading stops all three layers — local ring reset, `AbortController` abort, `chrome.downloads.cancel()` if the dialog is already open. The button becomes a filled square, turns red on hover, tooltip switches to "Downloading, click to cancel".
- **Instagram fetches bytes first**: no longer hands the URL to `chrome.downloads` directly; the offscreen document fetches real bytes and the extension decides the extension from the file header. On failure it **falls back to the direct download**, so a CDN hiccup never breaks a working download.
- Zip packaging also reports progress and supports cancel (progress by item count; cancelling discards the archive).
- New `__insDl.*` console diagnostics (`debug` / `media` / `ring` / `cancel` / `clearCache`) mirroring `__wbDl.*`.
- Regression tests 202 → **242** (new `test/test-content.js` with 30, `test-background.js` 81 → 91).
- README added in English / 日本語 / 한국어 with a language switcher.

### v2.0.1(2026-11-20)

A UI and naming cleanup; download logic unchanged:

- Display name `ins download` → **download-everything** (matching the repo), including popup title, button tooltip and the `[download-everything]` log prefix
- Popup rows now show only the site name (`Instagram` / `微博`); hover turns them into blue underlined links to the site, switches unchanged
- Settings page: both site titles moved **outside** the card frame at the same size, with the site name in parentheses clickable; Instagram's image and video groups share one card
- Load folder, default subfolders (`Downloads\ins-download\*`, `Downloads\weibo-download\*`) and all storage keys unchanged — existing settings and files unaffected

### v2.0.0(2026-11-19)

Naming and archiving release: identical functionality to v1.3.1, aligning the project name and major version with its actual scope.

- Repository renamed to **download-everything** (was `instagram-downloader`); GitHub redirects the old links
- Version 1.3.1 → **2.0.0**: the extension now covers Instagram + Weibo, so the major version had to move
- README rewritten per site, documenting every implemented capability and the progress/cancel data path
- No code changes (`content.js` / `content.css` untouched)

### v1.3.1(2026-11-19)

Added an "escape hatch" to the loading phase; Instagram untouched:

- **Clicking again while loading cancels** — previously the button was dead during loading, leaving no way out of a 5–15 s video fetch
- **Cancel lands in three layers**: stop resolving further; abort the `fetch` and read loop in the offscreen document; `chrome.downloads.cancel()` if the dialog is already open
- **The button turns into a stop square** while loading, red on hover, tooltip "Downloading, click to cancel"
- **Silent cancellation**: no red flash, no retry, no second dialog, neutral "Cancelled" toast
- **Double-click safe**: one `progressId` spans all three stages, and a cancel arriving before the download request is recorded (`cancelRequests`) and checked at task start
- Only the originating button can cancel its own download
- `__wbDl.cancel()` available in the console

### Older versions

v1.0.0 – v1.3.0 focused on the Weibo implementation: button injection, nine-grid/HD parity, the progress ring, and the "downloads as .htm" fix. The full per-version notes are in the [Chinese README](README.md#更新日志) and in the git history.

## License

[MIT](LICENSE)
