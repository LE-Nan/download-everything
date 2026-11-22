/* 弹窗：三个站点开关 + 设置入口。
 * 文案全部走 i18n.js，按用户在「显示设置」里选的界面语言渲染。
 */
const I18N = globalThis.DELi18n || null;

function whenLangReady(fn) {
  if (I18N && I18N.ready) I18N.ready.then(fn);
  else fn();
}

whenLangReady(() => {
  if (I18N) {
    I18N.applyDom(document);
    document.documentElement.lang = I18N.htmlLang();
  }

  const toggle = document.getElementById("enabled");
  chrome.storage.sync.get(["enabled"], (res) => {
    toggle.checked = res.enabled !== false;
  });
  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: toggle.checked });
  });

  // 微博开关（独立键 weiboEnabled，不复用也不改动上面的 enabled）
  const weiboToggle = document.getElementById("weiboEnabled");
  if (weiboToggle) {
    chrome.storage.sync.get(["weiboEnabled"], (res) => {
      weiboToggle.checked = res.weiboEnabled !== false;
    });
    weiboToggle.addEventListener("change", () => {
      chrome.storage.sync.set({ weiboEnabled: weiboToggle.checked });
    });
  }

  // X（推特）开关：同样是独立键 twitterEnabled
  const twitterToggle = document.getElementById("twitterEnabled");
  if (twitterToggle) {
    chrome.storage.sync.get(["twitterEnabled"], (res) => {
      twitterToggle.checked = res.twitterEnabled !== false;
    });
    twitterToggle.addEventListener("change", () => {
      chrome.storage.sync.set({ twitterEnabled: twitterToggle.checked });
    });
  }

  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
