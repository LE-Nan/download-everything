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
 * ── 抗站点改版策略 ──────────────────────────────────────────
 * 不依赖任何构建期哈希类名（weibo 用 Vue，类名形如 .woo-box-flex 尚算语义，
 * 但外层容器类名常变），只依赖两样稳定物：
 *   1) 每条微博容器上的 mid 属性（微博自己的 JS 全程使用，改版风险最低）
 *   2) 图片域名 sinaimg.cn + 路径首段的尺寸标记（orj360 / mw690 / large …）
 * 媒体元素本身用通用选择器 img / video 扫描，再向上找最近的 [mid] 容器。
 * 这样即使信息流 DOM 结构大改，只要 mid 属性还在，按钮就能挂上去。
 *
 * ── 取址链路（逐级降级）────────────────────────────────────
 *   1) /ajax/statuses/show?id={mid}  内部接口，一次拿到全部图片 + 视频多档流
 *   2) DOM 兜底：本轮已渲染的 img / video（视频若是 blob 流则拿不到）
 * 图片清晰度通过替换 URL 路径首段实现（orj360 → mw690 → orj1080 → large）。
 *
 * ⚠️ 选择器与接口均未在真实登录态页面实测（开发环境无法访问微博），
 *    首次加载后请看控制台 [weibo download] 前缀的日志核对，必要时只改下面的 SEL。
 */
(function () {
  "use strict";

  const LOG = "[weibo download]";
  const PROCESSED_ATTR = "data-wbdl-processed";

  let enabled = true;
  // 微博专有配置，与 ins 的 imageQuality / videoQuality 互不干扰
  const settings = { imageQuality: "orj1080", videoQuality: "hd" };

  const entries = []; // { btn, root }
  let rafPending = false;
  const statusCache = new Map(); // mid -> items

  // ---------- 适配层：改版时只动这里 ----------
  const SEL = {
    // 微博每条微博的容器都带 mid 属性；旧版/特殊页面的兜底
    rootCandidates: ["[mid]", '[action-type="feed_list_item"]'],
    media: "img, video"
  };

  // sinaimg 的尺寸标记，出现在 URL 第一段路径：/orj1080/xxx.jpg
  const IMG_TOKENS = [
    "thumb150",
    "orj360",
    "bmiddle",
    "mw690",
    "orj1080",
    "mw2000",
    "large",
    "original"
  ];

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

  // 只认「微博正文配图」：sinaimg.cn 域名 + 首段是已知尺寸标记。
  // 这一条同时排除了头像（crop.0.0.180…）、表情（h5.sinaimg.cn/m/emoticon）、站点图标。
  function isFeedImageUrl(url) {
    if (!url) return false;
    if (!/^https?:\/\/[\w.-]+sinaimg\.cn\//i.test(url)) return false;
    const seg = url
      .replace(/^https?:\/\/[^/]+\//i, "")
      .split(/[/?#]/)[0]
      .toLowerCase();
    return IMG_TOKENS.indexOf(seg) >= 0;
  }

  // 换尺寸：/orj360/ → /orj1080/。首段不在白名单时原样返回，避免改坏别的路径
  function applyImageQuality(url, quality) {
    const m = url.match(/^(https?:\/\/[^/]+)\/([^/?#]+)\/([^?#]+)([?#].*)?$/i);
    if (!m) return url;
    if (IMG_TOKENS.indexOf(m[2].toLowerCase()) < 0) return url;
    return m[1] + "/" + (quality || "orj1080") + "/" + m[3] + (m[4] || "");
  }

  // ---------- 定位每条微博 ----------
  function findRoot(el) {
    for (const sel of SEL.rootCandidates) {
      const r = el.closest(sel);
      if (r) return r;
    }
    return null;
  }

  function midOf(root) {
    const attr = root.getAttribute && root.getAttribute("mid");
    if (attr) return attr;
    const a = root.querySelector('a[href*="/detail/"], a[href*="/status/"]');
    if (a) {
      const m = a.href.match(/\/(?:detail|status)\/([0-9A-Za-z]+)/);
      if (m) return m[1];
    }
    return null;
  }

  function isUsableMedia(el) {
    const r = el.getBoundingClientRect();
    if (el.tagName === "VIDEO") return r.width > 60 && r.height > 60;
    if (r.width < 80 && r.height < 80) return false; // 头像、图标、表情
    return isFeedImageUrl(imageUrlOf(el));
  }

  // root -> [media]，按 DOM 顺序
  function collectItems() {
    const map = new Map();
    document.querySelectorAll(SEL.media).forEach((el) => {
      if (!isUsableMedia(el)) return;
      const root = findRoot(el);
      if (!root) return;
      let arr = map.get(root);
      if (!arr) {
        arr = [];
        map.set(root, arr);
      }
      if (arr.indexOf(el) < 0) arr.push(el);
    });
    return map;
  }

  // ---------- 取媒体：接口优先，DOM 兜底 ----------
  async function fetchStatusMedia(mid) {
    if (statusCache.has(mid)) return statusCache.get(mid);
    let items = [];
    try {
      const r = await fetch("/ajax/statuses/show?id=" + encodeURIComponent(mid), {
        credentials: "include",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      if (r.ok) items = parseStatusMedia(await r.json());
    } catch (e) {
      console.debug(LOG, "接口请求失败", e && e.message);
    }
    console.debug(LOG, "mid", mid, "取到媒体数", items.length);
    statusCache.set(mid, items);
    return items;
  }

  // 从 media_info 里收所有 mp4 地址，按 hd / sd 分类
  function collectVideoVariants(info) {
    const v = {};
    if (!info || typeof info !== "object") return v;
    const take = (key, url) => {
      if (!/^https?:/i.test(url || "")) return;
      if (/hd|high/i.test(key)) {
        if (!v.hd) v.hd = url;
      } else if (!v.sd) {
        v.sd = url;
      }
    };
    if (info.stream_url_hd) take("hd", info.stream_url_hd);
    if (info.stream_url) take("sd", info.stream_url);
    for (const k in info) {
      const val = info[k];
      if (typeof val === "string" && /^https?:/i.test(val) && /\.mp4|weibocdn|video\.weibo/i.test(val)) {
        take(k, val);
      }
    }
    return v;
  }

  function parseStatusMedia(json) {
    const out = [];
    const seen = new Set();
    const push = (item) => {
      if (!item || !item.url) return;
      const key = item.url.split("#")[0];
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };

    const root = json && (json.data || json);
    const list = [root];
    // 转发微博：媒体常挂在被转发的那条上
    if (root && root.retweeted_status) list.push(root.retweeted_status);

    for (const s of list) {
      if (!s || typeof s !== "object") continue;

      const pi = s.page_info;
      if (pi && pi.media_info) {
        const v = collectVideoVariants(pi.media_info);
        if (v.hd || v.sd) {
          push({ type: "video", url: v.hd || v.sd, variants: v });
          continue;
        }
      }

      if (Array.isArray(s.pics)) {
        for (const p of s.pics) {
          const u = (p.large && p.large.url) || p.url;
          if (u) push({ type: "image", url: u });
        }
      } else if (Array.isArray(s.pic_ids) && pi === undefined) {
        // 极端兜底：只有 pic_ids 时构造不了地址，跳过
      }
    }
    return out;
  }

  function domMedia(root) {
    const out = [];
    const seen = new Set();
    const push = (item) => {
      const key = (item.url || "").split(/[?#]/)[0];
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };

    root.querySelectorAll("video").forEach((v) => {
      if (!isUsableMedia(v)) return;
      const src =
        (v.src && /^https?:/.test(v.src) ? v.src : null) ||
        (v.currentSrc && /^https?:/.test(v.currentSrc) ? v.currentSrc : null) ||
        (v.getAttribute("data-src") || "").trim() ||
        ((v.querySelector("source") || {}).src || "");
      if (/^https?:/.test(src)) push({ type: "video", url: src, variants: {} });
    });
    root.querySelectorAll("img").forEach((img) => {
      if (!isUsableMedia(img)) return;
      push({ type: "image", url: imageUrlOf(img) });
    });
    return out;
  }

  function resolveUrl(item) {
    if (item.type === "video") {
      const v = item.variants || {};
      return settings.videoQuality === "sd"
        ? v.sd || v.hd || item.url
        : v.hd || v.sd || item.url;
    }
    return applyImageQuality(item.url, settings.imageQuality);
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
    if (resp && resp.error) return String(resp.error);
    return "未知错误";
  }

  function downloadItem(btn, item, nameSuffix) {
    const url = resolveUrl(item);
    if (!url || !/^https?:/.test(url)) {
      flash(btn, "wb-dl-error");
      showToast("未找到可下载的媒体地址");
      return;
    }
    chrome.runtime.sendMessage(
      { action: "download", site: "weibo", url, type: item.type, nameSuffix: nameSuffix || "" },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          flash(btn, "wb-dl-error");
          showToast("下载失败：" + errorText(resp));
        } else {
          flash(btn, "wb-dl-done");
        }
      }
    );
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
      if (openMenu.contains(ev.target) || ev.target.closest(".wb-dl-btn")) return;
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
      if (btn.classList.contains("wb-dl-loading")) return;
      btn.classList.add("wb-dl-loading");
      const items = list.map((it) => ({ url: resolveUrl(it), type: it.type }));
      chrome.runtime.sendMessage(
        { action: "zip", site: "weibo", prefix: "weibo_", items },
        (resp) => {
          btn.classList.remove("wb-dl-loading");
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            flash(btn, "wb-dl-error");
            showToast("打包下载失败：" + errorText(resp));
          } else {
            flash(btn, "wb-dl-done");
          }
        }
      );
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
  async function onDownloadClick(ev, root) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    if (btn.classList.contains("wb-dl-loading")) return;

    let list = [];
    const mid = midOf(root);
    if (mid) {
      btn.classList.add("wb-dl-loading");
      try {
        list = await fetchStatusMedia(mid);
      } finally {
        btn.classList.remove("wb-dl-loading");
      }
    }

    if (!list.length) list = domMedia(root);

    if (!list.length) {
      flash(btn, "wb-dl-error");
      showToast("未找到可下载的媒体（接口与页面解析均未取到）");
      return;
    }
    if (list.length === 1) {
      downloadItem(btn, list[0], "");
      return;
    }
    if (openMenu) {
      closeMenu();
      return;
    }
    showMenu(btn, list);
  }

  function attachTo(root) {
    if (!root || root.hasAttribute(PROCESSED_ATTR)) return;
    if (entries.some((e) => !e.dead && e.root === root)) return;
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
    const entry = { btn, root };
    entries.push(entry);
    positionEntry(entry);
  }

  // 按钮挂在 card 右侧外部，与 ins 的交互模型一致；
  // 微博正文列右侧常有侧栏，超出视口时向内收，避免飘到侧栏上
  function positionEntry(e) {
    if (!e.root.isConnected) {
      e.btn.remove();
      e.dead = true;
      return;
    }
    const r = e.root.getBoundingClientRect();
    const visible =
      r.width > 60 && r.height > 60 && r.top >= 0 && r.top < window.innerHeight;
    if (!visible) {
      e.btn.style.display = "none";
      return;
    }
    const left = Math.min(r.right + 8, window.innerWidth - 44);
    e.btn.style.display = "";
    e.btn.style.top = Math.max(8, r.top + 8) + "px";
    e.btn.style.left = Math.max(8, left) + "px";
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
    collectItems().forEach((medias, root) => {
      if (medias.length) attachTo(root);
    });
  }

  // 微博信息流 DOM 变动非常频繁（虚拟滚动 + 角标/点赞数实时更新），
  // 每次 mutation 都全量扫描会卡，这里把扫描节流到 250ms 一次；定位仍走 rAF。
  let scanTimer = 0;
  const observer = new MutationObserver(() => {
    if (!enabled) return;
    schedulePosition();
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 250);
  });

  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);

  // 诊断入口：微博页面 DevTools 控制台（选中扩展的隔离世界）里执行
  //   __wbDl.debug()                          打印当前识别到的每条微博及其媒体数量
  //   __wbDl.checkImage("https://wx1.sinaimg.cn/orj360/xxx.jpg")
  //                                           看某个图片地址能否被识别、换成各档清晰度后的样子
  window.__wbDl = {
    debug() {
      const map = collectItems();
      const rows = [];
      map.forEach((medias, root) => {
        rows.push({
          mid: midOf(root),
          rootClass: root.className && String(root.className).slice(0, 60),
          media: medias.length,
          kinds: medias.map((m) => m.tagName.toLowerCase())
        });
      });
      console.table(rows);
      return rows;
    },
    checkImage(url) {
      const variants = {};
      ["orj360", "mw690", "orj1080", "large"].forEach((q) => {
        variants[q] = applyImageQuality(url, q);
      });
      const isFeedImage = isFeedImageUrl(url);
      console.log("是正文配图:", isFeedImage, variants);
      return { isFeedImage, variants };
    },
    parseStatusMedia,
    scan,
    clearCache: () => statusCache.clear()
  };

  loadState();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
