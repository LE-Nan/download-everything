/* twitter.js — X（推特，x.com / twitter.com）网页端图片/视频下载
 *
 * 与 ins / 微博 内容脚本完全独立：独立 DOM 适配层、独立取址链路、独立按钮样式、
 * 独立存储键，互不共享变量。
 *
 * ── 为什么 X 要三层取址 ───────────────────────────────────────
 * 1) 页面自身抓到的 GraphQL 数据（twitter-hook.js 注入 MAIN world 抓的）
 *    X 的时间线/详情页本来就是靠 GraphQL 拿数据的，响应里带完整的
 *    video_info.variants（全部码率的 mp4 直链）与 media_url_https。
 *    这是最准、最快的一层：不发任何额外请求，页面滚过就有。
 * 2) cdn.syndication.twimg.com/tweet-result（官方公开的嵌入接口，免登录）
 *    页面缓存里没有这条推文时用（例如刚打开详情页、深链接直达）。
 *    由 background → offscreen 代发，避开 CORS 与页面 CSP。
 * 3) DOM 兜底
 *    图片：pbs.twimg.com/media/... 的 img，改 `name=` 参数取原图；
 *    视频：只有当 video.src 是 http(s) 直链时才可用——X 的视频多为 MSE 的
 *          blob: 流，这种情况没有 DOM 兜底，必须靠前两层。
 *
 * ── 最高画质 ────────────────────────────────────────────────
 * 图片：pbs 支持 `name=orig`（上传原图，最大档），其次 4096x4096 / large(2048)
 *       / medium(1200) / small(680)。默认 orig。
 * 视频：variants 里按 bitrate 从高到低排，默认取最高码率那一档；HLS（m3u8）
 *       不是可直接保存的文件，直接跳过。
 *
 * ── 与微博共用的一套能力 ────────────────────────────────────
 * 下载写盘、zip 打包、进度回传、取消都由 background/offscreen 提供，站点无关，
 * 消息里带 site:"twitter" 就能路由到 X 自己的目录与文件名前缀。
 *
 * ⚠️ X 的 DOM 是 data-testid 驱动的，改版时先跑 __xdl.debug() 核对，
 *    只需改下面的 SEL 一处。
 */
(function () {
  "use strict";

  const LOG = "[x download]";
  const PROCESSED_ATTR = "data-xdl-processed";

  // 界面文案走 i18n.js（manifest 里排在 twitter.js 之前）
  const I18N = globalThis.DELi18n || null;
  const langReady = I18N ? I18N.ready : Promise.resolve("zh");
  function t(key, vars) {
    return I18N ? I18N.t(key, vars) : key;
  }

  let enabled = true;
  // X 专有配置：图片默认原图，视频默认原画质（＝源最高码率）
  const settings = { imageQuality: "orig", videoQuality: "orig" };

  const entries = []; // { btn, root, dead, media, mediaAt }
  let rafPending = false;
  const itemCache = new Map(); // tweetId -> [{type, candidates}]

  // 信息流可以无限往下滚，缓存必须封顶，否则长时间挂机吃内存
  const CACHE_MAX = 300;
  function cacheSet(id, items) {
    itemCache.set(id, items);
    while (itemCache.size > CACHE_MAX) {
      const first = itemCache.keys().next();
      if (first.done) break;
      itemCache.delete(first.value);
    }
  }

  // ---------- 适配层：改版时只动这里 ----------
  const SEL = {
    // article[data-testid="tweet"] 是 X 目前唯一的「一条推文」容器；
    // 后两个是历史/兜底选择器（老版本 twitter.com、部分嵌入视图）
    roots: [
      'article[data-testid="tweet"]',
      'article[role="article"]',
      'div[data-testid="tweet"]'
    ],
    media: [
      '[data-testid="tweetPhoto"]',
      '[data-testid="videoPlayer"]',
      '[data-testid="videoComponent"]',
      "video"
    ].join(", ")
  };

  const MEDIA_HOST_RE = /^https?:\/\/pbs\.twimg\.com\//i;
  const MEDIA_PATH_RE = /^https?:\/\/pbs\.twimg\.com\/media\//i;
  // 头像 / 表情 / 卡片图标都可能挂在 pbs 上，但都不在 /media/ 下
  const IMG_BLOCK = [/\/profile_images\//i, /\/emoji\//i, /\/hashflags\//i, /\/card_img\//i];

  // ---------- 配置 ----------
  function loadState() {
    // 等语言读出来再建按钮，避免英文界面先闪一下中文 title
    langReady.then(() => {
      chrome.storage.sync.get(
        ["twitterEnabled", "twitterImageQuality", "twitterVideoQuality"],
        (res) => {
          enabled = res.twitterEnabled !== false;
          settings.imageQuality = res.twitterImageQuality || settings.imageQuality;
          settings.videoQuality = res.twitterVideoQuality || settings.videoQuality;
          if (enabled) scan();
          else removeAllButtons();
        }
      );
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.twitterEnabled) {
      enabled = changes.twitterEnabled.newValue !== false;
      if (enabled) scan();
      else removeAllButtons();
    }
    if (changes.twitterImageQuality) {
      settings.imageQuality = changes.twitterImageQuality.newValue;
      itemCache.clear(); // 清晰度变了，之前算好的候选地址作废
    }
    if (changes.twitterVideoQuality) {
      settings.videoQuality = changes.twitterVideoQuality.newValue;
      itemCache.clear();
    }
  });

  /* 语言切换后就地刷新已注入按钮的提示文字：不再重新扫描，也不用刷新页面。
   * 正在下载的那条保持「点击取消」，只换语言不换语义。 */
  function refreshButtonTitles() {
    for (const e of entries) {
      if (!e || e.dead || !e.btn) continue;
      const busy = ring.pid && ring.btn === e.btn;
      e.btn.title = busy ? titleBusy() : titleIdle();
      if (busy) e.btn.setAttribute("aria-label", t("btn.aria.cancel"));
      else e.btn.removeAttribute("aria-label");
    }
  }
  if (I18N) I18N.onChange(refreshButtonTitles);

  function removeAllButtons() {
    while (entries.length) {
      const e = entries.pop();
      e.btn.remove();
      if (e.root.isConnected) e.root.removeAttribute(PROCESSED_ATTR);
    }
  }

  // 统一给后台发消息：任何异常（含扩展被重载后 context 失效）都吞掉，不让页面报错
  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---------- 图片地址：pbs.twimg.com ----------
  function isMediaUrl(url) {
    if (!url || !MEDIA_HOST_RE.test(url)) return false;
    if (!/\/media\//i.test(url)) return false;
    for (const re of IMG_BLOCK) {
      if (re.test(url)) return false;
    }
    return true;
  }

  function imageUrlOf(img) {
    const cands = [img.currentSrc, img.getAttribute("src"), img.getAttribute("data-src")];
    for (const c of cands) {
      if (c && isMediaUrl(c)) return c;
    }
    return "";
  }

  /* 给 pbs 地址换尺寸档：?name=orig / 4096x4096 / large / medium / small。
   * URL 里没有 format 也没有扩展名时补 format=jpg，否则 pbs 会 400。 */
  function withName(url, name) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return url;
    }
    u.searchParams.set("name", name);
    if (!u.searchParams.has("format") && !/\.[a-z0-9]{2,4}$/i.test(u.pathname)) {
      u.searchParams.set("format", "jpg");
    }
    return u.toString();
  }

  /* 图片档位：pbs 的 name 参数 → 实际长边宽度。orig 是上传原图（最大档）。
   * 设置页与 Instagram 共用一套取值（orig / 240 / 480 / 720 / 1080 / 2k / 4k），
   * 这里翻译成 pbs 的 name；选档规则一致：取不低于设置的最小一档，源图最高档
   * 低于设置（比如设了 4K）时落到原图。 */
  const IMG_TIERS = [
    { name: "small", w: 680 },
    { name: "medium", w: 1200 },
    { name: "large", w: 2048 },
    { name: "4096x4096", w: 4096 },
    { name: "orig", w: Infinity }
  ];
  const IMG_TARGET = {
    "240": 240,
    "480": 480,
    "720": 720,
    "1080": 1080,
    "2k": 1440,
    "4k": 2160,
    orig: Infinity
  };
  // v2.3.1 及以前存下的是 pbs 档位名（small / medium / large / 4096x4096），
  // 更早的版本还存过像素值（4096 / 2048 / 1200 / 680），读到就地折算
  const IMG_LEGACY = {
    small: "240",
    medium: "720",
    large: "2k",
    "4096x4096": "4k",
    4096: "4k",
    2048: "2k",
    1200: "720",
    680: "240"
  };

  function normalizeImageQuality(q) {
    if (IMG_TARGET[q] !== undefined) return q;
    return IMG_LEGACY[q] || "orig";
  }

  // 设置值或档位名 → 起始档位下标（不低于设置的最小一档）
  function imageTierIndex(q) {
    const target = IMG_TARGET[normalizeImageQuality(q)];
    const i = IMG_TIERS.findIndex((t) => t.w >= target);
    return i < 0 ? IMG_TIERS.length - 1 : i;
  }

  // 候选顺序：所选档 → 更高的档 → 原图。返回 pbs 的 name
  function imageTierOrder(q) {
    return IMG_TIERS.slice(imageTierIndex(q)).map((t) => t.name);
  }

  /* 候选按优先级排列：所选档 → 逐档往上 → 页面原本给的地址。
   * 清晰度规则：以设置为准；只有当源素材最高档低于设置（或所选档取不到）时，
   * 才顺着候选链拿到源素材能给的最高档——永远不会因为设置过高而下载失败。
   * 取不到的档在取字节阶段会被逐个跳过，最后一档是保底。 */
  function imageCandidates(url, quality) {
    const list = [];
    const push = (u) => {
      if (u && list.indexOf(u) < 0) list.push(u);
    };
    for (const name of imageTierOrder(quality || settings.imageQuality)) {
      push(withName(url, name));
    }
    push(String(url).replace(/[?#].*$/, ""));
    push(url);
    return list;
  }

  // ---------- 视频地址：video.twimg.com ----------
  function fixProto(u) {
    if (typeof u !== "string") return "";
    if (u.indexOf("//") === 0) return "https:" + u;
    return /^https?:/i.test(u) ? u : "";
  }

  function dedupe(list) {
    const out = [];
    for (const u of list) {
      if (u && out.indexOf(u) < 0) out.push(u);
    }
    return out;
  }

  /* 视频清晰度 → 目标高度。设置页标注的技术标准就是这一档的下限：
   * 480P / 720P / 1080P / 2K；原画质（orig）＝源最高档。
   * hd / sd 是 v2.3.x 之前存下的值，设置页已不再提供，读到就按老语义折算。 */
  const VIDEO_TARGET = {
    "480": 480,
    "720": 720,
    "1080": 1080,
    "2k": 1440,
    "orig": Infinity,
    hd: Infinity,
    sd: 480
  };

  /* X 的 mp4 档只给码率、不给分辨率，而官方产出的档位与码率是稳定对应的
   * （≈360P 不到 1M，≈720P 在 2M 上下，≈1080P 在 5M 以上），据此反推高度用于选档。 */
  function heightOfBitrate(bps) {
    if (bps >= 4000000) return 1080;
    if (bps >= 1200000) return 720;
    if (bps >= 400000) return 360;
    return 180;
  }

  /* 按设置排成偏好顺序：不低于设置的最小一档 → 更低的档（高到低）→ 判不出档的。
   * 取字节阶段逐档回退，所以顺序就是「按设置生效」的落地方式。 */
  function orderByQuality(list, q) {
    const target = VIDEO_TARGET[q] !== undefined ? VIDEO_TARGET[q] : VIDEO_TARGET["720"];
    const known = list.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
    const unknown = list.filter((x) => !(x.h > 0));
    if (target === Infinity) return known.concat(unknown); // 原画质：源最高档起步
    const up = known.filter((x) => x.h >= target).sort((a, b) => a.h - b.h);
    const down = known.filter((x) => x.h < target); // known 已按高到低排好，过滤后仍有序
    return up.concat(down, unknown);
  }

  /* variants → 可下载的 mp4 列表。
   * X 的 video_info 里通常同时给 m3u8（HLS，需要切片+合流）和多档 mp4；
   * 我们只保留 mp4，再按设置选档（见 orderByQuality）。
   * 源只有一档时，任何设置都会落到这一档（= 源最高档），不会下载失败。 */
  function videoCandidates(variants, quality) {
    const q = quality || settings.videoQuality;
    const list = [];
    for (const v of variants || []) {
      if (!v || !v.url) continue;
      const ct = String(v.content_type || "").toLowerCase();
      const url = fixProto(v.url);
      if (!/^https?:/i.test(url)) continue;
      if (ct.indexOf("mpegurl") >= 0 || /\.m3u8(\?|$)/i.test(url)) continue; // HLS 不是文件
      if (ct && ct.indexOf("mp4") < 0) continue;
      list.push({ url, h: heightOfBitrate(Number(v.bitrate) || 0) });
    }
    return orderByQuality(list, q).map((x) => x.url);
  }

  // ---------- 媒体实体 → 下载项 ----------
  // 统一收口：hook（GraphQL）与 syndication 接口给的实体形状相同
  //   { type: "photo" | "video" | "animated_gif", url, variants }
  function normalizeMedia(entities) {
    const out = [];
    if (!Array.isArray(entities)) return out;
    for (const m of entities) {
      if (!m) continue;
      const type = String(m.type || "").toLowerCase();
      if (type === "photo" || type === "image" || (!type && m.url)) {
        const url = m.media_url_https || m.url;
        if (isMediaUrl(url)) out.push({ type: "image", candidates: imageCandidates(url) });
        continue;
      }
      const cands = videoCandidates(m.variants || []);
      // 只有 HLS 的视频（无 mp4 档）在这里会拿不到候选，交给 DOM 兜底
      if (cands.length) out.push({ type: "video", candidates: cands });
    }
    return out;
  }

  // ---------- 第 1 层：页面自身抓到的 GraphQL 数据 ----------
  /* 与 twitter-hook.js 的约定：window.postMessage
   *   问：{ __xdl: "query", id, reqId }
   *   答：{ __xdl: "media", id, reqId, media: [{type,url,variants}] }
   * 页面里没有这条推文时 hook 会立刻回 media:null，这里最多等 400ms，
   * 保证「点了没反应」不会超过半秒。 */
  function queryHook(id) {
    return new Promise((resolve) => {
      if (!window.postMessage || !window.addEventListener) {
        resolve(null);
        return;
      }
      const reqId = "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try {
          window.removeEventListener("message", onMsg);
        } catch (e) {
          /* ignore */
        }
        resolve(v);
      };
      function onMsg(ev) {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__xdl !== "media" || d.reqId !== reqId) return;
        finish(Array.isArray(d.media) ? d.media : null);
      }
      window.addEventListener("message", onMsg);
      try {
        window.postMessage({ __xdl: "query", id: String(id), reqId }, "*");
      } catch (e) {
        finish(null);
        return;
      }
      setTimeout(() => finish(null), 400);
    });
  }

  // ---------- 第 2 层：官方嵌入接口 ----------
  /* token 是 X 自己前端在用的那套算法（把 id 映射成一个稳定的短串），
   * 不带 token 时接口也常能返回，但带上更稳。 */
  function tweetToken(id) {
    try {
      return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
    } catch (e) {
      return "";
    }
  }

  function parseJsonSafe(text) {
    if (!text) return null;
    const s = String(text).trim();
    if (!s || s.charAt(0) !== "{") return null; // 失败时可能返回 HTML
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  // 兼容接口的两种形状：新版 mediaDetails[]，老版 photos[] + video{}
  function entitiesOfTweet(json) {
    const out = [];
    if (Array.isArray(json.mediaDetails)) {
      for (const m of json.mediaDetails) {
        if (!m) continue;
        out.push({
          type: m.type || (m.video_info ? "video" : "photo"),
          url: m.media_url_https,
          variants: (m.video_info && m.video_info.variants) || null
        });
      }
      return out;
    }
    if (Array.isArray(json.photos)) {
      for (const p of json.photos) {
        out.push({ type: "photo", url: (p && (p.url || p.media_url_https)) || "" });
      }
    }
    if (json.video && Array.isArray(json.video.variants)) {
      out.push({
        type: "video",
        url: json.video.poster || "",
        variants: json.video.variants
      });
    }
    return out;
  }

  function fetchTweet(id) {
    const url =
      "https://cdn.syndication.twimg.com/tweet-result?id=" +
      encodeURIComponent(id) +
      "&lang=en&token=" +
      tweetToken(id);
    return sendBg({ action: "x-api", url }).then((resp) => {
      const json = parseJsonSafe(resp && resp.ok ? resp.text : "");
      return json ? entitiesOfTweet(json) : null;
    });
  }

  // ---------- 第 3 层：DOM 兜底 ----------
  function isUsableImage(img) {
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) return false;
    return isMediaUrl(imageUrlOf(img));
  }

  function isUsableVideo(v) {
    const r = v.getBoundingClientRect();
    return r.width > 80 && r.height > 60;
  }

  function domMedia(root) {
    const out = [];

    for (const v of root.querySelectorAll("video")) {
      if (!isUsableVideo(v)) continue;
      const cands = dedupe(
        [v.currentSrc, v.src, v.getAttribute("data-src")]
          .map((u) => (u && /^https?:/i.test(u) ? u : ""))
          .filter(Boolean)
      );
      // blob: / MSE 流拿不到直链，这一档只能放弃（前两层通常已经命中）
      if (cands.length) out.push({ type: "video", candidates: cands });
    }

    const seen = new Set();
    const pushImg = (u) => {
      if (!isMediaUrl(u)) return;
      const key = u.split("?")[0];
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ type: "image", candidates: imageCandidates(u) });
    };
    const photos = root.querySelectorAll('[data-testid="tweetPhoto"] img');
    for (const img of photos) {
      if (!isUsableImage(img)) continue;
      pushImg(imageUrlOf(img));
    }
    // 兜底：结构又变了的时候，按域名 + 尺寸再捞一遍
    if (!out.some((x) => x.type === "image")) {
      for (const img of root.querySelectorAll("img")) {
        if (isUsableImage(img)) pushImg(imageUrlOf(img));
      }
    }
    return out;
  }

  // ---------- 汇总：hook → 接口 → DOM ----------
  function mediaOf(root) {
    const id = tweetIdOf(root);
    if (!id) return Promise.resolve(domMedia(root));
    if (itemCache.has(id)) return Promise.resolve(itemCache.get(id));

    return queryHook(id)
      .then((entities) => {
        const items = normalizeMedia(entities);
        if (items.length) return items;
        return fetchTweet(id).then((list) => normalizeMedia(list));
      })
      .then((items) => {
        if (items && items.length) {
          console.debug(LOG, "id", id, "取到媒体数", items.length);
          cacheSet(id, items);
          return items;
        }
        console.debug(LOG, "id", id, "接口未取到，改用 DOM 兜底");
        return domMedia(root);
      })
      .catch((e) => {
        console.debug(LOG, "取媒体失败", e && e.message);
        return domMedia(root);
      });
  }

  // ---------- 卡片定位 ----------
  function findRoot(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 24; depth++) {
      for (const sel of SEL.roots) {
        if (node.matches && node.matches(sel)) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /* 推文 id：优先取 <time> 所在的时间戳链接（这是这条推文自己的永久链接），
   * 它不会像「引用推文」里的链接那样把 id 张冠李戴。
   * 拿不到时退回第一个 /status/ 链接。 */
  function tweetIdOf(root) {
    const time = root.querySelector("time");
    if (time) {
      const a = time.closest && time.closest("a[href]");
      const m = a && (a.getAttribute("href") || "").match(/\/status\/(\d{5,})/);
      if (m) return m[1];
    }
    const links = root.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const m = (a.getAttribute("href") || "").match(/\/status\/(\d{5,})/);
      if (m) return m[1];
    }
    return null;
  }

  // 卡片里有没有「本条推文」的媒体。这里放宽：只看结构不看当前 src，
  // 因为真实地址来自接口，不依赖这张图加载到哪一步。
  function hasMedia(root) {
    let nodes;
    try {
      nodes = root.querySelectorAll(SEL.media + ", img");
    } catch (e) {
      return false;
    }
    for (const n of nodes) {
      if (n.tagName === "IMG") {
        const r = n.getBoundingClientRect();
        if (r.width >= 100 && r.height >= 80 && isMediaUrl(imageUrlOf(n))) return true;
        continue;
      }
      return true;
    }
    return false;
  }

  // ---------- 按钮 ----------
  const titleIdle = () => t("btn.title.twitter");
  const titleBusy = () => t("btn.title.busy");

  function makeButton() {
    const btn = document.createElement("button");
    btn.className = "x-dl-btn";
    btn.title = titleIdle();
    // 两个图标叠着放，靠 .x-dl-progress 切换：下载中显示「停止」方块，
    // 让「再点一次 = 取消」这件事在视觉上说得通
    btn.innerHTML =
      '<svg class="x-dl-ico x-dl-ico-dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      '<svg class="x-dl-ico x-dl-ico-stop" viewBox="0 0 24 24">' +
      '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
    return btn;
  }

  function flash(btn, cls) {
    if (!btn) return;
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 1500);
  }

  /* ---------- 下载进度环 ----------
   * 与微博同一套状态机：解析阶段 2%→12% 缓慢爬升，取字节阶段按真实字节比例
   * 封顶 98%，「字节取完、准备弹保存框」那一刻填满 100%。
   */
  const ring = { pid: null, btn: null, p: 0, ceiling: 12, known: false, timer: 0 };

  const canceledIds = new Set();

  function isCanceled(pid) {
    return !!(pid && canceledIds.has(pid));
  }

  function markCanceled(pid) {
    if (!pid) return;
    canceledIds.add(pid);
    setTimeout(() => canceledIds.delete(pid), 30000);
  }

  function paintRing() {
    if (ring.btn) ring.btn.style.setProperty("--x-dl-p", ring.p.toFixed(1));
  }

  function stopRingTimer() {
    if (ring.timer) {
      clearInterval(ring.timer);
      ring.timer = 0;
    }
  }

  function newProgressId() {
    return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function startRing(btn, pid) {
    endRing(); // 结束上一个没收尾的进度，避免两个环打架
    ring.pid = pid;
    ring.btn = btn;
    ring.p = 2;
    ring.ceiling = 12;
    ring.known = false;
    btn.classList.add("x-dl-progress");
    btn.title = titleBusy();
    btn.setAttribute("aria-label", t("btn.aria.cancel"));
    paintRing();
    stopRingTimer();
    ring.timer = setInterval(() => {
      if (ring.known || !ring.btn) return;
      if (ring.p >= ring.ceiling) return;
      ring.p = Math.min(ring.ceiling, ring.p + Math.max(0.45, (ring.ceiling - ring.p) * 0.08));
      paintRing();
    }, 260);
  }

  function endRing(pid) {
    if (pid && ring.pid && pid !== ring.pid) return;
    stopRingTimer();
    if (ring.btn) {
      ring.btn.classList.remove("x-dl-progress");
      ring.btn.style.removeProperty("--x-dl-p");
      ring.btn.title = titleIdle();
      ring.btn.removeAttribute("aria-label");
    }
    ring.pid = null;
    ring.btn = null;
    ring.p = 0;
    ring.ceiling = 12;
    ring.known = false;
  }

  function onRingProgress(msg) {
    if (!ring.pid || msg.id !== ring.pid || !ring.btn) return;
    if (msg.phase === "fetch") {
      if (msg.total > 0) {
        ring.known = true;
        ring.p = Math.max(ring.p, Math.min(98, (msg.loaded / msg.total) * 100));
        paintRing();
      } else {
        ring.known = false;
        ring.ceiling = Math.max(ring.ceiling, 92);
      }
      return;
    }
    if (msg.phase === "save") {
      ring.known = true;
      ring.ceiling = 100;
      ring.p = 100;
      paintRing();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "wb-dl-progress") return; // 三站共用同一条进度通道
    onRingProgress(msg);
  });

  function showToast(text, kind) {
    const el = document.createElement("div");
    el.className = "x-dl-toast" + (kind === "info" ? " x-dl-toast-info" : "");
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), kind === "info" ? 2200 : 5000);
  }

  function errorText(resp) {
    if (chrome.runtime.lastError) return chrome.runtime.lastError.message;
    if (resp && resp.error === "permission") return t("err.permission");
    if (resp && resp.error === "media-blocked") return t("err.blockedTwitter");
    if (resp && resp.error === "all-fetch-failed") return t("err.allFailed");
    if (resp && resp.error === "aborted") return t("err.aborted");
    if (resp && resp.error) return String(resp.error);
    return t("err.unknown");
  }

  function cancelActive(btn) {
    const pid = ring.pid;
    if (!pid) return;
    markCanceled(pid);
    endRing();
    flash(btn, "x-dl-canceled");
    showToast(t("toast.canceled"), "info");
    sendBg({ action: "cancel", progressId: pid });
  }

  function downloadItem(btn, item, nameSuffix, pid) {
    const candidates = (item.candidates || []).filter((u) => /^https?:/i.test(u));
    if (!candidates.length) {
      endRing(pid);
      flash(btn, "x-dl-error");
      showToast(t("toast.noMedia"));
      return;
    }
    const id = pid || newProgressId();
    if (isCanceled(id)) {
      endRing(id);
      return;
    }
    if (!pid) startRing(btn, id);
    sendBg({
      action: "download",
      site: "twitter",
      type: item.type,
      candidates,
      nameSuffix: nameSuffix || "",
      progressId: id
    }).then((resp) => {
      if (isCanceled(id) || (resp && (resp.canceled || resp.error === "aborted"))) {
        endRing(id);
        return;
      }
      endRing(id);
      if (!resp) {
        flash(btn, "x-dl-error");
        showToast(t("toast.noResponse"));
        return;
      }
      if (!resp.ok) {
        flash(btn, "x-dl-error");
        showToast(t("toast.dlFailed", { msg: errorText(resp) }));
      } else {
        flash(btn, "x-dl-done");
      }
    });
  }

  // ---------- 多图选择菜单 ----------
  let openMenu = null;

  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
  }

  document.addEventListener(
    "click",
    (ev) => {
      if (!openMenu) return;
      const target = ev.target;
      if (openMenu.contains(target)) return;
      if (target && target.closest && target.closest(".x-dl-btn")) return;
      closeMenu();
    },
    true
  );

  function showMenu(btn, list) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "x-dl-menu";

    const single = document.createElement("button");
    single.className = "x-dl-menu-item";
    single.textContent = t("menu.firstOnly");
    single.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      downloadItem(btn, list[0], "");
    });

    const all = document.createElement("button");
    all.className = "x-dl-menu-item";
    all.textContent = t("menu.allZipX", { n: list.length });
    all.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      if (ring.pid) return; // 已有下载在进行
      const pid = newProgressId();
      const items = list.map((it) => ({ candidates: it.candidates, type: it.type }));
      startRing(btn, pid);
      sendBg({
        action: "zip",
        site: "twitter",
        prefix: "twitter_",
        items,
        progressId: pid
      }).then((resp) => {
        if (isCanceled(pid) || (resp && (resp.canceled || resp.error === "aborted"))) {
          endRing(pid);
          return;
        }
        endRing(pid);
        if (!resp) {
          flash(btn, "x-dl-error");
          showToast(t("toast.zipNoResponse"));
        } else if (!resp.ok) {
          flash(btn, "x-dl-error");
          showToast(t("toast.zipFailed", { msg: errorText(resp) }));
        } else {
          flash(btn, "x-dl-done");
        }
      });
    });

    menu.appendChild(single);
    menu.appendChild(all);

    const r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, r.right - 200) + "px";
    document.body.appendChild(menu);
    openMenu = menu;
  }

  // ---------- 点击 ----------
  function onDownloadClick(ev, root) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    if (openMenu) {
      closeMenu();
      return;
    }
    if (ring.pid) {
      // 加载中再点一次 = 取消；只允许取消自己这条按钮发起的下载
      if (ring.btn === btn) cancelActive(btn);
      else showToast(t("toast.busyOtherTwitter"), "info");
      return;
    }

    const pid = newProgressId();
    startRing(btn, pid);
    mediaOf(root)
      .then((list) => {
        if (isCanceled(pid)) return;
        if (!list || !list.length) {
          endRing(pid);
          flash(btn, "x-dl-error");
          showToast(t("toast.noMediaDeep"));
          return;
        }
        if (list.length === 1) {
          downloadItem(btn, list[0], "", pid);
          return;
        }
        endRing(pid); // 等用户选菜单，先收掉进度
        showMenu(btn, list);
      })
      .catch((e) => {
        if (isCanceled(pid)) return;
        endRing(pid);
        flash(btn, "x-dl-error");
        showToast(t("toast.parseFailed", { msg: e && e.message ? e.message : e }));
      });
  }

  function attachTo(root) {
    if (!root || root.hasAttribute(PROCESSED_ATTR)) return;
    if (entries.some((e) => !e.dead && e.root === root)) return;
    // 多个选择器可能命中同一条推文（嵌套容器），任一方向已处理就跳过
    if (root.closest && root.closest("[" + PROCESSED_ATTR + "]")) return;
    if (root.querySelector && root.querySelector("[" + PROCESSED_ATTR + "]")) return;
    root.setAttribute(PROCESSED_ATTR, "1");
    const btn = makeButton();
    btn.addEventListener("click", (ev) => onDownloadClick(ev, root), true);
    // 拦截指针事件，避免点击穿透到 X 的图片查看层/播放器
    ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick"].forEach((type) => {
      btn.addEventListener(
        type,
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        },
        true
      );
    });
    document.body.appendChild(btn);
    const entry = { btn, root, dead: false, nodes: null, nodesAt: 0 };
    entries.push(entry);
    positionEntry(entry);
  }

  /* ---------- 定位 ----------
   * X 的卡片结构和微博不一样：头像正右方就是 X 自己的「···」菜单按钮，
   * 放在卡片外右侧又会压到右栏。所以改成贴在这条推文的媒体区域右上角
   * （多图九宫格取整块的右上角），既不会和 X 的按钮打架，也只出现在有媒体的卡片上。
   * 媒体很高、滚到视口上方时把按钮夹在可视区内，避免整块图看不到按钮。
   */
  function mediaNodesOf(e) {
    if (e.nodes && e.nodes.every((n) => n.isConnected)) return e.nodes;
    if (Date.now() - (e.nodesAt || 0) < 2000) return e.nodes || [];
    e.nodesAt = Date.now();
    const out = [];
    for (const n of e.root.querySelectorAll(SEL.media)) {
      if (n.closest && n.closest('article[data-testid="tweet"]') !== e.root) continue;
      out.push(n);
    }
    e.nodes = out;
    return out;
  }

  function mediaBox(nodes) {
    let box = null;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (r.width < 60 || r.height < 40) continue;
      if (!box) {
        box = { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
      } else {
        box.top = Math.min(box.top, r.top);
        box.left = Math.min(box.left, r.left);
        box.right = Math.max(box.right, r.right);
        box.bottom = Math.max(box.bottom, r.bottom);
      }
    }
    return box;
  }

  // X 顶部是 sticky 的时间线标题栏，内容会滑到它下面
  const occl = { value: 0, at: 0 };

  function occludedTop() {
    const now = Date.now();
    if (now - occl.at < 400) return occl.value;
    occl.at = now;

    let bottom = 0;
    const probes = [
      [0.5, 8],
      [0.3, 8],
      [0.5, 36],
      [0.8, 8]
    ];
    for (const [fx, py] of probes) {
      let el = null;
      try {
        el = document.elementFromPoint(Math.round(window.innerWidth * fx), py);
      } catch (e) {
        continue;
      }
      if (!el) continue;
      if (el.classList && el.classList.contains("x-dl-btn")) continue;
      let guard = 0;
      while (el && guard++ < 12) {
        const cs = getComputedStyle(el);
        if ((cs.position === "fixed" || cs.position === "sticky") && el.getBoundingClientRect().top <= 2) {
          const r = el.getBoundingClientRect();
          if (r.height > 20 && r.height < 240 && r.width > window.innerWidth * 0.5) {
            bottom = Math.max(bottom, r.bottom);
          }
          break;
        }
        el = el.parentElement;
      }
    }

    if (!bottom) {
      for (const sel of ['header[role="banner"]', '[data-testid="TopNavBar"]', "header"]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        const r = el.getBoundingClientRect();
        if (r.top <= 2 && r.bottom > 0 && r.height < 240) bottom = Math.max(bottom, r.bottom);
      }
    }
    occl.value = bottom;
    return bottom;
  }

  function positionEntry(e) {
    if (!e.root.isConnected) {
      e.btn.remove();
      e.dead = true;
      return;
    }
    const cr = e.root.getBoundingClientRect();
    if (cr.width <= 60 || cr.height <= 60) {
      e.btn.style.display = "none";
      return;
    }
    const box = mediaBox(mediaNodesOf(e));
    if (!box) {
      e.btn.style.display = "none";
      return;
    }

    const size = 34;
    const guard = occludedTop();
    // 媒体整体滑出视口（上或下）就不显示；顶部被吸顶栏盖住时同样隐藏
    if (box.bottom <= guard || box.top >= window.innerHeight) {
      e.btn.style.display = "none";
      return;
    }

    const top = Math.min(Math.max(box.top + 8, guard + 6), window.innerHeight - size - 6);
    const left = Math.min(Math.max(box.right - size - 8, 8), window.innerWidth - size - 10);
    e.btn.style.display = "";
    e.btn.style.top = Math.round(top) + "px";
    e.btn.style.left = Math.round(left) + "px";
  }

  function positionAll() {
    rafPending = false;
    const seen = new Set();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e.dead && seen.has(e.root)) {
        e.btn.remove();
        e.dead = true;
      }
      if (e.dead) {
        entries.splice(i, 1);
        continue;
      }
      seen.add(e.root);
      positionEntry(e);
    }
  }

  function schedulePosition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(positionAll);
  }

  function scan() {
    if (!enabled) return;
    for (const sel of SEL.roots) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const root of nodes) {
        if (root.hasAttribute(PROCESSED_ATTR)) continue;
        if (!hasMedia(root)) continue;
        attachTo(root);
      }
    }
  }

  // X 的时间线 DOM 变动极频繁（虚拟滚动、浏览量/点赞数实时更新），
  // 全量扫描节流到 300ms 一次；定位仍走 rAF。
  let scanTimer = 0;
  const observer = new MutationObserver(() => {
    if (!enabled) return;
    schedulePosition();
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 300);
  });

  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);

  /* 诊断入口（DevTools 里选中扩展的隔离世界）：
   *   __xdl.debug()          当前识别到的每条推文：id / 媒体数 / 类型
   *   __xdl.inspect(0)       对第 0 条跑完整取址链路
   *   __xdl.resolve("id")    直接看某条推文的解析结果
   *   __xdl.hook("id")       只看页面 hook 抓到的原始数据（不发网络请求）
   *   __xdl.checkImage(url)  看图片候选档位
   *   __xdl.ring() / cancel() 进度环状态 / 取消当前下载
   */
  window.__xdl = {
    sel: SEL,
    tweetIdOf,
    findRoot,
    normalizeMedia,
    imageCandidates,
    withName,
    videoCandidates,
    // 选档排序（回归测试用）：把 [{url,h}] 按设置排成偏好顺序
    orderByQuality,
    isMediaUrl,
    _makeBtn: makeButton,
    _startRing: startRing,
    _endRing: endRing,
    _cancelActive: cancelActive,
    _isCanceled: isCanceled,
    _queryHook: queryHook,
    _fetchTweet: fetchTweet,
    debug() {
      const rows = [];
      for (const sel of SEL.roots) {
        for (const root of document.querySelectorAll(sel)) {
          if (!hasMedia(root)) continue;
          const medias = root.querySelectorAll(SEL.media);
          rows.push({
            sel,
            tweetId: tweetIdOf(root),
            media: medias.length,
            kinds: Array.prototype.map
              .call(medias, (m) => m.getAttribute("data-testid") || m.tagName.toLowerCase())
              .join(",")
          });
        }
      }
      console.table(rows);
      return rows;
    },
    inspect(index) {
      const roots = [];
      for (const sel of SEL.roots) {
        for (const root of document.querySelectorAll(sel)) {
          if (hasMedia(root) && roots.indexOf(root) < 0) roots.push(root);
        }
      }
      const root = roots[index || 0];
      if (!root) {
        console.warn(LOG, "没有第", index || 0, "条推文");
        return Promise.resolve([]);
      }
      return mediaOf(root).then((list) => {
        console.log(LOG, "tweetId", tweetIdOf(root), "媒体数", list.length, list);
        return list;
      });
    },
    hook(id) {
      return queryHook(id).then((media) => {
        console.log(LOG, "hook 缓存", media);
        return media;
      });
    },
    resolve(id) {
      return fetchTweet(id).then((list) => {
        console.log(LOG, "接口实体", list);
        return normalizeMedia(list);
      });
    },
    checkImage(url) {
      const candidates = imageCandidates(url);
      console.log("候选档位:", candidates);
      return { isMedia: isMediaUrl(url), candidates };
    },
    scan,
    ring: () => ({ pid: ring.pid, percent: Math.round(ring.p), known: ring.known }),
    cancel() {
      if (!ring.pid) {
        console.log(LOG, "当前没有进行中的下载");
        return false;
      }
      cancelActive(ring.btn);
      return true;
    },
    occlusion: () => {
      occl.at = 0;
      const v = occludedTop();
      console.log(LOG, "吸顶栏底边 =", v, "px");
      return v;
    },
    clearCache: () => itemCache.clear()
  };

  loadState();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  langReady.then(scan);
})();
