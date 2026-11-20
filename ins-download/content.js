/* download-everything - content script
 * 每条 Instagram 动态（article）注入一个下载按钮，
 * 按钮挂在 document.body（position:fixed），定位在动态卡片右侧外部，
 * 避免与卡片内的关注/菜单按钮冲突，也避开视频上的透明交互层。
 * 轮播动态点击时下载当前正在显示的那一项媒体。
 *
 * v2.1.0 起与微博对齐：
 *   按钮点下去进入加载态，外圈画真实字节进度环，加载态里「再点一次 = 取消」。
 *   取消分三层落地：本地立刻收环（点击必须即时反馈）、通知 background 断掉
 *   offscreen 的取字节请求、保存框已弹出则 chrome.downloads.cancel()。
 *   三条链路都归一成 canceled，上层静默收尾（不闪红、不重试）。
 */
(function () {
  "use strict";

  const PROCESSED_ATTR = "data-ins-dl-processed";
  let enabled = true;
  let settings = { imageQuality: "1080", videoQuality: "1080" };
  const entries = []; // { btn, article }
  let rafPending = false;

  // 界面文案走 i18n.js（manifest 里排在 content.js 之前）
  const I18N = globalThis.DELi18n || null;
  const langReady = I18N ? I18N.ready : Promise.resolve("zh");
  function t(key, vars) {
    return I18N ? I18N.t(key, vars) : key;
  }

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
    // 等语言读出来再建按钮，避免英文界面先闪一下中文 title
    langReady.then(() => {
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
    });
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

  // ---------- 按钮 ----------
  // 文案按当前显示语言取，语言切换后由 refreshButtonTitles() 就地刷新
  const titleIdle = () => t("btn.title.ins");
  const titleBusy = () => t("btn.title.busy");

  function makeButton() {
    const btn = document.createElement("button");
    btn.className = "ins-dl-btn";
    btn.title = titleIdle();
    // 两个图标叠着放，靠 .ins-dl-progress 切换：下载中显示「停止」方块，
    // 让「再点一次 = 取消」这件事在视觉上说得通（否则用户以为点了没反应）
    btn.innerHTML =
      '<svg class="ins-dl-ico ins-dl-ico-dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      '<svg class="ins-dl-ico ins-dl-ico-stop" viewBox="0 0 24 24">' +
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
    if (ring.btn) ring.btn.style.setProperty("--ins-dl-p", ring.p.toFixed(1));
  }

  function stopRingTimer() {
    if (ring.timer) {
      clearInterval(ring.timer);
      ring.timer = 0;
    }
  }

  function newProgressId() {
    return "ig" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function startRing(btn, pid) {
    endRing(); // 结束上一个没收尾的进度，避免两个环打架
    ring.pid = pid;
    ring.btn = btn;
    ring.p = 2;
    ring.ceiling = 12; // 解析媒体阶段：慢慢爬到 12%
    ring.known = false;
    btn.classList.add("ins-dl-progress");
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
      ring.btn.classList.remove("ins-dl-progress");
      ring.btn.style.removeProperty("--ins-dl-p");
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

  // 与微博共用同一条进度通道（消息 type 统一为 wb-dl-progress）
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "wb-dl-progress") return;
    onRingProgress(msg);
  });

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
    flash(btn, "ins-dl-canceled");
    showToast(t("toast.canceled"), "info");
    chrome.runtime.sendMessage({ action: "cancel", progressId: pid }, () =>
      void chrome.runtime.lastError
    );
  }

  // kind 为空是错误提示（红）；"info" 是中性提示（深灰蓝），如「已取消」
  function showToast(text, kind) {
    const node = document.createElement("div");
    node.className = "ins-dl-toast" + (kind === "info" ? " ins-dl-toast-info" : "");
    node.textContent = text;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), kind === "info" ? 2200 : 5000);
  }

  function errorText(resp) {
    if (chrome.runtime.lastError) return chrome.runtime.lastError.message;
    if (resp && resp.error === "permission") return t("err.permission");
    if (resp && resp.error === "media-blocked") return t("err.blockedIns");
    if (resp && resp.error === "all-fetch-failed") return t("err.allFailed");
    if (resp && resp.error === "aborted") return t("err.aborted");
    if (resp && resp.error) return String(resp.error);
    return t("err.unknown");
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
    console.debug("[download-everything] 帖子", shortcode, "取到媒体数:", media.length);
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

  function downloadItem(btn, item, nameSuffix, pid) {
    const url = resolveUrl(item);
    const id = pid || newProgressId();
    if (!url || !url.startsWith("http")) {
      endRing(id);
      flash(btn, "ins-dl-error");
      showToast(t("toast.noMedia"));
      return false;
    }
    // 解析阶段就被取消的，不要把下载再发出去
    if (isCanceled(id)) {
      endRing(id);
      return false;
    }
    if (!pid) startRing(btn, id);
    chrome.runtime.sendMessage(
      { action: "download", url, type: item.type, nameSuffix: nameSuffix || "", progressId: id },
      (resp) => {
        // 取消：按静默收尾处理（浏览器下载被取消也走这里）
        if (isCanceled(id) || (resp && (resp.canceled || resp.error === "aborted"))) {
          endRing(id);
          return;
        }
        endRing(id);
        if (chrome.runtime.lastError || !resp) {
          flash(btn, "ins-dl-error");
          showToast(t("toast.noResponse"));
        } else if (!resp.ok) {
          flash(btn, "ins-dl-error");
          showToast(t("toast.dlFailed", { msg: errorText(resp) }));
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
    itemSingle.textContent = t("menu.single");
    itemSingle.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      downloadItem(btn, list[Math.min(currentIdx, list.length - 1)], "");
    });

    const itemAll = document.createElement("button");
    itemAll.className = "ins-dl-menu-item";
    itemAll.textContent = t("menu.allZip", { n: list.length });
    itemAll.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
      if (ring.pid) return; // 已有下载在进行
      // 全部媒体打包成一个 zip 一次下载，不再逐项弹保存框；
      // 打包也走同一条进度通道：offscreen 每取完一项报一次，环按项数走
      const pid = newProgressId();
      const items = list.map((item) => ({ url: resolveUrl(item), type: item.type }));
      startRing(btn, pid);
      chrome.runtime.sendMessage({ action: "zip", items, progressId: pid }, (resp) => {
        // 打包途中取消（或它自己的保存框被取消）：静默收尾
        if (isCanceled(pid) || (resp && (resp.canceled || resp.error === "aborted"))) {
          endRing(pid);
          return;
        }
        endRing(pid);
        if (chrome.runtime.lastError || !resp) {
          flash(btn, "ins-dl-error");
          showToast(t("toast.zipNoResponse"));
        } else if (!resp.ok) {
          flash(btn, "ins-dl-error");
          showToast(t("toast.zipFailed", { msg: errorText(resp) }));
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
    if (openMenu) {
      closeMenu();
      return;
    }
    if (ring.pid) {
      // 加载中再点一次 = 取消。但只允许取消「自己这条按钮」发起的下载，
      // 别的卡片正在下载时点它会容易被误解成"我取消了别人"，给个提示就好
      if (ring.btn === btn) cancelActive(btn);
      else showToast(t("toast.busyOtherIns"), "info");
      return;
    }

    // 解析媒体也要等接口，先把进度环点起来，让点击立刻有反馈
    const pid = newProgressId();
    startRing(btn, pid);

    // 优先走帖子数据接口：能拿到全部轮播项和视频真实 mp4 地址
    let list = [];
    const sc = findShortcode(article);
    if (sc) list = await fetchPostMedia(sc);
    // 解析期间被用户取消：不再发起下载、也不弹多张菜单
    if (isCanceled(pid)) return;

    if (!list.length) {
      // 接口失败，回退 DOM 方案
      const domList = collectAllMedia(article);
      list = domList
        .map((m) => getMediaInfo(m))
        .filter((info) => info && info.url);
    }
    if (isCanceled(pid)) return;
    if (!list.length) {
      endRing(pid);
      flash(btn, "ins-dl-error");
      showToast(t("toast.noMediaDeep"));
      return;
    }
    if (list.length === 1) {
      downloadItem(btn, list[0], "", pid); // 沿用同一个进度 id
      return;
    }
    endRing(pid); // 等用户选菜单，先收掉进度
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

  // 诊断入口：Instagram 页面 DevTools 控制台（选中扩展的隔离世界）里执行
  //   __insDl.debug()    打印当前识别到的每条动态：按钮数 / 媒体数 / shortcode
  //   __insDl.ring()     查看进度环状态（pid / 百分比 / 是否已知总量）
  //   __insDl.cancel()   取消当前下载（等价于在加载中的按钮上再点一次）
  //   __insDl.media(0)   对第 0 条动态跑完整取址链路，打印候选地址
  window.__insDl = {
    scan,
    // 进度环 / 取消状态机（回归测试用；也可在控制台手动演练）
    _makeBtn: makeButton,
    _startRing: startRing,
    _endRing: endRing,
    _cancelActive: cancelActive,
    _isCanceled: isCanceled,
    ring: () => ({ pid: ring.pid, percent: Math.round(ring.p), known: ring.known }),
    cancel() {
      if (!ring.pid) {
        console.log("[download-everything] 当前没有进行中的下载");
        return false;
      }
      console.log("[download-everything] 取消", ring.pid);
      cancelActive(ring.btn);
      return true;
    },
    debug() {
      const rows = entries.map((e) => ({
        shortcode: e.article.isConnected ? findShortcode(e.article) : null,
        buttons: e.dead ? 0 : 1,
        media: e.article.isConnected ? collectAllMedia(e.article).length : 0
      }));
      console.table(rows);
      return rows;
    },
    media(index) {
      const list = Array.from(document.querySelectorAll("article"))[index || 0];
      if (!list) {
        console.warn("[download-everything] 没有第", index || 0, "条动态");
        return Promise.resolve([]);
      }
      const sc = findShortcode(list);
      if (!sc) return Promise.resolve([]);
      return fetchPostMedia(sc).then((media) => {
        console.log("[download-everything] shortcode", sc, "媒体数", media.length, media);
        return media;
      });
    },
    clearCache() {
      for (const k in shortcodeCache) delete shortcodeCache[k];
    }
  };

  loadState();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  langReady.then(scan);
})();
