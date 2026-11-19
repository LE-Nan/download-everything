const QUALITY_KEYS = ["imageQuality", "videoQuality"];
const DEFAULTS = {
  imageQuality: "1080",
  videoQuality: "1080"
};

function displayEl(key) {
  return document.getElementById(key + "DirDisplay");
}

async function refreshDirUI(key) {
  const res = await chrome.storage.sync.get([key + "Custom", key + "DirName"]);
  const custom = res[key + "Custom"] === true;
  const reauthBtn = document.getElementById(key + "Reauth");
  const resetBtn = document.getElementById(key + "Reset");
  if (!custom) {
    displayEl(key).textContent = "默认（下载\\ins-download\\" + key + "s）";
    reauthBtn.style.display = "none";
    resetBtn.style.display = "none";
    return;
  }
  const name = res[key + "DirName"] || "已选择的文件夹";
  // 检查授权状态（浏览器重启后权限会重置，需要重新授权一次）
  let perm = "granted";
  try {
    const handle = await idbGet(key + "DirHandle");
    if (handle) perm = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) { /* ignore */ }
  displayEl(key).textContent =
    "自定义：" + name + (perm === "granted" ? "" : "（需要重新授权）");
  reauthBtn.style.display = perm === "granted" ? "none" : "";
  resetBtn.style.display = "";
}

async function pickFolder(key) {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet(key + "DirHandle", handle);
    await chrome.storage.sync.set({
      [key + "Custom"]: true,
      [key + "DirName"]: handle.name
    });
    await refreshDirUI(key);
  } catch (e) {
    // 用户取消选择，不做任何事
  }
}

async function resetFolder(key) {
  await idbDel(key + "DirHandle");
  await chrome.storage.sync.set({ [key + "Custom"]: false });
  await refreshDirUI(key);
}

async function restore() {
  const res = await chrome.storage.sync.get(QUALITY_KEYS);
  for (const k of QUALITY_KEYS) {
    document.getElementById(k).value = res[k] !== undefined ? res[k] : DEFAULTS[k];
  }
  await refreshDirUI("image");
  await refreshDirUI("video");
}

function save() {
  const data = {};
  for (const k of QUALITY_KEYS) data[k] = document.getElementById(k).value;
  chrome.storage.sync.set(data, () => {
    const s = document.getElementById("status");
    s.textContent = "已保存";
    setTimeout(() => (s.textContent = ""), 1500);
  });
}

document.addEventListener("DOMContentLoaded", restore);
document.getElementById("imagePick").addEventListener("click", () => pickFolder("image"));
document.getElementById("videoPick").addEventListener("click", () => pickFolder("video"));
document.getElementById("imageReauth").addEventListener("click", () => pickFolder("image"));
document.getElementById("videoReauth").addEventListener("click", () => pickFolder("video"));
document.getElementById("imageReset").addEventListener("click", () => resetFolder("image"));
document.getElementById("videoReset").addEventListener("click", () => resetFolder("video"));
document.getElementById("save").addEventListener("click", save);

/* ================= 微博设置 =================
 * 完全独立于上面的 ins 设置：独立的 storage 键、独立的句柄、独立的默认目录。
 * 不修改任何已有函数，只追加新函数与新的监听器。
 */
const WEIBO_DEFAULT_DIR = {
  image: "weibo-download/images",
  video: "weibo-download/videos"
};
const WEIBO_QUALITY_DEFAULTS = {
  weiboImageQuality: "orj1080",
  weiboVideoQuality: "hd"
};

function wbPrefix(which) {
  return which === "image" ? "weiboImage" : "weiboVideo";
}

async function refreshWeiboDirUI(which) {
  const prefix = wbPrefix(which);
  const res = await chrome.storage.sync.get([prefix + "Custom", prefix + "DirName"]);
  const display = document.getElementById(prefix + "DirDisplay");
  const reauth = document.getElementById(prefix + "Reauth");
  const reset = document.getElementById(prefix + "Reset");
  if (!display) return;

  if (res[prefix + "Custom"] !== true) {
    display.textContent =
      "默认（下载\\" + WEIBO_DEFAULT_DIR[which].replace(/\//g, "\\") + "）";
    reauth.style.display = "none";
    reset.style.display = "none";
    return;
  }

  const name = res[prefix + "DirName"] || "已选择的文件夹";
  let perm = "granted";
  try {
    const handle = await idbGet(prefix + "DirHandle");
    if (handle) perm = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) {
    /* ignore */
  }
  display.textContent =
    "自定义：" + name + (perm === "granted" ? "" : "（需要重新授权）");
  reauth.style.display = perm === "granted" ? "none" : "";
  reset.style.display = "";
}

async function pickWeiboFolder(which) {
  const prefix = wbPrefix(which);
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet(prefix + "DirHandle", handle);
    await chrome.storage.sync.set({
      [prefix + "Custom"]: true,
      [prefix + "DirName"]: handle.name
    });
    await refreshWeiboDirUI(which);
  } catch (e) {
    // 用户取消选择
  }
}

async function resetWeiboFolder(which) {
  const prefix = wbPrefix(which);
  await idbDel(prefix + "DirHandle");
  await chrome.storage.sync.set({ [prefix + "Custom"]: false });
  await refreshWeiboDirUI(which);
}

async function restoreWeibo() {
  const res = await chrome.storage.sync.get(Object.keys(WEIBO_QUALITY_DEFAULTS));
  for (const k in WEIBO_QUALITY_DEFAULTS) {
    const el = document.getElementById(k);
    if (el) el.value = res[k] !== undefined ? res[k] : WEIBO_QUALITY_DEFAULTS[k];
  }
  await refreshWeiboDirUI("image");
  await refreshWeiboDirUI("video");
}

function saveWeibo() {
  const data = {};
  for (const k in WEIBO_QUALITY_DEFAULTS) {
    const el = document.getElementById(k);
    if (el) data[k] = el.value;
  }
  chrome.storage.sync.set(data);
}

document.addEventListener("DOMContentLoaded", () => {
  restoreWeibo();
  document
    .getElementById("weiboImagePick")
    .addEventListener("click", () => pickWeiboFolder("image"));
  document
    .getElementById("weiboVideoPick")
    .addEventListener("click", () => pickWeiboFolder("video"));
  document
    .getElementById("weiboImageReauth")
    .addEventListener("click", () => pickWeiboFolder("image"));
  document
    .getElementById("weiboVideoReauth")
    .addEventListener("click", () => pickWeiboFolder("video"));
  document
    .getElementById("weiboImageReset")
    .addEventListener("click", () => resetWeiboFolder("image"));
  document
    .getElementById("weiboVideoReset")
    .addEventListener("click", () => resetWeiboFolder("video"));
  document.getElementById("save").addEventListener("click", saveWeibo);
});
