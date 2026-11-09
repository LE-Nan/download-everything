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
