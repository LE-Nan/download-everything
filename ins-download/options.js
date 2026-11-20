/* download-everything - 设置页
 * 左侧导航 + 两个分栏：保存位置（下载目录与清晰度）/ 显示设置（界面语言）。
 * 所有 storage 键与 v2.1.0 完全一致，只换了展示层与分栏结构。
 */
const I18N = globalThis.DELi18n || null;
function t(key, vars) {
  return I18N ? I18N.t(key, vars) : key;
}

const QUALITY_KEYS = ["imageQuality", "videoQuality"];
const DEFAULTS = {
  imageQuality: "1080",
  videoQuality: "1080"
};

/* ================= 保存位置 ================= */

function displayEl(key) {
  return document.getElementById(key + "DirDisplay");
}

async function refreshDirUI(key) {
  const res = await chrome.storage.sync.get([key + "Custom", key + "DirName"]);
  const custom = res[key + "Custom"] === true;
  const reauthBtn = document.getElementById(key + "Reauth");
  const resetBtn = document.getElementById(key + "Reset");
  if (!custom) {
    displayEl(key).textContent = t("opt.dirDefault", {
      path: "ins-download\\" + key + "s"
    });
    reauthBtn.style.display = "none";
    resetBtn.style.display = "none";
    return;
  }
  const name = res[key + "DirName"] || t("opt.pickedFolder");
  // 检查授权状态（浏览器重启后权限会重置，需要重新授权一次）
  let perm = "granted";
  try {
    const handle = await idbGet(key + "DirHandle");
    if (handle) perm = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) { /* ignore */ }
  displayEl(key).textContent =
    t("opt.dirCustom", { name: name }) + (perm === "granted" ? "" : t("opt.needReauth"));
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
    s.textContent = t("opt.saved");
    setTimeout(() => (s.textContent = ""), 1500);
  });
}

/* ================= 微博设置 =================
 * 完全独立于上面的 ins 设置：独立的 storage 键、独立的句柄、独立的默认目录。
 */
const WEIBO_DEFAULT_DIR = {
  image: "weibo-download/images",
  video: "weibo-download/videos"
};
const WEIBO_QUALITY_DEFAULTS = {
  // 默认取原图：微博接口直接给的就是最大档，再降档反而丢画质；
  // orj1080 并不是每张图都有，作为首选项容易 404，所以只作为兜底
  weiboImageQuality: "large",
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
    display.textContent = t("opt.dirDefault", {
      path: WEIBO_DEFAULT_DIR[which].replace(/\//g, "\\")
    });
    reauth.style.display = "none";
    reset.style.display = "none";
    return;
  }

  const name = res[prefix + "DirName"] || t("opt.pickedFolder");
  let perm = "granted";
  try {
    const handle = await idbGet(prefix + "DirHandle");
    if (handle) perm = await handle.queryPermission({ mode: "readwrite" });
  } catch (e) {
    /* ignore */
  }
  display.textContent =
    t("opt.dirCustom", { name: name }) + (perm === "granted" ? "" : t("opt.needReauth"));
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

/* ================= 分栏导航 ================= */

const PANES = ["storage", "display"];

function showPane(name) {
  if (PANES.indexOf(name) < 0) name = "storage";
  document.querySelectorAll(".nav-item").forEach((btn) => {
    const on = btn.dataset.pane === name;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  document.querySelectorAll(".pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === "pane-" + name);
  });
  // 用 hash 记住当前分栏：刷新后回到同一页，也支持 options.html#display 直达
  try {
    history.replaceState(null, "", "#" + name);
  } catch (e) {
    /* file:// 等场景可能不允许 */
  }
}

function initNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showPane(btn.dataset.pane));
  });
  const fromHash = (location.hash || "").replace(/^#/, "");
  showPane(PANES.indexOf(fromHash) >= 0 ? fromHash : "storage");
}

/* ================= 显示语言 ================= */

async function applyLanguage() {
  if (I18N) I18N.applyDom(document);
  document.title = t("opt.docTitle");
  // 目录显示里的「默认 / 自定义 / 需要重新授权」是运行时拼的，重算一遍
  await refreshDirUI("image");
  await refreshDirUI("video");
  await refreshWeiboDirUI("image");
  await refreshWeiboDirUI("video");
}

function initLanguage() {
  const sel = document.getElementById("uiLang");
  if (!sel) return;
  sel.value = I18N ? I18N.getLang() : "zh";
  sel.addEventListener("change", async () => {
    if (I18N) await I18N.setLang(sel.value);
    // 记住语言选择的同时，把 html lang 也改对，便于屏幕阅读器与断词
    document.documentElement.lang = I18N ? I18N.htmlLang() : "zh-CN";
    await applyLanguage();
  });
}

/* ================= 启动 ================= */

function bindButtons() {
  document.getElementById("imagePick").addEventListener("click", () => pickFolder("image"));
  document.getElementById("videoPick").addEventListener("click", () => pickFolder("video"));
  document.getElementById("imageReauth").addEventListener("click", () => pickFolder("image"));
  document.getElementById("videoReauth").addEventListener("click", () => pickFolder("video"));
  document.getElementById("imageReset").addEventListener("click", () => resetFolder("image"));
  document.getElementById("videoReset").addEventListener("click", () => resetFolder("video"));

  document.getElementById("weiboImagePick").addEventListener("click", () => pickWeiboFolder("image"));
  document.getElementById("weiboVideoPick").addEventListener("click", () => pickWeiboFolder("video"));
  document.getElementById("weiboImageReauth").addEventListener("click", () => pickWeiboFolder("image"));
  document.getElementById("weiboVideoReauth").addEventListener("click", () => pickWeiboFolder("video"));
  document.getElementById("weiboImageReset").addEventListener("click", () => resetWeiboFolder("image"));
  document.getElementById("weiboVideoReset").addEventListener("click", () => resetWeiboFolder("video"));

  // 同一个「保存」按钮：两组设置一起落盘（原有的两个监听器行为不变）
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("save").addEventListener("click", saveWeibo);
}

function boot() {
  const verEl = document.getElementById("verText");
  try {
    verEl.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (e) {
    verEl.textContent = "";
  }
  if (I18N) I18N.applyDom(document);
  document.title = t("opt.docTitle");
  document.documentElement.lang = I18N ? I18N.htmlLang() : "zh-CN";
  initNav();
  initLanguage();
  bindButtons();
  restore();
  restoreWeibo();
}

if (I18N && I18N.ready) I18N.ready.then(boot);
else boot();
