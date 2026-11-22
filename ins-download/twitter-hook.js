/* twitter-hook.js — 在页面自己的 JS 环境（MAIN world）里旁听 X 的数据请求
 *
 * 为什么需要它：
 *   X 的推文数据（含 video_info.variants 里全部码率的 mp4 直链）是页面自己通过
 *   GraphQL 拿的。内容脚本在隔离世界里读不到页面的 JS 变量，也拿不到响应体，
 *   所以这里在最早期（document_start）包一层 fetch / XMLHttpRequest，
 *   把带媒体的响应**克隆一份**解析出来，按推文 id 存进本地缓存。
 *
 * 约束（很重要）：
 *   - 只旁听，绝不改动请求与响应：原始 Promise / Response / XHR 原样返回，
 *     解析放在 side branch 里，任何异常都吞掉。X 自己的逻辑完全不受影响。
 *   - 只处理 JSON 响应，且先用字符串粗筛（extended_entities / video_info）
 *     再解析，避免为了几百 KB 的无关响应做无谓的 JSON.parse。
 *   - 缓存有上限（MAX 条），超出按插入顺序淘汰，长时间挂机不会吃内存。
 *
 * 与内容脚本的约定（window.postMessage，跨隔离世界）：
 *   问：{ __xdl: "query", id: "<tweetId>", reqId }
 *   答：{ __xdl: "media", id, reqId, media: [{ type, url, variants }] | null }
 */
(function () {
  "use strict";

  const CACHE = new Map(); // tweetId -> [{type,url,variants}]
  const MAX = 200;
  const MAX_TEXT = 8 * 1024 * 1024;
  const NEED = ["extended_entities", "video_info", "media_url_https"];
  const URL_RE = /graphql|\/i\/api\/|TweetResult|TweetDetail|UserTweets|UserMedia|SearchTimeline|HomeTimeline|ListLatestTweets/i;

  function normMedia(m) {
    if (!m || typeof m !== "object") return null;
    const type = String(m.type || "");
    if (!type) return null;
    return {
      type: type,
      url: m.media_url_https || "",
      variants: (m.video_info && m.video_info.variants) || null
    };
  }

  /* 广度遍历 JSON，找出「带 legacy.extended_entities.media 的推文对象」。
   * GraphQL 的响应结构层层嵌套（timeline → instructions → entries → …），
   * 直接递归找 rest_id + media 比记结构稳得多，也不怕 X 改包裹层。 */
  function collect(root) {
    const found = new Map();
    const stack = [{ v: root, d: 0 }];
    let seen = 0;
    while (stack.length) {
      const cur = stack.pop();
      const v = cur.v;
      if (!v || typeof v !== "object") continue;
      if (cur.d > 14) continue;
      if (++seen > 40000) break;

      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push({ v: v[i], d: cur.d + 1 });
        continue;
      }

      const legacy = v.legacy && typeof v.legacy === "object" ? v.legacy : null;
      const id = v.rest_id || (legacy && legacy.id_str) || "";
      if (id) {
        const ext = legacy && legacy.extended_entities;
        const ent = legacy && legacy.entities;
        const media =
          (ext && Array.isArray(ext.media) && ext.media) ||
          (ent && Array.isArray(ent.media) && ent.media) ||
          null;
        if (media && media.length) {
          const list = [];
          for (const m of media) {
            const n = normMedia(m);
            if (n) list.push(n);
          }
          if (list.length) found.set(String(id), list);
        }
      }

      for (const k in v) {
        const c = v[k];
        if (c && typeof c === "object") stack.push({ v: c, d: cur.d + 1 });
      }
    }
    return found;
  }

  function trim() {
    while (CACHE.size > MAX) {
      const first = CACHE.keys().next();
      if (first.done) return;
      CACHE.delete(first.value);
    }
  }

  function scanText(text) {
    if (!text || text.length > MAX_TEXT) return;
    let hit = false;
    for (const k of NEED) {
      if (text.indexOf(k) >= 0) {
        hit = true;
        break;
      }
    }
    if (!hit) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return; // 非 JSON（或已被截断）：静默放弃
    }
    const found = collect(json);
    if (!found.size) return;
    for (const [id, media] of found) CACHE.set(id, media);
    trim();
  }

  function shouldScan(url) {
    return typeof url === "string" && URL_RE.test(url);
  }

  /* ---------- fetch ---------- */
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input) {
        const p = origFetch.apply(this, arguments);
        try {
          const url = typeof input === "string" ? input : input && input.url;
          if (shouldScan(url) && p && typeof p.then === "function") {
            p.then((resp) => {
              try {
                if (!resp || !resp.ok || !resp.clone) return;
                const ct = (resp.headers && resp.headers.get("content-type")) || "";
                if (ct && ct.indexOf("json") < 0) return;
                resp
                  .clone()
                  .text()
                  .then(scanText)
                  .catch(() => {});
              } catch (e) {
                /* 旁听失败不影响页面 */
              }
            }).catch(() => {});
          }
        } catch (e) {
          /* ignore */
        }
        return p;
      };
    }
  } catch (e) {
    /* 页面锁定 fetch 时放弃这一层（还有 syndication 接口与 DOM 兜底） */
  }

  /* ---------- XMLHttpRequest（X 现在主用 fetch，这里只作保险） ---------- */
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try {
          this.__xdlUrl = url;
        } catch (e) {
          /* ignore */
        }
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        try {
          this.addEventListener("load", () => {
            try {
              if (!shouldScan(this.__xdlUrl)) return;
              const rt = this.responseType;
              if (rt && rt !== "text" && rt !== "json") return;
              const text = rt === "json" ? JSON.stringify(this.response) : this.responseText;
              scanText(text);
            } catch (e) {
              /* ignore */
            }
          });
        } catch (e) {
          /* ignore */
        }
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {
    /* ignore */
  }

  /* ---------- 与内容脚本的问答通道 ---------- */
  try {
    window.addEventListener("message", (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.__xdl !== "query" || !d.id) return;
      const media = CACHE.get(String(d.id)) || null;
      try {
        window.postMessage(
          { __xdl: "media", id: String(d.id), reqId: d.reqId, media },
          "*"
        );
      } catch (e) {
        /* ignore */
      }
    });
  } catch (e) {
    /* ignore */
  }

  // 诊断用：页面控制台（默认 world）里执行 __xdlPeek("tweetId")
  try {
    window.__xdlPeek = (id) => (id ? CACHE.get(String(id)) || null : Array.from(CACHE.keys()));
  } catch (e) {
    /* ignore */
  }
})();
