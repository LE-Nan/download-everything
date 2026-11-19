/* offscreen document：有 DOM 环境且带 host 权限（跨域 fetch 不受 CORS 限制）
 * 职责：
 *  1) 单文件下载写入用户自定义文件夹（File System Access API）
 *  2) 多张下载：抓取全部媒体 -> 打包 zip -> 写入自定义文件夹，
 *     未设置自定义文件夹时返回 dataUrl 交给 chrome.downloads 下载
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  (async () => {
    try {
      if (msg.action === "zip") {
        sendResponse(await handleZip(msg));
        return;
      }
      if (msg.action === "probe-media") {
        sendResponse(await probeMedia(msg));
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

/* ---------------- 媒体探测 ----------------
 * 微博图片按「路径首段」区分尺寸，很多图并没有 orj1080 / large 档，直接访问会返回
 * 404 的 HTML；Chrome 识别到内容是 HTML 就把后缀改成 .htm（历史 bug）。
 * 这里先用 4KB Range 请求拿文件头与 Content-Type，确认是真媒体并识别真实格式，
 * 再把「可用地址 + 正确后缀」交回 background 去下载。
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

async function probeMedia(msg) {
  const kind = msg.kind === "video" ? "video" : "image";
  const list = Array.isArray(msg.candidates) ? msg.candidates : [];
  const tried = [];

  for (const raw of list) {
    const url = typeof raw === "string" ? raw : raw && raw.url;
    if (!url || !/^https?:/i.test(url)) continue;
    try {
      const resp = await fetch(url, {
        credentials: "omit",
        cache: "no-store",
        headers: { Range: "bytes=0-" + (RANGE_BYTES - 1) }
      });
      if (!resp.ok) {
        tried.push({ url, status: resp.status });
        continue;
      }
      const ct = resp.headers.get("content-type") || "";
      const sniff = sniffMedia(await readPrefix(resp, RANGE_BYTES), ct);
      if (!sniff || sniff.kind !== kind) {
        tried.push({ url, status: resp.status, type: ct || "unknown" });
        continue;
      }
      return { ok: true, url, ext: sniff.ext, mime: sniff.mime || ct, tried };
    } catch (e) {
      tried.push({ url, error: String(e && e.message ? e.message : e) });
    }
  }
  return { ok: false, error: "media-blocked", tried };
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
