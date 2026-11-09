/* ins download - content script
 * 每条 Instagram 动态（article）注入一个下载按钮，
 * 按钮挂在 document.body（position:fixed），定位在动态卡片右侧外部，
 * 避免与卡片内的关注/菜单按钮冲突，也避开视频上的透明交互层。
 * 轮播动态点击时下载当前正在显示的那一项媒体。
 */
(function () {
  "use strict";

  const PROCESSED_ATTR = "data-ins-dl-processed";
  let enabled = true;
  let settings = { imageQuality: "1080", videoQuality: "1080" };
  const entries = []; // { btn, article }
  let rafPending = false;

  // P 值 -> 目标宽度（近似映射，用于从 srcset 中挑选最接近的档）
  const QUALITY_WIDTH = {
    "240": 320,
    "480": 640,
    "720": 750,
    "1080": 1080,
    "2k": 1440,
    "4k": 2160
  };

  function loadState() {
    chrome.storage.sync.get(
      ["enabled", "imageQuality", "videoQuality"],
      (res) => {
        enabled = res.enabled !== false;
        settings.imageQuality = res.imageQuality || settings.imageQuality;
        settings.videoQuality = res.videoQuality || settings.videoQuality;
        if (enabled) scan();
        else removeAllButtons();
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (enabled) scan();
      else removeAllButtons();
    }
    for (const k of ["imageQuality", "videoQuality"]) {
      if (changes[k]) settings[k] = changes[k].newValue;
    }
  });

  function removeAllButtons() {
    while (entries.length) {
      const e = entries.pop();
      e.btn.remove();
      if (e.article.isConnected) e.article.removeAttribute(PROCESSED_ATTR);
    }
  }

  // 从 srcset 挑选最接近目标宽度的 URL
  function pickFromSrcset(srcset, targetWidth) {
    if (!srcset) return null;
    const candidates = srcset
      .split(",")
      .map((s) => s.trim())
      .map((s) => {
        const parts = s.split(/\s+/);
        return { url: parts[0], w: parseInt(parts[1], 10) || 0 };
      })
      .filter((c) => c.url);
    if (!candidates.length) return null;
    const sorted = candidates.sort((a, b) => a.w - b.w);
    const ge = sorted.find((c) => c.w >= targetWidth);
    return (ge || sorted[sorted.length - 1]).url;
  }

  function getMediaInfo(media) {
    if (media.tagName === "VIDEO") {
      const src =
        media.src && !media.src.startsWith("blob:")
          ? media.src
          : media.currentSrc && !media.currentSrc.startsWith("blob:")
          ? media.currentSrc
          : (media.querySelector("source") || {}).src;
      if (src && src.startsWith("http")) return { type: "video", url: src };
      return null;
    }
    const target = QUALITY_WIDTH[settings.imageQuality] || 1080;
    const url = pickFromSrcset(media.getAttribute("srcset"), target) || media.src;
    if (url && url.startsWith("http")) return { type: "image", url };
    return null;
  }

  function overlapRatio(a, b) {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const area = w * h;
    const base = a.width * a.height;
    return base > 0 ? area / base : 0;
  }

  function isBigEnough(m) {
    const r = m.getBoundingClientRect();
    return r.width > 60 && r.height > 60;
  }

  // 收集动态内全部可下载媒体（按 DOM 顺序，排除被视频覆盖的封面图）
  function collectAllMedia(article) {
    const videos = Array.from(article.querySelectorAll("video")).filter(isBigEnough);
    return Array.from(article.querySelectorAll("video, img")).filter((m) => {
      if (!isBigEnough(m)) return false;
      if (m.tagName === "IMG") {
        const r = m.getBoundingClientRect();
        return !videos.some((v) => overlapRatio(r, v.getBoundingClientRect()) > 0.5);
      }
      return true;
    });
  }

  // 在动态中挑选“当前正在显示”的媒体：
  // 轮播项通过横向位移切换，取水平中心最接近动态中心的那个
  function pickCurrentMedia(article) {
    const pool = collectAllMedia(article);
    if (!pool.length) return null;
    const ar = article.getBoundingClientRect();
    const cx = ar.left + ar.width / 2;
    pool.sort(
      (a, b) =>
        Math.abs(a.getBoundingClientRect().left + a.getBoundingClientRect().width / 2 - cx) -
        Math.abs(b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2 - cx)
    );
    return pool[0];
  }

  function makeButton() {
    const btn = document.createElement("button");
    btn.className = "ins-dl-btn";
    btn.title = "下载（ins download）";
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/></svg>';
    return btn;
  }

  function flash(btn, cls) {
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 1500);
  }

  // 页面底部错误提示条：失败时给出明确原因，不再“无反应”
  function showToast(text) {
    const t = document.createElement("div");
    t.className = "ins-dl-toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  function errorText(resp) {
    if (chrome.runtime.lastError) return chrome.runtime.lastError.message;
    if (resp && resp.error === "permission") return "文件夹授权已失效，请到插件设置页重新授权";
    if (resp && resp.error) return String(resp.error);
    return "未知错误";
  }

  // ---- 通过帖子数据接口取全部媒体真实地址（解决轮播懒加载/视频 blob 流问题）----
  const shortcodeCache = {};

  function findShortcode(article) {
    const a = article.querySelector(
      'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]'
    );
    if (!a) return null;
    const m = a.href.match(/\/(p|reel|reels)\/([A-Za-z0-9_-]+)/);
    return m ? m[2] : null;
  }

  // 递归搜索 JSON，收集所有含 display_url / video_url 的媒体节点
  function collectMediaFromJson(root) {
    const out = [];
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      const u = o.video_url || o.display_url;
      if (typeof u === "string" && u.startsWith("http")) {
        if (!seen.has(u)) {
          seen.add(u);
          out.push({
            type: o.video_url ? "video" : "image",
            url: u,
            resources: Array.isArray(o.display_resources)
              ? o.display_resources
                  .map((d) => ({ url: d.src, w: d.config_width || 0 }))
                  .filter((r) => r.url)
              : null
          });
        }
      }
      for (const k in o) walk(o[k]);
    })(root);
    return out;
  }

  // 从帖子页 HTML 中正则提取全部媒体地址（接口被拦截时的兜底）
  // 兼容转义（\"video_url\":\"...\"）与非转义两种 JSON 嵌入格式
  function extractFromHtml(text) {
    const out = [];
    const seen = new Set();
    const re = /\\*"(video_url|display_url)\\*":\\*"((?:\\.|[^"\\])*)\\*"/g;
    let m;
    while ((m = re.exec(text))) {
      const u = m[2]
        .replace(/\\u0026/gi, "&")
        .replace(/\\\//g, "/")
        .replace(/\\u0025/gi, "%")
        .replace(/\\u003d/gi, "=")
        .replace(/\\u003f/gi, "?");
      if (!u.startsWith("http") || seen.has(u)) continue;
      seen.add(u);
      out.push({ type: m[1] === "video_url" ? "video" : "image", url: u, resources: null });
    }
    return out;
  }

  // shortcode -> 数字媒体 ID（base64 变体解码）
  function shortcodeToId(sc) {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const ch of sc) {
      const v = alphabet.indexOf(ch);
      if (v < 0) return null;
      id = id * 64n + BigInt(v);
    }
    return id.toString();
  }

  // 解析 /api/v1/media/{id}/info/ 的响应：轮播全部项 + 图片/视频多档清晰度
  function parseMediaInfo(json) {
    const out = [];
    const items = json && json.items;
    if (!Array.isArray(items)) return out;
    for (const it of items) {
      const nodes = Array.isArray(it.carousel_media) ? it.carousel_media : [it];
      for (const n of nodes) {
        if (Array.isArray(n.video_versions) && n.video_versions.length) {
          out.push({
            type: "video",
            url: n.video_versions[0].url,
            resources: n.video_versions
              .map((v) => ({ url: v.url, w: v.width || 0 }))
              .filter((r) => r.url)
          });
        } else if (
          n.image_versions2 &&
          Array.isArray(n.image_versions2.candidates) &&
          n.image_versions2.candidates.length
        ) {
          const cands = n.image_versions2.candidates
            .map((c) => ({ url: c.url, w: c.width || 0 }))
            .filter((r) => r.url);
          out.push({ type: "image", url: cands[0].url, resources: cands });
        }
      }
    }
    return out;
  }

  async function fetchPostMedia(shortcode) {
    if (shortcodeCache[shortcode]) return shortcodeCache[shortcode];
    let media = [];
    // 方案 1：内部媒体信息接口（最稳定，含轮播全部项）
    const mediaId = shortcodeToId(shortcode);
    if (mediaId) {
      try {
        const r = await fetch("/api/v1/media/" + mediaId + "/info/", {
          credentials: "include",
          headers: {
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            Accept: "application/json"
          }
        });
        if (r.ok) media = parseMediaInfo(await r.json());
      } catch (e) { /* ignore */ }
    }
    // 方案 2：__a=1 数据接口
    if (!media.length) {
      try {
        const r = await fetch("/p/" + shortcode + "/?__a=1&__d=dis", {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" }
        });
        if (r.ok) media = collectMediaFromJson(await r.json());
      } catch (e) { /* ignore */ }
    }
    // 方案 3：抓嵌入页 HTML，正则提取
    if (!media.length) {
      try {
        const r = await fetch("/p/" + shortcode + "/embed/captioned/", {
          credentials: "include"
        });
        if (r.ok) media = extractFromHtml(await r.text());
      } catch (e) { /* ignore */ }
    }
    // 方案 4：抓帖子页 HTML，正则提取
    if (!media.length) {
      try {
        const r = await fetch("/p/" + shortcode + "/", { credentials: "include" });
        if (r.ok) media = extractFromHtml(await r.text());
      } catch (e) { /* ignore */ }
    }
    shortcodeCache[shortcode] = media;
    console.debug("[ins download] 帖子", shortcode, "取到媒体数:", media.length);
    return media;
  }

  // 按设置的分辨率/清晰度从多档资源中选档（图片用 imageQuality，视频用 videoQuality）
  function resolveUrl(item) {
    if (!item.resources || !item.resources.length) return item.url;
    const q = item.type === "video" ? settings.videoQuality : settings.imageQuality;
    const target = QUALITY_WIDTH[q] || 1080;
    const sorted = item.resources.slice().sort((a, b) => a.w - b.w);
    const ge = sorted.find((r) => r.w >= target);
    return (ge || sorted[sorted.length - 1]).url;
  }

  function downloadItem(btn, item, nameSuffix) {
    const url = resolveUrl(item);
    if (!url || !url.startsWith("http")) {
      flash(btn, "ins-dl-error");
      btn.title = "未找到可下载的媒体地址";
      return false;
    }
    chrome.runtime.sendMessage(
      { action: "download", url, type: item.type, nameSuffix: nameSuffix || "" },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          flash(btn, "ins-dl-error");
          showToast("下载失败：" + errorText(resp));
        } else {
          flash(btn, "ins-dl-done");
        }
      }
    );
    return true;
  }

  // ---- 多张下载选择菜单 ----
  let openMenu = null;

  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
  }

  // 点击菜单外部时收起
  document.addEventListener(
    "click",
    (ev) => {
      if (!openMenu) return;
      if (openMenu.contains(ev.target) || ev.target.closest(".ins-dl-btn")) return;
      closeMenu();
    },
    true
  );

  function showMenu(btn, list, currentIdx) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "ins-dl-menu";

    const itemSingle = document.createElement("button");
    itemSingle.className = "ins-dl-menu-item";
    itemSingle.textContent = "下载单张（当前显示）";
    itemSingle.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      downloadItem(btn, list[Math.min(currentIdx, list.length - 1)], "");
    });

    const itemAll = document.createElement("button");
    itemAll.className = "ins-dl-menu-item";
    itemAll.textContent = "下载多张（全部 " + list.length + " 项，打包 zip）";
    itemAll.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      if (btn.classList.contains("ins-dl-loading")) return;
      btn.classList.add("ins-dl-loading");
      // 全部媒体打包成一个 zip 一次下载，不再逐项弹保存框
      const items = list.map((item) => ({ url: resolveUrl(item), type: item.type }));
      chrome.runtime.sendMessage({ action: "zip", items }, (resp) => {
        btn.classList.remove("ins-dl-loading");
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          flash(btn, "ins-dl-error");
          showToast("打包下载失败：" + errorText(resp));
        } else {
          flash(btn, "ins-dl-done");
        }
      });
    });

    menu.appendChild(itemSingle);
    menu.appendChild(itemAll);

    const r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, r.right - 180) + "px";
    document.body.appendChild(menu);
    openMenu = menu;
  }

  async function onDownloadClick(ev, article) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    if (btn.classList.contains("ins-dl-loading")) return;

    // 优先走帖子数据接口：能拿到全部轮播项和视频真实 mp4 地址
    let list = [];
    const sc = findShortcode(article);
    if (sc) {
      btn.classList.add("ins-dl-loading");
      list = await fetchPostMedia(sc);
      btn.classList.remove("ins-dl-loading");
    }

    if (!list.length) {
      // 接口失败，回退 DOM 方案
      const domList = collectAllMedia(article);
      list = domList
        .map((m) => getMediaInfo(m))
        .filter((info) => info && info.url);
    }
    if (!list.length) {
      flash(btn, "ins-dl-error");
      showToast("未找到可下载的媒体地址（接口与页面解析均未取到）");
      return;
    }
    if (list.length === 1) {
      downloadItem(btn, list[0], "");
      return;
    }
    // 多张：弹出单张/多张选择菜单
    if (openMenu) {
      closeMenu();
      return;
    }
    // 当前显示项在列表中的序号（按 DOM 顺序对应轮播顺序）
    const domList = collectAllMedia(article);
    const cur = pickCurrentMedia(article);
    const idx = Math.max(0, domList.indexOf(cur));
    showMenu(btn, list, idx);
  }

  function attachTo(article) {
    if (!article || article.hasAttribute(PROCESSED_ATTR)) return;
    // 去重：同一动态已有存活按钮时不再创建（防止滚动复用 DOM 时出现两个按钮）
    if (entries.some((e) => !e.dead && e.article === article)) return;
    article.setAttribute(PROCESSED_ATTR, "1");
    const btn = makeButton();
    btn.addEventListener("click", (ev) => onDownloadClick(ev, article), true);
    ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick"].forEach(
      (t) => {
        btn.addEventListener(
          t,
          (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          },
          true
        );
      }
    );
    document.body.appendChild(btn);
    const entry = { btn, article };
    entries.push(entry);
    positionEntry(entry);
  }

  function positionEntry(e) {
    if (!e.article.isConnected) {
      e.btn.remove();
      e.dead = true;
      return;
    }
    const r = e.article.getBoundingClientRect();
    // 卡片顶部滚出视口时隐藏按钮（不要钉在视口顶部，否则像多出来的按钮）
    const visible =
      r.width > 60 && r.height > 60 && r.top >= 0 && r.top < window.innerHeight;
    if (!visible) {
      e.btn.style.display = "none";
      return;
    }
    e.btn.style.display = "";
    // 动态卡片右侧外部（红框位置）
    e.btn.style.top = r.top + 8 + "px";
    e.btn.style.left = r.right + 8 + "px";
  }

  function positionAll() {
    rafPending = false;
    const seenArticles = new Set();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      // 同一条动态出现重复按钮时，只保留一个
      if (!e.dead && seenArticles.has(e.article)) {
        e.btn.remove();
        e.dead = true;
      }
      if (e.dead) {
        entries.splice(i, 1);
        continue;
      }
      seenArticles.add(e.article);
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
    document.querySelectorAll("article").forEach((article) => {
      if (pickCurrentMedia(article)) attachTo(article);
    });
  }

  const observer = new MutationObserver(() => {
    if (enabled) {
      scan();
      schedulePosition();
    }
  });

  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);

  loadState();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
