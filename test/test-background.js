/* 回归测试：加载 background.js，验证 ins / 微博 的路由、探测协议、接口代理与目录隔离
 * 运行：node test/test-background.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "ins-download", "background.js"), "utf8");

const downloads = [];
const canceledDownloads = [];
const offscreenMsgs = [];
const dnrRules = [];
const progressMsgs = [];
let storageData = {};
let onMessage = null;
let saveResult = null;
let saveGate = null; // 设置后 save-media 会等它 resolve，便于在「取字节中」插入断言
let zipResult = null; // 设置后 zip 会回 dataUrl，用于验证打包后的落盘目录

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
      },
      cancel: (id, cb) => {
        canceledDownloads.push(id);
        if (cb) cb();
      }
    },
    tabs: {
      sendMessage: (tabId, msg) => {
        progressMsgs.push({ tabId, msg });
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
          const out =
            saveResult ||
            {
              ok: true,
              saved: "blob",
              url: "blob:chrome-extension://test-extension-id/" + offscreenMsgs.length,
              ext: msg.kind === "video" ? "mp4" : "jpg",
              size: 1024
            };
          if (saveGate) return saveGate.then(() => out);
          return Promise.resolve(out);
        }
        if (msg && msg.action === "release-blob") return Promise.resolve({ ok: true });
        if (msg && msg.action === "blob-dataurl") {
          return Promise.resolve({ ok: true, dataUrl: "data:image/jpeg;base64,AAAA" });
        }
        if (msg && msg.action === "weibo-api") {
          return Promise.resolve({ ok: true, status: 200, text: '{"mblogid":"P1"}' });
        }
        // zip 默认只回 ok（旧测试只关心发给 offscreen 的消息）；
        // 需要验证「打包完成后落到哪个目录」时由用例塞一个 dataUrl
        if (msg && msg.action === "zip") {
          return Promise.resolve(zipResult || { ok: true });
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

function send(msg, sender) {
  return new Promise((resolve) => {
    onMessage(msg, sender || {}, resolve);
  });
}

// 等一轮微任务 + 宏任务，让链路上的 await 全部推进
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

const dirOf = (filename) => filename.split("/").slice(0, 2).join("/");
const baseName = (filename) => filename.split("/").pop();

(async () => {
  console.log("== 1. ins 原生路径（不传 site，无 progressId 也应正常下载）==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  let r = await send({ action: "download", url: "https://cdn/x.jpg", type: "image" });
  check("返回 ok", r.ok, true);
  check("落到 ins-download/images", dirOf(downloads[0].filename), "ins-download/images");
  check("文件名前缀 ins_image_", baseName(downloads[0].filename).startsWith("ins_image_"), true);
  check("saveAs 为 false", downloads[0].saveAs, false);
  // v2.1.0：ins 与微博一样先取字节再交付，进度环才有字节数可画
  check(
    "ins 也走取字节链路（进度环数据来源）",
    offscreenMsgs.filter((m) => m.action === "save-media").length,
    1
  );
  check(
    "ins 取字节的 kind 是 image",
    offscreenMsgs.find((m) => m.action === "save-media").kind,
    "image"
  );

  console.log("== 2. ins 视频路径（不传 site）==");
  downloads.length = 0;
  await send({ action: "download", url: "https://cdn/v.mp4", type: "video" });
  check("落到 ins-download/videos", dirOf(downloads[0].filename), "ins-download/videos");
  check("文件名前缀 ins_video_", baseName(downloads[0].filename).startsWith("ins_video_"), true);

  console.log("== 2b. ins 带 progressId：进度转发到发起标签页 ==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  progressMsgs.length = 0;
  const insSender = { tab: { id: 7 } };
  let release2b;
  saveGate = new Promise((res) => (release2b = res));
  saveResult = {
    ok: true,
    saved: "blob",
    url: "blob:chrome-extension://test-extension-id/ig-progress",
    ext: "jpg",
    size: 1024
  };
  const insJob = send(
    { action: "download", url: "https://cdn/p.jpg", type: "image", progressId: "ig-test-1" },
    insSender
  );
  await tick();
  // 取字节还挂在 gate 上，此刻 pid 仍绑定着标签页 —— 注入一条字节进度看是否转发
  // （这条消息不回复，只做转发，所以不能 await 它的 sendResponse）
  onMessage({ action: "wb-fetch-progress", progressId: "ig-test-1", loaded: 50, total: 100 }, {}, () => {});
  await tick();
  const fwd = progressMsgs.find(
    (m) => m.tabId === 7 && m.msg.type === "wb-dl-progress" && m.msg.phase === "fetch"
  );
  check("进度消息转发到 ins 标签页", !!fwd, true);
  check("带上已取字节数与总量", fwd && [fwd.msg.loaded, fwd.msg.total], [50, 100]);
  release2b();
  saveGate = null;
  await insJob;
  saveResult = null;

  console.log("== 2c. ins 取消：取消先到，取字节回来也不许再下载 ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  let release;
  saveGate = new Promise((res) => (release = res));
  saveResult = {
    ok: true,
    saved: "blob",
    url: "blob:chrome-extension://test-extension-id/ig-cancel",
    ext: "jpg",
    size: 1024
  };
  const canceledJob = send(
    { action: "download", url: "https://cdn/q.jpg", type: "image", progressId: "ig-test-2" },
    insSender
  );
  await tick();
  await send({ action: "cancel", progressId: "ig-test-2" });
  release();
  saveGate = null;
  r = await canceledJob;
  check("取消后返回 canceled", r.canceled, true);
  check("取消后不再触发下载", downloads.length, 0);
  check(
    "取消后释放已取回的 blob",
    offscreenMsgs.some((m) => m.action === "release-blob"),
    true
  );
  saveResult = null;

  console.log("== 2d. ins 取字节失败时退回直拉（不把能下的变成下不了）==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  saveResult = { ok: false, error: "media-blocked", tried: [] };
  r = await send({ action: "download", url: "https://cdn/fallback.jpg", type: "image" });
  check("回退后仍返回成功", r.ok, true);
  check("回退直接用原地址", downloads[0].url, "https://cdn/fallback.jpg");
  check("回退仍落到默认目录", dirOf(downloads[0].filename), "ins-download/images");
  saveResult = null;

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
  offscreenMsgs.length = 0;
  saveResult = null; // ins 没设自定义目录，offscreen 不会拿到 dirKey
  r = await send({ action: "download", url: "https://cdn/y.jpg", type: "image" });
  check("ins 仍走 chrome.downloads", r.ok, true);
  check("ins 落到默认目录", dirOf(downloads[0].filename), "ins-download/images");
  check(
    "ins 不会误用微博的目录句柄",
    offscreenMsgs.find((m) => m.action === "save-media").dirKey,
    null
  );

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

  console.log("== 9b. X（推特）：独立目录、独立前缀 ==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  r = await send({
    action: "download",
    site: "twitter",
    type: "image",
    candidates: ["https://pbs.twimg.com/media/GX1?format=jpg&name=orig"]
  });
  check("返回 ok", r.ok, true);
  check("落到 twitter-download/images", dirOf(downloads[0].filename), "twitter-download/images");
  check("文件名前缀 twitter_image_", baseName(downloads[0].filename).startsWith("twitter_image_"), true);
  check("同样走取字节链路", offscreenMsgs.filter((m) => m.action === "save-media").length, 1);

  downloads.length = 0;
  await send({
    action: "download",
    site: "twitter",
    type: "video",
    candidates: ["https://video.twimg.com/v/2176.mp4"]
  });
  check("落到 twitter-download/videos", dirOf(downloads[0].filename), "twitter-download/videos");
  check("文件名前缀 twitter_video_", baseName(downloads[0].filename).startsWith("twitter_video_"), true);

  console.log("== 9c. X 自定义目录键与微博/ins 互不影响 ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  storageData = { twitterImageCustom: true, twitterImageDir: "我的\\X图" };
  await send({
    action: "download",
    site: "twitter",
    type: "image",
    candidates: ["https://pbs.twimg.com/media/GX2?format=jpg&name=orig"]
  });
  const xSave = offscreenMsgs.find((m) => m.action === "save-media");
  check("自定义目录走 DirHandle", xSave.dirKey, "twitterImageDirHandle");
  storageData = { weiboImageCustom: true, weiboImageDir: "我的\\微博" };
  offscreenMsgs.length = 0;
  await send({
    action: "download",
    site: "twitter",
    type: "image",
    candidates: ["https://pbs.twimg.com/media/GX3?format=jpg&name=orig"]
  });
  check(
    "微博的自定义目录不会串到 X 上",
    offscreenMsgs.find((m) => m.action === "save-media").dirKey,
    null
  );

  console.log("== 9d. X zip：命名、目录与扩展名探测 ==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  zipResult = { ok: true, dataUrl: "data:application/zip;base64,AAAA" };
  r = await send({
    action: "zip",
    site: "twitter",
    items: [
      { candidates: ["https://pbs.twimg.com/media/A?format=jpg&name=orig"], type: "image" },
      { candidates: ["https://pbs.twimg.com/media/B?format=jpg&name=orig"], type: "image" }
    ]
  });
  check("zip 返回 ok", r.ok, true);
  const xZip = offscreenMsgs.find((m) => m.action === "zip");
  check("zip 前缀 twitter_", xZip.prefix, "twitter_");
  check("zip 开启扩展名探测", xZip.sniffExt, true);
  check("zip 文件名 twitter_images_", baseName(xZip.zipName).startsWith("twitter_images_"), true);
  check("纯图片落到图片目录", dirOf(downloads[0].filename), "twitter-download/images");

  downloads.length = 0;
  offscreenMsgs.length = 0;
  await send({
    action: "zip",
    site: "twitter",
    items: [
      { candidates: ["https://pbs.twimg.com/media/A?format=jpg&name=orig"], type: "image" },
      { candidates: ["https://video.twimg.com/v/63.mp4"], type: "video" }
    ]
  });
  check("含视频的 zip 落到视频目录", dirOf(downloads[0].filename), "twitter-download/videos");
  check(
    "含视频的 zip 命名 twitter_videos_",
    baseName(downloads[0].filename).startsWith("twitter_videos_"),
    true
  );
  zipResult = null;

  console.log("== 10. 接口代理只转发微博域名 ==");
  r = await send({ action: "weibo-api", url: "https://weibo.com/ajax/statuses/show?id=P1" });
  check("微博接口放行", r.ok, true);
  r = await send({ action: "weibo-api", url: "https://example.com/steal?x=1" });
  check("外部域名被拒", r.error, "host-not-allowed");
  r = await send({ action: "weibo-api", url: "not-a-url" });
  check("非法地址被拒", r.error, "bad-url");

  console.log("== 10b. X 嵌入接口代理只放行 twimg / x.com 的接口域名 ==");
  r = await send({
    action: "x-api",
    url: "https://cdn.syndication.twimg.com/tweet-result?id=1700000000000000001&lang=en&token=abc"
  });
  check("syndication 接口放行", r.ok, true);
  r = await send({ action: "x-api", url: "https://pbs.twimg.com/media/GX1?format=jpg" });
  check("图片 CDN 不放行（不需要代理）", r.error, "host-not-allowed");
  r = await send({ action: "x-api", url: "https://example.com/steal" });
  check("外部域名被拒", r.error, "host-not-allowed");
  r = await send({ action: "x-api", url: "nope" });
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

  console.log("== 12. 下载进度：字节数与「填满」都要回传给发起下载的标签页 ==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  progressMsgs.length = 0;
  saveResult = null;
  saveGate = null;

  let dlListener = null;
  const dlStates = new Map();
  sandbox.chrome.downloads.onChanged = {
    addListener: (fn) => {
      dlListener = fn;
    },
    removeListener: (fn) => {
      if (dlListener === fn) dlListener = null;
    }
  };
  sandbox.chrome.downloads.search = ({ id }, cb) =>
    cb([{ id, state: dlStates.get(id) || "in_progress" }]);

  // 让 save-media 卡住，模拟「视频还在下载中」
  let releaseSave;
  saveGate = new Promise((r) => {
    releaseSave = r;
  });

  let settled = false;
  const p = send(
    {
      action: "download",
      site: "weibo",
      type: "video",
      candidates: ["https://f.video.weibocdn.com/o0/p.mp4"],
      progressId: "p1"
    },
    { tab: { id: 77 } }
  );
  p.then(() => {
    settled = true;
  });

  await tick();
  onMessage({ action: "wb-fetch-progress", progressId: "p1", loaded: 30, total: 120 }, {}, () => {});
  await tick();
  check("进度转发到原标签页", progressMsgs.every((m) => m.tabId === 77), true);
  check("phase 是 fetch", progressMsgs[0].msg.phase, "fetch");
  check("已取字节数透传", progressMsgs[0].msg.loaded, 30);
  check("总字节数透传", progressMsgs[0].msg.total, 120);
  check("带 progressId 而不是别的 key", progressMsgs[0].msg.id, "p1");
  check("取字节阶段尚未返回", settled, false);

  releaseSave();
  await tick();
  check("下载前已发出 save（填满）", progressMsgs.some((m) => m.msg.phase === "save"), true);
  check("下载已启动", downloads.length, 1);

  console.log("== 12b. 保存框开着时响应挂起（进度环保持填满），点保存后才返回 ==");
  dlStates.set(1, "in_progress");
  await tick();
  check("in_progress 时不返回", settled, false);

  dlStates.set(1, "complete");
  dlListener({ id: 1, state: { current: "complete" } });
  const doneRes = await p;
  check("完成后才返回", settled, true);
  check("返回 ok", doneRes.ok, true);

  console.log("== 13. 用户取消保存：静默恢复，不重试、不报错 ==");
  downloads.length = 0;
  progressMsgs.length = 0;
  dlStates.clear();
  const p2 = send(
    {
      action: "download",
      site: "weibo",
      type: "video",
      candidates: ["https://f.video.weibocdn.com/o0/q.mp4"],
      progressId: "p2"
    },
    { tab: { id: 88 } }
  );
  await tick();
  dlStates.set(1, "interrupted");
  dlListener({ id: 1, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } });
  const cancelRes = await p2;
  check("取消视为成功（不报错）", cancelRes.ok, true);
  check("标记 canceled", cancelRes.canceled, true);
  check("取消后不再弹第二次保存框", downloads.length, 1);

  console.log("== 13b. 取消：取字节阶段就把 offscreen 的请求断掉 ==");
  storageData = {};
  downloads.length = 0;
  offscreenMsgs.length = 0;
  progressMsgs.length = 0;
  canceledDownloads.length = 0;
  saveResult = null;
  let releaseFetch;
  saveGate = new Promise((r) => {
    releaseFetch = r;
  });

  let fetchSettled = false;
  const pCancelFetch = send(
    {
      action: "download",
      site: "weibo",
      type: "video",
      candidates: ["https://f.video.weibocdn.com/o0/c1.mp4"],
      progressId: "c1"
    },
    { tab: { id: 66 } }
  );
  pCancelFetch.then(() => {
    fetchSettled = true;
  });
  await tick();
  const c1 = await send({ action: "wb-cancel", progressId: "c1" });
  check("取消请求返回 ok", c1.ok, true);
  check(
    "offscreen 收到 abort",
    offscreenMsgs.filter((m) => m.target === "offscreen" && m.action === "abort" && m.progressId === "c1")
      .length,
    1
  );
  check("取字节阶段还没返回", fetchSettled, false);

  releaseFetch();
  const c1Res = await pCancelFetch;
  saveGate = null;
  check("取消后归一成 ok", c1Res.ok, true);
  check("标记 canceled", c1Res.canceled, true);
  check("取消后不再弹保存框", downloads.length, 0);

  console.log("== 13c. 取消早于下载请求（连点两下）也要拦住 ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  await send({ action: "wb-cancel", progressId: "c2" });
  await tick();
  offscreenMsgs.length = 0; // 丢掉 abort 转发本身，只看下载链路
  const c2Res = await send({
    action: "download",
    site: "weibo",
    type: "image",
    candidates: ["https://wx1.sinaimg.cn/large/c2.jpg"],
    progressId: "c2"
  });
  check("直接返回 canceled", [c2Res.ok, c2Res.canceled], [true, true]);
  check("根本不去取字节", offscreenMsgs.filter((m) => m.action === "save-media").length, 0);
  check("不弹保存框", downloads.length, 0);

  console.log("== 13d. 保存框已弹出时取消：取消那次浏览器下载 ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  canceledDownloads.length = 0;
  dlStates.clear();
  const pCancelSave = send(
    {
      action: "download",
      site: "weibo",
      type: "video",
      candidates: ["https://f.video.weibocdn.com/o0/c3.mp4"],
      progressId: "c3"
    },
    { tab: { id: 55 } }
  );
  await tick();
  check("已发起浏览器下载", downloads.length, 1);
  // 保存框开着 → in_progress，响应挂起
  dlStates.set(1, "in_progress");
  await tick();
  const c3 = await send({ action: "wb-cancel", progressId: "c3" });
  check("取消落到 browser download 上", canceledDownloads, [1]);
  check("取消返回 ok", c3.ok, true);
  // Chrome 取消后会把状态推到 interrupted/USER_CANCELED
  dlListener({ id: 1, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } });
  const c3Res = await pCancelSave;
  check("最终归一成 canceled", [c3Res.ok, c3Res.canceled], [true, true]);
  check("不重试第二次保存框", downloads.length, 1);

  console.log("== 13e. 取消之后状态清干净：下一条下载照常 ==");
  downloads.length = 0;
  offscreenMsgs.length = 0;
  saveResult = null;
  dlStates.clear();
  dlStates.set(1, "complete"); // 下一条会正常下完
  const pAfter = send(
    {
      action: "download",
      site: "weibo",
      type: "image",
      candidates: ["https://wx1.sinaimg.cn/large/after.jpg"],
      progressId: "c4"
    },
    { tab: { id: 55 } }
  );
  await tick();
  const afterCancel = await pAfter;
  check("新下载成功", afterCancel.ok, true);
  check("没有误报 canceled", !!afterCancel.canceled, false);
  check("正常落到图片目录", dirOf(downloads[0].filename), "weibo-download/images");

  console.log("== 14. 没有 progressId 时不发任何进度消息（ins 不受影响）==");
  delete sandbox.chrome.downloads.onChanged;
  delete sandbox.chrome.downloads.search;
  progressMsgs.length = 0;
  downloads.length = 0;
  saveResult = null;
  await send(
    { action: "download", site: "weibo", type: "image", candidates: ["https://wx1.sinaimg.cn/large/n.jpg"] },
    { tab: { id: 99 } }
  );
  check("无 progressId → 零进度消息", progressMsgs.length, 0);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
