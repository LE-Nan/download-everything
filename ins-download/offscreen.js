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
      sendResponse(await handleSingle(msg));
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();

  return true;
});

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
  const prefix = msg.prefix || "ins_";
  const files = [];
  for (let i = 0; i < msg.items.length; i++) {
    const item = msg.items[i];
    const resp = await fetch(item.url, { credentials: "omit" });
    if (!resp.ok) continue; // 跳过失败项，不中断整包
    const buf = new Uint8Array(await resp.arrayBuffer());
    const ext = item.type === "video" ? "mp4" : "jpg";
    files.push({ name: prefix + String(i + 1).padStart(2, "0") + "." + ext, data: buf });
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
