/* 临时测试：加载 background.js，验证 ins 与 weibo 的路由、文件名前缀、默认目录互不影响 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(
  path.join(__dirname, "..", "ins-download", "background.js"),
  "utf8"
);

const downloads = [];
let storageData = {};
let onMessage = null;

const sandbox = {
  console,
  setTimeout,
  Date,
  chrome: {
    storage: {
      sync: {
        // MV3 里 storage 既支持回调也支持 Promise，这里给 Promise 版本
        get: (keys) => Promise.resolve(
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
      onMessage: {
        addListener(fn) {
          onMessage = fn;
        }
      },
      sendMessage: () => Promise.resolve({ ok: true })
    },
    offscreen: {
      hasDocument: () => Promise.resolve(true),
      createDocument: () => Promise.resolve()
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

(async () => {
  console.log("== 1. ins 原生路径（不传 site，行为应与 1.0.0 一致）==");
  storageData = {};
  downloads.length = 0;
  let r = await send({ action: "download", url: "https://cdn/x.jpg", type: "image" });
  check("返回 ok", r.ok, true);
  check("落到 ins-download/images", downloads[0].filename.split("/").slice(0, 2).join("/"), "ins-download/images");
  check("文件名前缀 ins_image_", downloads[0].filename.split("/").pop().startsWith("ins_image_"), true);
  check("saveAs 为 false", downloads[0].saveAs, false);

  console.log("== 2. ins 视频路径（不传 site）==");
  downloads.length = 0;
  await send({ action: "download", url: "https://cdn/v.mp4", type: "video" });
  check("落到 ins-download/videos", downloads[0].filename.split("/").slice(0, 2).join("/"), "ins-download/videos");
  check("文件名前缀 ins_video_", downloads[0].filename.split("/").pop().startsWith("ins_video_"), true);

  console.log("== 3. 微博图片路径（site=weibo）==");
  downloads.length = 0;
  r = await send({ action: "download", site: "weibo", url: "https://wx1.sinaimg.cn/large/a.jpg", type: "image" });
  check("返回 ok", r.ok, true);
  check("落到 weibo-download/images", downloads[0].filename.split("/").slice(0, 2).join("/"), "weibo-download/images");
  check("文件名前缀 weibo_image_", downloads[0].filename.split("/").pop().startsWith("weibo_image_"), true);

  console.log("== 4. 微博视频路径（site=weibo）==");
  downloads.length = 0;
  await send({ action: "download", site: "weibo", url: "https://f.video.weibocdn.com/a.mp4", type: "video" });
  check("落到 weibo-download/videos", downloads[0].filename.split("/").slice(0, 2).join("/"), "weibo-download/videos");
  check("文件名前缀 weibo_video_", downloads[0].filename.split("/").pop().startsWith("weibo_video_"), true);

  console.log("== 5. 自定义目录优先（微博）==");
  storageData = { weiboImageCustom: true };
  downloads.length = 0;
  const offBefore = downloads.length;
  // 自定义目录走 offscreen（stub 直接返回 ok），不应触发 chrome.downloads
  r = await send({ action: "download", site: "weibo", url: "https://wx1.sinaimg.cn/large/a.jpg", type: "image" });
  check("走 offscreen 返回 ok", r.ok, true);
  check("未触发 chrome.downloads", downloads.length, offBefore);

  console.log("== 6. ins 自定义目录键不受微博键影响 ==");
  storageData = { weiboImageCustom: true }; // 微博开了自定义，ins 没开
  downloads.length = 0;
  r = await send({ action: "download", url: "https://cdn/y.jpg", type: "image" });
  check("ins 仍走 chrome.downloads", r.ok, true);
  check("ins 落到默认目录", downloads[0].filename.split("/").slice(0, 2).join("/"), "ins-download/images");

  console.log("== 7. 自定义目录名（weiboDir）覆盖默认 ==");
  storageData = { weiboVideoDir: "我的/微博" };
  downloads.length = 0;
  await send({ action: "download", site: "weibo", url: "https://f.video.weibocdn.com/b.mp4", type: "video" });
  check("尊重自定义目录名", downloads[0].filename.split("/").slice(0, 2).join("/"), "我的/微博");

  console.log("== 8. zip 路由 ==");
  storageData = {};
  const zipMsg = {
    action: "zip",
    site: "weibo",
    prefix: "weibo_",
    items: [{ url: "https://wx1.sinaimg.cn/large/1.jpg", type: "image" }]
  };
  r = await send(zipMsg);
  check("微博 zip 返回 ok", r.ok, true);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
