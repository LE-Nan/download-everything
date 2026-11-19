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
 * ⚠️ 选择器实测自公开维护中的同类脚本（owendswang / firo1603 的「下载微博图片和视频」），
 *    站点改版后应先跑 __wbDl.debug() 核对，只改下面 SEL 一处即可。
 */
(function () {
  "use strict";

  const LOG = "[weibo download]";
  const PROCESSED_ATTR = "data-wbdl-processed";

  let enabled = true;
  // 微博专有配置，与 ins 的 imageQuality / videoQuality 互不干扰。
  // 图片默认取原图：接口返回的本来就是最大档，orj1080 并非每张图都有
  const settings = { imageQuality: "large", videoQuality: "hd" };

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
    }
    if (changes.weiboVideoQuality) {
      settings.videoQuality = changes.weiboVideoQuality.newValue;
    }
  });

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

  // 换尺寸：/orj360/ → /orj1080/。首段不在白名单时原样返回，避免改坏别的路径
  function applyImageQuality(url, quality) {
    const m = url.match(/^(https?:\/\/[^/]+)\/([^/?#]+)\/([^?#]+)([?#].*)?$/i);
    if (!m) return url;
    if (IMG_TOKENS.indexOf(m[2].toLowerCase()) < 0) return url;
    return m[1] + "/" + (quality || "orj1080") + "/" + m[3] + (m[4] || "");
  }

  // 候选按优先级排列：所选清晰度 → 原图 → 中间档 → 页面原本给的地址。
  // 微博并没有为每张图都生成所有档位，404 的档位会在取字节阶段被逐个跳过，
  // 所以这里给足备选；最后一档「原样地址」是保底——接口/页面给的地址一定真实存在。
  function imageCandidates(url, quality) {
    const q = quality || settings.imageQuality;
    const list = [];
    const push = (u) => {
      if (u && list.indexOf(u) < 0) list.push(u);
    };
    push(applyImageQuality(url, q));
    push(applyImageQuality(url, "large"));
    push(applyImageQuality(url, "mw2000"));
    push(applyImageQuality(url, "orj1080"));
    push(applyImageQuality(url, "mw690"));
    push(applyImageQuality(url, "orj360"));
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

  function dedupe(list) {
    const out = [];
    for (const u of list) {
      if (u && out.indexOf(u) < 0) out.push(u);
    }
    return out;
  }

  function videoCandidates(mediaInfo) {
    if (!mediaInfo || typeof mediaInfo !== "object") return Promise.resolve([]);
    const bases = [];
    const push = (u) => {
      const v = fixProto(u);
      if (v && bases.indexOf(v) < 0) bases.push(v);
    };

    // playback_list 是微博新版给的清晰度列表（按清晰度从高到低）
    if (Array.isArray(mediaInfo.playback_list)) {
      for (const p of mediaInfo.playback_list) {
        if (p && p.play_info && p.play_info.url) push(p.play_info.url);
      }
    }
    // 常见字段：高清在前，标清在后
    ["mp4_1080p_mp4", "mp4_720p_mp4", "mp4_hd_url", "stream_url_hd", "mp4_sd_url", "stream_url", "mp4_url"].forEach(
      (k) => {
        if (typeof mediaInfo[k] === "string") push(mediaInfo[k]);
      }
    );

    const fid = fidOf(mediaInfo);
    const viaComponent = fid
      ? componentVideo(fid).then((list) => list.map((x) => x.url))
      : Promise.resolve([]);

    return viaComponent.then((comp) => {
      // 组件接口给的是最完整的档位列表，放最前面
      const all = dedupe(comp.concat(bases));
      return settings.videoQuality === "sd" ? all.slice().reverse() : all;
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
            if (list.length) out.push({ type: "video", candidates: list.map((x) => x.url) });
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
  function makeButton() {
    const btn = document.createElement("button");
    btn.className = "wb-dl-btn";
    btn.title = "下载（微博图片/视频）";
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/></svg>';
    return btn;
  }

  function flash(btn, cls) {
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

  function showToast(text) {
    const t = document.createElement("div");
    t.className = "wb-dl-toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  function errorText(resp) {
    if (chrome.runtime.lastError) return chrome.runtime.lastError.message;
    if (resp && resp.error === "permission") return "文件夹授权已失效，请到插件设置页重新授权";
    if (resp && resp.error === "media-blocked") return "微博拒绝了该地址（403）或已失效，换一张试试";
    if (resp && resp.error === "all-fetch-failed") return "全部媒体都下载失败";
    if (resp && resp.error) return String(resp.error);
    return "未知错误";
  }

  function downloadItem(btn, item, nameSuffix, pid) {
    const candidates = (item.candidates || []).filter((u) => /^https?:/i.test(u));
    if (!candidates.length) {
      endRing(pid);
      flash(btn, "wb-dl-error");
      showToast("未找到可下载的媒体地址");
      return;
    }
    const id = pid || newProgressId();
    if (!pid) startRing(btn, id);
    sendBg({
      action: "download",
      site: "weibo",
      type: item.type,
      candidates,
      nameSuffix: nameSuffix || "",
      progressId: id
    }).then((resp) => {
      endRing(id);
      if (!resp) {
        // 后台可能被浏览器回收（消息通道断开），此时不要把环留在 100%
        flash(btn, "wb-dl-error");
        showToast("下载请求没有响应，请重试");
        return;
      }
      if (!resp.ok) {
        if (resp.canceled) return; // 用户自己点了取消，不算失败
        flash(btn, "wb-dl-error");
        showToast("下载失败：" + errorText(resp));
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
    single.textContent = "只下载第 1 项";
    single.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      downloadItem(btn, list[0], "");
    });

    const all = document.createElement("button");
    all.className = "wb-dl-menu-item";
    all.textContent = "全部下载（" + list.length + " 项，打包 zip）";
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
        endRing(pid);
        if (!resp) {
          flash(btn, "wb-dl-error");
          showToast("打包请求没有响应，请重试");
        } else if (!resp.ok) {
          if (resp.canceled) return;
          flash(btn, "wb-dl-error");
          showToast("打包下载失败：" + errorText(resp));
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
    if (ring.pid) return; // 这条按钮已有下载在进行
    if (openMenu) {
      closeMenu();
      return;
    }

    // 解析媒体也要等接口，先把进度环点起来，让点击立刻有反馈
    const pid = newProgressId();
    startRing(btn, pid);
    mediaOf(root)
      .then((list) => {
        if (!list || !list.length) {
          endRing(pid);
          flash(btn, "wb-dl-error");
          showToast("未找到可下载的媒体（接口与页面解析均未取到）");
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
        endRing(pid);
        flash(btn, "wb-dl-error");
        showToast("解析失败：" + (e && e.message ? e.message : e));
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
  window.__wbDl = {
    sel: SEL,
    // 下面几个纯函数供回归测试直接调用
    postIdOf,
    findRoot,
    parseStatus,
    imageCandidates,
    applyImageQuality,
    isFeedImageUrl,
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
  scan();
})();
