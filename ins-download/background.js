/* ins download - background service worker
 * 两种下载模式：
 *  1) 用户选择了自定义文件夹 -> 经 offscreen document 用 File System Access API 写入该文件夹
 *  2) 默认模式 -> chrome.downloads 下载到浏览器下载目录的子文件夹（不询问）
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
