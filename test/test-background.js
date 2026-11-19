/* 回归测试：加载 background.js，验证 ins / 微博 的路由、探测协议、接口代理与目录隔离
 * 运行：node test/test-background.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "ins-download", "background.js"), "utf8");

const downloads = [];
const offscreenMsgs = [];
const dnrRules = [];
let storageData = {};
let onMessage = null;
let probeResult = null;

const sandbox = {
  console,
  setTimeout,
  Date,
  URL,
  chrome: {
    storage: {
      sync: {
        get: (keys) =>
          Promise.resolve(
            Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys])
                .filter((k) => k in storageData)
                .map((k) => [k, storageData[k]])
            )
          )
      }
    },
    downloads: {
      download: (opts, cb) => {
        downloads.push(opts);
        cb(downloads.length);
      }
    },
    runtime: {
      lastError: null,
      id: "test-extension-id",
      onMessage: {
        addListener(fn) {
          onMessage = fn;
        }
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: (msg) => {
        offscreenMsgs.push(msg);
        if (msg && msg.action === "probe-media") {
          if (probeResult) return Promise.resolve(probeResult);
          return Promise.resolve({
            ok: true,
            url: (msg.candidates && msg.candidates[0]) || "",
            ext: msg.kind === "video" ? "mp4" : "jpg"
          });
        }
        if (msg && msg.action === "weibo-api") {
          return Promise.resolve({ ok: true, status: 200, text: '{"mblogid":"P1"}' });
        }
        return Promise.resolve({ ok: true });
      }
    },
    offscreen: {
      hasDocument: () => Promise.resolve(true),
      createDocument: () => Promise.resolve()
    },
    declarativeNetRequest: {
      updateSessionRules: (opts) => {
        dnrRules.push(opts);
        return Promise.resolve();
      }
    }
  }
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "background.js" });

function send(msg) {
  return new Promise((resolve) => {
    onMessage(msg, {}, resolve);
  });
}

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

const dirOf = (filename) => filename.split("/").slice(0, 2).join("/");
const baseName = (filename) => filename.split("/").pop();

(async () => {
  console.log("== 1. ins 原生路径（不传 site，行为应与 1.0.0 一致）==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  let r = await send({ action: "download", url: "https://cdn/x.jpg", type: "image" });
  check("返回 ok", r.ok, true);
  check("落到 ins-download/images", dirOf(downloads[0].filename), "ins-download/images");
  check("文件名前缀 ins_image_", baseName(downloads[0].filename).startsWith("ins_image_"), true);
  check("saveAs 为 false", downloads[0].saveAs, false);
  check("ins 不做媒体探测（零额外请求）", offscreenMsgs.filter((m) => m.action === "probe-media").length, 0);

  console.log("== 2. ins 视频路径（不传 site）==");
  downloads.length = 0;
  await send({ action: "download", url: "https://cdn/v.mp4", type: "video" });
  check("落到 ins-download/videos", dirOf(downloads[0].filename), "ins-download/videos");
  check("文件名前缀 ins_video_", baseName(downloads[0].filename).startsWith("ins_video_"), true);

  console.log("== 3. 微博图片：先探测再下载 ==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  probeResult = { ok: true, url: "https://wx1.sinaimg.cn/large/a.webp", ext: "webp" };
  r = await send({
    action: "download",
    site: "weibo",
    type: "image",
    candidates: ["https://wx1.sinaimg.cn/orj1080/a.jpg", "https://wx1.sinaimg.cn/large/a.jpg"]
  });
  check("返回 ok", r.ok, true);
  check("探测收到全部候选", offscreenMsgs[0].candidates.length, 2);
  check("探测的 kind 是 image", offscreenMsgs[0].kind, "image");
  check("用探测给出的地址下载", downloads[0].url, "https://wx1.sinaimg.cn/large/a.webp");
  check("后缀取自探测（不是写死 jpg）", baseName(downloads[0].filename).endsWith(".webp"), true);
  check("落到 weibo-download/images", dirOf(downloads[0].filename), "weibo-download/images");
  check("文件名前缀 weibo_image_", baseName(downloads[0].filename).startsWith("weibo_image_"), true);

  console.log("== 4. 探测失败时明确报错，不留 .htm 垃圾文件 ==");
  downloads.length = 0;
  probeResult = { ok: false, error: "media-blocked", tried: [] };
  r = await send({
    action: "download",
    site: "weibo",
    type: "image",
    candidates: ["https://wx1.sinaimg.cn/orj1080/a.jpg"]
  });
  check("返回失败", r.ok, false);
  check("错误码 media-blocked", r.error, "media-blocked");
  check("没有触发下载", downloads.length, 0);

  console.log("== 5. 微博视频：探测后落到视频目录 ==");
  probeResult = null;
  downloads.length = 0;
  offscreenMsgs.length = 0;
  await send({
    action: "download",
    site: "weibo",
    type: "video",
    candidates: ["https://f.video.weibocdn.com/o0/hd.mp4"]
  });
  check("探测 kind 是 video", offscreenMsgs[0].kind, "video");
  check("落到 weibo-download/videos", dirOf(downloads[0].filename), "weibo-download/videos");
  check("文件名后缀 mp4", baseName(downloads[0].filename).endsWith(".mp4"), true);
  check("文件名前缀 weibo_video_", baseName(downloads[0].filename).startsWith("weibo_video_"), true);

  console.log("== 6. 微博自定义目录：走 offscreen 写盘 ==");
  storageData = { weiboImageCustom: true };
  downloads.length = 0;
  offscreenMsgs.length = 0;
  probeResult = null;
  r = await send({
    action: "download",
    site: "weibo",
    type: "image",
    candidates: ["https://wx1.sinaimg.cn/large/a.jpg"]
  });
  check("返回 ok", r.ok, true);
  const save = offscreenMsgs.find((m) => m.dirKey === "weiboImageDirHandle");
  check("写入到 weibo 目录句柄", !!save, true);
  check("未触发 chrome.downloads", downloads.length, 0);

  console.log("== 7. ins 自定义目录键不受微博键影响 ==");
  storageData = { weiboImageCustom: true };
  downloads.length = 0;
  r = await send({ action: "download", url: "https://cdn/y.jpg", type: "image" });
  check("ins 仍走 chrome.downloads", r.ok, true);
  check("ins 落到默认目录", dirOf(downloads[0].filename), "ins-download/images");

  console.log("== 8. 自定义目录名覆盖默认 ==");
  storageData = { weiboVideoDir: "我的/微博" };
  downloads.length = 0;
  probeResult = null;
  await send({
    action: "download",
    site: "weibo",
    type: "video",
    candidates: ["https://f.video.weibocdn.com/b.mp4"]
  });
  check("尊重自定义目录名", dirOf(downloads[0].filename), "我的/微博");

  console.log("== 9. zip 路由 ==");
  storageData = {};
  offscreenMsgs.length = 0;
  r = await send({
    action: "zip",
    site: "weibo",
    prefix: "weibo_",
    items: [{ candidates: ["https://wx1.sinaimg.cn/large/1.jpg"], type: "image" }]
  });
  check("微博 zip 返回 ok", r.ok, true);
  const zipMsg = offscreenMsgs.find((m) => m.action === "zip");
  check("微博 zip 开启扩展名探测", zipMsg.sniffExt, true);
  check("微博 zip 前缀 weibo_", zipMsg.prefix, "weibo_");

  offscreenMsgs.length = 0;
  await send({
    action: "zip",
    items: [{ url: "https://cdn/x.jpg", type: "image" }]
  });
  const insZip = offscreenMsgs.find((m) => m.action === "zip");
  check("ins zip 不带 sniffExt", insZip.sniffExt, undefined);

  console.log("== 10. 接口代理只转发微博域名 ==");
  r = await send({ action: "weibo-api", url: "https://weibo.com/ajax/statuses/show?id=P1" });
  check("微博接口放行", r.ok, true);
  r = await send({ action: "weibo-api", url: "https://example.com/steal?x=1" });
  check("外部域名被拒", r.error, "host-not-allowed");
  r = await send({ action: "weibo-api", url: "not-a-url" });
  check("非法地址被拒", r.error, "bad-url");

  console.log("== 11. 请求头规则：只补 Referer，作用于微博自有域名 ==");
  const last = dnrRules[dnrRules.length - 1];
  const rule = last && last.addRules && last.addRules[0];
  check("规则存在", !!rule, true);
  check("规则 id 固定", rule.id, 9001);
  check("设置 referer", rule.action.requestHeaders[0].header, "referer");
  check("referer 值", rule.action.requestHeaders[0].value, "https://weibo.com/");
  check(
    "覆盖图床/视频 CDN",
    rule.condition.requestDomains.indexOf("sinaimg.cn") >= 0 &&
      rule.condition.requestDomains.indexOf("weibocdn.com") >= 0,
    true
  );

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
