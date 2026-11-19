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

async function handleWeiboDownload(msg) {
  const { key, prefix } = weiboKeys(msg.type);
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const ext = key === "video" ? "mp4" : "jpg";
  const suffix = msg.nameSuffix || "";
  const name = "weibo_" + key + "_" + timestamp() + suffix + "." + ext;

  if (cfg[prefix + "Custom"]) {
    try {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage({
        target: "offscreen",
        dirKey: prefix + "DirHandle",
        url: msg.url,
        fileName: name
      });
      return resp || { ok: false, error: "no-response" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  const dir = (cfg[prefix + "Dir"] || WEIBO_DEFAULT_DIR[key]).replace(/^\/+|\/+$/g, "");
  return downloadViaChrome(msg.url, dir + "/" + name);
}

async function handleWeiboZip(msg) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  // 含视频的合集落到视频目录，纯图片落到图片目录（ins 侧沿用旧行为，不动）
  const hasVideo = items.some((it) => it.type === "video");
  const { key, prefix } = weiboKeys(hasVideo ? "video" : "image");
  const cfg = await chrome.storage.sync.get([prefix + "Custom", prefix + "Dir"]);
  const zipName = "weibo_" + key + "s_" + timestamp() + ".zip";

  try {
    await ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "zip",
      items,
      zipName,
      prefix: "weibo_",
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
});
