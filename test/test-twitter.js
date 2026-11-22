/* 回归测试：加载 twitter.js，验证推文 id 取值 / 图片换档 / 视频码率排序 /
 * 实体归一化 / 卡片定位 / 进度环与取消状态机
 * 运行：node test/test-twitter.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = path.join(__dirname, "..", "ins-download");
const src = fs.readFileSync(path.join(dir, "twitter.js"), "utf8");
// 界面文案由 i18n.js 提供（manifest 里排在内容脚本之前），沙箱里也要先加载
const i18nSrc = fs.readFileSync(path.join(dir, "i18n.js"), "utf8");

// ---- 最小环境桩（同 test-weibo.js：按钮状态全靠 class / style / title 承载）----
function stubEl(tag) {
  const cls = new Set();
  const styleProps = {};
  const attrs = {};
  return {
    tagName: String(tag || "div").toUpperCase(),
    title: "",
    textContent: "",
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
      contains: (c) => cls.has(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c))
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

const appended = [];

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL, // withName 用标准 URL 拼接查询参数（浏览器里是内建全局）
  // 网络一律失败：hook 与嵌入接口都取不到，链路应平稳落到 DOM 兜底
  fetch: async () => {
    throw new Error("offline");
  },
  requestAnimationFrame: (fn) => fn(),
  MutationObserver: class {
    observe() {}
  },
  getComputedStyle: () => ({ position: "static" }),
  chrome: {
    storage: {
      sync: { get: (keys, cb) => cb({}) },
      onChanged: { addListener() {} }
    },
    runtime: {
      // 回调必须被调用，否则 sendBg 的 Promise 永远挂起
      sendMessage: (msg, cb) => {
        if (cb) cb(null);
      },
      onMessage: { addListener() {} },
      lastError: null
    }
  },
  document: {
    cookie: "",
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    documentElement: {},
    body: {
      appendChild: (el) => {
        appended.push(el);
      }
    },
    createElement: stubEl
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.innerWidth = 1400;
sandbox.window.innerHeight = 900;
sandbox.window.addEventListener = () => {};

vm.createContext(sandbox);
vm.runInContext(i18nSrc, sandbox, { filename: "i18n.js" });
vm.runInContext(src, sandbox, { filename: "twitter.js" });

const x = sandbox.window.__xdl;
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log("  PASS", name);
  } else {
    fail++;
    console.log(
      "  FAIL",
      name,
      "\n    实际:",
      JSON.stringify(actual),
      "\n    期望:",
      JSON.stringify(expected)
    );
  }
}

// ---- 假 DOM：只实现 findRoot / tweetIdOf 用到的那部分 ----
function el(tag, opts) {
  const o = opts || {};
  const attrs = o.attrs || {};
  const parent = {
    parentElement: null,
    matches: () => false,
    getAttribute: () => null,
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const node = {
    tagName: tag.toUpperCase(),
    parentElement: o.parent || null,
    children: o.children || [],
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    matches(sel) {
      if (sel === 'article[data-testid="tweet"]') return attrs["data-testid"] === "tweet";
      if (sel === 'article[role="article"]') return node.tagName === "ARTICLE" && attrs.role === "article";
      if (sel === 'div[data-testid="tweet"]') return attrs["data-testid"] === "tweet";
      return false;
    },
    querySelector(sel) {
      if (sel === "time") return o.time || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'a[href*="/status/"]') return o.anchors || [];
      return [];
    },
    getBoundingClientRect: () => ({ width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400 })
  };
  if (parent && !o.parent) node.parentElement = null;
  return node;
}

function anchor(href) {
  return { getAttribute: (k) => (k === "href" ? href : null) };
}

function chain(nodes) {
  // nodes 从内到外，串成 parentElement 链，返回最内层
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].parentElement = nodes[i + 1];
  return nodes[0];
}

(async () => {
  console.log("== 1. 图片地址识别：只认 pbs 的正文配图 ==");
  check("media 图被识别", x.isMediaUrl("https://pbs.twimg.com/media/GX1abc.jpg"), true);
  check("带参数也认", x.isMediaUrl("https://pbs.twimg.com/media/GX1abc?format=jpg&name=small"), true);
  check("头像被排除", x.isMediaUrl("https://pbs.twimg.com/profile_images/1/abc_normal.jpg"), false);
  check("表情被排除", x.isMediaUrl("https://pbs.twimg.com/emoji/v2/svg/1f600.svg"), false);
  check("非 pbs 域名被排除", x.isMediaUrl("https://video.twimg.com/abc.mp4"), false);

  console.log("== 2. 换档：name 参数 ==");
  const base = "https://pbs.twimg.com/media/GX1abc?format=jpg&name=small";
  check("small → orig", x.withName(base, "orig"), "https://pbs.twimg.com/media/GX1abc?format=jpg&name=orig");
  check(
    "无扩展名时补 format",
    x.withName("https://pbs.twimg.com/media/GX1abc", "orig"),
    "https://pbs.twimg.com/media/GX1abc?name=orig&format=jpg"
  );
  check(
    "有扩展名时不补 format",
    x.withName("https://pbs.twimg.com/media/GX1abc.jpg", "orig"),
    "https://pbs.twimg.com/media/GX1abc.jpg?name=orig"
  );

  console.log("== 3. 图片候选：默认最高画质 orig ==");
  const cands = x.imageCandidates(base);
  check("首位是 orig", cands[0], "https://pbs.twimg.com/media/GX1abc?format=jpg&name=orig");
  check(
    "默认原图时候选只有 orig 与原始地址（不塞中间档）",
    cands.join(","),
    "https://pbs.twimg.com/media/GX1abc?format=jpg&name=orig,https://pbs.twimg.com/media/GX1abc," + base
  );
  check("末位保底是原始地址", cands[cands.length - 1], base);
  check("无重复项", cands.length, new Set(cands).size);
  check(
    "选了低档才带上升级链（480 → medium → large → 4096 → orig）",
    x
      .imageCandidates(base, "480")
      .slice(0, 5)
      .map((u) => new URL(u).searchParams.get("name"))
      .join(","),
    "small,medium,large,4096x4096,orig"
  );
  const nameOf = (q) => {
    const u = new URL(x.imageCandidates(base, q)[0]);
    return u.searchParams.get("name");
  };
  check("设置 240 → small（680）", nameOf("240"), "small");
  check("设置 480 → small（680）", nameOf("480"), "small");
  check("设置 720 → medium（1200）", nameOf("720"), "medium");
  check("设置 1080 → medium（1200）", nameOf("1080"), "medium");
  check("设置 2K → large（2048）", nameOf("2k"), "large");
  check("设置 4K → 4096x4096", nameOf("4k"), "4096x4096");
  check("设置 原图 → orig", nameOf("orig"), "orig");
  check(
    "所选档取不到时逐档往上回退（4K → 原图）",
    new URL(x.imageCandidates(base, "4k")[1]).searchParams.get("name"),
    "orig"
  );
  check(
    "老值 medium 仍按 pbs 档位名直出",
    new URL(x.imageCandidates(base, "medium")[0]).searchParams.get("name"),
    "medium"
  );

  console.log("== 4. 视频：跳过 HLS，按设置的清晰度选档 ==");
  const variants = [
    { content_type: "application/x-mpegURL", url: "https://video.twimg.com/pl/abc.m3u8" },
    { bitrate: 632000, content_type: "video/mp4", url: "https://video.twimg.com/v/632.mp4" },
    { bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/v/2176.mp4" },
    { bitrate: 10368000, content_type: "video/mp4", url: "https://video.twimg.com/v/10368.mp4" }
  ];
  const vc = x.videoCandidates(variants);
  check("取到 3 档 mp4", vc.length, 3);
  check("原画质在首位（默认设置）", vc[0], "https://video.twimg.com/v/10368.mp4");
  check("m3u8 被排除", vc.some((u) => u.indexOf(".m3u8") >= 0), false);
  check(
    "设置 480 → 不低于 480 的最低一档（2176k ≈ 720P）在首位",
    x.videoCandidates(variants, "480")[0],
    "https://video.twimg.com/v/2176.mp4"
  );
  check(
    "设置 1080 → 1080 档在首位",
    x.videoCandidates(variants, "1080")[0],
    "https://video.twimg.com/v/10368.mp4"
  );
  check(
    "设置 1080 时的回退档按高到低排",
    x.videoCandidates(variants, "1080")[1],
    "https://video.twimg.com/v/2176.mp4"
  );
  check(
    "设置 2K 而源最高只有 1080 → 取源最高档",
    x.videoCandidates(variants, "2k")[0],
    "https://video.twimg.com/v/10368.mp4"
  );
  check(
    "源只有一档时，任何设置都取它（= 源最高档）",
    x.videoCandidates(
      [{ bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/v/2176.mp4" }],
      "480"
    )[0],
    "https://video.twimg.com/v/2176.mp4"
  );

  console.log("== 5. 实体归一化：图片 / 视频 / GIF ==");
  const items = x.normalizeMedia([
    { type: "photo", url: "https://pbs.twimg.com/media/P1?format=jpg&name=small" },
    { type: "video", url: "https://pbs.twimg.com/thumb/V1.jpg", variants: variants },
    { type: "animated_gif", url: "https://pbs.twimg.com/thumb/G1.jpg", variants: [{ bitrate: 0, content_type: "video/mp4", url: "https://video.twimg.com/tweet_video/G1.mp4" }] }
  ]);
  check("取到 3 项", items.length, 3);
  check("第 1 项是图", items[0].type, "image");
  check("第 2 项是视频", items[1].type, "video");
  check("GIF 也是 mp4", items[2].candidates[0], "https://video.twimg.com/tweet_video/G1.mp4");

  console.log("== 6. 只有 HLS 的视频不产生下载项（交给 DOM 兜底）==");
  const hlsOnly = x.normalizeMedia([
    { type: "video", url: "", variants: [{ content_type: "application/x-mpegURL", url: "https://video.twimg.com/x.m3u8" }] }
  ]);
  check("不生成可下载项", hlsOnly.length, 0);
  check("空输入不报错", x.normalizeMedia(null).length, 0);

  console.log("== 7. 推文 id：优先时间戳链接 ==");
  const timeAnchor = anchor("/elonmusk/status/1700000000000000001");
  const rootWithTime = el("article", {
    attrs: { "data-testid": "tweet" },
    time: { closest: (sel) => (sel === "a[href]" ? timeAnchor : null) },
    anchors: [anchor("/someone/status/1699999999999999999")]
  });
  check("时间戳链接优先（避开引用推文）", x.tweetIdOf(rootWithTime), "1700000000000000001");

  const rootNoTime = el("article", {
    attrs: { "data-testid": "tweet" },
    anchors: [anchor("/user/status/1234567890123456789?s=20"), anchor("/x/status/1")]
  });
  check("退回 /status/ 链接", x.tweetIdOf(rootNoTime), "1234567890123456789");

  const rootNoId = el("article", {
    attrs: { "data-testid": "tweet" },
    anchors: [anchor("/user"), anchor("#")]
  });
  check("没有链接返回 null", x.tweetIdOf(rootNoId), null);

  console.log("== 8. 卡片定位：最近祖先匹配选择器 ==");
  const media = el("div");
  const inner = el("div");
  const article = el("article", { attrs: { "data-testid": "tweet" } });
  chain([media, inner, article]);
  check("找到 article[data-testid=tweet]", x.findRoot(media) === article, true);

  const m2 = el("div");
  chain([m2, el("div"), el("div")]);
  check("无匹配容器时返回 null（不误挂按钮）", x.findRoot(m2), null);

  console.log("== 9. hook 通道在无 postMessage 环境下安全退化 ==");
  check("queryHook 返回 null", await x._queryHook("1700000000000000001"), null);

  console.log("== 10. 嵌入接口不可用时也不抛错 ==");
  check("fetchTweet 返回 null", await x._fetchTweet("1700000000000000001"), null);

  console.log("== 11. 加载中：按钮变成可取消状态 ==");
  const btn = x._makeBtn();
  const pid = "xtest1";
  x._startRing(btn, pid);
  check("进入加载态", btn.classList.contains("x-dl-progress"), true);
  check("提示文案换成可取消", btn.title, "下载中，点击取消");
  check("无障碍标签也换了", btn.getAttribute("aria-label"), "取消下载");
  check("进度环从 2% 起", btn.style.getPropertyValue("--x-dl-p"), "2.0");
  check("ring 记录当前 pid", x.ring().pid, pid);
  check("此时还没被取消", x._isCanceled(pid), false);

  console.log("== 12. 再点一次 = 取消：按钮立刻复位、pid 记入取消 ==");
  x._cancelActive(btn);
  check("退出加载态", btn.classList.contains("x-dl-progress"), false);
  check("标题复位", btn.title, "下载（X 图片/视频）");
  check("移除无障碍标签", btn.getAttribute("aria-label"), null);
  check("进度环清空", x.ring().pid, null);
  check("不再有残值", btn.style.getPropertyValue("--x-dl-p"), "");
  check("pid 被记为已取消", x._isCanceled(pid), true);
  check("新 pid 不受影响", x._isCanceled("xtest2"), false);
  check("给了灰色反馈", btn.classList.contains("x-dl-canceled"), true);
  check(
    "弹出中性提示（不是红色报错）",
    appended.some(
      (n) => String(n.textContent).indexOf("已取消") >= 0 && n.className.indexOf("x-dl-toast-info") >= 0
    ),
    true
  );

  console.log("== 13. 别的 pid 收尾不能误清当前进度环 ==");
  const btn2 = x._makeBtn();
  x._startRing(btn2, "pidA");
  x._endRing("pidB");
  check("别人的 pid 无效", x.ring().pid, "pidA");
  check("按钮仍在加载态", btn2.classList.contains("x-dl-progress"), true);
  x._endRing("pidA");
  check("自己的 pid 才收尾", x.ring().pid, null);
  check("按钮已复位", btn2.classList.contains("x-dl-progress"), false);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
