/* 回归测试：加载 content.js（Instagram），验证进度环 / 取消状态机
 * 运行：node test/test-content.js
 *
 * 只测「按钮状态机」这一层：进度环百分比、按钮形态（下载 ↔ 停止）、取消后的
 * 静默收尾、取消凭据的记账。取址逻辑依赖真实页面，不在这里覆盖。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "ins-download", "content.js"), "utf8");
// 界面文案由 i18n.js 提供（manifest 里排在内容脚本之前），沙箱里也要先加载
const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "ins-download", "i18n.js"), "utf8");

// ---- 最小环境桩：class / style / title 要能记账，否则测不出状态切换 ----
function stubEl(tag) {
  const cls = new Set();
  const styleProps = {};
  const attrs = {};
  return {
    tagName: String(tag || "div").toUpperCase(),
    title: "",
    textContent: "",
    innerHTML: "",
    style: {
      setProperty: (k, v) => {
        styleProps[k] = v;
      },
      removeProperty: (k) => {
        delete styleProps[k];
      },
      getPropertyValue: (k) => (k in styleProps ? styleProps[k] : "")
    },
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c)
    },
    addEventListener() {},
    remove() {},
    appendChild() {},
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => {
      delete attrs[k];
    },
    hasAttribute: (k) => k in attrs,
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

const toasts = [];
const sent = [];
let onRuntimeMessage = null;

const documentStub = {
  documentElement: stubEl("html"),
  body: {
    appendChild: (el) => {
      if (el && el.className && String(el.className).indexOf("ins-dl-toast") === 0) toasts.push(el);
    }
  },
  createElement: (tag) => stubEl(tag),
  querySelectorAll: () => [],
  addEventListener() {}
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => fn(),
  document: documentStub,
  window: { addEventListener() {}, innerHeight: 900, innerWidth: 1400 },
  MutationObserver: class {
    observe() {}
  },
  fetch: async () => {
    throw new Error("offline");
  },
  chrome: {
    storage: {
      sync: { get: (keys, cb) => cb({}) },
      onChanged: { addListener() {} }
    },
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          onRuntimeMessage = fn;
        }
      },
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (cb) cb({ ok: true });
      }
    }
  }
};
sandbox.window.__insDl = undefined;

vm.createContext(sandbox);
vm.runInContext(i18nSrc, sandbox, { filename: "i18n.js" });
vm.runInContext(src, sandbox, { filename: "content.js" });

const tick = () => new Promise((r) => setTimeout(r, 0));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log("  PASS", name);
  } else {
    fail++;
    console.log("  FAIL", name, "\n    实际:", JSON.stringify(actual), "\n    期望:", JSON.stringify(expected));
  }
}

const api = sandbox.window.__insDl;

(async () => {
  console.log("== 1. 按钮初始形态 ==");
  check("暴露了诊断入口", !!api, true);
  const btn = api._makeBtn();
  check("初始 title 是下载", btn.title, "下载（download-everything）");
  check(
    "同时带下载与停止两个图标",
    btn.innerHTML.indexOf("ins-dl-ico-dl") > 0 && btn.innerHTML.indexOf("ins-dl-ico-stop") > 0,
    true
  );
  check("初始没有进度态 class", btn.classList.contains("ins-dl-progress"), false);

  console.log("== 2. 进度环：解析阶段按时间爬升，最多到 12% ==");
  api._startRing(btn, "ig-t1");
  check("进入进度态", btn.classList.contains("ins-dl-progress"), true);
  check("title 变成点击取消", btn.title, "下载中，点击取消");
  check("aria-label 提示取消", btn.getAttribute("aria-label"), "取消下载");
  check("起始百分比写入 CSS 变量", btn.style.getPropertyValue("--ins-dl-p"), "2.0");
  const p0 = Number(btn.style.getPropertyValue("--ins-dl-p"));
  await new Promise((r) => setTimeout(r, 600));
  const p1 = Number(btn.style.getPropertyValue("--ins-dl-p"));
  check("等待后百分比上升", p1 > p0, true);
  check("解析阶段不超过 12%", p1 <= 12, true);

  console.log("== 3. 真实字节进度：按 loaded/total 走，封顶 98 ==");
  onRuntimeMessage({ type: "wb-dl-progress", id: "ig-t1", phase: "fetch", loaded: 50, total: 100 });
  check("按字节比例更新", btn.style.getPropertyValue("--ins-dl-p"), "50.0");
  onRuntimeMessage({ type: "wb-dl-progress", id: "ig-t1", phase: "fetch", loaded: 100, total: 100 });
  check("100% 字节也只画到 98（留 100 给保存框）", btn.style.getPropertyValue("--ins-dl-p"), "98.0");
  onRuntimeMessage({ type: "wb-dl-progress", id: "ig-t1", phase: "save" });
  check("字节取完填满 100", btn.style.getPropertyValue("--ins-dl-p"), "100.0");

  console.log("== 4. 收尾：环清空、按钮复位 ==");
  api._endRing("ig-t1");
  check("退出进度态", btn.classList.contains("ins-dl-progress"), false);
  check("百分比变量被移除", btn.style.getPropertyValue("--ins-dl-p"), "");
  check("title 复位", btn.title, "下载（download-everything）");
  check("aria-label 被移除", btn.getAttribute("aria-label"), null);
  check("ring 状态清空", api.ring().pid, null);

  console.log("== 5. 取消：立刻收环 + 通知后台 + 中性提示 ==");
  const btn2 = api._makeBtn();
  api._startRing(btn2, "ig-t2");
  toasts.length = 0;
  sent.length = 0;
  api._cancelActive(btn2);
  check("环立刻收掉（不等后台确认）", btn2.classList.contains("ins-dl-progress"), false);
  check("闪一下取消色", btn2.classList.contains("ins-dl-canceled"), true);
  check("后台收到取消指令", sent.map((m) => m.action), ["cancel"]);
  check("取消带的是当前 progressId", sent[0].progressId, "ig-t2");
  check("提示是中性文案", toasts.length && toasts[0].textContent, "已取消下载");
  check("提示条用 info 样式", toasts.length && toasts[0].className, "ins-dl-toast ins-dl-toast-info");
  check("取消凭据已记账", api._isCanceled("ig-t2"), true);
  check("别的 pid 不受影响", api._isCanceled("ig-other"), false);

  console.log("== 6. 取消之后的迟到进度不再画环 ==");
  onRuntimeMessage({ type: "wb-dl-progress", id: "ig-t2", phase: "fetch", loaded: 10, total: 10 });
  check("不会把环重新画出来", btn2.classList.contains("ins-dl-progress"), false);
  check("没有 pid 时不更新百分比", btn2.style.getPropertyValue("--ins-dl-p"), "");

  console.log("== 7. 取消后再开新任务：状态干净 ==");
  const btn3 = api._makeBtn();
  api._startRing(btn3, "ig-t3");
  check("新任务重新进入进度态", btn3.classList.contains("ins-dl-progress"), true);
  check("当前 pid 是新任务的", api.ring().pid, "ig-t3");
  api._endRing("ig-t3");

  console.log("== 8. 选档：按设置取档，源最高档更低时取源最高档 ==");
  const img = (resources) => ({ type: "image", url: "fallback.jpg", resources });
  const vid = (resources) => ({ type: "video", url: "fallback.mp4", resources });

  check(
    "默认原图 → 图片取源最高档",
    api._resolveUrl(img([{ url: "w640.jpg", w: 640 }, { url: "w1080.jpg", w: 1080 }])),
    "w1080.jpg"
  );
  check(
    "默认原画质 → 视频取源最高档（源最高只有 720）",
    api._resolveUrl(vid([{ url: "w480.mp4", w: 480 }, { url: "w720.mp4", w: 720 }])),
    "w720.mp4"
  );
  check(
    "源只有一档时就用它",
    api._resolveUrl(img([{ url: "w240.jpg", w: 240 }])),
    "w240.jpg"
  );
  check("没有候选表时用原始地址", api._resolveUrl({ type: "image", url: "only.jpg" }), "only.jpg");

  // 视频清晰度按设置页标注的技术标准取档（原画质 = Infinity，已在上面覆盖）
  const live = api._settings;
  live.videoQuality = "480";
  check(
    "设置标清 480 → 取不低于 480 的最小一档",
    api._resolveUrl(vid([{ url: "w360.mp4", w: 360 }, { url: "w480.mp4", w: 480 }, { url: "w720.mp4", w: 720 }])),
    "w480.mp4"
  );
  live.videoQuality = "1080";
  check(
    "设置超清 1080 → 取 1080 档（不擅自降到 720）",
    api._resolveUrl(vid([{ url: "w480.mp4", w: 480 }, { url: "w720.mp4", w: 720 }, { url: "w1080.mp4", w: 1080 }])),
    "w1080.mp4"
  );
  live.videoQuality = "orig";
  live.imageQuality = "720";
  check(
    "图片设置 720 → 取不低于 720 的最小一档",
    api._resolveUrl(img([{ url: "w640.jpg", w: 640 }, { url: "w750.jpg", w: 750 }, { url: "w1080.jpg", w: 1080 }])),
    "w750.jpg"
  );
  live.imageQuality = "orig";
  check(
    "srcset：设置高于源最高档（2160 > 1080）时取最大那张",
    api._pickFromSrcset("s640.jpg 640w, l1080.jpg 1080w", 2160),
    "l1080.jpg"
  );
  check(
    "srcset：原图（Infinity）取最大那张",
    api._pickFromSrcset("s640.jpg 640w, l1080.jpg 1080w", Infinity),
    "l1080.jpg"
  );
  check(
    "srcset：设置低于源时按设置取最近的档（不下取到最小）",
    api._pickFromSrcset("s640.jpg 640w, l1080.jpg 1080w", 320),
    "s640.jpg"
  );

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
