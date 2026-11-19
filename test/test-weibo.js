/* 回归测试：加载 weibo.js，验证卡片识别 / 帖子 id 取值 / 接口解析 / 地址候选
 * 运行：node test/test-weibo.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "ins-download", "weibo.js"), "utf8");

// ---- 最小环境桩 ----
const stubEl = () => ({
  style: {},
  classList: { add() {}, remove() {}, contains: () => false },
  addEventListener() {},
  remove() {},
  appendChild() {},
  setAttribute() {},
  hasAttribute: () => false,
  getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
  querySelector: () => null,
  querySelectorAll: () => []
});

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  // 网络一律失败：走不到组件接口时 parseStatus 应稳定返回本地字段
  fetch: async () => {
    throw new Error("offline");
  },
  requestAnimationFrame: (fn) => fn(),
  MutationObserver: class {
    observe() {}
  },
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
    addEventListener() {},
    documentElement: {},
    body: { appendChild() {} },
    createElement: stubEl
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.innerWidth = 1600;
sandbox.window.innerHeight = 900;
sandbox.window.addEventListener = () => {};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "weibo.js" });

const wb = sandbox.window.__wbDl;
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

// ---- 假 DOM：只实现 findRoot / postIdOf 用到的那部分 ----
function el(tag, opts) {
  const o = opts || {};
  const attrs = o.attrs || {};
  const anchors = (o.hrefs || []).map((h) => ({
    getAttribute: (k) => (k === "href" ? h : null)
  }));
  return {
    tagName: tag.toUpperCase(),
    className: o.cls || "",
    parentElement: null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    matches(sel) {
      if (sel === "article.woo-panel-main")
        return this.tagName === "ARTICLE" && this.className.indexOf("woo-panel-main") >= 0;
      if (sel === "div.card-wrap")
        return this.tagName === "DIV" && this.className.indexOf("card-wrap") >= 0;
      if (sel === '[action-type="feed_list_item"]') return attrs["action-type"] === "feed_list_item";
      if (sel === "[mid]") return "mid" in attrs;
      if (sel === "[data-mid]") return "data-mid" in attrs;
      return false;
    },
    querySelectorAll(sel) {
      return sel === "a[href]" ? anchors : [];
    },
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 600, height: 400 })
  };
}

function chain(nodes) {
  // nodes 从内到外，串成 parentElement 链，返回最内层
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].parentElement = nodes[i + 1];
  return nodes[0];
}

(async () => {
  console.log("== 1. 图片地址识别与换档 ==");
  const img = wb.checkImage("https://wx1.sinaimg.cn/orj360/006ABCdefgy1h1a2b3c.jpg");
  check("正文配图被识别", img.isFeedImage, true);
  check(
    "候选首位是原图（默认设置）",
    img.candidates[0],
    "https://wx1.sinaimg.cn/large/006ABCdefgy1h1a2b3c.jpg"
  );
  check("候选含 1080 兜底", img.candidates.indexOf("https://wx1.sinaimg.cn/orj1080/006ABCdefgy1h1a2b3c.jpg") >= 0, true);
  check("360→原图", img.variants.large, "https://wx1.sinaimg.cn/large/006ABCdefgy1h1a2b3c.jpg");
  check(
    "头像被排除",
    wb.checkImage("https://tvax1.sinaimg.cn/crop.0.0.180.180.180/006abc.jpg").isFeedImage,
    false
  );
  check(
    "表情被排除",
    wb.checkImage("https://h5.sinaimg.cn/m/emoticon/icon/default/d_haixiu.png").isFeedImage,
    false
  );
  check(
    "带 query 的图保参",
    wb.checkImage("https://wx2.sinaimg.cn/mw690/abc.jpg?KID=imgbed").variants.large,
    "https://wx2.sinaimg.cn/large/abc.jpg?KID=imgbed"
  );
  check(
    "未知路径段不改写",
    wb.checkImage("https://wx2.sinaimg.cn/weird/abc.jpg").variants.large,
    "https://wx2.sinaimg.cn/weird/abc.jpg"
  );

  console.log("== 2. 卡片定位：新版首页（无 mid）==");
  const media = el("img");
  // 新版首页：img → div → article.woo-panel-main
  const inner = el("div");
  const article = el("article", { cls: "woo-panel-main" });
  chain([media, inner, article]);
  check("找到 article.woo-panel-main", wb.findRoot(media) === article, true);

  console.log("== 3. 卡片定位：搜索页 card-wrap ==");
  const m2 = el("img");
  const cardWrap = el("div", { cls: "card-wrap", attrs: { mid: "5000000000000001" } });
  chain([m2, cardWrap]);
  check("找到 div.card-wrap", wb.findRoot(m2) === cardWrap, true);

  console.log("== 4. 卡片定位：无匹配容器时返回 null ==");
  const m3 = el("img");
  chain([m3, el("div"), el("div")]);
  check("不误挂按钮", wb.findRoot(m3), null);

  console.log("== 5. 帖子 id 取值 ==");
  const withMid = el("div", { cls: "card-wrap", attrs: { mid: "5000000000000009" } });
  check("mid 属性优先", wb.postIdOf(withMid), "5000000000000009");

  const newUi = el("article", {
    cls: "woo-panel-main",
    hrefs: ["https://weibo.com/u/1234567890", "https://weibo.com/1234567890/PabcDEF1234?from=page"]
  });
  check("新版从微博链接取 mblogid", wb.postIdOf(newUi), "PabcDEF1234");

  const detail = el("article", { cls: "woo-panel-main", hrefs: ["/detail/5012345678901234"] });
  check("详情页链接取 id", wb.postIdOf(detail), "5012345678901234");

  const statusLink = el("div", { cls: "card-wrap", hrefs: ["https://m.weibo.cn/status/5099999999999999"] });
  check("移动端 status 链接取 id", wb.postIdOf(statusLink), "5099999999999999");

  const noId = el("article", { cls: "woo-panel-main", hrefs: ["https://weibo.com/", "#"] });
  check("没有可用链接返回 null", wb.postIdOf(noId), null);

  console.log("== 6. 接口解析：pic_infos 九宫格（按 pic_ids 顺序）==");
  const picInfos = {};
  const picIds = [];
  for (let i = 0; i < 9; i++) {
    picIds.push("p" + i);
    picInfos["p" + i] = {
      largest: { url: "https://wx1.sinaimg.cn/large/" + i + ".jpg" },
      pic_big: { url: "https://wx1.sinaimg.cn/orj360/" + i + ".jpg" }
    };
  }
  const grid = await wb.parseStatus({ mblogid: "Pgrid0001", pic_infos: picInfos, pic_ids: picIds });
  check("九宫格取到 9 项", grid.length, 9);
  check("顺序按 pic_ids", grid[0].candidates[0], "https://wx1.sinaimg.cn/large/0.jpg");
  check("类型为 image", grid[0].type, "image");

  console.log("== 7. 接口解析：视频（无 fid，走字段）==");
  const vid = await wb.parseStatus({
    mblogid: "Pvid00001",
    page_info: {
      type: "video",
      media_info: {
        stream_url: "https://f.video.weibocdn.com/o0/sd.mp4?label=mp4_ld",
        stream_url_hd: "https://f.video.weibocdn.com/o0/hd.mp4?label=mp4_hd"
      }
    }
  });
  check("视频 1 项", vid.length, 1);
  check("类型为 video", vid[0].type, "video");
  check("高清排在首位", vid[0].candidates[0], "https://f.video.weibocdn.com/o0/hd.mp4?label=mp4_hd");
  check("标清作为兜底候选", vid[0].candidates.indexOf("https://f.video.weibocdn.com/o0/sd.mp4?label=mp4_ld") >= 0, true);

  console.log("== 7b. 视频帖的封面图不重复计入 ==");
  const vidCover = await wb.parseStatus({
    mblogid: "Pvid00002",
    page_info: { type: "video", media_info: { stream_url_hd: "https://f.video.weibocdn.com/o0/hd.mp4" } },
    pic_infos: { c1: { largest: { url: "https://wx1.sinaimg.cn/large/cover.jpg" } } },
    pic_ids: ["c1"]
  });
  check("只返回视频 1 项", vidCover.length, 1);
  check("是视频", vidCover[0].type, "video");

  console.log("== 8. 接口解析：转发微博 ==");
  const repost = await wb.parseStatus({
    mblogid: "Prepost001",
    text_raw: "转发",
    retweeted_status: {
      pics: [
        { url: "https://wx1.sinaimg.cn/orj360/a.jpg" },
        { url: "https://wx1.sinaimg.cn/orj360/b.jpg" }
      ]
    }
  });
  check("取被转发者的 2 张", repost.length, 2);

  console.log("== 9. 接口解析：图文+视频混排 ==");
  const mixed = await wb.parseStatus({
    mblogid: "Pmix00001",
    mix_media_info: {
      items: [
        { type: "pic", data: { largest: { url: "https://wx1.sinaimg.cn/large/x1.jpg" } } },
        {
          type: "video",
          data: { media_info: { stream_url_hd: "https://f.video.weibocdn.com/o0/m.mp4" } }
        },
        { type: "pic", data: { largest: { url: "https://wx1.sinaimg.cn/large/x2.jpg" } } }
      ]
    }
  });
  check("混排取到 3 项", mixed.length, 3);
  check("第 1 项是图", mixed[0].type, "image");
  check("第 2 项是视频", mixed[1].type, "video");
  check("第 3 项是图", mixed[2].type, "image");

  console.log("== 10. 空数据与去重 ==");
  const dup = await wb.parseStatus({
    pics: [
      { url: "https://wx1.sinaimg.cn/orj360/x.jpg" },
      { url: "https://wx1.sinaimg.cn/orj360/x.jpg" }
    ]
  });
  check("重复图片去重", dup.length, 1);
  check("空对象不报错", (await wb.parseStatus({})).length, 0);
  check("null 不报错", (await wb.parseStatus(null)).length, 0);
  check("只有文字返回空", (await wb.parseStatus({ mblogid: "P1", text_raw: "hi" })).length, 0);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
