/* ins download - background service worker
 * 两种下载模式：
 *  1) 用户选择了自定义文件夹 -> 经 offscreen document 用 File System Access API 写入该文件夹
 *  2) 默认模式 -> chrome.downloads 下载到浏览器下载目录的子文件夹（不询问）
 *
 * 按 site 路由：msg.site === "weibo" 走微博专用逻辑（独立的目录配置与文件名前缀），
 * 其余情况（不传 site 或 site === "ins"）完全走原有 ins 逻辑，行为不变。
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

async function handleDownload(msg) {
  if (msg.site === "weibo") return handleWeiboDownload(msg);
  const key = msg.type === "video" ? "video" : "image";
  const cfg = await chrome.storage.sync.get([key + "Custom", key + "Dir", key + "DirName"]);
  const ext = msg.type === "video" ? "mp4" : "jpg";
  // nameSuffix 用于多张下载时自动编号，如 _1、_2，保证命名不冲突
  const suffix = msg.nameSuffix || "";
  const name = "ins_" + msg.type + "_" + timestamp() + suffix + "." + ext;

  if (cfg[key + "Custom"]) {
    try {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage({
        target: "offscreen",
        dirKey: key + "DirHandle",
        url: msg.url,
        fileName: name
      });
      return resp || { ok: false, error: "no-response" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  const dir = (cfg[key + "Dir"] || "ins-download/" + key + "s").replace(/^\/+|\/+$/g, "");
  return downloadViaChrome(msg.url, dir + "/" + name);
}

async function handleZip(msg) {
  if (msg.site === "weibo") return handleWeiboZip(msg);
  const cfg = await chrome.storage.sync.get(["imageCustom", "imageDir"]);
  const zipName = "ins_images_" + timestamp() + ".zip";
  try {
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "zip",
      items: msg.items,
      zipName,
      dirKey: cfg.imageCustom ? "imageDirHandle" : null
    });
    if (resp && resp.ok && resp.dataUrl) {
      // 默认模式：走 chrome.downloads，只下载一个 zip（至多一次保存提示）
      const dir = (cfg.imageDir || "ins-download/images").replace(/^\/+|\/+$/g, "");
      return downloadViaChrome(resp.dataUrl, dir + "/" + zipName);
    }
    return resp || { ok: false, error: "no-response" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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
      console.warn("[ins download] 微博请求头规则安装失败", e2 && e2.message);
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

// 探测候选地址：返回第一个「真能拿到媒体字节」的地址 + 真实扩展名
async function probeCandidates(candidates, kind) {
  await ensureWeiboHeaders();
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    target: "offscreen",
    action: "probe-media",
    candidates,
    kind
  });
  return resp || { ok: false, error: "no-response" };
}

async function handleWeiboDownload(msg) {
  const { key, prefix } = weiboKeys(msg.type);
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const suffix = msg.nameSuffix || "";
  const base = "weibo_" + key + "_" + timestamp() + suffix;

  // 兼容旧消息格式（只带 url）
  let candidates = Array.isArray(msg.candidates) ? msg.candidates.filter(Boolean) : [];
  if (!candidates.length && msg.url) candidates = [msg.url];
  if (!candidates.length) return { ok: false, error: "no-candidates" };

  try {
    // 先探明哪个地址是真正的媒体（避开 404 HTML / 403 错误页，拿到真实后缀）
    const probe = await probeCandidates(candidates, key);
    if (!probe.ok) return probe;

    const fileName = base + "." + probe.ext;

    if (cfg[prefix + "Custom"]) {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage({
        target: "offscreen",
        dirKey: prefix + "DirHandle",
        url: probe.url,
        fileName,
        rejectHtml: true
      });
      return resp || { ok: false, error: "no-response" };
    }

    const dir = (cfg[prefix + "Dir"] || WEIBO_DEFAULT_DIR[key]).replace(/^\/+|\/+$/g, "");
    return downloadViaChrome(probe.url, dir + "/" + fileName);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function handleWeiboZip(msg) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  // 含视频的合集落到视频目录，纯图片落到图片目录（ins 侧沿用旧行为，不动）
  const hasVideo = items.some((it) => it.type === "video");
  const { key, prefix } = weiboKeys(hasVideo ? "video" : "image");
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const zipName = "weibo_" + key + "s_" + timestamp() + ".zip";

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
      dirKey: cfg[prefix + "Custom"] ? prefix + "DirHandle" : null
    });
    if (resp && resp.ok && resp.dataUrl) {
      const dir = (cfg[prefix + "Dir"] || WEIBO_DEFAULT_DIR[key]).replace(/^\/+|\/+$/g, "");
      return downloadViaChrome(resp.dataUrl, dir + "/" + zipName);
    }
    return resp || { ok: false, error: "no-response" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.action === "download") {
    handleDownload(msg).then(sendResponse);
    return true;
  }
  if (msg.action === "zip") {
    handleZip(msg).then(sendResponse);
    return true;
  }
  if (msg.action === "weibo-api") {
    handleWeiboApi(msg).then(sendResponse);
    return true;
  }
});
