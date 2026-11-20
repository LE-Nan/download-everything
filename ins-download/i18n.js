/* download-everything - i18n
 * 扩展自身 UI 的显示语言：中文 / English / 日本語 / 한국어。
 *
 * 用户选择的语言存在 chrome.storage.sync 的 uiLang 键里，没选过时按浏览器语言猜一次
 * （只影响显示，不写存储）。四条链路共用这一份字典：
 *   popup.html / options.html     通过 <script src="i18n.js"> 引入
 *   content.js / weibo.js         manifest 的 content_scripts 里排在它们前面
 *
 * 对外接口（挂在 globalThis.DELi18n，浏览器隔离世界与 Node 测试沙箱都能取到）：
 *   t(key, vars)      取当前语言文案，{name} 占位符用 vars 填充
 *   ready             Promise，语言从存储读出来后 resolve
 *   getLang()         当前语言代码
 *   setLang(code)     写存储并立即在本页生效
 *   applyDom(root)    把 data-i18n / data-i18n-title 的静态文案刷一遍
 *   onChange(fn)      语言变化时回调（content script 用它刷新已注入按钮的 title）
 *
 * 注意：字典里的中文必须与 v2.1.0 的原文案逐字一致，回归测试按原文断言。
 */
(function () {
  const LANGS = [
    { code: "zh", label: "中文" },
    { code: "en", label: "English" },
    { code: "ja", label: "日本語" },
    { code: "ko", label: "한국어" }
  ];
  const DEFAULT_LANG = "zh";

  const STRINGS = {
    zh: {
      "btn.title.ins": "下载（download-everything）",
      "btn.title.weibo": "下载（微博图片/视频）",
      "btn.title.busy": "下载中，点击取消",
      "btn.aria.cancel": "取消下载",
      "toast.canceled": "已取消下载",
      "toast.noMedia": "未找到可下载的媒体地址",
      "toast.noMediaDeep": "未找到可下载的媒体地址（接口与页面解析均未取到）",
      "toast.noResponse": "下载请求没有响应，请重试",
      "toast.dlFailed": "下载失败：{msg}",
      "toast.zipNoResponse": "打包请求没有响应，请重试",
      "toast.zipFailed": "打包下载失败：{msg}",
      "toast.busyOtherIns": "正在下载另一条动态，请稍候",
      "toast.busyOtherWeibo": "正在下载另一条微博，请稍候",
      "toast.parseFailed": "解析失败：{msg}",
      "err.permission": "文件夹授权已失效，请到插件设置页重新授权",
      "err.blockedIns": "Instagram 拒绝了该地址，换一条试试",
      "err.blockedWeibo": "微博拒绝了该地址（403）或已失效，换一张试试",
      "err.allFailed": "全部媒体都下载失败",
      "err.aborted": "已取消",
      "err.unknown": "未知错误",
      "menu.single": "下载单张（当前显示）",
      "menu.allZip": "下载多张（全部 {n} 项，打包 zip）",
      "menu.firstOnly": "只下载第 1 项",
      "menu.allZipWeibo": "全部下载（{n} 项，打包 zip）",

      "site.weibo": "微博",
      "popup.openIg": "打开 Instagram",
      "popup.openWeibo": "打开微博",
      "popup.openOptions": "打开设置",

      "opt.docTitle": "download-everything 设置",
      "opt.brand": "设置",
      "nav.storage": "保存位置",
      "nav.display": "显示设置",
      "opt.igTitleBefore": "Instagram下载设置（",
      "opt.igTitleAfter": "）",
      "opt.wbTitleBefore": "微博下载设置（",
      "opt.wbTitleAfter": "）",
      "opt.wbHint": "以下设置只作用于微博，与上面的 Instagram 设置互不影响",
      "opt.img": "图片下载",
      "opt.video": "视频下载",
      "opt.imgDir": "图片保存位置",
      "opt.videoDir": "视频保存位置",
      "opt.pick": "选择文件夹",
      "opt.reauth": "重新授权",
      "opt.reset": "恢复默认",
      "opt.imgDirHint":
        "点击“选择文件夹”在弹出的系统窗口中挑选任意目录，之后图片静默下载到该目录，不再询问",
      "opt.videoDirHint": "与图片目录独立设置，互不影响",
      "opt.imgQuality": "图片分辨率",
      "opt.imgClarity": "图片清晰度",
      "opt.videoQuality": "视频清晰度",
      "opt.insVideoHint": "视频以 Instagram 实际提供的流为准，会优先匹配所选清晰度",
      "opt.wbImgHint": "微博并非每张图都有 1080 / 690 档，取不到的档位会自动回退到原图",
      "opt.wbVideoHint": "微博接口通常只提供高清/标清两档，以实际返回为准",
      "opt.save": "保存",
      "opt.saved": "已保存",
      "opt.dirDefault": "默认（下载\\{path}）",
      "opt.dirCustom": "自定义：{name}",
      "opt.needReauth": "（需要重新授权）",
      "opt.pickedFolder": "已选择的文件夹",
      "q.orig": "原图（不压缩，推荐）",
      "q.orj1080": "超清（1080P）",
      "q.mw690": "高清（690P）",
      "q.orj360": "标准（360P）",
      "q.hd": "高清",
      "q.sd": "标清",

      "opt.displayTitle": "显示设置",
      "opt.langSection": "语言",
      "opt.langLabel": "界面语言",
      "opt.langHint":
        "切换后立即生效：本页、工具栏弹窗与网页内下载按钮的提示文字会同步更新",
      "opt.version": "版本"
    },

    en: {
      "btn.title.ins": "Download (download-everything)",
      "btn.title.weibo": "Download (Weibo images & videos)",
      "btn.title.busy": "Downloading — click to cancel",
      "btn.aria.cancel": "Cancel download",
      "toast.canceled": "Download canceled",
      "toast.noMedia": "No downloadable media found",
      "toast.noMediaDeep": "No downloadable media found (both API and page parsing failed)",
      "toast.noResponse": "No response from the download request, please retry",
      "toast.dlFailed": "Download failed: {msg}",
      "toast.zipNoResponse": "No response from the packaging request, please retry",
      "toast.zipFailed": "Packaging failed: {msg}",
      "toast.busyOtherIns": "Another post is downloading, please wait",
      "toast.busyOtherWeibo": "Another Weibo post is downloading, please wait",
      "toast.parseFailed": "Parsing failed: {msg}",
      "err.permission": "Folder permission expired, please re-authorize in settings",
      "err.blockedIns": "Instagram rejected this URL, try another one",
      "err.blockedWeibo": "Weibo rejected this URL (403) or it expired, try another one",
      "err.allFailed": "All media failed to download",
      "err.aborted": "Canceled",
      "err.unknown": "Unknown error",
      "menu.single": "Download current item",
      "menu.allZip": "Download all {n} items as zip",
      "menu.firstOnly": "Download the 1st item only",
      "menu.allZipWeibo": "Download all ({n} items, as zip)",

      "site.weibo": "Weibo",
      "popup.openIg": "Open Instagram",
      "popup.openWeibo": "Open Weibo",
      "popup.openOptions": "Open settings",

      "opt.docTitle": "download-everything settings",
      "opt.brand": "Settings",
      "nav.storage": "Save location",
      "nav.display": "Display",
      "opt.igTitleBefore": "Instagram download settings (",
      "opt.igTitleAfter": ")",
      "opt.wbTitleBefore": "Weibo download settings (",
      "opt.wbTitleAfter": ")",
      "opt.wbHint": "These settings apply to Weibo only and are independent of Instagram above",
      "opt.img": "Images",
      "opt.video": "Videos",
      "opt.imgDir": "Image folder",
      "opt.videoDir": "Video folder",
      "opt.pick": "Choose folder",
      "opt.reauth": "Re-authorize",
      "opt.reset": "Reset to default",
      "opt.imgDirHint":
        "Pick any folder in the system dialog. Images are then saved silently without asking again",
      "opt.videoDirHint": "Configured separately from the image folder",
      "opt.imgQuality": "Image resolution",
      "opt.imgClarity": "Image quality",
      "opt.videoQuality": "Video quality",
      "opt.insVideoHint":
        "Based on the streams Instagram actually serves; the closest match is preferred",
      "opt.wbImgHint":
        "Not every Weibo image has 1080 / 690 variants; missing ones fall back to the original",
      "opt.wbVideoHint": "The Weibo API usually offers HD/SD only; the actual response wins",
      "opt.save": "Save",
      "opt.saved": "Saved",
      "opt.dirDefault": "Default (Downloads\\{path})",
      "opt.dirCustom": "Custom: {name}",
      "opt.needReauth": " (re-authorization needed)",
      "opt.pickedFolder": "Selected folder",
      "q.orig": "Original (no compression, recommended)",
      "q.orj1080": "Ultra HD (1080P)",
      "q.mw690": "HD (690P)",
      "q.orj360": "Standard (360P)",
      "q.hd": "HD",
      "q.sd": "SD",

      "opt.displayTitle": "Display",
      "opt.langSection": "Language",
      "opt.langLabel": "Interface language",
      "opt.langHint":
        "Takes effect immediately: this page, the toolbar popup and on-page button tooltips all update",
      "opt.version": "Version"
    },

    ja: {
      "btn.title.ins": "ダウンロード（download-everything）",
      "btn.title.weibo": "ダウンロード（Weibo 画像・動画）",
      "btn.title.busy": "ダウンロード中（クリックでキャンセル）",
      "btn.aria.cancel": "ダウンロードをキャンセル",
      "toast.canceled": "ダウンロードをキャンセルしました",
      "toast.noMedia": "ダウンロード可能なメディアが見つかりません",
      "toast.noMediaDeep":
        "ダウンロード可能なメディアが見つかりません（API とページ解析のどちらも取得できませんでした）",
      "toast.noResponse": "ダウンロード要求に応答がありません。再試行してください",
      "toast.dlFailed": "ダウンロード失敗：{msg}",
      "toast.zipNoResponse": "ZIP 作成要求に応答がありません。再試行してください",
      "toast.zipFailed": "ZIP 作成に失敗：{msg}",
      "toast.busyOtherIns": "別の投稿をダウンロード中です。しばらくお待ちください",
      "toast.busyOtherWeibo": "別の Weibo 投稿をダウンロード中です。しばらくお待ちください",
      "toast.parseFailed": "解析に失敗：{msg}",
      "err.permission": "フォルダの権限が失効しました。設定ページで再認証してください",
      "err.blockedIns": "Instagram がこの URL を拒否しました。別のものを試してください",
      "err.blockedWeibo": "Weibo がこの URL を拒否しました（403）、または失効しています",
      "err.allFailed": "すべてのメディアのダウンロードに失敗しました",
      "err.aborted": "キャンセルしました",
      "err.unknown": "不明なエラー",
      "menu.single": "現在の項目をダウンロード",
      "menu.allZip": "すべてダウンロード（{n} 件、ZIP）",
      "menu.firstOnly": "1 件目のみダウンロード",
      "menu.allZipWeibo": "すべてダウンロード（{n} 件、ZIP 圧縮）",

      "site.weibo": "Weibo",
      "popup.openIg": "Instagram を開く",
      "popup.openWeibo": "Weibo を開く",
      "popup.openOptions": "設定を開く",

      "opt.docTitle": "download-everything 設定",
      "opt.brand": "設定",
      "nav.storage": "保存先",
      "nav.display": "表示設定",
      "opt.igTitleBefore": "Instagram ダウンロード設定（",
      "opt.igTitleAfter": "）",
      "opt.wbTitleBefore": "Weibo ダウンロード設定（",
      "opt.wbTitleAfter": "）",
      "opt.wbHint": "以下の設定は Weibo のみに適用され、上の Instagram 設定とは独立しています",
      "opt.img": "画像",
      "opt.video": "動画",
      "opt.imgDir": "画像の保存先",
      "opt.videoDir": "動画の保存先",
      "opt.pick": "フォルダを選択",
      "opt.reauth": "再認証",
      "opt.reset": "既定に戻す",
      "opt.imgDirHint":
        "「フォルダを選択」から任意のフォルダを指定すると、以降は確認なしで保存されます",
      "opt.videoDirHint": "画像フォルダとは独立して設定されます",
      "opt.imgQuality": "画像の解像度",
      "opt.imgClarity": "画像の画質",
      "opt.videoQuality": "動画の画質",
      "opt.insVideoHint":
        "動画は Instagram が実際に配信するストリームに依存し、選択した画質に最も近いものを優先します",
      "opt.wbImgHint":
        "Weibo の画像がすべて 1080 / 690 の画質を持つわけではなく、無い場合は原図に戻ります",
      "opt.wbVideoHint": "Weibo API は通常 HD/SD の 2 段のみです。実際の応答が優先されます",
      "opt.save": "保存",
      "opt.saved": "保存しました",
      "opt.dirDefault": "既定（ダウンロード\\{path}）",
      "opt.dirCustom": "カスタム：{name}",
      "opt.needReauth": "（再認証が必要）",
      "opt.pickedFolder": "選択済みのフォルダ",
      "q.orig": "原図（圧縮なし・推奨）",
      "q.orj1080": "超高画質（1080P）",
      "q.mw690": "高画質（690P）",
      "q.orj360": "標準（360P）",
      "q.hd": "HD",
      "q.sd": "SD",

      "opt.displayTitle": "表示設定",
      "opt.langSection": "言語",
      "opt.langLabel": "表示言語",
      "opt.langHint":
        "すぐに反映されます。このページ、ツールバーのポップアップ、ページ内ボタンのツールチップが同時に更新されます",
      "opt.version": "バージョン"
    },

    ko: {
      "btn.title.ins": "다운로드(download-everything)",
      "btn.title.weibo": "다운로드(웨이보 이미지·동영상)",
      "btn.title.busy": "다운로드 중 — 클릭하여 취소",
      "btn.aria.cancel": "다운로드 취소",
      "toast.canceled": "다운로드를 취소했습니다",
      "toast.noMedia": "다운로드할 미디어를 찾지 못했습니다",
      "toast.noMediaDeep": "다운로드할 미디어를 찾지 못했습니다(API와 페이지 분석 모두 실패)",
      "toast.noResponse": "다운로드 요청에 응답이 없습니다. 다시 시도하세요",
      "toast.dlFailed": "다운로드 실패: {msg}",
      "toast.zipNoResponse": "압축 요청에 응답이 없습니다. 다시 시도하세요",
      "toast.zipFailed": "압축 다운로드 실패: {msg}",
      "toast.busyOtherIns": "다른 게시물을 다운로드 중입니다. 잠시 기다려 주세요",
      "toast.busyOtherWeibo": "다른 웨이보 게시물을 다운로드 중입니다. 잠시 기다려 주세요",
      "toast.parseFailed": "분석 실패: {msg}",
      "err.permission": "폴더 권한이 만료되었습니다. 설정 페이지에서 다시 승인하세요",
      "err.blockedIns": "Instagram이 이 주소를 거부했습니다. 다른 항목을 시도하세요",
      "err.blockedWeibo": "웨이보가 이 주소를 거부했거나(403) 만료되었습니다",
      "err.allFailed": "모든 미디어 다운로드에 실패했습니다",
      "err.aborted": "취소됨",
      "err.unknown": "알 수 없는 오류",
      "menu.single": "현재 항목 다운로드",
      "menu.allZip": "전체 다운로드({n}개, ZIP)",
      "menu.firstOnly": "1번째 항목만 다운로드",
      "menu.allZipWeibo": "전체 다운로드({n}개, ZIP 압축)",

      "site.weibo": "웨이보",
      "popup.openIg": "Instagram 열기",
      "popup.openWeibo": "웨이보 열기",
      "popup.openOptions": "설정 열기",

      "opt.docTitle": "download-everything 설정",
      "opt.brand": "설정",
      "nav.storage": "저장 위치",
      "nav.display": "표시 설정",
      "opt.igTitleBefore": "Instagram 다운로드 설정(",
      "opt.igTitleAfter": ")",
      "opt.wbTitleBefore": "웨이보 다운로드 설정(",
      "opt.wbTitleAfter": ")",
      "opt.wbHint": "아래 설정은 웨이보에만 적용되며 위의 Instagram 설정과 별개입니다",
      "opt.img": "이미지",
      "opt.video": "동영상",
      "opt.imgDir": "이미지 저장 위치",
      "opt.videoDir": "동영상 저장 위치",
      "opt.pick": "폴더 선택",
      "opt.reauth": "다시 승인",
      "opt.reset": "기본값으로",
      "opt.imgDirHint":
        "「폴더 선택」에서 원하는 폴더를 지정하면 이후에는 묻지 않고 저장됩니다",
      "opt.videoDirHint": "이미지 폴더와 별도로 설정됩니다",
      "opt.imgQuality": "이미지 해상도",
      "opt.imgClarity": "이미지 화질",
      "opt.videoQuality": "동영상 화질",
      "opt.insVideoHint":
        "동영상은 Instagram이 실제로 제공하는 스트림을 기준으로 하며 선택한 화질에 가장 가까운 것을 우선합니다",
      "opt.wbImgHint":
        "웨이보 이미지가 모두 1080 / 690 화질을 가진 것은 아니며, 없으면 원본으로 대체됩니다",
      "opt.wbVideoHint": "웨이보 API는 보통 HD/SD 두 단계만 제공하며 실제 응답을 따릅니다",
      "opt.save": "저장",
      "opt.saved": "저장됨",
      "opt.dirDefault": "기본(다운로드\\{path})",
      "opt.dirCustom": "사용자 지정: {name}",
      "opt.needReauth": "(다시 승인 필요)",
      "opt.pickedFolder": "선택한 폴더",
      "q.orig": "원본(압축 없음, 권장)",
      "q.orj1080": "초고화질(1080P)",
      "q.mw690": "고화질(690P)",
      "q.orj360": "표준(360P)",
      "q.hd": "HD",
      "q.sd": "SD",

      "opt.displayTitle": "표시 설정",
      "opt.langSection": "언어",
      "opt.langLabel": "표시 언어",
      "opt.langHint":
        "즉시 적용됩니다. 이 페이지, 툴바 팝업, 페이지 내 버튼 툴팁이 함께 갱신됩니다",
      "opt.version": "버전"
    }
  };

  function isSupported(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(STRINGS, code);
  }

  // 没设置过时按浏览器语言猜：zh* → 中文，ja / ko 各自命中，其余给英文
  function guessLang() {
    try {
      const nav = typeof navigator !== "undefined" ? navigator : null;
      const raw = (nav && (nav.language || (nav.languages && nav.languages[0]))) || "";
      const code = String(raw).toLowerCase();
      if (code.indexOf("zh") === 0) return "zh";
      if (code.indexOf("ja") === 0) return "ja";
      if (code.indexOf("ko") === 0) return "ko";
      if (code) return "en";
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_LANG;
  }

  let lang = DEFAULT_LANG;
  const listeners = [];

  function format(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) =>
      vars[k] === undefined ? m : String(vars[k])
    );
  }

  function t(key, vars) {
    const table = STRINGS[lang] || STRINGS[DEFAULT_LANG];
    let text = table[key];
    if (text === undefined) text = STRINGS[DEFAULT_LANG][key];
    if (text === undefined) return key;
    return format(text, vars);
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn(lang);
      } catch (e) {
        /* 单个回调失败不影响其他 */
      }
    }
  }

  function readLang(cb) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(["uiLang"], (res) => {
          const v = res && res.uiLang;
          cb(isSupported(v) ? v : guessLang());
        });
        return;
      }
    } catch (e) {
      /* ignore */
    }
    cb(guessLang());
  }

  let resolveReady;
  const ready = new Promise((res) => (resolveReady = res));
  readLang((code) => {
    lang = code;
    resolveReady(lang);
  });

  // 语言在别处被改（另一个设置页 / 扩展同步）：本页立即跟着换，已注入的按钮也刷新
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync" || !changes.uiLang) return;
        const next = changes.uiLang.newValue;
        if (!isSupported(next) || next === lang) return;
        lang = next;
        notify();
      });
    }
  } catch (e) {
    /* ignore */
  }

  function setLang(code) {
    if (!isSupported(code)) return Promise.resolve(lang);
    const changed = code !== lang;
    lang = code;
    try {
      chrome.storage.sync.set({ uiLang: code });
    } catch (e) {
      /* ignore */
    }
    if (changed) notify();
    return Promise.resolve(lang);
  }

  function applyDom(root) {
    try {
      const scope = root || (typeof document !== "undefined" ? document : null);
      if (!scope || !scope.querySelectorAll) return;
      scope.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.getAttribute("data-i18n"));
      });
      scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.title = t(el.getAttribute("data-i18n-title"));
      });
    } catch (e) {
      /* ignore */
    }
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  const api = {
    t,
    ready,
    getLang: () => lang,
    // <html lang> 用：中文给 zh-CN，其余与语言代码一致
    htmlLang: () => (lang === "zh" ? "zh-CN" : lang),
    setLang,
    applyDom,
    onChange,
    langs: LANGS,
    supported: LANGS.map((l) => l.code),
    isSupported
  };

  try {
    globalThis.DELi18n = api;
    if (typeof window !== "undefined") window.DELi18n = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
  } catch (e) {
    /* ignore */
  }
})();
