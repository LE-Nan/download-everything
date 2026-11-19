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
let saveResult = null;

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
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
        if (msg && msg.action === "save-media") {
          if (saveResult) return Promise.resolve(saveResult);
          return Promise.resolve({
            ok: true,
            saved: "blob",
            url: "blob:chrome-extension://test-extension-id/" + offscreenMsgs.length,
            ext: msg.kind === "video" ? "mp4" : "jpg",
            size: 1024
          });
        }
        if (msg && msg.action === "release-blob") return Promise.resolve({ ok: true });
        if (msg && msg.action === "blob-dataurl") {
          return Promise.resolve({ ok: true, dataUrl: "data:image/jpeg;base64,AAAA" });
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
  check(
    "ins 不走微博取字节链路（零额外请求）",
    offscreenMsgs.filter((m) => m.action === "save-media").length,
    0
  );

  console.log("== 2. ins 视频路径（不传 site）==");
  downloads.length = 0;
  await send({ action: "download", url: "https://cdn/v.mp4", type: "video" });
  check("落到 ins-download/videos", dirOf(downloads[0].filename), "ins-download/videos");
  check("文件名前缀 ins_video_", baseName(downloads[0].filename).startsWith("ins_video_"), true);

  console.log("== 3. 微博图片（小文件）：offscreen 取字节后以 dataUrl 交付 ==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  saveResult = {
    ok: true,
    saved: "blob",
    url: "blob:chrome-extension://test-extension-id/aaa",
    ext: "webp",
    size: 2048
  };
  r = await send({
    action: "download",
    site: "weibo",
    type: "image",
    candidates: ["https://wx1.sinaimg.cn/orj1080/a.jpg", "https://wx1.sinaimg.cn/large/a.jpg"]
  });
  check("返回 ok", r.ok, true);
  const saveMsg = offscreenMsgs.find((m) => m.action === "save-media");
  check("全部候选交给 offscreen", saveMsg.candidates.length, 2);
  check("取字节的 kind 是 image", saveMsg.kind, "image");
  check(
    "小文件走 dataUrl（与已验证的 zip 同一条路）",
    String(downloads[0].url).indexOf("data:") === 0,
    true
  );
  check("后缀取自真实文件头", baseName(downloads[0].filename).endsWith(".webp"), true);
  check("落到 weibo-download/images", dirOf(downloads[0].filename), "weibo-download/images");
  check("文件名前缀 weibo_image_", baseName(downloads[0].filename).startsWith("weibo_image_"), true);
  check("下载后释放 blob", offscreenMsgs.some((m) => m.action === "release-blob"), true);

  console.log("== 3b. 大视频：不做 base64，直接交 blob URL ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  saveResult = {
    ok: true,
    saved: "blob",
    url: "blob:chrome-extension://test-extension-id/bbb",
    ext: "mp4",
    size: 50 * 1024 * 1024
  };
  await send({
    action: "download",
    site: "weibo",
    type: "video",
    candidates: ["https://f.video.weibocdn.com/o0/big.mp4"]
  });
  check("大文件走 blob", String(downloads[0].url).indexOf("blob:") === 0, true);
  check("大文件不转 base64", offscreenMsgs.filter((m) => m.action === "blob-dataurl").length, 0);

  console.log("== 4. 取字节失败时明确报错，不留 .htm 垃圾文件 ==");
  downloads.length = 0;
  saveResult = { ok: false, error: "media-blocked", tried: [] };
  r = await send({
    action: "download",
    site: "weibo",
    type: "image",
    candidates: ["https://wx1.sinaimg.cn/orj1080/a.jpg"]
  });
  check("返回失败", r.ok, false);
  check("错误码 media-blocked", r.error, "media-blocked");
  check("没有触发下载", downloads.length, 0);

  console.log("== 4b. blob URL 被拒时退回 dataUrl ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  saveResult = {
    ok: true,
    saved: "blob",
    url: "blob:chrome-extension://test-extension-id/ccc",
    ext: "mp4",
    size: 50 * 1024 * 1024
  };
  const origDownload = sandbox.chrome.downloads.download;
  sandbox.chrome.downloads.download = (opts, cb) => {
    downloads.push(opts);
    const isBlob = String(opts.url).indexOf("blob:") === 0;
    if (isBlob) cb(undefined); // 模拟不支持离屏 blob URL
    else cb(downloads.length);
  };
  await send({
    action: "download",
    site: "weibo",
    type: "video",
    candidates: ["https://f.video.weibocdn.com/o0/x.mp4"]
  });
  check("先试了 blob", String(downloads[0].url).indexOf("blob:") === 0, true);
  check("重试用了 dataUrl", String(downloads[1].url).indexOf("data:") === 0, true);
  check("重试仍落到视频目录", dirOf(downloads[1].filename), "weibo-download/videos");
  sandbox.chrome.downloads.download = origDownload;

  console.log("== 4c. blob 下载被异步中断时同样回退 dataUrl ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  saveResult = {
    ok: true,
    saved: "blob",
    url: "blob:chrome-extension://test-extension-id/ddd",
    ext: "mp4",
    size: 50 * 1024 * 1024
  };
  let listener = null;
  sandbox.chrome.downloads.onChanged = {
    addListener: (fn) => {
      listener = fn;
    },
    removeListener: () => {
      listener = null;
    }
  };
  const dlSync = sandbox.chrome.downloads.download;
  sandbox.chrome.downloads.download = (opts, cb) => {
    downloads.push(opts);
    const id = downloads.length;
    cb(id);
    const isBlob = String(opts.url).indexOf("blob:") === 0;
    setTimeout(() => {
      if (listener) listener({ id, state: { current: isBlob ? "interrupted" : "complete" } });
    }, 0);
  };
  r = await send({
    action: "download",
    site: "weibo",
    type: "video",
    candidates: ["https://f.video.weibocdn.com/o0/y.mp4"]
  });
  check("先试了 blob", String(downloads[0].url).indexOf("blob:") === 0, true);
  check("中断后自动换 dataUrl", String(downloads[1].url).indexOf("data:") === 0, true);
  check("最终返回成功", r.ok, true);
  delete sandbox.chrome.downloads.onChanged;
  sandbox.chrome.downloads.download = dlSync;

  console.log("== 5. 微博视频：取字节后落到视频目录 ==");
  saveResult = null;
  downloads.length = 0;
  offscreenMsgs.length = 0;
  await send({
    action: "download",
    site: "weibo",
    type: "video",
    candidates: ["https://f.video.weibocdn.com/o0/hd.mp4"]
  });
  check("取字节 kind 是 video", offscreenMsgs.find((m) => m.action === "save-media").kind, "video");
  check("落到 weibo-download/videos", dirOf(downloads[0].filename), "weibo-download/videos");
  check("文件名后缀 mp4", baseName(downloads[0].filename).endsWith(".mp4"), true);
  check("文件名前缀 weibo_video_", baseName(downloads[0].filename).startsWith("weibo_video_"), true);

  console.log("== 6. 微博自定义目录：走 offscreen 直接写盘 ==");
  storageData = { weiboImageCustom: true };
  downloads.length = 0;
  offscreenMsgs.length = 0;
  saveResult = { ok: true, saved: "fs", ext: "jpg", size: 2048 };
  r = await send({
    action: "download",
    site: "weibo",
    type: "image",
    candidates: ["https://wx1.sinaimg.cn/large/a.jpg"]
  });
  check("返回 ok", r.ok, true);
  const save = offscreenMsgs.find((m) => m.action === "save-media");
  check("写入到 weibo 目录句柄", save && save.dirKey, "weiboImageDirHandle");
  check("文件名不含扩展名（由 offscreen 按真实格式补）", /\.[a-z0-9]+$/i.test(save.fileName), false);
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
  saveResult = null;
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
