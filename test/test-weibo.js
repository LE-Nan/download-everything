/* 临时测试：用最小 DOM 桩加载 weibo.js，验证取址/解析/清晰度替换的真实逻辑 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(
  path.join(__dirname, "..", "ins-download", "weibo.js"),
  "utf8"
);

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
  fetch: async () => ({ ok: false }),
  requestAnimationFrame: (fn) => fn(),
  MutationObserver: class {
    observe() {}
  },
  chrome: {
    storage: {
      sync: { get: (keys, cb) => cb({}) },
      onChanged: { addListener() {} }
    },
    runtime: { sendMessage() {}, lastError: null }
  },
  document: {
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
    console.log("  FAIL", name, "\n    实际:", JSON.stringify(actual), "\n    期望:", JSON.stringify(expected));
  }
}

console.log("== 1. 图片地址识别（排除头像/表情）==");
const img = wb.checkImage("https://wx1.sinaimg.cn/orj360/006ABCdefgy1h1a2b3c.jpg");
check("正文配图被识别", img.isFeedImage, true);
check("360→1080 换档", img.variants.orj1080, "https://wx1.sinaimg.cn/orj1080/006ABCdefgy1h1a2b3c.jpg");
check("360→原图", img.variants.large, "https://wx1.sinaimg.cn/large/006ABCdefgy1h1a2b3c.jpg");
check("头像被排除", wb.checkImage("https://tvax1.sinaimg.cn/crop.0.0.180.180.180/006abc.jpg").isFeedImage, false);
check("表情被排除", wb.checkImage("https://h5.sinaimg.cn/m/emoticon/icon/default/d_haixiu.png").isFeedImage, false);
check(
  "带 query 的图保参",
  wb.checkImage("https://wx2.sinaimg.cn/mw690/abc.jpg?KID=imgbed").variants.large,
  "https://wx2.sinaimg.cn/large/abc.jpg?KID=imgbed"
);
check(
  "非白名单路径不改写",
  wb.checkImage("https://wx2.sinaimg.cn/weird/abc.jpg").variants.large,
  "https://wx2.sinaimg.cn/weird/abc.jpg"
);

console.log("== 2. 接口解析：九宫格 ==");
const grid = {
  id: "5000000000000001",
  pics: Array.from({ length: 9 }, (_, i) => ({
    pid: "p" + i,
    url: "https://wx1.sinaimg.cn/orj360/" + i + ".jpg",
    large: { url: "https://wx1.sinaimg.cn/large/" + i + ".jpg" }
  }))
};
const g1 = wb.parseStatusMedia(grid);
check("九宫格取到 9 项", g1.length, 9);
check("优先取 large 原图", g1[0].url, "https://wx1.sinaimg.cn/large/0.jpg");
check("类型为 image", g1[0].type, "image");

console.log("== 3. 接口解析：视频 ==");
const vid = {
  id: "5000000000000002",
  page_info: {
    type: "video",
    media_info: {
      stream_url: "https://f.video.weibocdn.com/o0/sd.mp4?label=mp4_ld",
      stream_url_hd: "https://f.video.weibocdn.com/o0/hd.mp4?label=mp4_hd"
    }
  }
};
const g2 = wb.parseStatusMedia(vid);
check("视频 1 项", g2.length, 1);
check("类型为 video", g2[0].type, "video");
check("默认取 hd", g2[0].url, "https://f.video.weibocdn.com/o0/hd.mp4?label=mp4_hd");
check("sd 变体留存", g2[0].variants.sd, "https://f.video.weibocdn.com/o0/sd.mp4?label=mp4_ld");

console.log("== 4. 接口解析：转发微博 ==");
const repost = {
  id: "5000000000000003",
  text_raw: "转发内容",
  pics: [],
  retweeted_status: {
    id: "5000000000000000",
    pics: [
      { url: "https://wx1.sinaimg.cn/orj360/a.jpg" },
      { url: "https://wx1.sinaimg.cn/orj360/b.jpg" }
    ]
  }
};
const g3 = wb.parseStatusMedia(repost);
check("转发取到被转发者的 2 张", g3.length, 2);

console.log("== 5. 去重与空数据 ==");
const dup = {
  id: "5000000000000004",
  pics: [
    { url: "https://wx1.sinaimg.cn/orj360/x.jpg" },
    { url: "https://wx1.sinaimg.cn/orj360/x.jpg" }
  ]
};
check("重复图片去重", wb.parseStatusMedia(dup).length, 1);
check("空对象不报错", wb.parseStatusMedia({}).length, 0);
check("null 不报错", wb.parseStatusMedia(null).length, 0);
check("只有文字返回空", wb.parseStatusMedia({ id: "1", text_raw: "hi" }).length, 0);

console.log("== 6. 混合：视频优先于同条图片 ==");
const mixed = {
  id: "5000000000000005",
  page_info: { type: "video", media_info: { stream_url: "https://f.video.weibocdn.com/a.mp4" } },
  pics: [{ url: "https://wx1.sinaimg.cn/orj360/cover.jpg" }]
};
const g4 = wb.parseStatusMedia(mixed);
check("视频帖不重复计入封面图", g4.length, 1);
check("是视频", g4[0].type, "video");

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
