/* 回归测试：加载 offscreen.js，验证「媒体探测」与 zip 的候选重试
 * 重点覆盖历史 bug：把 404/403 的 HTML 错误页当成图片下载 → 文件变成 .htm
 * 运行：node test/test-offscreen.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = path.join(__dirname, "..", "ins-download");
const zipSrc = fs.readFileSync(path.join(dir, "zip.js"), "utf8");
const src = fs.readFileSync(path.join(dir, "offscreen.js"), "utf8");

// ---- 构造各种文件头 ----
function bytes(list) {
  return new Uint8Array(list);
}
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00]);
const WEBP = bytes([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38]);
const MP4 = bytes([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]);
const MOV = bytes([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x00]);
const HTML = Buffer.from("<!DOCTYPE html><html><body>403 Forbidden</body></html>");
const JSONB = Buffer.from('{"error":"forbidden"}');
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]);

// ---- 桩环境 ----
const written = [];
const fakeHandle = {
  queryPermission: async () => "granted",
  getFileHandle: async (name) => ({
    createWritable: async () => ({
      write: async (data) => {
        written.push({ name, size: data && data.size !== undefined ? data.size : data.length });
      },
      close: async () => {}
    })
  })
};

const fetchCalls = [];
let responder = () => ({ status: 404, body: HTML, ct: "text/html" });

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Blob,
  URL,
  TextEncoder,
  TextDecoder,
  fetch: async (url) => {
    fetchCalls.push(url);
    const r = responder(url);
    if (r.throw) throw new Error("network");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? r.ct : null) },
      // body 为 null → readPrefix 走 arrayBuffer 分支，测试里只需前若干字节
      body: null,
      blob: async () => new Blob([r.body], { type: r.ct || "" }),
      arrayBuffer: async () => {
        const b = r.body;
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
    };
  },
  idbGet: async () => fakeHandle,
  chrome: {
    runtime: { onMessage: { addListener() {} }, lastError: null, sendMessage: async () => ({ ok: true }) }
  }
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(zipSrc, sandbox, { filename: "zip.js" });
vm.runInContext(src, sandbox, { filename: "offscreen.js" });

const off = sandbox;
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
  console.log("== 1. 文件头识别 ==");
  check("JPEG", off.sniffMedia(JPEG, "image/jpeg").ext, "jpg");
  check("PNG", off.sniffMedia(PNG, "").ext, "png");
  check("GIF", off.sniffMedia(GIF, "").ext, "gif");
  check("WEBP", off.sniffMedia(WEBP, "").ext, "webp");
  check("MP4", off.sniffMedia(MP4, "").ext, "mp4");
  check("MOV", off.sniffMedia(MOV, "").ext, "mov");
  check("WEBM", off.sniffMedia(WEBM, "").ext, "webm");
  check("MP4 判为 video", off.sniffMedia(MP4, "").kind, "video");

  console.log("== 2. 错误页必须被拒（.htm 的根因）==");
  check("HTML 文本被拒", off.sniffMedia(new Uint8Array(HTML), "text/html"), null);
  check("HTML 但标成 image/jpeg 也被拒", off.sniffMedia(new Uint8Array(HTML), "image/jpeg"), null);
  check("JSON 被拒", off.sniffMedia(new Uint8Array(JSONB), "application/json"), null);
  check("空内容被拒", off.sniffMedia(new Uint8Array(0), "image/jpeg"), null);

  console.log("== 3. 取字节：跳过 404 的清晰度档，命中可用档 ==");
  responder = (url) => {
    if (url.indexOf("/orj1080/") >= 0) return { status: 404, body: HTML, ct: "text/html" };
    if (url.indexOf("/large/") >= 0) return { status: 200, body: JPEG, ct: "image/jpeg" };
    return { status: 403, body: HTML, ct: "text/html" };
  };
  let r = await off.fetchFirstMedia(
    [
      "https://wx1.sinaimg.cn/orj1080/a.jpg",
      "https://wx1.sinaimg.cn/large/a.jpg",
      "https://wx1.sinaimg.cn/orj360/a.jpg"
    ],
    "image",
    false
  );
  check("取字节成功", r.ok, true);
  check("落到 large 档", r.url, "https://wx1.sinaimg.cn/large/a.jpg");
  check("后缀是 jpg 而非 htm", r.ext, "jpg");
  check("只试了失败的 1 个候选", r.tried.length, 1);

  console.log("== 4. 取字节：全部被拒时明确报错 ==");
  responder = () => ({ status: 403, body: HTML, ct: "text/html" });
  r = await off.fetchFirstMedia(["https://wx1.sinaimg.cn/large/x.jpg"], "image", false);
  check("返回 media-blocked", r.error, "media-blocked");
  check("ok 为 false", r.ok, false);

  console.log("== 5. 取字节：类型不匹配要跳过（图片请求打到视频）==");
  responder = (url) =>
    url.indexOf("v.mp4") >= 0
      ? { status: 200, body: MP4, ct: "video/mp4" }
      : { status: 200, body: JPEG, ct: "image/jpeg" };
  r = await off.fetchFirstMedia(
    ["https://f.video.weibocdn.com/v.mp4", "https://wx1.sinaimg.cn/large/b.jpg"],
    "image",
    false
  );
  check("跳过视频，取到图片", r.url, "https://wx1.sinaimg.cn/large/b.jpg");
  check("图片后缀正确", r.ext, "jpg");

  console.log("== 6. 取字节：视频请求命中 mp4 ==");
  r = await off.fetchFirstMedia(
    ["https://wx1.sinaimg.cn/large/c.jpg", "https://f.video.weibocdn.com/v.mp4"],
    "video",
    false
  );
  check("取到 mp4", r.url, "https://f.video.weibocdn.com/v.mp4");
  check("后缀 mp4", r.ext, "mp4");

  console.log("== 6b. saveMedia：默认目录 → 返回 blob URL（不再让下载器自己去拉）==");
  responder = (url) =>
    url.indexOf("/large/") >= 0
      ? { status: 200, body: JPEG, ct: "image/jpeg" }
      : { status: 404, body: HTML, ct: "text/html" };
  const blobRes = await off.saveMedia({
    candidates: ["https://wx1.sinaimg.cn/orj1080/z.jpg", "https://wx1.sinaimg.cn/large/z.jpg"],
    kind: "image",
    fileName: "weibo_image_20260101"
  });
  check("保存成功", blobRes.ok, true);
  check("走 blob 模式", blobRes.saved, "blob");
  check("返回的是 blob URL", String(blobRes.url).indexOf("blob:") === 0, true);
  check("后缀按真实文件头", blobRes.ext, "jpg");
  check("字节数与响应一致", blobRes.size, JPEG.length);
  check("blob 是 image/jpeg", (await (await fetch(blobRes.url)).blob()).type, "image/jpeg");
  check("释放 blob", off.releaseBlobSoon(blobRes.url).ok, true);

  console.log("== 6c. saveMedia：自定义目录 → 直接写盘，文件名带真实后缀 ==");
  written.length = 0;
  const fsRes = await off.saveMedia({
    candidates: ["https://wx1.sinaimg.cn/large/y.jpg"],
    kind: "image",
    fileName: "weibo_image_20260101",
    dirKey: "weiboImageDirHandle"
  });
  check("保存成功", fsRes.ok, true);
  check("走写盘模式", fsRes.saved, "fs");
  check("文件名补上 .jpg", written[0] && written[0].name, "weibo_image_20260101.jpg");

  console.log("== 6d. saveMedia：全部失败时不产生文件 ==");
  written.length = 0;
  responder = () => ({ status: 200, body: HTML, ct: "text/html" });
  const badRes = await off.saveMedia({
    candidates: ["https://wx1.sinaimg.cn/large/none.jpg"],
    kind: "image",
    fileName: "weibo_image_bad",
    dirKey: "weiboImageDirHandle"
  });
  check("返回失败", badRes.ok, false);
  check("错误码 media-blocked", badRes.error, "media-blocked");
  check("没有写盘", written.length, 0);

  console.log("== 7. zip：候选重试 + 按真实格式命名 ==");
  written.length = 0;
  responder = (url) => {
    if (url.indexOf("bad") >= 0) return { status: 200, body: HTML, ct: "text/html" };
    return { status: 200, body: JPEG, ct: "image/jpeg" };
  };
  const zipRes = await off.handleZip({
    items: [
      { candidates: ["https://wx1.sinaimg.cn/large/bad.jpg", "https://wx1.sinaimg.cn/large/ok.jpg"], type: "image" },
      { candidates: ["https://f.video.weibocdn.com/bad.mp4"], type: "video" }
    ],
    zipName: "weibo_images.zip",
    prefix: "weibo_",
    sniffExt: true,
    dirKey: "weiboImageDirHandle"
  });
  check("zip 写入成功", zipRes.ok, true);
  check("写入了 1 个文件", written.length, 1);
  check("文件名是 zip", written[0] && written[0].name, "weibo_images.zip");

  console.log("== 8. zip：ins 老路径行为不变（无 candidates / 无 sniffExt）==");
  written.length = 0;
  responder = () => ({ status: 200, body: JPEG, ct: "image/jpeg" });
  const insZip = await off.handleZip({
    items: [{ url: "https://cdninstagram.com/a.jpg", type: "image" }],
    zipName: "ins_images.zip",
    dirKey: "imageDirHandle"
  });
  check("ins zip 成功", insZip.ok, true);
  check("ins zip 命名沿用", written[0] && written[0].name, "ins_images.zip");

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
