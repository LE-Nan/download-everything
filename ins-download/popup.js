document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("enabled");
  chrome.storage.sync.get(["enabled"], (res) => {
    toggle.checked = res.enabled !== false;
  });
  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: toggle.checked });
  });
  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});

// 微博开关（独立键 weiboEnabled，不复用也不改动上面的 enabled）
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("weiboEnabled");
  if (!toggle) return;
  chrome.storage.sync.get(["weiboEnabled"], (res) => {
    toggle.checked = res.weiboEnabled !== false;
  });
  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ weiboEnabled: toggle.checked });
  });
});
