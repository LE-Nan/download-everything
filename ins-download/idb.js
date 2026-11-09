/* 共享 IndexedDB 助手：存取用户选择的文件夹句柄（FileSystemDirectoryHandle） */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ins-download-db", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const t = db.transaction("handles", "readwrite");
    t.objectStore("handles").put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction("handles").objectStore("handles").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const t = db.transaction("handles", "readwrite");
    t.objectStore("handles").delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
