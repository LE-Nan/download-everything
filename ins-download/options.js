/* download-everything - 设置页
 * 左侧导航 + 两个分栏：保存位置（下载目录与清晰度）/ 显示设置（界面语言）。
 * 所有 storage 键与 v2.1.0 完全一致，只换了展示层与分栏结构。
 */
const I18N = globalThis.DELi18n || null;
function t(key, vars) {
  return I18N ? I18N.t(key, vars) : key;
}

const QUALITY_KEYS = ["imageQuality", "videoQuality"];
// 默认都取「原图 / 原画质」：不主动降档，也不猜站点有多少档
const DEFAULTS = {
  imageQuality: "orig",
  videoQuality: "orig"
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

/* 老版本存下的值可能已经不在选项里了（视频从 hd/sd、240/4k 改成了 480P~2K 加原画质）。
 * 直接赋给 select 会变成「一项都没选中」的空白框，所以先按迁移表落一档，
 * 迁移表也没有的才回落到默认值。 */
const LEGACY_QUALITY = {
  videoQuality: { "240": "480", "4k": "2k" },
  weiboVideoQuality: { hd: "orig", sd: "480" },
  twitterVideoQuality: { hd: "orig", sd: "480" },
  // 图片分辨率：三个站点现在共用 ins 那套档位，老值（微博的尺寸标记、
  // X 的 name 档）按实际宽度折算到最近的档，避免下拉框空白
  weiboImageQuality: {
    large: "orig",
    oslarge: "orig",
    original: "orig",
    mw2000: "2k",
    orj1080: "1080",
    mw1024: "720",
    mw690: "720",
    orj480: "480",
    orj360: "240"
  },
  twitterImageQuality: {
    "4096x4096": "4k",
    4096: "4k",
    2048: "2k",
    large: "2k",
    medium: "720",
    1200: "720",
    small: "240",
    680: "240"
  }
};

function setQualityValue(el, value, fallback) {
  const known = (v) => v !== undefined && v !== null && !!el.querySelector('option[value="' + v + '"]');
  let v = value;
  if (!known(v)) {
    const map = LEGACY_QUALITY[el.id] || {};
    v = map[value];
    if (!known(v)) v = fallback;
  }
  el.value = v;
}

async function restore() {
  const res = await chrome.storage.sync.get(QUALITY_KEYS);
  for (const k of QUALITY_KEYS) {
    setQualityValue(document.getElementById(k), res[k], DEFAULTS[k]);
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

/* ================= 站点独立设置（微博 / X） =================
 * 每个站点一份完全独立的 storage 键、独立句柄、独立默认目录与清晰度默认值，
 * 版式与交互一致，所以用同一套函数按 prefix 驱动；元素 id 一律是
 * `<prefix>Pick` / `<prefix>Reauth` / `<prefix>Reset` / `<prefix>DirDisplay`。
 * ins 沿用上面那套独立实现（键名与历史行为都没有变）。
 */
const SITE_SECTIONS = [
  {
    name: "weibo",
    dirs: { image: "weibo-download/images", video: "weibo-download/videos" },
    prefix: { image: "weiboImage", video: "weiboVideo" },
    // 默认取原图：接口直接给的就是最大档，orj1080 并非每张图都有
    quality: { weiboImageQuality: "orig", weiboVideoQuality: "orig" }
  },
  {
    name: "twitter",
    dirs: { image: "twitter-download/images", video: "twitter-download/videos" },
    prefix: { image: "twitterImage", video: "twitterVideo" },
    // X 默认取上传原图（orig）与原画质
    quality: { twitterImageQuality: "orig", twitterVideoQuality: "orig" }
  }
];

function siteOf(name) {
  for (const s of SITE_SECTIONS) if (s.name === name) return s;
  return null;
}

async function refreshSiteDirUI(site, which) {
  const prefix = site.prefix[which];
  const res = await chrome.storage.sync.get([prefix + "Custom", prefix + "DirName"]);
  const display = document.getElementById(prefix + "DirDisplay");
  const reauth = document.getElementById(prefix + "Reauth");
  const reset = document.getElementById(prefix + "Reset");
  if (!display) return;

  if (res[prefix + "Custom"] !== true) {
    display.textContent = t("opt.dirDefault", {
      path: site.dirs[which].replace(/\//g, "\\")
    });
    reauth.style.display = "none";
    reset.style.display = "none";
    return;
  }

  const name = res[prefix + "DirName"] || t("opt.pickedFolder");
  // 浏览器重启后权限会重置，需要重新授权一次
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

async function pickSiteFolder(site, which) {
  const prefix = site.prefix[which];
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet(prefix + "DirHandle", handle);
    await chrome.storage.sync.set({
      [prefix + "Custom"]: true,
      [prefix + "DirName"]: handle.name
    });
    await refreshSiteDirUI(site, which);
  } catch (e) {
    // 用户取消选择
  }
}

async function resetSiteFolder(site, which) {
  const prefix = site.prefix[which];
  await idbDel(prefix + "DirHandle");
  await chrome.storage.sync.set({ [prefix + "Custom"]: false });
  await refreshSiteDirUI(site, which);
}

async function restoreSite(site) {
  const res = await chrome.storage.sync.get(Object.keys(site.quality));
  for (const k in site.quality) {
    const el = document.getElementById(k);
    if (el) setQualityValue(el, res[k], site.quality[k]);
  }
  await refreshSiteDirUI(site, "image");
  await refreshSiteDirUI(site, "video");
}

function saveSite(site) {
  const data = {};
  for (const k in site.quality) {
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
  for (const site of SITE_SECTIONS) {
    await refreshSiteDirUI(site, "image");
    await refreshSiteDirUI(site, "video");
  }
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

  document.getElementById("weiboImagePick").addEventListener("click", () => pickSiteFolder(siteOf("weibo"), "image"));
  document.getElementById("weiboVideoPick").addEventListener("click", () => pickSiteFolder(siteOf("weibo"), "video"));
  document.getElementById("weiboImageReauth").addEventListener("click", () => pickSiteFolder(siteOf("weibo"), "image"));
  document.getElementById("weiboVideoReauth").addEventListener("click", () => pickSiteFolder(siteOf("weibo"), "video"));
  document.getElementById("weiboImageReset").addEventListener("click", () => resetSiteFolder(siteOf("weibo"), "image"));
  document.getElementById("weiboVideoReset").addEventListener("click", () => resetSiteFolder(siteOf("weibo"), "video"));

  document.getElementById("twitterImagePick").addEventListener("click", () => pickSiteFolder(siteOf("twitter"), "image"));
  document.getElementById("twitterVideoPick").addEventListener("click", () => pickSiteFolder(siteOf("twitter"), "video"));
  document.getElementById("twitterImageReauth").addEventListener("click", () => pickSiteFolder(siteOf("twitter"), "image"));
  document.getElementById("twitterVideoReauth").addEventListener("click", () => pickSiteFolder(siteOf("twitter"), "video"));
  document.getElementById("twitterImageReset").addEventListener("click", () => resetSiteFolder(siteOf("twitter"), "image"));
  document.getElementById("twitterVideoReset").addEventListener("click", () => resetSiteFolder(siteOf("twitter"), "video"));

  // 同一个「保存」按钮：所有站点的设置一起落盘
  document.getElementById("save").addEventListener("click", save);
  for (const site of SITE_SECTIONS) {
    document.getElementById("save").addEventListener("click", () => saveSite(site));
  }
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
  for (const site of SITE_SECTIONS) restoreSite(site);
}

if (I18N && I18N.ready) I18N.ready.then(boot);
else boot();
