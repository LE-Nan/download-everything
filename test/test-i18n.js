/* 回归测试：加载 i18n.js，验证四语字典的完整性与切换行为
 * 运行：node test/test-i18n.js
 *
 * 重点不是「翻译对不对」（那是人看的），而是「四个语言是否齐全」：
 * 少一个键，界面上就会露出 key 原文或悄悄回落中文，这类问题只有对比键集才抓得住。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "ins-download", "i18n.js"), "utf8");

let saved = null;
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  chrome: {
    storage: {
      sync: {
        get: (keys, cb) => cb({}),
        set: (data, cb) => {
          saved = data;
          if (cb) cb();
        }
      },
      onChanged: { addListener() {} }
    }
  }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "i18n.js" });

const api = sandbox.DELi18n;
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + " — 期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));
  }
}

function checkTrue(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

(async () => {
  console.log("== 1. 默认语言与基础取值 ==");
  await api.ready;
  check("沙箱里没有 uiLang，回落默认中文", api.getLang(), "zh");
  check("按 key 取中文文案", api.t("btn.title.busy"), "下载中，点击取消");
  check("未知 key 原样返回", api.t("no.such.key"), "no.such.key");
  check("html lang 中文给 zh-CN", api.htmlLang(), "zh-CN");

  console.log("== 2. 占位符替换 ==");
  check(
    "单占位符",
    api.t("toast.dlFailed", { msg: "网络错误" }),
    "下载失败：网络错误"
  );
  check("数字占位符", api.t("menu.allZip", { n: 3 }), "下载多张（全部 3 项，打包 zip）");
  check("变量缺省时保留原样", api.t("menu.allZip"), "下载多张（全部 {n} 项，打包 zip）");

  console.log("== 3. 四语语言表 ==");
  const langs = api.supported;
  check("支持四种语言", langs.join(","), "zh,en,ja,ko");
  check("语言名用各自母语书写", api.langs.map((l) => l.label).join("|"), "中文|English|日本語|한국어");
  for (const code of langs) {
    await api.setLang(code);
    check("可以切换到 " + code, api.getLang(), code);
  }
  await api.setLang("zh");

  console.log("== 4. 每种语言都覆盖全部中文键 ==");
  // 中文键集：用一个「几乎必然存在」的探测器反向确认——逐个键在每种语言下都不该等于键名
  const probe = [
    "btn.title.ins", "btn.title.weibo", "btn.title.busy", "btn.aria.cancel",
    "toast.canceled", "toast.noMedia", "toast.noMediaDeep", "toast.noResponse",
    "toast.dlFailed", "toast.zipNoResponse", "toast.zipFailed", "toast.busyOtherIns",
    "toast.busyOtherWeibo", "toast.parseFailed",
    "err.permission", "err.blockedIns", "err.blockedWeibo", "err.allFailed",
    "err.aborted", "err.unknown",
    "menu.single", "menu.allZip", "menu.firstOnly", "menu.allZipWeibo",
    "btn.title.twitter", "toast.busyOtherTwitter", "err.blockedTwitter", "menu.allZipX",
    "site.twitter", "popup.openX",
    "opt.twTitleBefore", "opt.twTitleAfter", "opt.twHint", "opt.twImgHint", "opt.twVideoHint",
    "site.weibo", "popup.openIg", "popup.openWeibo", "popup.openOptions",
    "opt.docTitle", "opt.brand", "nav.storage", "nav.display",
    "opt.igTitleBefore", "opt.igTitleAfter", "opt.wbTitleBefore", "opt.wbTitleAfter",
    "opt.wbHint", "opt.img", "opt.video", "opt.imgDir", "opt.videoDir",
    "opt.pick", "opt.reauth", "opt.reset", "opt.imgDirHint", "opt.videoDirHint",
    "opt.imgQuality", "opt.imgClarity", "opt.videoQuality", "opt.insImgHint", "opt.insVideoHint",
    "opt.wbImgHint", "opt.wbVideoHint", "opt.save", "opt.saved",
    "opt.dirDefault", "opt.dirCustom", "opt.needReauth", "opt.pickedFolder",
    "q.orig",
    "q.vOrig", "q.v480", "q.v720", "q.v1080", "q.v2k",
    "opt.displayTitle", "opt.langSection", "opt.langLabel", "opt.langHint", "opt.version"
  ];
  for (const code of langs) {
    await api.setLang(code);
    const missing = probe.filter((k) => api.t(k) === k);
    checkTrue(code + " 无缺失键", missing.length === 0, "缺：" + missing.join(", "));
    const empty = probe.filter((k) => !String(api.t(k)).trim());
    checkTrue(code + " 无空文案", empty.length === 0, "空：" + empty.join(", "));
  }

  console.log("== 5. 占位符在每种语言里都保留 ==");
  for (const code of langs) {
    await api.setLang(code);
    checkTrue(
      code + " dlFailed 含 {msg}",
      api.t("toast.dlFailed").indexOf("{msg}") > 0,
      api.t("toast.dlFailed")
    );
    checkTrue(
      code + " allZip 含 {n}",
      api.t("menu.allZip").indexOf("{n}") > 0,
      api.t("menu.allZip")
    );
    checkTrue(
      code + " dirCustom 含 {name}",
      api.t("opt.dirCustom").indexOf("{name}") > 0,
      api.t("opt.dirCustom")
    );
    checkTrue(
      code + " dirDefault 含 {path}",
      api.t("opt.dirDefault").indexOf("{path}") > 0,
      api.t("opt.dirDefault")
    );
  }

  console.log("== 6. 切换语言会写存储 ==");
  await api.setLang("ko");
  check("写进 uiLang", saved && saved.uiLang, "ko");
  check("切换到韩语后取值变化", api.t("menu.single"), "현재 항목 다운로드");
  check("html lang 跟随", api.htmlLang(), "ko");
  await api.setLang("zh-CN");
  check("不支持的语言码被忽略", api.getLang(), "ko");
  await api.setLang("zh");

  console.log("== 7. onChange 通知 ==");
  let notified = 0;
  api.onChange(() => notified++);
  await api.setLang("en");
  check("语言真正变化时通知一次", notified, 1);
  await api.setLang("en");
  check("相同语言不重复通知", notified, 1);
  await api.setLang("zh");

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
