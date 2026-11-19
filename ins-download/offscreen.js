/* offscreen document：有 DOM 环境且带 host 权限（跨域 fetch 不受 CORS 限制）
 * 职责：
 *  1) 单文件下载写入用户自定义文件夹（File System Access API）
 *  2) 多张下载：抓取全部媒体 -> 打包 zip -> 写入自定义文件夹，
 *     未设置自定义文件夹时返回 dataUrl 交给 chrome.downloads 下载
 *  3) 微博：取回真实媒体字节后交回 background（写盘 / blob URL / dataUrl），
 *     避免浏览器自己去拉地址时被 CDN 的 HTML 错误页改掉后缀
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  (async () => {
    try {
      if (msg.action === "zip") {
        sendResponse(await handleZip(msg));
        return;
      }
      if (msg.action === "save-media") {
        sendResponse(await saveMedia(msg));
        return;
      }
      if (msg.action === "blob-dataurl") {
        sendResponse(await blobUrlToDataUrl(msg.url));
        return;
      }
      if (msg.action === "release-blob") {
        sendResponse(releaseBlobSoon(msg.url));
        return;
      }
      if (msg.action === "weibo-api") {
        sendResponse(await proxyApi(msg));
        return;
      }
      sendResponse(await handleSingle(msg));
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();

  return true;
});

/* ---------------- 媒体取字节 ----------------
 * 微博图片按「路径首段」区分尺寸，很多图并没有 orj1080 / large 档，直接访问会返回
 * 404 的 HTML；Chrome 识别到内容是 HTML 就把后缀改成 .htm（历史 bug）。
 * 这里逐个候选地址取回真实字节并嗅探文件头，既确认它是真媒体，也拿到真实格式。
 */
const RANGE_BYTES = 4096;

function ascii(bytes, offset, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = bytes[offset + i];
    if (c === undefined) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function matchBytes(bytes, offset, str) {
  for (let i = 0; i < str.length; i++) {
    if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

// 按文件头判断真实格式；HTML/JSON 一律判为「不是媒体」
function sniffMedia(bytes, contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.indexOf("text/html") >= 0 || ct.indexOf("application/json") >= 0) return null;
  if (!bytes || bytes.length < 12) return null;

  const head = ascii(bytes, 0, 64).trim().toLowerCase();
  // 有些 CDN 把错误页的 Content-Type 也写成 image/jpeg，只能靠内容首字符兜底
  if (head.charAt(0) === "<" || head.indexOf("<!doctype") === 0) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { ext: "jpg", kind: "image", mime: "image/jpeg" };
  if (bytes[0] === 0x89 && matchBytes(bytes, 1, "PNG"))
    return { ext: "png", kind: "image", mime: "image/png" };
  if (matchBytes(bytes, 0, "GIF8")) return { ext: "gif", kind: "image", mime: "image/gif" };
  if (matchBytes(bytes, 0, "RIFF") && matchBytes(bytes, 8, "WEBP"))
    return { ext: "webp", kind: "image", mime: "image/webp" };
  if (matchBytes(bytes, 4, "ftyp")) {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (brand.indexOf("qt") === 0) return { ext: "mov", kind: "video", mime: "video/quicktime" };
    if (brand.indexOf("m4a") === 0) return { ext: "m4a", kind: "audio", mime: "audio/mp4" };
    return { ext: "mp4", kind: "video", mime: "video/mp4" };
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return { ext: "webm", kind: "video", mime: "video/webm" };

  // 文件头不认识时退一步信 Content-Type（有些 CDN 传的是分段 mp4，头部不在前 4KB）
  if (ct.indexOf("image/") === 0) {
    const sub = ct.split("/")[1].split(";")[0].replace("jpeg", "jpg");
    return { ext: sub || "jpg", kind: "image", mime: ct };
  }
  if (ct.indexOf("video/") === 0) {
    const sub = ct.split("/")[1].split(";")[0];
    return { ext: sub === "quicktime" ? "mov" : sub || "mp4", kind: "video", mime: ct };
  }
  return null;
}

// 只读前若干字节，然后主动断开，避免为探测把整个视频拖下来
async function readPrefix(resp, max) {
  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    return buf.subarray(0, Math.min(buf.length, max));
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < max) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    total += step.value.length;
    if (total >= max) break;
  }
  try {
    await reader.cancel();
  } catch (e) {
    /* 已结束的流取消会抛错，忽略 */
  }
  const out = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const take = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out;
}

/* 逐个候选地址试探，返回第一个「真能拿到该类型媒体字节」的地址。
 * full=false 只读 4KB（探测用）；full=true 拿到完整 Blob（真正保存用）。
 * 无论哪种模式，HTML/JSON 错误页都会被 sniffMedia 判为「不是媒体」而跳过。
 * 大视频用 resp.blob() 而不是 arrayBuffer()：Chrome 会把大 Blob 落到磁盘，
 * 内存里只留引用，避免一个几百 MB 的视频把离屏文档撑爆。
 */
async function fetchFirstMedia(candidates, kind, full) {
  const list = Array.isArray(candidates) ? candidates : [];
  const tried = [];

  for (const raw of list) {
    const url = typeof raw === "string" ? raw : raw && raw.url;
    if (!url || !/^https?:/i.test(url)) continue;
    try {
      const init = { credentials: "omit", cache: "no-store" };
      if (!full) init.headers = { Range: "bytes=0-" + (RANGE_BYTES - 1) };
      const resp = await fetch(url, init);
      if (!resp.ok) {
        tried.push({ url, status: resp.status });
        continue;
      }
      const ct = resp.headers.get("content-type") || "";
      let blob = null;
      let head;
      if (full) {
        blob = await resp.blob();
        head = new Uint8Array(
          await blob.slice(0, Math.min(blob.size, RANGE_BYTES)).arrayBuffer()
        );
      } else {
        head = await readPrefix(resp, RANGE_BYTES);
      }
      const sniff = sniffMedia(head, ct);
      if (!sniff || sniff.kind !== kind) {
        tried.push({ url, status: resp.status, type: ct || "unknown" });
        continue;
      }
      return {
        ok: true,
        url,
        blob,
        ext: sniff.ext,
        mime: sniff.mime || ct,
        size: blob ? blob.size : 0,
        tried
      };
    } catch (e) {
      tried.push({ url, error: String(e && e.message ? e.message : e) });
    }
  }
  return { ok: false, error: "media-blocked", tried };
}

/* ---------------- 单文件保存 ----------------
 * 为什么不是把地址交给 chrome.downloads 自己拉：
 *   下载请求由浏览器发起，带的是 chrome-extension:// 来源、没有页面 Referer，
 *   微博图床 / 视频 CDN 会返回 200 的 HTML 错误页；Chrome 识别到 HTML 就把
 *   文件名后缀改成 .htm —— 这正是「下载下来是 .htm」的根因。
 * 所以改成：这里先取回真实字节，再按字节交付：
 *   有自定义文件夹 → 直接写盘；否则生成 blob URL 交给 background 走下载器。
 * blob 的 MIME 与文件名都由我们决定，服务器再也没有机会改动后缀。
 */
const liveBlobs = new Map(); // blobUrl -> timer

async function saveMedia(msg) {
  const kind = msg.kind === "video" ? "video" : "image";
  const got = await fetchFirstMedia(msg.candidates, kind, true);
  if (!got.ok) return got;

  const mime = got.mime || (kind === "video" ? "video/mp4" : "image/jpeg");
  // slice 只是换 type 视图，不复制字节
  const blob = got.blob.slice(0, got.blob.size, mime);

  if (msg.dirKey) {
    const handle = await getGrantedHandle(msg.dirKey);
    if (!handle) return { ok: false, error: "permission" };
    await writeToDir(handle, (msg.fileName || "weibo_media") + "." + got.ext, blob);
    return { ok: true, saved: "fs", ext: got.ext, size: blob.size };
  }

  const url = URL.createObjectURL(blob);
  // 兜底回收：background 正常会主动 release；异常中断时 5 分钟后自清
  liveBlobs.set(
    url,
    setTimeout(() => releaseBlob(url), 5 * 60 * 1000)
  );
  return { ok: true, saved: "blob", url, ext: got.ext, size: blob.size };
}

function releaseBlob(url) {
  const timer = liveBlobs.get(url);
  if (timer) {
    clearTimeout(timer);
    liveBlobs.delete(url);
  }
  try {
    URL.revokeObjectURL(url);
  } catch (e) {
    /* 已释放 */
  }
  return { ok: true };
}

// 下载已开始后延后释放，避免浏览器还没把 blob 读走就失效
function releaseBlobSoon(url) {
  if (!url || !liveBlobs.has(url)) return { ok: true };
  clearTimeout(liveBlobs.get(url));
  liveBlobs.set(
    url,
    setTimeout(() => releaseBlob(url), 60000)
  );
  return { ok: true };
}

async function blobUrlToDataUrl(url) {
  if (!url) return { ok: false, error: "bad-url" };
  const blob = await (await fetch(url)).blob();
  return { ok: true, dataUrl: await blobToDataUrl(blob) };
}

/* 微博接口代理：页面里同源 fetch 不通时由这里代发（扩展有 host 权限，不受 CORS 限制，
 * 且带 credentials 时会带上该域名的 Cookie） */
async function proxyApi(msg) {
  const init = { method: msg.method || "GET", credentials: "include", cache: "no-store" };
  if (msg.body) init.body = msg.body;
  if (msg.contentType) init.headers = { "Content-Type": msg.contentType };
  const resp = await fetch(msg.url, init);
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text };
}

async function getGrantedHandle(dirKey) {
  if (!dirKey) return null;
  const handle = await idbGet(dirKey);
  if (!handle) return null;
  let perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") {
    try {
      perm = await handle.requestPermission({ mode: "readwrite" });
    } catch (e) { /* 无用户手势时会失败 */ }
  }
  return perm === "granted" ? handle : null;
}

async function writeToDir(handle, fileName, data) {
  const fh = await handle.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function handleSingle(msg) {
  const handle = await getGrantedHandle(msg.dirKey);
  if (!handle) return { ok: false, error: "permission" };
  const resp = await fetch(msg.url, { credentials: "omit" });
  if (!resp.ok) throw new Error("fetch " + resp.status);
  // rejectHtml：微博侧会把 403/404 变成 200 的 HTML 错误页，别把它写成 .jpg
  if (msg.rejectHtml) {
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("text/html") >= 0) return { ok: false, error: "media-blocked" };
  }
  await writeToDir(handle, msg.fileName, await resp.blob());
  return { ok: true };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function handleZip(msg) {
  // 抓取全部媒体
  // prefix：zip 内文件名前缀。ins 侧不传，默认 "ins_"（保持原行为）；微博传 "weibo_"
  // sniffExt：微博侧传 true —— 逐个候选地址重试并按文件头定扩展名，跳过 HTML 错误页
  const prefix = msg.prefix || "ins_";
  const files = [];
  for (let i = 0; i < msg.items.length; i++) {
    const item = msg.items[i];
    const cands =
      Array.isArray(item.candidates) && item.candidates.length ? item.candidates : [item.url];
    let got = null;
    for (const c of cands) {
      const url = typeof c === "string" ? c : c && c.url;
      if (!url || !/^https?:/i.test(url)) continue;
      try {
        const resp = await fetch(url, { credentials: "omit" });
        if (!resp.ok) continue; // 跳过失败项，不中断整包
        const buf = new Uint8Array(await resp.arrayBuffer());
        const sniff = msg.sniffExt
          ? sniffMedia(buf.subarray(0, Math.min(buf.length, RANGE_BYTES)), resp.headers.get("content-type"))
          : null;
        if (msg.sniffExt && !sniff) continue; // 拿到的是 HTML 错误页，换下一个候选
        got = { buf, ext: sniff ? sniff.ext : item.type === "video" ? "mp4" : "jpg" };
        break;
      } catch (e) {
        /* 换下一个候选 */
      }
    }
    if (!got) continue;
    files.push({ name: prefix + String(i + 1).padStart(2, "0") + "." + got.ext, data: got.buf });
  }
  if (!files.length) return { ok: false, error: "all-fetch-failed" };

  const zipBlob = InsZip.build(files);

  // 有自定义文件夹：直接写入，无任何弹窗
  const handle = await getGrantedHandle(msg.dirKey);
  if (handle) {
    await writeToDir(handle, msg.zipName, zipBlob);
    return { ok: true };
  }
  if (msg.dirKey) return { ok: false, error: "permission" };

  // 默认模式：返回 dataUrl 由 background 走 chrome.downloads（只弹一次保存框）
  return { ok: true, dataUrl: await blobToDataUrl(zipBlob) };
}
