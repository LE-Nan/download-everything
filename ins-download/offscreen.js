/* offscreen document：有 DOM 环境且带 host 权限（跨域 fetch 不受 CORS 限制）
 * 职责：
 *  1) 单文件下载写入用户自定义文件夹（File System Access API）
 *  2) 多张下载：抓取全部媒体 -> 打包 zip -> 写入自定义文件夹，
 *     未设置自定义文件夹时返回 dataUrl 交给 chrome.downloads 下载
 *  3) 微博：取回真实媒体字节后交回 background（写盘 / blob URL / dataUrl），
 *     避免浏览器自己去拉地址时被 CDN 的 HTML 错误页改掉后缀
 *  4) 可中断：每个带 progressId 的任务配一个 AbortController，background 收到
 *     取消请求就 forward 过来，正在进行的 fetch 会立刻断开（不再白下几十 MB）
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  (async () => {
    try {
      if (msg.action === "abort") {
        sendResponse(abortJob(msg.progressId));
        return;
      }
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

/* ---------------- 任务中断（用户再次点按钮 = 取消）----------------
 * 一个 progressId 对应一个任务。content script 在下载按钮上再点一次时，
 * background 会发 action:"abort"，这里把对应任务的 AbortController 断掉：
 *   - 正在 fetch 的取字节请求 → 立刻中止，不再继续消耗流量
 *   - 正在读流 / 打包 → 读循环里发现 aborted 主动退出
 * 取消结果统一用 { ok:false, error:"aborted" } 表示，上层据此静默收尾
 * （不弹红条、不重试），和「用户自己要取消」的语义保持一致。
 *
 * pendingAborts 处理时序：取消消息有可能比任务本身先到（连点两下按钮），
 * 这时先把 pid 记下来，等真正建 controller 时立刻中止，避免"取消无效"。
 */
const controllers = new Map(); // progressId -> AbortController
const pendingAborts = new Set(); // 取消先于任务到达

function controllerFor(pid) {
  if (!pid) return null;
  const exist = controllers.get(pid);
  if (exist) return exist;
  const ac = new AbortController();
  controllers.set(pid, ac);
  if (pendingAborts.delete(pid)) ac.abort();
  return ac;
}

function releaseController(pid) {
  if (!pid) return;
  controllers.delete(pid);
  pendingAborts.delete(pid);
}

function abortJob(pid) {
  if (!pid) return { ok: false, error: "no-progress-id" };
  const ac = controllers.get(pid);
  if (ac) {
    ac.abort();
    return { ok: true, had: true };
  }
  pendingAborts.add(pid);
  // 任务一直没来（或早已结束）时别让集合无限增长
  setTimeout(() => pendingAborts.delete(pid), 60000);
  return { ok: true, had: false };
}

function abortedError(tried) {
  return { ok: false, error: "aborted", tried: tried || [] };
}

// 让读循环抛出与 fetch 一致的 AbortError，被同一处 catch 识别
function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

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

/* 边下边报进度：background 收到后转发给发起下载的标签页，内容脚本据此画进度环。
 * 只带字节数，不带内容，开销可以忽略；没有 progressId 时（ins 侧）完全静默。
 */
function reportProgress(pid, loaded, total) {
  if (!pid) return;
  try {
    chrome.runtime.sendMessage(
      { action: "wb-fetch-progress", progressId: pid, loaded: loaded || 0, total: total || 0 },
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    /* 扩展上下文已失效，忽略 */
  }
}

function joinHead(head, chunk) {
  if (!head || !head.length) return chunk;
  const out = new Uint8Array(head.length + chunk.length);
  out.set(head, 0);
  out.set(chunk, head.length);
  return out;
}

/* 读取完整响应体，边读边回报进度。
 * 先攒够 64 字节就嗅探文件头：不是媒体（HTML 错误页 / JSON）立刻断开，
 * 不会为了一个 403 页面把几十 MB 的错误页拖下来。
 * signal 被 abort 时抛 AbortError —— 上层据此判定「用户取消」，不再尝试下一个候选。
 */
async function readAllWithProgress(resp, kind, onProgress, signal) {
  const ct = resp.headers.get("content-type") || "";
  const total = Number(resp.headers.get("content-length")) || 0;

  // 没有可读流（旧环境 / 测试桩）：退化成一次性读取，不报中间进度
  if (!resp.body || !resp.body.getReader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    const sniff = sniffMedia(buf.subarray(0, Math.min(buf.length, RANGE_BYTES)), ct);
    if (!sniff || sniff.kind !== kind) return { bad: true, ct };
    if (onProgress) onProgress(buf.length, total || buf.length);
    return { blob: new Blob([buf], { type: ct }), sniff, ct, size: buf.length };
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  let head = new Uint8Array(0);
  let sniff = null;
  let lastAt = 0;

  for (;;) {
    // 有些环境的 fetch 不会因为 abort 而让 read() 立刻抛错，这里再兜一层
    if (signal && signal.aborted) {
      try {
        await reader.cancel();
      } catch (e) {
        /* 已结束 */
      }
      throw abortError();
    }
    const step = await reader.read();
    if (step.done) break;
    const chunk = step.value;
    if (!chunk || !chunk.length) continue;
    chunks.push(chunk);
    loaded += chunk.length;

    if (!sniff) {
      head = joinHead(head, chunk);
      if (head.length >= 64) {
        sniff = sniffMedia(head.subarray(0, Math.min(head.length, RANGE_BYTES)), ct);
        if (!sniff || sniff.kind !== kind) {
          try {
            await reader.cancel();
          } catch (e) {
            /* 已结束 */
          }
          return { bad: true, ct };
        }
      }
    }

    const now = Date.now();
    if (onProgress && now - lastAt > 120) {
      lastAt = now;
      onProgress(loaded, total);
    }
  }

  if (!sniff) {
    sniff = sniffMedia(head.subarray(0, Math.min(head.length, RANGE_BYTES)), ct);
    if (!sniff || sniff.kind !== kind) return { bad: true, ct };
  }
  if (onProgress) onProgress(loaded, total || loaded);

  return { blob: new Blob(chunks, { type: ct }), sniff, ct, size: loaded };
}

/* 逐个候选地址试探，返回第一个「真能拿到该类型媒体字节」的地址。
 * full=false 只读 4KB（探测用）；full=true 取完整内容（真正保存用）。
 * 无论哪种模式，HTML/JSON 错误页都会被 sniffMedia 判为「不是媒体」而跳过。
 * full 模式走流式读取：一边下一边把已取字节数报给上层画进度环。
 * signal 存在时一旦被 abort，立刻返回 aborted —— 不能继续试下一个候选，
 * 否则用户点了取消还在后台挨个地址拉。
 */
async function fetchFirstMedia(candidates, kind, full, onProgress, signal) {
  const list = Array.isArray(candidates) ? candidates : [];
  const tried = [];

  for (const raw of list) {
    if (signal && signal.aborted) return abortedError(tried);
    const url = typeof raw === "string" ? raw : raw && raw.url;
    if (!url || !/^https?:/i.test(url)) continue;
    try {
      const init = { credentials: "omit", cache: "no-store" };
      if (signal) init.signal = signal;
      if (!full) init.headers = { Range: "bytes=0-" + (RANGE_BYTES - 1) };
      const resp = await fetch(url, init);
      if (!resp.ok) {
        tried.push({ url, status: resp.status });
        continue;
      }
      const ct = resp.headers.get("content-type") || "";

      if (full) {
        const got = await readAllWithProgress(resp, kind, onProgress, signal);
        if (got.bad) {
          tried.push({ url, status: resp.status, type: got.ct || "unknown" });
          continue;
        }
        return {
          ok: true,
          url,
          blob: got.blob,
          ext: got.sniff.ext,
          mime: got.sniff.mime || got.ct,
          size: got.size,
          tried
        };
      }

      const head = await readPrefix(resp, RANGE_BYTES);
      const sniff = sniffMedia(head, ct);
      if (!sniff || sniff.kind !== kind) {
        tried.push({ url, status: resp.status, type: ct || "unknown" });
        continue;
      }
      return { ok: true, url, blob: null, ext: sniff.ext, mime: sniff.mime || ct, size: 0, tried };
    } catch (e) {
      if (signal && signal.aborted) return abortedError(tried);
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
  const pid = msg.progressId || null;
  const ac = controllerFor(pid);
  const signal = ac ? ac.signal : null;

  try {
    if (signal && signal.aborted) return abortedError();
    const got = await fetchFirstMedia(
      msg.candidates,
      kind,
      true,
      (loaded, total) => reportProgress(pid, loaded, total),
      signal
    );
    if (!got.ok) return got;
    // 字节刚取完就被取消：不建 blob、不写盘，直接收尾
    if (signal && signal.aborted) return abortedError(got.tried);

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
  } finally {
    releaseController(pid);
  }
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
  // progressId：微博侧传，每取完一项回报一次（进度环按项数走）；ins 侧不传则完全静默
  const prefix = msg.prefix || "ins_";
  const pid = msg.progressId || null;
  const total = Array.isArray(msg.items) ? msg.items.length : 0;
  const ac = controllerFor(pid);
  const signal = ac ? ac.signal : null;
  const files = [];
  try {
    for (let i = 0; i < msg.items.length; i++) {
      // 打包也是一项一项取，取消时立刻停手，不把剩下的全拉完
      if (signal && signal.aborted) return abortedError();
      const item = msg.items[i];
      const cands =
        Array.isArray(item.candidates) && item.candidates.length ? item.candidates : [item.url];
      let got = null;
      for (const c of cands) {
        if (signal && signal.aborted) return abortedError();
        const url = typeof c === "string" ? c : c && c.url;
        if (!url || !/^https?:/i.test(url)) continue;
        try {
          const init = { credentials: "omit" };
          if (signal) init.signal = signal;
          const resp = await fetch(url, init);
          if (!resp.ok) continue; // 跳过失败项，不中断整包
          const buf = new Uint8Array(await resp.arrayBuffer());
          const sniff = msg.sniffExt
            ? sniffMedia(buf.subarray(0, Math.min(buf.length, RANGE_BYTES)), resp.headers.get("content-type"))
            : null;
          if (msg.sniffExt && !sniff) continue; // 拿到的是 HTML 错误页，换下一个候选
          got = { buf, ext: sniff ? sniff.ext : item.type === "video" ? "mp4" : "jpg" };
          break;
        } catch (e) {
          if (signal && signal.aborted) return abortedError();
          /* 换下一个候选 */
        }
      }
      if (got) files.push({ name: prefix + String(i + 1).padStart(2, "0") + "." + got.ext, data: got.buf });
      if (pid) reportProgress(pid, i + 1, total);
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
  } finally {
    releaseController(pid);
  }
}
