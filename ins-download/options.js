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
