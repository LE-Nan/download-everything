/* download-everything - background service worker
 * 两种下载模式：
 *  1) 用户选择了自定义文件夹 -> 经 offscreen document 用 File System Access API 写入该文件夹
 *  2) 默认模式 -> chrome.downloads 下载到浏览器下载目录的子文件夹（不询问）
 *
 * 按 site 路由：msg.site === "weibo" 走微博专用逻辑、"twitter" 走 X（推特）专用逻辑
 * （各自独立的目录配置与文件名前缀），其余情况（不传 site 或 site === "ins"）走 ins 逻辑。
 * 三条链路都先由 offscreen 取回真实字节再交付，因此都支持进度回传与取消；
 * 目录、文件名、请求头仍完全独立，互不干扰。
 */

const OFFSCREEN_PATH = "offscreen.html";
let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"],
      justification: "将下载的图片/视频写入用户选择的文件夹"
    });
  }
  await creatingOffscreen;
  creatingOffscreen = null;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/* 下载进度回传：内容脚本发下载请求时带一个 progressId，这里记住它来自哪个标签页，
 * 之后 offscreen 边下边报的字节数、以及「字节已取完」这些事件都转发回该标签页。
 * Instagram 与微博现在共用这一套（两个站点的内容脚本各自画自己的环）。
 */
const progressTabs = new Map(); // progressId -> tabId

function bindProgress(pid, sender) {
  if (!pid) return;
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (tabId === undefined) return;
  progressTabs.set(pid, tabId);
}

/* ---------------- 取消（按钮再点一次）----------------
 * 一条下载在用户眼里只有「加载中」一个状态，但内部跨了三个阶段，取消要分别处理：
 *   1) 解析媒体（content script 内部，页面自己处理）
 *   2) offscreen 取字节 / 打包 → 转成 action:"abort"，断掉 AbortController
 *   3) 保存框已弹出（chrome.downloads 已登记）→ chrome.downloads.cancel
 * 另外用 cancelRequests 记一笔：取消消息有可能先于下载请求到达（连点两下），
 * 任务真正开始时先查这里，已取消就直接返回，避免"取消了还在下"。
 */
const cancelRequests = new Map(); // progressId -> 取消时间
const activeDownloadIds = new Map(); // progressId -> chrome downloadId

// 取消登记只活 30 秒：够覆盖「取消先到、下载后到」的竞态，
// 又不会因为偶发的空取消让这张表一直涨（service worker 是常驻内存的）
const CANCEL_TTL_MS = 30 * 1000;

function pruneCancels() {
  const now = Date.now();
  for (const [pid, at] of cancelRequests) {
    if (now - at > CANCEL_TTL_MS) cancelRequests.delete(pid);
  }
}

function isCanceled(pid) {
  return !!(pid && cancelRequests.has(pid));
}

function requestCancel(pid) {
  if (!pid) return { ok: false, error: "no-progress-id" };
  pruneCancels();
  cancelRequests.set(pid, Date.now());
  // 1) 停掉 offscreen 里正在进行的取字节 / 打包（没人接收时会报 lastError，吞掉）
  try {
    chrome.runtime.sendMessage({ target: "offscreen", action: "abort", progressId: pid }, () =>
      void chrome.runtime.lastError
    );
  } catch (e) {
    /* offscreen 尚未创建，任务开始时也还没开始取字节，无需处理 */
  }
  // 2) 已经弹了保存框：取消这次浏览器下载（会转成 USER_CANCELED，上层静默收尾）
  const dlId = activeDownloadIds.get(pid);
  if (dlId !== undefined) cancelChromeDownload(dlId);
  return { ok: true };
}

function cancelChromeDownload(downloadId) {
  if (downloadId === undefined || !chrome.downloads || !chrome.downloads.cancel) return;
  try {
    chrome.downloads.cancel(downloadId, () => void chrome.runtime.lastError);
  } catch (e) {
    /* 下载已结束 */
  }
}

function releaseCancel(pid) {
  if (!pid) return;
  cancelRequests.delete(pid);
  activeDownloadIds.delete(pid);
}

function notifyProgress(pid, payload) {
  if (!pid) return;
  const tabId = progressTabs.get(pid);
  if (tabId === undefined) return;
  if (!chrome.tabs || !chrome.tabs.sendMessage) return;
  try {
    chrome.tabs.sendMessage(
      tabId,
      Object.assign({ type: "wb-dl-progress", id: pid }, payload),
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    /* 页面已关闭或标签页已销毁，忽略 */
  }
}

function releaseProgress(pid) {
  if (pid) progressTabs.delete(pid);
}

function downloadViaChrome(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError
              ? chrome.runtime.lastError.message
              : "download failed"
          });
        } else {
          resolve({ ok: true, downloadId });
        }
      }
    );
  });
}

async function handleDownload(msg, sender) {
  if (msg.site === "weibo") return handleWeiboDownload(msg, sender);
  if (msg.site === "twitter") return handleTwitterDownload(msg, sender);
  const key = msg.type === "video" ? "video" : "image";
  const cfg = await chrome.storage.sync.get([key + "Custom", key + "Dir", key + "DirName"]);
  const ext = msg.type === "video" ? "mp4" : "jpg";
  // nameSuffix 用于多张下载时自动编号，如 _1、_2，保证命名不冲突
  const suffix = msg.nameSuffix || "";
  const base = "ins_" + msg.type + "_" + timestamp() + suffix;

  const pid = msg.progressId || null;
  // 兼容旧消息格式（只带 url），新格式带 candidates（多档候选）
  const candidates = (Array.isArray(msg.candidates) ? msg.candidates : []).filter(Boolean);
  if (!candidates.length && msg.url) candidates.push(msg.url);

  bindProgress(pid, sender);
  // 连点两下：取消可能比下载请求先到，这里先认账
  if (isCanceled(pid)) {
    releaseCancel(pid);
    releaseProgress(pid);
    return { ok: true, canceled: true };
  }
  if (!candidates.length) {
    releaseProgress(pid);
    return { ok: false, error: "no-candidates" };
  }

  /* Instagram 也改成「先取字节再交付」，与微博同一条链路：
   * 内容脚本要画进度环就得知道已取多少字节，而 chrome.downloads 直接拉地址时
   * 扩展拿不到任何中间进度；字节先行还顺带解决了「服务器返回 HTML 错误页时
   * 后缀被改成 .htm」这类问题（扩展名按真实文件头决定）。
   * progressId 同时是取消的凭据：用户再点一次按钮，offscreen 会断掉这次请求。
   */
  try {
    await ensureOffscreen();
    const saved = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "save-media",
      candidates,
      kind: key,
      fileName: base, // 不含扩展名，扩展名由 offscreen 按真实文件头决定
      progressId: pid,
      dirKey: cfg[key + "Custom"] ? key + "DirHandle" : null
    });

    // 取字节过程中被取消：不报错、不重试，也不建 blob
    if (isCanceled(pid) || (saved && saved.error === "aborted")) {
      if (saved && saved.url) releaseBlobLater(saved.url);
      return { ok: true, canceled: true };
    }

    if (saved && saved.ok) {
      if (saved.saved === "fs") {
        // 直接写盘，没有保存框：字节取完即完成
        notifyProgress(pid, { phase: "save" });
        return { ok: true };
      }
      const name = base + "." + (saved.ext || ext);
      const dir = (cfg[key + "Dir"] || "ins-download/" + key + "s").replace(/^\/+|\/+$/g, "");
      const resp = await deliverBytes(saved, dir + "/" + name, pid);
      releaseBlobLater(saved.url);
      return resp;
    }

    // 取字节失败（CDN 拒绝扩展来源 / 不是可识别媒体）：退回原来的直拉方式，
    // 宁可没有进度环也不能把原本能下的内容变成下不了。
    if (isCanceled(pid)) return { ok: true, canceled: true };
    console.warn("[download-everything] ins 取字节失败，退回直拉", saved && saved.error);
    notifyProgress(pid, { phase: "save" });
    return legacyInsDownload(candidates[0], key, cfg, base + "." + ext);
  } catch (e) {
    return legacyInsDownload(candidates[0], key, cfg, base + "." + ext);
  } finally {
    releaseProgress(pid);
    releaseCancel(pid);
  }
}

/* 旧路径（v2.0.x 及之前）：把地址直接交给下载器。
 * 只在「取字节」失败时兜底使用，行为与改造前一致。 */
async function legacyInsDownload(url, key, cfg, name) {
  if (cfg[key + "Custom"]) {
    try {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage({
        target: "offscreen",
        dirKey: key + "DirHandle",
        url,
        fileName: name
      });
      return resp || { ok: false, error: "no-response" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }
  const dir = (cfg[key + "Dir"] || "ins-download/" + key + "s").replace(/^\/+|\/+$/g, "");
  return downloadViaChrome(url, dir + "/" + name);
}

async function handleZip(msg, sender) {
  if (msg.site === "weibo") return handleWeiboZip(msg, sender);
  if (msg.site === "twitter") return handleTwitterZip(msg, sender);
  const cfg = await chrome.storage.sync.get(["imageCustom", "imageDir"]);
  const zipName = "ins_images_" + timestamp() + ".zip";
  const pid = msg.progressId || null;
  bindProgress(pid, sender);
  if (isCanceled(pid)) {
    releaseCancel(pid);
    releaseProgress(pid);
    return { ok: true, canceled: true };
  }
  try {
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "zip",
      items: msg.items,
      zipName,
      prefix: "ins_",
      /* progressId：offscreen 每取完一项报一次，进度环按项数走；
       * 与微博共用同一条进度通道（消息 type 统一是 wb-dl-progress）。 */
      progressId: pid,
      dirKey: cfg.imageCustom ? "imageDirHandle" : null
    });
    // 打包途中取消：已取到的字节直接丢弃，不落盘
    if (isCanceled(pid) || (resp && resp.error === "aborted")) {
      return { ok: true, canceled: true };
    }
    if (resp && resp.ok && resp.dataUrl) {
      // 默认模式：走 chrome.downloads，只下载一个 zip（至多一次保存提示）
      const dir = (cfg.imageDir || "ins-download/images").replace(/^\/+|\/+$/g, "");
      notifyProgress(pid, { phase: "save" });
      const r = await downloadViaChrome(resp.dataUrl, dir + "/" + zipName);
      if (!r.ok) return r;
      activeDownloadIds.set(pid, r.downloadId);
      if (isCanceled(pid)) {
        cancelChromeDownload(r.downloadId);
        return { ok: true, canceled: true };
      }
      const end = await watchDownload(r.downloadId);
      return end && end.canceled ? { ok: true, canceled: true } : end;
    }
    if (resp && resp.ok) notifyProgress(pid, { phase: "save" });
    return resp || { ok: false, error: "no-response" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    releaseProgress(pid);
    releaseCancel(pid);
  }
}

/* ---------------- 微博：独立链路，与上面的 ins 逻辑零交叉 ----------------
 * 独立的 storage 键（weiboImageDir / weiboVideoDir / weiboImageCustom …）、
 * 独立的文件名前缀 weibo_、独立的默认目录 weibo-download/。
 * 这样两边设置互不干扰，任意一边改坏都影响不到另一边。
 */
const WEIBO_DEFAULT_DIR = {
  image: "weibo-download/images",
  video: "weibo-download/videos"
};

function weiboKeys(type) {
  const key = type === "video" ? "video" : "image";
  return { key, prefix: key === "video" ? "weiboVideo" : "weiboImage" };
}

/* 微博的图床与视频 CDN 会校验 Referer，缺了直接回 403（返回 HTML 错误页）。
 * 扩展发起的 fetch / chrome.downloads 默认带的是 chrome-extension:// 来源，
 * 所以用 declarativeNetRequest 会话规则把 Referer/Origin 补成 weibo.com。
 *
 * 只作用于图床与视频 CDN（sinaimg / weibocdn），**不包含 weibo.com 本身**：
 * 那条规则会连页面自己的 ajax 请求一起改，可能破坏微博自身的 CSRF 校验。
 * 会话级规则，浏览器重启后由 onStartup 重新安装。
 */
const WEIBO_HEADER_RULE_ID = 9001;
let weiboHeaderReady = null;

async function setupWeiboHeaders() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  const base = {
    id: WEIBO_HEADER_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "referer", operation: "set", value: "https://weibo.com/" }]
    },
    condition: { requestDomains: ["sinaimg.cn", "weibocdn.com", "weibocdn.cn"] }
  };
  // Origin 不是所有 Chrome 版本都允许改写，失败就只保留 Referer
  const withOrigin = JSON.parse(JSON.stringify(base));
  withOrigin.action.requestHeaders.push({
    header: "origin",
    operation: "set",
    value: "https://weibo.com/"
  });
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [WEIBO_HEADER_RULE_ID],
      addRules: [withOrigin]
    });
  } catch (e) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [WEIBO_HEADER_RULE_ID],
        addRules: [base]
      });
    } catch (e2) {
      console.warn("[download-everything] 微博请求头规则安装失败", e2 && e2.message);
    }
  }
}

function ensureWeiboHeaders() {
  if (!weiboHeaderReady) weiboHeaderReady = setupWeiboHeaders();
  return weiboHeaderReady;
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    weiboHeaderReady = null;
    ensureWeiboHeaders();
  });
}
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    weiboHeaderReady = null;
    ensureWeiboHeaders();
  });
}

async function handleWeiboDownload(msg, sender) {
  const { key, prefix } = weiboKeys(msg.type);
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const suffix = msg.nameSuffix || "";
  const base = "weibo_" + key + "_" + timestamp() + suffix;
  const pid = msg.progressId || null;
  bindProgress(pid, sender);

  // 连点两下：取消可能比下载请求先到，这里先认账
  if (isCanceled(pid)) {
    releaseCancel(pid);
    releaseProgress(pid);
    return { ok: true, canceled: true };
  }

  // 兼容旧消息格式（只带 url）
  let candidates = Array.isArray(msg.candidates) ? msg.candidates.filter(Boolean) : [];
  if (!candidates.length && msg.url) candidates = [msg.url];
  if (!candidates.length) {
    releaseProgress(pid);
    return { ok: false, error: "no-candidates" };
  }

  try {
    await ensureWeiboHeaders();
    await ensureOffscreen();

    /* 由 offscreen 取回真实字节再交付，不把地址丢给 chrome.downloads 去拉：
     * 下载请求没有页面 Referer，微博 CDN 会回 200 的 HTML 错误页，
     * Chrome 据此把后缀改成 .htm（历史 bug）。字节先行则后缀不可能再被改。
     * progressId 一并传下去：offscreen 边下边把已取字节数报回来，
     * 内容脚本据此画进度环——否则视频那 5～15 秒完全是黑盒。
     * 同一个 progressId 也是取消的凭据：用户再点一次按钮时，
     * background 会让 offscreen 断掉对应请求。
     */
    const saved = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "save-media",
      candidates,
      kind: key,
      fileName: base, // 不含扩展名；扩展名由 offscreen 按真实文件头决定
      progressId: pid,
      dirKey: cfg[prefix + "Custom"] ? prefix + "DirHandle" : null
    });
    // 取字节过程中被取消：不报错、不重试，也不建 blob
    if (isCanceled(pid) || (saved && saved.error === "aborted")) {
      if (saved && saved.url) releaseBlobLater(saved.url);
      return { ok: true, canceled: true };
    }
    if (!saved || !saved.ok) return saved || { ok: false, error: "no-response" };
    if (saved.saved === "fs") {
      // 直接写盘，没有保存框：字节取完即完成
      notifyProgress(pid, { phase: "save" });
      return { ok: true };
    }

    const fileName = base + "." + (saved.ext || (key === "video" ? "mp4" : "jpg"));
    const dir = (cfg[prefix + "Dir"] || WEIBO_DEFAULT_DIR[key]).replace(/^\/+|\/+$/g, "");
    const resp = await deliverBytes(saved, dir + "/" + fileName, pid);
    releaseBlobLater(saved.url);
    return resp;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    releaseProgress(pid);
    releaseCancel(pid);
  }
}

// 小文件（图片）阈值：低于它直接走 dataUrl
const SMALL_MEDIA = 6 * 1024 * 1024;

/* 把 offscreen 取回的字节交给下载器。
 * 小文件优先 dataUrl —— 这条路径与多图 zip 一致，是实测最稳的一条；
 * 大文件（视频）用 blob URL，避免 base64 膨胀；blob 不被接受时再退回 dataUrl。
 * pid 存在时，在真正调下载器之前把进度环填满：这一刻保存框正要弹出。
 * 之后一直等到下载结束（用户点保存 / 取消），响应才返回——
 * 内容脚本据此把按钮恢复原样，所以「填满」与「保存框」是联动的。
 * 下载一旦登记，就把 downloadId 记到 pid 名下：这时用户再点按钮，
 * 取消可以直接落到这次浏览器下载上（保存框会随之关掉）。
 */
async function deliverBytes(saved, target, pid) {
  let dataUrl = null;
  const asDataUrl = async () => {
    if (dataUrl) return dataUrl;
    const conv = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "blob-dataurl",
      url: saved.url
    });
    dataUrl = conv && conv.ok ? conv.dataUrl : null;
    return dataUrl;
  };

  const tryDownload = async (url) => {
    notifyProgress(pid, { phase: "save" });
    const r = await downloadViaChrome(url, target);
    if (!r.ok) return r;
    if (pid) {
      activeDownloadIds.set(pid, r.downloadId);
      // 保存框弹出来的同一瞬间点了取消：补一刀
      if (isCanceled(pid)) cancelChromeDownload(r.downloadId);
    }
    return watchDownload(r.downloadId);
  };

  // 用户点取消不是失败：归一成 ok，避免上层弹红条
  const done = (r) => (r && r.canceled ? { ok: true, canceled: true } : r);

  if (!saved.size || saved.size <= SMALL_MEDIA) {
    const d = await asDataUrl();
    if (d) {
      // 转 base64 这一步也可能刚好赶上用户取消：别再去弹保存框
      if (isCanceled(pid)) return { ok: true, canceled: true };
      const r = await tryDownload(d);
      if (r.ok || r.canceled) return done(r);
    }
  }

  // 取消后不要为了"换个地址重试"再弹一次保存框
  if (isCanceled(pid)) return { ok: true, canceled: true };

  let r = await tryDownload(saved.url);
  if (r.ok || r.canceled) return done(r);
  if (isCanceled(pid)) return { ok: true, canceled: true };
  // 少数 Chrome 版本不接受离屏文档创建的 blob URL
  const d = await asDataUrl();
  if (!d) return r;
  return done(await tryDownload(d));
}

/* 下载器接受 URL 后会「立刻」返回 downloadId，之后才可能因为资源无法解析
 * （例如离屏文档的 blob URL 不被接受）转到 interrupted —— 这种失败不会走回调，
 * 只看回调会误判成成功、按钮变绿而文件是坏的。
 *
 * 这里一直盯到下载真正结束：
 *   complete    → 成功（用户已在保存框点了保存，字节落盘）
 *   interrupted → 失败；原因是 USER_CANCELED 时标记 canceled（用户自己取消，不报错）
 *   in_progress → 继续等（保存框打开期间就是这个状态，进度环保持填满）
 *   超时        → 视为已开始，避免保存框长期开着把消息通道拖死
 */
const WAIT_END_MS = 4 * 60 * 1000;

function watchDownload(downloadId, ms) {
  return new Promise((resolve) => {
    const changes = chrome.downloads && chrome.downloads.onChanged;
    if (downloadId === undefined || !changes) {
      resolve({ ok: true, downloadId });
      return;
    }
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try {
        changes.removeListener(onChange);
      } catch (e) {
        /* 忽略 */
      }
      clearTimeout(timer);
      resolve(r);
    };
    const interrupted = (reason) =>
      finish({
        ok: false,
        error: "download-interrupted",
        reason: reason || "",
        canceled: reason === "USER_CANCELED"
      });
    const onChange = (delta) => {
      if (!delta || delta.id !== downloadId || !delta.state) return;
      const s = delta.state.current;
      if (s === "complete") finish({ ok: true, downloadId, state: s });
      else if (s === "interrupted") interrupted(delta.error && delta.error.current);
      // in_progress：保存框可能正开着，继续等
    };
    const timer = setTimeout(() => finish({ ok: true, downloadId, state: "pending" }), ms || WAIT_END_MS);
    const listen = () => {
      try {
        changes.addListener(onChange);
      } catch (e) {
        finish({ ok: true, downloadId });
      }
    };

    // 小文件可能在挂监听之前就下完了，先查一次当前状态再决定
    if (chrome.downloads.search) {
      let dispatched = false;
      try {
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (settled) return;
          const it = items && items[0];
          const s = it && it.state;
          if (s === "complete") finish({ ok: true, downloadId, state: s });
          else if (s === "interrupted") interrupted(it.error);
          else listen();
        });
        dispatched = true;
      } catch (e) {
        dispatched = false; // 查询不可用，落到监听
      }
      if (dispatched) return;
    }
    listen();
  });
}

function releaseBlobLater(url) {
  if (!url) return;
  try {
    chrome.runtime.sendMessage(
      { target: "offscreen", action: "release-blob", url },
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    /* offscreen 已关闭时忽略 */
  }
}

async function handleWeiboZip(msg, sender) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  // 含视频的合集落到视频目录，纯图片落到图片目录（ins 侧沿用旧行为，不动）
  const hasVideo = items.some((it) => it.type === "video");
  const { key, prefix } = weiboKeys(hasVideo ? "video" : "image");
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const zipName = "weibo_" + key + "s_" + timestamp() + ".zip";
  const pid = msg.progressId || null;
  bindProgress(pid, sender);

  if (isCanceled(pid)) {
    releaseCancel(pid);
    releaseProgress(pid);
    return { ok: true, canceled: true };
  }

  try {
    await ensureWeiboHeaders();
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "zip",
      items,
      zipName,
      prefix: "weibo_",
      sniffExt: true,
      progressId: pid, // offscreen 每取完一项报一次，进度环按项数走
      dirKey: cfg[prefix + "Custom"] ? prefix + "DirHandle" : null
    });
    // 打包途中取消：已取到的字节直接丢弃，不落盘
    if (isCanceled(pid) || (resp && resp.error === "aborted")) {
      return { ok: true, canceled: true };
    }
    if (resp && resp.ok && resp.dataUrl) {
      const dir = (cfg[prefix + "Dir"] || WEIBO_DEFAULT_DIR[key]).replace(/^\/+|\/+$/g, "");
      notifyProgress(pid, { phase: "save" });
      const r = await downloadViaChrome(resp.dataUrl, dir + "/" + zipName);
      if (!r.ok) return r;
      activeDownloadIds.set(pid, r.downloadId);
      if (isCanceled(pid)) {
        cancelChromeDownload(r.downloadId);
        return { ok: true, canceled: true };
      }
      const end = await watchDownload(r.downloadId);
      return end && end.canceled ? { ok: true, canceled: true } : end;
    }
    if (resp && resp.ok) notifyProgress(pid, { phase: "save" });
    return resp || { ok: false, error: "no-response" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    releaseProgress(pid);
    releaseCancel(pid);
  }
}

/* 微博接口兜底：页面里同源 fetch 失败时（如 s.weibo.com 上没有该接口、
 * 或跨域被 CORS 拦），由 offscreen（带 host 权限）代发一次。
 * 只转发微博自有域名，避免变成任意地址的通用代理。
 */
async function handleWeiboApi(msg) {
  let url;
  try {
    url = new URL(msg.url);
  } catch (e) {
    return { ok: false, error: "bad-url" };
  }
  if (!/(^|\.)weibo\.com$|(^|\.)weibo\.cn$/i.test(url.hostname)) {
    return { ok: false, error: "host-not-allowed" };
  }
  await ensureWeiboHeaders();
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    target: "offscreen",
    action: "weibo-api",
    url: url.toString(),
    method: msg.method || "GET",
    body: msg.body || null,
    contentType: msg.contentType || null
  });
  return resp || { ok: false, error: "no-response" };
}

/* ---------------- X（推特）：独立链路 ----------------
 * 与微博结构一致但完全独立：独立的 storage 键（twitterImageDir / twitterVideoDir /
 * twitterImageCustom …）、文件名前缀 twitter_、默认目录 twitter-download/。
 *
 * 与微博的差别只有一个：twimg 的图床/CDN 不校验 Referer（pbs / video.twimg.com 本来就是
 * 给第三方 embed 用的），所以不需要 declarativeNetRequest 改请求头，链路更短。
 */
const TWITTER_DEFAULT_DIR = {
  image: "twitter-download/images",
  video: "twitter-download/videos"
};

function twitterKeys(type) {
  const key = type === "video" ? "video" : "image";
  return { key, prefix: key === "video" ? "twitterVideo" : "twitterImage" };
}

async function handleTwitterDownload(msg, sender) {
  const { key, prefix } = twitterKeys(msg.type);
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const suffix = msg.nameSuffix || "";
  const base = "twitter_" + key + "_" + timestamp() + suffix;
  const pid = msg.progressId || null;
  bindProgress(pid, sender);

  if (isCanceled(pid)) {
    releaseCancel(pid);
    releaseProgress(pid);
    return { ok: true, canceled: true };
  }

  let candidates = Array.isArray(msg.candidates) ? msg.candidates.filter(Boolean) : [];
  if (!candidates.length && msg.url) candidates = [msg.url];
  if (!candidates.length) {
    releaseProgress(pid);
    return { ok: false, error: "no-candidates" };
  }

  try {
    await ensureOffscreen();
    // 与微博同一条「先取字节」链路：扩展名按真实文件头决定，保存框弹一次，
    // 进度与取消都靠 progressId 串起来。
    const saved = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "save-media",
      candidates,
      kind: key,
      fileName: base,
      progressId: pid,
      dirKey: cfg[prefix + "Custom"] ? prefix + "DirHandle" : null
    });
    if (isCanceled(pid) || (saved && saved.error === "aborted")) {
      if (saved && saved.url) releaseBlobLater(saved.url);
      return { ok: true, canceled: true };
    }
    if (!saved || !saved.ok) return saved || { ok: false, error: "no-response" };
    if (saved.saved === "fs") {
      notifyProgress(pid, { phase: "save" });
      return { ok: true };
    }

    const fileName = base + "." + (saved.ext || (key === "video" ? "mp4" : "jpg"));
    const dir = (cfg[prefix + "Dir"] || TWITTER_DEFAULT_DIR[key]).replace(/^\/+|\/+$/g, "");
    const resp = await deliverBytes(saved, dir + "/" + fileName, pid);
    releaseBlobLater(saved.url);
    return resp;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    releaseProgress(pid);
    releaseCancel(pid);
  }
}

async function handleTwitterZip(msg, sender) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  // 含视频的合集落到视频目录，纯图片落到图片目录
  const hasVideo = items.some((it) => it.type === "video");
  const { key, prefix } = twitterKeys(hasVideo ? "video" : "image");
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const zipName = "twitter_" + key + "s_" + timestamp() + ".zip";
  const pid = msg.progressId || null;
  bindProgress(pid, sender);

  if (isCanceled(pid)) {
    releaseCancel(pid);
    releaseProgress(pid);
    return { ok: true, canceled: true };
  }

  try {
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "zip",
      items,
      zipName,
      prefix: "twitter_",
      sniffExt: true,
      progressId: pid,
      dirKey: cfg[prefix + "Custom"] ? prefix + "DirHandle" : null
    });
    if (isCanceled(pid) || (resp && resp.error === "aborted")) {
      return { ok: true, canceled: true };
    }
    if (resp && resp.ok && resp.dataUrl) {
      const dir = (cfg[prefix + "Dir"] || TWITTER_DEFAULT_DIR[key]).replace(/^\/+|\/+$/g, "");
      notifyProgress(pid, { phase: "save" });
      const r = await downloadViaChrome(resp.dataUrl, dir + "/" + zipName);
      if (!r.ok) return r;
      activeDownloadIds.set(pid, r.downloadId);
      if (isCanceled(pid)) {
        cancelChromeDownload(r.downloadId);
        return { ok: true, canceled: true };
      }
      const end = await watchDownload(r.downloadId);
      return end && end.canceled ? { ok: true, canceled: true } : end;
    }
    if (resp && resp.ok) notifyProgress(pid, { phase: "save" });
    return resp || { ok: false, error: "no-response" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    releaseProgress(pid);
    releaseCancel(pid);
  }
}

/* X 的公开嵌入接口（cdn.syndication.twimg.com/tweet-result）：页面里发会被 CORS 拦，
 * 由 offscreen 代发。只放行这一个域名，避免变成通用代理。 */
async function handleXApi(msg) {
  let url;
  try {
    url = new URL(msg.url);
  } catch (e) {
    return { ok: false, error: "bad-url" };
  }
  if (!/^(cdn\.syndication\.twimg\.com|api\.x\.com|api\.twitter\.com)$/i.test(url.hostname)) {
    return { ok: false, error: "host-not-allowed" };
  }
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    target: "offscreen",
    action: "weibo-api", // offscreen 侧只是一个通用 GET 代理，与站点无关
    url: url.toString(),
    method: "GET"
  });
  return resp || { ok: false, error: "no-response" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  // offscreen 边下边报的字节数：转给发起下载的那个标签页，画进度环用
  if (msg.action === "wb-fetch-progress") {
    notifyProgress(msg.progressId, {
      phase: "fetch",
      loaded: msg.loaded || 0,
      total: msg.total || 0
    });
    return;
  }
  if (msg.action === "download") {
    handleDownload(msg, sender).then(sendResponse);
    return true;
  }
  if (msg.action === "zip") {
    handleZip(msg, sender).then(sendResponse);
    return true;
  }
  // 内容脚本在加载中再次点击按钮 = 取消这条下载
  // action:"cancel" 是新名字（三站共用），"wb-cancel" 保留兼容旧脚本
  if (msg.action === "cancel" || msg.action === "wb-cancel") {
    sendResponse(requestCancel(msg.progressId));
    return;
  }
  if (msg.action === "weibo-api") {
    handleWeiboApi(msg).then(sendResponse);
    return true;
  }
  if (msg.action === "x-api") {
    handleXApi(msg).then(sendResponse);
    return true;
  }
});
