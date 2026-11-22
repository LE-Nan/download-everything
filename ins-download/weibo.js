/* weibo.js — 微博网页端（weibo.com）图片/视频下载
 *
 * 与 ins 内容脚本完全独立：独立的 DOM 适配层、独立的取址链路、独立的按钮样式，
 * 互不共享变量，任何一个站点的改版都不会影响另一个。
 *
 * ── 架构选择 ────────────────────────────────────────────────
 * 纯 content script + 复用 background/offscreen。下载与打包写盘的能力
 * （自定义文件夹、zip、chrome.downloads）与站点无关，不需要为微博再写一套，
 * 只要在消息里带上 site: "weibo" 即可路由到独立的目录配置。
 *
 * ── 卡片识别（v1.2 修正）──────────────────────────────────────
 * 微博现在同时存在两套前端：
 *   新版首页/详情页  <article class="woo-panel-main">   ← 没有 mid 属性！
 *   搜索页/旧版列表  <div class="card-wrap" action-type="feed_list_item" mid="...">
 * v1.1 只认 [mid]，导致首页完全挂不上按钮。现改为按「最近祖先匹配任一卡片选择器」，
 * 并把帖子 id 的取值拆成两条：
 *   1) 有 mid 属性 → 直接用（数字 mid，接口同样接受）
 *   2) 没有 → 从卡片里的微博链接取 mblogid（形如 /{uid}/{mblogid}、/detail/xxx、/status/xxx）
 * 两者都能直接喂给 /ajax/statuses/show?id= 接口。
 *
 * ── 取址链路（逐级降级）────────────────────────────────────
 *   1) GET  /ajax/statuses/show?id={id}          —— 拿 pic_infos 原图、page_info/mix_media_info 视频
 *   2) POST /tv/api/component?page=/tv/show/{fid} —— 拿视频全部分辨率直链（最可靠的一档）
 *   3) DOM 兜底：本轮已渲染的 img / video；视频若是 blob 流则尝试卡片内的 fid 链接
 * 注意：s.weibo.com 上没有 /ajax/statuses/show 这个接口（返回的是 HTML 页面），
 * 所以同源取不到时自动改走 background → offscreen 的跨域兜底。
 *
 * ── 为什么下载必须由 offscreen 取字节 ──────────────────────
 * 把 CDN 地址直接交给 chrome.downloads 是不行的：下载请求由浏览器发起，
 * 带的是 chrome-extension:// 来源、没有页面 Referer，微博图床 / 视频 CDN 会
 * 返回 200 的 HTML 错误页；Chrome 识别到 HTML 就把后缀改成 .htm —— 这就是
 * 「下载下来是 .htm」的根因（多图 zip 之所以一直正常，正是因为它传的是本地数据）。
 * 现在改为：offscreen 逐个候选地址取回**真实字节**并嗅探文件头，再由 background
 * 以 blob / 写盘的方式交付，后缀与 MIME 完全由我们决定，服务器再也没有机会改。
 *
 * ── 可中断（v1.3.1）────────────────────────────────────────
 * 按钮点下去就进入加载态，加载态里**再点一次 = 取消**。取消不是只把界面收掉：
 * 解析阶段本地记一笔直接放弃；取字节 / 打包阶段让 offscreen 断掉 AbortController；
 * 保存框已弹出则 chrome.downloads.cancel()。三条链路都归一成 "canceled"，
 * 内容脚本静默复位按钮，不闪红、不重试、不会再弹第二个保存框。
 *
 * ⚠️ 选择器实测自公开维护中的同类脚本（owendswang / firo1603 的「下载微博图片和视频」），
 *    站点改版后应先跑 __wbDl.debug() 核对，只改下面 SEL 一处即可。
 */
(function () {
  "use strict";

  const LOG = "[weibo download]";
  const PROCESSED_ATTR = "data-wbdl-processed";

  // 界面文案走 i18n.js（manifest 里排在 weibo.js 之前）
  const I18N = globalThis.DELi18n || null;
  const langReady = I18N ? I18N.ready : Promise.resolve("zh");
  function t(key, vars) {
    return I18N ? I18N.t(key, vars) : key;
  }

  let enabled = true;
  // 微博专有配置，与 ins 的 imageQuality / videoQuality 互不干扰。
  // 图片默认取原图（orig，映射到微博的 large 档）：接口返回的本来就是最大档
  // 视频默认取原画质：不去猜接口给到哪一档，能拿到最高的就是最高的
  const settings = { imageQuality: "orig", videoQuality: "orig" };

  const entries = []; // { btn, root, dead }
  let rafPending = false;
  const statusCache = new Map(); // postId -> [{type, candidates}]
  const componentCache = new Map(); // fid -> [{url, height}]

  // ---------- 适配层：改版时只动这里 ----------
  const SEL = {
    // 最近祖先优先匹配；顺序即优先级（新版首页必须放第一个）
    roots: [
      "article.woo-panel-main", // 新版首页 / 详情页信息流卡片
      "div.card-wrap", // 搜索页 / 旧版列表卡片
      '[action-type="feed_list_item"]', // 旧版信息流
      "[mid]", // 兜底：任何带 mid 的容器
      "[data-mid]"
    ],
    media: "img, video"
  };

  // sinaimg 的尺寸标记，出现在 URL 第一段路径：/orj1080/xxx.jpg
  const IMG_TOKENS = [
    "thumb150",
    "thumb300",
    "thumb600",
    "wap180",
    "wap360",
    "orj360",
    "orj480",
    "bmiddle",
    "mw690",
    "mw1024",
    "mw2000",
    "orj1080",
    "oslarge",
    "large",
    "original"
  ];

  // 首段命中这些前缀的都不是正文配图：头像 crop.0.0.180.180.50、表情 m/emoticon、站点图标 images
  const IMG_BLOCK = [/^crop\./i, /^m$/i, /^images?$/i, /^upload/i, /^emoticon/i, /^n$/i];

  // ---------- 配置 ----------
  function loadState() {
    // 等语言读出来再建按钮，避免英文界面先闪一下中文 title
    langReady.then(() => {
      chrome.storage.sync.get(
        ["weiboEnabled", "weiboImageQuality", "weiboVideoQuality"],
        (res) => {
          enabled = res.weiboEnabled !== false;
          settings.imageQuality = res.weiboImageQuality || settings.imageQuality;
          settings.videoQuality = res.weiboVideoQuality || settings.videoQuality;
          if (enabled) scan();
          else removeAllButtons();
        }
      );
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.weiboEnabled) {
      enabled = changes.weiboEnabled.newValue !== false;
      if (enabled) scan();
      else removeAllButtons();
    }
    if (changes.weiboImageQuality) {
      settings.imageQuality = changes.weiboImageQuality.newValue;
      statusCache.clear(); // 清晰度变了，之前算好的候选地址作废，下载时按新设置重算
    }
    if (changes.weiboVideoQuality) {
      settings.videoQuality = changes.weiboVideoQuality.newValue;
      statusCache.clear();
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

  // ---------- 图片 URL ----------
  // 微博图片是懒加载的：src 常常还是占位图，真实地址在 data-src。
  // 所以先按顺序挑出「看起来是正文配图」的那个候选，再回退到 src。
  function imageUrlOf(img) {
    const cands = [
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
      img.currentSrc,
      img.src
    ];
    for (const c of cands) {
      if (c && isFeedImageUrl(c)) return c;
    }
    return img.currentSrc || img.src || "";
  }

  function urlPathSeg(url) {
    return url
      .replace(/^https?:\/\/[^/]+\//i, "")
      .split(/[/?#]/)[0]
      .toLowerCase();
  }

  // 只认「微博正文配图」：sinaimg.cn 域名 + 首段不是头像/表情/图标
  function isFeedImageUrl(url) {
    if (!url) return false;
    if (!/^https?:\/\/[\w.-]+sinaimg\.cn\//i.test(url)) return false;
    const seg = urlPathSeg(url);
    for (const re of IMG_BLOCK) {
      if (re.test(seg)) return false;
    }
    return true;
  }

  /* 微博图片档位：URL 首段的尺寸标记 → 实际宽度。large 是微博的原图（不压缩）。
   * 设置页与 Instagram 共用一套取值（orig / 240 / 480 / 720 / 1080 / 2k / 4k），
   * 这里把它翻译成微博自己的档位名，选档规则也一致：取「不低于设置的最小一档」，
   * 源图最高档都低于设置时（比如设了 4K）就落到原图。 */
  const IMG_TIERS = [
    { token: "orj360", w: 360 },
    { token: "orj480", w: 480 },
    { token: "mw690", w: 690 },
    { token: "mw1024", w: 1024 },
    { token: "orj1080", w: 1080 },
    { token: "mw2000", w: 2000 },
    { token: "large", w: Infinity }
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
  // v2.3.1 及以前把微博档位名直接存进了 storage（large / mw690 …），读到就地折算
  const IMG_LEGACY = {
    large: "orig",
    oslarge: "orig",
    original: "orig",
    mw2000: "2k",
    orj1080: "1080",
    mw1024: "720",
    mw690: "720",
    orj480: "480",
    orj360: "240"
  };

  function normalizeImageQuality(q) {
    if (IMG_TARGET[q] !== undefined) return q;
    return IMG_LEGACY[q] || "orig";
  }

  // 设置值或档位名 → 起始档位在 IMG_TIERS 里的下标（不低于设置的最小一档）
  function imageTierIndex(q) {
    const target = IMG_TARGET[normalizeImageQuality(q)];
    const i = IMG_TIERS.findIndex((t) => t.w >= target);
    return i < 0 ? IMG_TIERS.length - 1 : i;
  }

  // 候选顺序：所选档 → 更高的档 → 原图。返回微博的档位名
  function imageTierOrder(q) {
    return IMG_TIERS.slice(imageTierIndex(q)).map((t) => t.token);
  }

  // 换尺寸：/orj360/ → /orj1080/。首段不在白名单时原样返回，避免改坏别的路径
  // 参数可以是设置值（orig / 720 …），也可以直接是微博档位名（large / mw690 …）
  function applyImageQuality(url, quality) {
    const m = url.match(/^(https?:\/\/[^/]+)\/([^/?#]+)\/([^?#]+)([?#].*)?$/i);
    if (!m) return url;
    if (IMG_TOKENS.indexOf(m[2].toLowerCase()) < 0) return url;
    let token = quality || "large";
    // 不是微博的档位名，就当成设置值（orig / 240 / 720 / 2k …）翻译一次
    if (IMG_TOKENS.indexOf(String(token).toLowerCase()) < 0) {
      token = IMG_TIERS[imageTierIndex(token)].token;
    }
    return m[1] + "/" + token + "/" + m[3] + (m[4] || "");
  }

  // 候选按优先级排列：所选档 → 逐档往上 → 页面原本给的地址。
  // 微博并没有为每张图都生成所有档位，404 的档位会在取字节阶段被逐个跳过，
  // 所以这里给足备选；最后一档「原样地址」是保底——接口/页面给的地址一定真实存在。
  function imageCandidates(url, quality) {
    const list = [];
    const push = (u) => {
      if (u && list.indexOf(u) < 0) list.push(u);
    };
    for (const token of imageTierOrder(quality || settings.imageQuality)) {
      push(applyImageQuality(url, token));
    }
    push(url);
    return list;
  }

  // ---------- 卡片定位 ----------
  // 从媒体元素往上找最近的卡片容器；找不到就返回 null（宁可不挂按钮，也不错挂）
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

  // 帖子 id：优先 mid 属性，其次卡片里的微博链接（新版首页只有链接，没有 mid）
  function postIdOf(root) {
    const attr = root.getAttribute("mid") || root.getAttribute("data-mid");
    if (attr) return attr;

    const links = root.querySelectorAll("a[href]");
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      let m = href.match(/\/(\d{5,})\/([0-9A-Za-z]{6,14})(?:[?#/]|$)/);
      if (m) return m[2]; // /{uid}/{mblogid}
      m = href.match(/\/detail\/([0-9A-Za-z]{6,16})/);
      if (m) return m[1];
      m = href.match(/\/status\/([0-9A-Za-z]{6,16})/);
      if (m) return m[1];
    }
    return null;
  }

  function isUsableImage(img) {
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) return false; // 头像、图标、表情
    return isFeedImageUrl(imageUrlOf(img));
  }

  function isUsableVideo(v) {
    const r = v.getBoundingClientRect();
    return r.width > 80 && r.height > 60;
  }

  // 判断一张卡片里有没有媒体。这里刻意放宽：只要有一张「大到不可能是头像/图标」的图，
  // 或任意 video，就认为该卡片有媒体 —— 因为真正的地址是靠接口拿的，
  // 不依赖这张图当前的 src（新版信息流可能是占位图 / 懒加载未触发）。
  function hasMedia(root) {
    if (root.querySelector("video")) return true;
    const imgs = root.querySelectorAll("img");
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 80) return true;
    }
    return false;
  }

  // ---------- 接口：帖子详情 ----------
  // 微博接口对 XSRF-TOKEN 有校验，缺了可能被当成未登录请求
  function xsrfHeaders() {
    const h = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };
    const m = (document.cookie || "").match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    if (m) h["X-XSRF-TOKEN"] = decodeURIComponent(m[1]);
    return h;
  }

  function getStatus(id) {
    const path = "/ajax/statuses/show?id=" + encodeURIComponent(id);
    // 1) 同源直连（weibo.com 页面下都能通，带登录态）
    return fetch(path, {
      credentials: "include",
      headers: xsrfHeaders()
    })
      .then((r) => r.text().then((t) => ({ ok: r.ok, text: t })))
      .catch(() => null)
      .then((res) => {
        const parsed = parseJsonSafe(res && res.ok ? res.text : "");
        if (parsed) return parsed;
        // 2) 同源不通（s.weibo.com 无此接口 / 跨域被拦）→ 走后台 offscreen 兜底
        return sendBg({
          action: "weibo-api",
          url: "https://weibo.com" + path
        }).then((resp) => parseJsonSafe(resp && resp.ok ? resp.text : ""));
      });
  }

  function parseJsonSafe(text) {
    if (!text) return null;
    const t = String(text).trim();
    if (!t || t.charAt(0) !== "{") return null; // 微博失败时返回 HTML 登录页，直接排除
    try {
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  }

  // ---------- 接口：视频组件（拿全部分辨率直链）----------
  function fidOf(mediaInfo) {
    if (!mediaInfo || typeof mediaInfo !== "object") return null;
    const h5 = mediaInfo.h5_url || mediaInfo.page_url || "";
    let m = String(h5).match(/[?&]fid=(\d+:[\w]+)/);
    if (m) return m[1];
    m = String(h5).match(/\/tv\/show\/(\d+:[\w]+)/);
    if (m) return m[1];
    if (mediaInfo.object_id) return String(mediaInfo.object_id);
    if (mediaInfo.oid) return String(mediaInfo.oid);
    return null;
  }

  function componentVideo(fid) {
    if (componentCache.has(fid)) return Promise.resolve(componentCache.get(fid));
    const page = "/tv/show/" + fid;
    const body =
      "data=" +
      encodeURIComponent(JSON.stringify({ Component_Play_Playinfo: { oid: String(fid) } }));
    const path = "/tv/api/component?page=" + encodeURIComponent(page);

    return fetch(path, {
      method: "POST",
      credentials: "include",
      headers: Object.assign(xsrfHeaders(), {
        "Content-Type": "application/x-www-form-urlencoded"
      }),
      body
    })
      .then((r) => r.text().then((t) => ({ ok: r.ok, text: t })))
      .catch(() => null)
      .then((res) => {
        const parsed = parseJsonSafe(res && res.ok ? res.text : "");
        if (parsed) return parsed;
        return sendBg({
          action: "weibo-api",
          url: "https://weibo.com" + path,
          method: "POST",
          body,
          contentType: "application/x-www-form-urlencoded"
        }).then((resp) => parseJsonSafe(resp && resp.ok ? resp.text : ""));
      })
      .then((json) => {
        const urls =
          json && json.data && json.data.Component_Play_Playinfo
            ? json.data.Component_Play_Playinfo.urls
            : null;
        const list = [];
        if (urls && typeof urls === "object") {
          for (const key of Object.keys(urls)) {
            let u = urls[key];
            if (typeof u !== "string") continue;
            if (u.indexOf("//") === 0) u = "https:" + u;
            if (!/^https?:/i.test(u)) continue;
            const m = key.match(/(\d{3,4})p/);
            list.push({ url: u, height: m ? parseInt(m[1], 10) : 0 });
          }
        }
        list.sort((a, b) => b.height - a.height); // 高分辨率在前
        componentCache.set(fid, list);
        console.debug(LOG, "fid", fid, "组件返回清晰度档数", list.length);
        return list;
      });
  }

  // ---------- 取视频候选 ----------
  function fixProto(u) {
    if (typeof u !== "string") return "";
    if (u.indexOf("//") === 0) return "https:" + u;
    return /^https?:/i.test(u) ? u : "";
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

  // 老字段名自带档位：接口不给标签时靠它判高度（判不出记 0，排到最后兜底）
  const FIELD_HEIGHT = {
    mp4_1080p_mp4: 1080,
    mp4_720p_mp4: 720,
    mp4_hd_url: 720,
    stream_url_hd: 720,
    mp4_sd_url: 480,
    stream_url: 480,
    mp4_url: 0
  };

  // playback_list 的一项里找清晰度标签（微博写的是 "1080P" 这类字样）
  function playbackHeight(p) {
    const labels = [
      p.quality_label,
      p.quality_desc,
      p.meta && p.meta.quality_label,
      p.play_info && p.play_info.quality_label
    ];
    for (const s of labels) {
      if (typeof s !== "string") continue;
      const m = s.match(/(\d{3,4})\s*[pP]/);
      if (m) return parseInt(m[1], 10);
    }
    // 标签缺失时退回地址里的线索：.../mp4_720p.mp4、?label=mp4_hd
    const u = String((p.play_info && p.play_info.url) || "");
    const mp = u.match(/mp4_(\d{3,4})p/i);
    if (mp) return parseInt(mp[1], 10);
    const lm = u.match(/label=mp4_(hd|sd|ld)/i);
    if (lm) return lm[1].toLowerCase() === "hd" ? 720 : 480;
    return 0;
  }

  /* 按设置把候选排成偏好顺序：不低于设置的最小一档 → 更低的档（高到低）→ 判不出高度的。
   * 取字节阶段是逐档回退的，所以顺序本身就是「按设置生效」的落地方式。 */
  function orderByQuality(list, q) {
    const target = VIDEO_TARGET[q] !== undefined ? VIDEO_TARGET[q] : VIDEO_TARGET["720"];
    const known = list.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
    const unknown = list.filter((x) => !(x.h > 0));
    if (target === Infinity) return known.concat(unknown); // 原画质：源最高档起步
    const up = known.filter((x) => x.h >= target).sort((a, b) => a.h - b.h);
    const down = known.filter((x) => x.h < target); // known 已按高到低排好，过滤后仍有序
    return up.concat(down, unknown);
  }

  function videoCandidates(mediaInfo, quality) {
    const q = quality || settings.videoQuality;
    if (!mediaInfo || typeof mediaInfo !== "object") return Promise.resolve([]);
    const entries = [];
    const push = (u, h) => {
      const v = fixProto(u);
      if (!v) return;
      const hit = entries.find((x) => x.url === v);
      if (hit) {
        // 同一地址被多路提到时，补上更高的已知档位
        if (!hit.h && h > 0) hit.h = h;
        return;
      }
      entries.push({ url: v, h: h > 0 ? h : 0 });
    };

    // playback_list 是微博新版给的清晰度列表（按清晰度从高到低）
    if (Array.isArray(mediaInfo.playback_list)) {
      for (const p of mediaInfo.playback_list) {
        if (p && p.play_info && p.play_info.url) push(p.play_info.url, playbackHeight(p));
      }
    }
    // 常见字段：高清在前，标清在后（高度按字段名补齐，供选档排序用）
    Object.keys(FIELD_HEIGHT).forEach((k) => {
      if (typeof mediaInfo[k] === "string") push(mediaInfo[k], FIELD_HEIGHT[k]);
    });

    const fid = fidOf(mediaInfo);
    const viaComponent = fid ? componentVideo(fid) : Promise.resolve([]);

    return viaComponent.then((comp) => {
      // 组件接口给的是最完整的档位列表（自带 height），放最前面
      for (const x of comp) push(x.url, x.height);
      // 源只提供一档时，任何设置都会落到这一档，不会因为设置不匹配而下载失败
      return orderByQuality(entries, q).map((x) => x.url);
    });
  }

  // ---------- 解析接口返回的媒体 ----------
  function picUrlOf(p) {
    if (!p || typeof p !== "object") return "";
    const cands = [
      p.largest && p.largest.url,
      p.large && p.large.url,
      p.pic_big && p.pic_big.url,
      p.bmiddle && p.bmiddle.url,
      p.url
    ];
    for (const u of cands) {
      if (u && /^https?:/i.test(u)) return u;
    }
    return "";
  }

  function statusImageUrls(s) {
    const out = [];
    const seen = new Set();
    const push = (u) => {
      const key = String(u).split("?")[0];
      if (!u || seen.has(key)) return;
      seen.add(key);
      out.push(u);
    };

    // 新版：pic_infos 是 pic_id → 各档位；pic_ids 给出顺序（九宫格顺序）
    if (s.pic_infos && typeof s.pic_infos === "object") {
      const ids = Array.isArray(s.pic_ids) ? s.pic_ids : Object.keys(s.pic_infos);
      for (const id of ids) {
        push(picUrlOf(s.pic_infos[id]));
      }
      if (!ids.length) {
        for (const k of Object.keys(s.pic_infos)) push(picUrlOf(s.pic_infos[k]));
      }
    } else if (Array.isArray(s.pics)) {
      for (const p of s.pics) push(picUrlOf(p));
    }
    return out;
  }

  function parseStatus(json) {
    const root = json && json.data && (json.data.mblogid || json.data.idstr) ? json.data : json;
    const s = (root && root.retweeted_status) || root;
    if (!s || typeof s !== "object") return Promise.resolve([]);

    const mix =
      s.mix_media_info && Array.isArray(s.mix_media_info.items) ? s.mix_media_info.items : null;

    if (!mix) {
      // 单视频帖：page_info.media_info
      const mi = s.page_info && s.page_info.media_info;
      const out = [];
      const video = mi
        ? videoCandidates(mi).then((cands) => {
            if (cands.length) out.push({ type: "video", candidates: cands });
          })
        : Promise.resolve();
      return video.then(() => {
        // 视频帖的 pic_infos / pics 是视频封面，不是独立配图，不重复计入
        if (out.some((x) => x.type === "video")) return out;
        for (const u of statusImageUrls(s)) {
          out.push({ type: "image", candidates: imageCandidates(u) });
        }
        return out;
      });
    }

    // 图文 + 视频混排：并发解析但必须保留 items 原始顺序（位次由用户看到的第一张决定）
    const jobs = [];
    mix.forEach((it, index) => {
      if (!it || !it.type) return;
      const data = it.data || {};
      if (it.type === "video") {
        jobs.push(
          videoCandidates(data.media_info || data).then((cands) => ({
            index,
            item: cands.length ? { type: "video", candidates: cands } : null
          }))
        );
      } else if (it.type === "pic") {
        const u = picUrlOf(data);
        jobs.push(Promise.resolve({ index, item: u ? { type: "image", candidates: imageCandidates(u) } : null }));
      }
    });

    return Promise.all(jobs).then((rows) => {
      rows.sort((a, b) => a.index - b.index);
      const out = [];
      for (const r of rows) {
        if (r.item) out.push(r.item);
      }
      return out.length ? out : parseStatusNoMix(s);
    });
  }

  function parseStatusNoMix(s) {
    const out = [];
    for (const u of statusImageUrls(s)) {
      out.push({ type: "image", candidates: imageCandidates(u) });
    }
    return out;
  }

  // ---------- DOM 兜底 ----------
  function domMedia(root) {
    const out = [];
    const videos = root.querySelectorAll("video");
    for (const v of videos) {
      if (!isUsableVideo(v)) continue;
      let src = v.currentSrc || v.src || "";
      if (!/^https?:/i.test(src)) src = v.getAttribute("data-src") || "";
      if (!/^https?:/i.test(src)) {
        const so = v.querySelector("source");
        if (so && /^https?:/i.test(so.src)) src = so.src;
      }
      if (/^https?:/i.test(src)) out.push({ type: "video", candidates: [src] });
    }

    // 视频是 blob 流、页面又没给 id 时，卡片里通常还有 fid 链接可救
    if (!out.some((x) => x.type === "video")) {
      const a = root.querySelector('a[href*="fid="]');
      if (a) {
        const m = (a.getAttribute("href") || "").match(/fid=(\d+:[\w]+)/);
        if (m) {
          return componentVideo(m[1]).then((list) => {
            if (list.length) {
              const ordered = orderByQuality(
                list.map((x) => ({ url: x.url, h: x.height })),
                settings.videoQuality
              );
              out.push({ type: "video", candidates: ordered.map((x) => fixProto(x.url)).filter(Boolean) });
            }
            return out.concat(domImages(root));
          });
        }
      }
    }

    return Promise.resolve(out.concat(domImages(root)));
  }

  function domImages(root) {
    const out = [];
    const imgs = root.querySelectorAll("img");
    for (const img of imgs) {
      if (!isUsableImage(img)) continue;
      out.push({ type: "image", candidates: imageCandidates(imageUrlOf(img)) });
    }
    return out;
  }

  // ---------- 汇总：接口优先，DOM 兜底 ----------
  function mediaOf(root) {
    const id = postIdOf(root);
    if (!id) return domMedia(root);
    if (statusCache.has(id)) return Promise.resolve(statusCache.get(id));

    return getStatus(id)
      .then((json) => (json ? parseStatus(json) : []))
      .then((list) => {
        if (list && list.length) {
          console.debug(LOG, "id", id, "接口取到媒体数", list.length);
          statusCache.set(id, list);
          return list;
        }
        console.debug(LOG, "id", id, "接口未取到，改用 DOM 兜底");
        return domMedia(root);
      })
      .catch((e) => {
        console.debug(LOG, "取媒体失败", e && e.message);
        return domMedia(root);
      });
  }

  // ---------- 按钮 ----------
  // 文案按当前显示语言取，语言切换后由 refreshButtonTitles() 就地刷新
  const titleIdle = () => t("btn.title.weibo");
  const titleBusy = () => t("btn.title.busy");

  function makeButton() {
    const btn = document.createElement("button");
    btn.className = "wb-dl-btn";
    btn.title = titleIdle();
    // 两个图标叠着放，靠 .wb-dl-progress 切换：下载中显示「停止」方块，
    // 让「再点一次 = 取消」这件事在视觉上说得通（否则用户以为点了没反应）
    btn.innerHTML =
      '<svg class="wb-dl-ico wb-dl-ico-dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      '<svg class="wb-dl-ico wb-dl-ico-stop" viewBox="0 0 24 24">' +
      '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
    return btn;
  }

  function flash(btn, cls) {
    if (!btn) return;
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 1500);
  }

  /* ---------- 下载进度环 ----------
   * 视频动辄几 MB～几十 MB，从点击到弹出保存框要 5～15 秒。这段时间以前只有
   * 一个半透明状态，看不出在动。现在按钮外圈画一个顺时针进度环：
   *   已取回的字节 → 绿色填充；未取回 → 留空
   * 数据来源是 offscreen 边下边报的字节数（经 background 转发到本脚本）；
   * Content-Length 缺失时按时间缓慢爬升，最多爬到 92%，不会假装完成。
   * 字节取完立即填满到 100%——那一刻保存框正要弹出；等用户点保存、
   * 下载状态变成 complete，才收尾恢复原样。
   */
  const ring = { pid: null, btn: null, p: 0, ceiling: 12, known: false, timer: 0 };

  /* 已被用户取消的 progressId。取消之后：
   *   - 正在解析媒体的：解析结果回来也不许再发起下载
   *   - 正在取字节的：后台断掉请求，响应回来时按 canceled 静默收尾
   * 用定时清除而不是立即删，是因为取消与响应回来之间还有几个异步跳。 */
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
    if (ring.btn) ring.btn.style.setProperty("--wb-dl-p", ring.p.toFixed(1));
  }

  function stopRingTimer() {
    if (ring.timer) {
      clearInterval(ring.timer);
      ring.timer = 0;
    }
  }

  function newProgressId() {
    return "wb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function startRing(btn, pid) {
    endRing(); // 结束上一个没收尾的进度，避免两个环打架
    ring.pid = pid;
    ring.btn = btn;
    ring.p = 2;
    ring.ceiling = 12; // 解析媒体阶段：慢慢爬到 12%
    ring.known = false;
    btn.classList.add("wb-dl-progress");
    // 提示文案同步换成「点击取消」：按钮此刻是可控的，不再是纯展示
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

  // pid 省略时强制清空；传了 pid 则只在它仍是当前进度时收尾
  function endRing(pid) {
    if (pid && ring.pid && pid !== ring.pid) return;
    stopRingTimer();
    if (ring.btn) {
      ring.btn.classList.remove("wb-dl-progress");
      ring.btn.style.removeProperty("--wb-dl-p");
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
        // 总量已知：按真实字节比例走，最多到 98，留 100 给「字节取完」这一刻
        ring.known = true;
        ring.p = Math.max(ring.p, Math.min(98, (msg.loaded / msg.total) * 100));
        paintRing();
      } else {
        // 总量未知（分块传输）：退回时间爬升
        ring.known = false;
        ring.ceiling = Math.max(ring.ceiling, 92);
      }
      return;
    }
    if (msg.phase === "save") {
      // 字节已取完，保存框正要弹出：填满
      ring.known = true;
      ring.ceiling = 100;
      ring.p = 100;
      paintRing();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "wb-dl-progress") return;
    onRingProgress(msg);
  });

  // kind 为空是错误提示（红）；"info" 是中性提示（深灰蓝），如「已取消」
  function showToast(text, kind) {
    const t = document.createElement("div");
    t.className = "wb-dl-toast" + (kind === "info" ? " wb-dl-toast-info" : "");
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), kind === "info" ? 2200 : 5000);
  }

  function errorText(resp) {
    if (chrome.runtime.lastError) return chrome.runtime.lastError.message;
    if (resp && resp.error === "permission") return t("err.permission");
    if (resp && resp.error === "media-blocked") return t("err.blockedWeibo");
    if (resp && resp.error === "all-fetch-failed") return t("err.allFailed");
    if (resp && resp.error === "aborted") return t("err.aborted");
    if (resp && resp.error) return String(resp.error);
    return t("err.unknown");
  }

  /* 加载中再次点击 = 取消。分三层收尾：
   *   1) 立刻把进度环收掉，按钮回到原样（不等后台确认，点击必须有即时反馈）
   *   2) 通知后台：断掉 offscreen 的取字节请求，若保存框已弹出则一并取消该次下载
   *   3) 记下 pid，后续回来的响应按 canceled 处理，不闪红、不再弹保存框
   */
  function cancelActive(btn) {
    const pid = ring.pid;
    if (!pid) return;
    markCanceled(pid);
    endRing();
    flash(btn, "wb-dl-canceled");
    showToast(t("toast.canceled"), "info");
    sendBg({ action: "wb-cancel", progressId: pid });
  }

  function downloadItem(btn, item, nameSuffix, pid) {
    const candidates = (item.candidates || []).filter((u) => /^https?:/i.test(u));
    if (!candidates.length) {
      endRing(pid);
      flash(btn, "wb-dl-error");
      showToast(t("toast.noMedia"));
      return;
    }
    const id = pid || newProgressId();
    // 解析阶段就被取消的，不要把下载再发出去
    if (isCanceled(id)) {
      endRing(id);
      return;
    }
    if (!pid) startRing(btn, id);
    sendBg({
      action: "download",
      site: "weibo",
      type: item.type,
      candidates,
      nameSuffix: nameSuffix || "",
      progressId: id
    }).then((resp) => {
      // 取消：按静默收尾处理（浏览器下载被取消也走这里，代码 canceled）
      if (isCanceled(id) || (resp && (resp.canceled || resp.error === "aborted"))) {
        endRing(id);
        return;
      }
      endRing(id);
      if (!resp) {
        // 后台可能被浏览器回收（消息通道断开），此时不要把环留在 100%
        flash(btn, "wb-dl-error");
        showToast(t("toast.noResponse"));
        return;
      }
      if (!resp.ok) {
        flash(btn, "wb-dl-error");
        showToast(t("toast.dlFailed", { msg: errorText(resp) }));
      } else {
        flash(btn, "wb-dl-done");
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
      const t = ev.target;
      if (openMenu.contains(t)) return;
      if (t && t.closest && t.closest(".wb-dl-btn")) return;
      closeMenu();
    },
    true
  );

  function showMenu(btn, list) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "wb-dl-menu";

    const single = document.createElement("button");
    single.className = "wb-dl-menu-item";
    single.textContent = t("menu.firstOnly");
    single.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      downloadItem(btn, list[0], "");
    });

    const all = document.createElement("button");
    all.className = "wb-dl-menu-item";
    all.textContent = t("menu.allZipWeibo", { n: list.length });
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
        site: "weibo",
        prefix: "weibo_",
        items,
        progressId: pid
      }).then((resp) => {
        // 打包途中取消（或它自己的保存框被取消）：静默收尾
        if (isCanceled(pid) || (resp && (resp.canceled || resp.error === "aborted"))) {
          endRing(pid);
          return;
        }
        endRing(pid);
        if (!resp) {
          flash(btn, "wb-dl-error");
          showToast(t("toast.zipNoResponse"));
        } else if (!resp.ok) {
          flash(btn, "wb-dl-error");
          showToast(t("toast.zipFailed", { msg: errorText(resp) }));
        } else {
          flash(btn, "wb-dl-done");
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
      // 加载中再点一次 = 取消。但只允许取消「自己这条按钮」发起的下载，
      // 别的卡片正在下载时点它会容易被误解成"我取消了别人"，给个提示就好
      if (ring.btn === btn) cancelActive(btn);
      else showToast(t("toast.busyOtherWeibo"), "info");
      return;
    }

    // 解析媒体也要等接口，先把进度环点起来，让点击立刻有反馈
    const pid = newProgressId();
    startRing(btn, pid);
    mediaOf(root)
      .then((list) => {
        // 解析期间被用户取消：不再发起下载、也不弹多图菜单
        if (isCanceled(pid)) return;
        if (!list || !list.length) {
          endRing(pid);
          flash(btn, "wb-dl-error");
          showToast(t("toast.noMediaDeep"));
          return;
        }
        if (list.length === 1) {
          downloadItem(btn, list[0], "", pid); // 沿用同一个进度 id
          return;
        }
        endRing(pid); // 等用户选菜单，先收掉进度
        showMenu(btn, list);
      })
      .catch((e) => {
        if (isCanceled(pid)) return;
        endRing(pid);
        flash(btn, "wb-dl-error");
        showToast(t("toast.parseFailed", { msg: e && e.message ? e.message : e }));
      });
  }

  function attachTo(root) {
    if (!root || root.hasAttribute(PROCESSED_ATTR)) return;
    if (entries.some((e) => !e.dead && e.root === root)) return;
    // 多个选择器可能命中同一条微博（外层 [mid] 容器 / 内层 media 容器），
    // 任一方向已被处理过就跳过，避免一条微博挂两个按钮
    if (root.closest && root.closest("[" + PROCESSED_ATTR + "]")) return;
    if (root.querySelector && root.querySelector("[" + PROCESSED_ATTR + "]")) return;
    root.setAttribute(PROCESSED_ATTR, "1");
    const btn = makeButton();
    btn.addEventListener("click", (ev) => onDownloadClick(ev, root), true);
    // 拦截指针事件，避免点击穿透到微博的播放器/图片查看层
    ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick"].forEach((t) => {
      btn.addEventListener(
        t,
        (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        },
        true
      );
    });
    document.body.appendChild(btn);
    const entry = { btn, root, dead: false, avatar: null, avatarAt: 0 };
    entries.push(entry);
    positionEntry(entry);
  }

  // ---------- 定位：与卡片头像水平对齐 ----------
  // 头像 = 卡片左上角那个接近正方形的小图。微博头像地址形如 /crop.0.0.180.180.50/xxx.jpg，
  // 先按地址特征找；地址对不上（换域名/CDN）再按几何位置兜底，避免一处失效就全歪。
  function avatarOf(root) {
    const rr = root.getBoundingClientRect();
    let geo = null;
    for (const img of root.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.width > 88) continue;
      if (Math.abs(r.width - r.height) > 12) continue;
      // 必须落在卡片左上角区域，否则会把转发里的头像误认成作者头像
      if (r.top - rr.top > 150 || r.left - rr.left > 260) continue;
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (/\/crop\.|\/avatar\//i.test(src)) return img;
      if (!geo) geo = img;
    }
    return geo;
  }

  // 微博顶部导航是 fixed 的，卡片会滑到它下面。按钮是 fixed + 最高 z-index，
  // 不处理就会「浮」在导航栏上（实测反馈的 bug）。这里用 elementFromPoint 在视口顶端
  // 取几个点，向上找 fixed/sticky 的祖先，拿它的底边当作「被遮挡分界线」。
  // 每 400ms 重新探测一次：导航栏高度会随滚动收缩，不必每帧算。
  const occl = { value: 0, at: 0 };

  function occludedTop() {
    const now = Date.now();
    if (now - occl.at < 400) return occl.value;
    occl.at = now;

    let bottom = 0;
    const probes = [
      [0.5, 8],
      [0.1, 8],
      [0.5, 36],
      [0.9, 8]
    ];
    for (const [fx, py] of probes) {
      let el = null;
      try {
        el = document.elementFromPoint(Math.round(window.innerWidth * fx), py);
      } catch (e) {
        continue;
      }
      if (!el) continue;
      if (el.classList && el.classList.contains("wb-dl-btn")) continue; // 探到自己的按钮，换下一个点
      let guard = 0;
      while (el && guard++ < 12) {
        const cs = getComputedStyle(el);
        if ((cs.position === "fixed" || cs.position === "sticky") && el.getBoundingClientRect().top <= 2) {
          const r = el.getBoundingClientRect();
          // 只认「横跨大半个视口的条状元素」，避免把侧边浮层当成顶部栏
          if (r.height > 20 && r.height < 240 && r.width > window.innerWidth * 0.5) {
            bottom = Math.max(bottom, r.bottom);
          }
          break;
        }
        el = el.parentElement;
      }
    }

    // 命中测试失败时按已知选择器兜底（微博导航容器）
    if (!bottom) {
      for (const sel of ["#woo-header", "[class*='woo-header']", "header"]) {
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

  // 兜底遮挡判定：在头像中心点做一次命中测试，落在卡片之外的元素说明被浮层盖住了
  function coveredByOverlay(root, ar) {
    try {
      const el = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2);
      if (!el) return false;
      if (el === root || root.contains(el)) return false;
      if (el.classList && el.classList.contains("wb-dl-btn")) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // 按钮挂在卡片右侧外部，与 ins 的交互模型一致；
  // 纵向与卡片头像居中对齐；头像被滑出视口或被顶部栏盖住时按钮一并隐藏
  function positionEntry(e) {
    if (!e.root.isConnected) {
      e.btn.remove();
      e.dead = true;
      return;
    }
    const r = e.root.getBoundingClientRect();
    if (r.width <= 60 || r.height <= 60) {
      e.btn.style.display = "none";
      return;
    }

    // 头像可能被虚拟滚动重建，掉了就重新找；找不到时 2 秒后再试，避免每帧查询
    if ((!e.avatar || !e.avatar.isConnected) && Date.now() - (e.avatarAt || 0) > 2000) {
      e.avatar = avatarOf(e.root);
      e.avatarAt = Date.now();
    }
    const ar = e.avatar ? e.avatar.getBoundingClientRect() : null;

    // 可见性判定以头像为准：头像滑出视口（上或下）时隐藏
    const visible = ar
      ? ar.bottom > 0 && ar.top < window.innerHeight
      : r.bottom > 0 && r.top < window.innerHeight;
    if (!visible) {
      e.btn.style.display = "none";
      return;
    }

    const size = 34;
    const top = ar ? ar.top + (ar.height - size) / 2 : r.top + 12;

    // 顶部栏已经盖住卡片：按钮同样隐藏，不能浮在导航栏上面
    const guard = occludedTop();
    if (top < guard) {
      e.btn.style.display = "none";
      return;
    }
    // 找不到固定的顶部栏时，靠近视口顶端再做一次命中测试兜底
    if (guard === 0 && ar && top < 140 && coveredByOverlay(e.root, ar)) {
      e.btn.style.display = "none";
      return;
    }

    const left = Math.min(r.right + 8, window.innerWidth - size - 10);
    e.btn.style.display = "";
    e.btn.style.top = Math.round(top) + "px";
    e.btn.style.left = Math.max(8, Math.round(left)) + "px";
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

  // 微博信息流 DOM 变动非常频繁（虚拟滚动 + 角标/点赞数实时更新），
  // 每次 mutation 都全量扫描会卡，这里把扫描节流到 300ms 一次；定位仍走 rAF。
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

  // 诊断入口：微博页面 DevTools 控制台（选中扩展的隔离世界）里执行
  //   __wbDl.debug()        打印当前识别到的每张卡片：postId / 媒体数 / 媒体类型
  //   __wbDl.inspect(0)     对第 0 张卡片跑完整取址链路，打印候选地址（排查取址问题用）
  //   __wbDl.resolve("id")  直接调接口看某条微博解析结果
  //   __wbDl.checkImage("https://wx1.sinaimg.cn/orj360/xxx.jpg")
  //   __wbDl.ring()         查看进度环状态（pid / 百分比 / 是否已知总量）
  //   __wbDl.cancel()       取消当前下载（等价于在加载中的按钮上再点一次）
  window.__wbDl = {
    sel: SEL,
    // 下面几个纯函数供回归测试直接调用
    postIdOf,
    findRoot,
    parseStatus,
    imageCandidates,
    videoCandidates,
    // 选档排序（回归测试用）：把 [{url,h}] 按设置排成偏好顺序
    orderByQuality,
    applyImageQuality,
    isFeedImageUrl,
    // 进度环 / 取消状态机（回归测试用；也可在控制台手动演练）
    _makeBtn: makeButton,
    _startRing: startRing,
    _endRing: endRing,
    _cancelActive: cancelActive,
    _isCanceled: isCanceled,
    debug() {
      const rows = [];
      for (const sel of SEL.roots) {
        const nodes = document.querySelectorAll(sel);
        for (const root of nodes) {
          if (!hasMedia(root)) continue;
          const medias = root.querySelectorAll("img, video");
          rows.push({
            sel,
            postId: postIdOf(root),
            media: medias.length,
            kinds: Array.prototype.map
              .call(medias, (m) => m.tagName.toLowerCase())
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
        console.warn(LOG, "没有第", index || 0, "张卡片");
        return Promise.resolve([]);
      }
      return mediaOf(root).then((list) => {
        console.log(LOG, "postId", postIdOf(root), "媒体数", list.length, list);
        return list;
      });
    },
    resolve(id) {
      return getStatus(id).then((json) => {
        console.log(LOG, "接口返回", json);
        return json ? parseStatus(json) : null;
      });
    },
    checkImage(url) {
      const variants = {};
      ["orj360", "mw690", "orj1080", "large"].forEach((q) => {
        variants[q] = applyImageQuality(url, q);
      });
      const isFeedImage = isFeedImageUrl(url);
      console.log("是正文配图:", isFeedImage, variants);
      return { isFeedImage, variants, candidates: imageCandidates(url) };
    },
    scan,
    // 进度环当前状态（排查「点了没反应 / 环不涨」时看这个）
    ring: () => ({ pid: ring.pid, percent: Math.round(ring.p), known: ring.known }),
    // 等价于在加载中的按钮上再点一次：断掉取字节、取消已发起的下载
    cancel() {
      if (!ring.pid) {
        console.log(LOG, "当前没有进行中的下载");
        return false;
      }
      console.log(LOG, "取消", ring.pid);
      cancelActive(ring.btn);
      return true;
    },
    // 当前检测到的吸顶栏遮挡线（按钮低于这条线就会隐藏）。若按钮仍浮在导航上而
    // 这里返回 0，说明没认出导航容器，把值告诉我即可按实际结构补选择器。
    occlusion: () => {
      occl.at = 0;
      const v = occludedTop();
      console.log(LOG, "吸顶栏底边 =", v, "px");
      return v;
    },
    clearCache: () => {
      statusCache.clear();
      componentCache.clear();
    }
  };

  loadState();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  langReady.then(scan);
})();
