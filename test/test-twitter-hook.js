/* 回归测试：加载 twitter-hook.js，验证
 *   1) 能从嵌套很深的 GraphQL 响应里翻出「推文 id + 媒体实体」
 *   2) 与内容脚本的 postMessage 问答通道（问 → 答 / 未命中回 null）
 *   3) 只旁听、不改变原请求：fetch 的返回值必须原样透传
 * 运行：node test/test-twitter-hook.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(
  path.join(__dirname, "..", "ins-download", "twitter-hook.js"),
  "utf8"
);

const posted = [];
let fetchCalls = 0;
let messageHandlers = [];

// 模拟 GraphQL UserTweets：entries 里嵌 instruction，再嵌 tweet_results
const payload = {
  data: {
    user: {
      result: {
        timeline_v2: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  {
                    entryId: "tweet-1700000000000000001",
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: "1700000000000000001",
                            legacy: {
                              id_str: "1700000000000000001",
                              full_text: "hi",
                              extended_entities: {
                                media: [
                                  {
                                    type: "photo",
                                    media_url_https: "https://pbs.twimg.com/media/GX1abc?format=jpg&name=small"
                                  },
                                  {
                                    type: "video",
                                    media_url_https: "https://pbs.twimg.com/amplify_video_thumb/1/img/x.jpg",
                                    video_info: {
                                      variants: [
                                        {
                                          bitrate: 632000,
                                          content_type: "video/mp4",
                                          url: "https://video.twimg.com/v/632.mp4"
                                        },
                                        {
                                          content_type: "application/x-mpegURL",
                                          url: "https://video.twimg.com/pl/x.m3u8"
                                        },
                                        {
                                          bitrate: 2176000,
                                          content_type: "video/mp4",
                                          url: "https://video.twimg.com/v/2176.mp4"
                                        }
                                      ]
                                    }
                                  }
                                ]
                              }
                            }
                          }
                        }
                      }
                    }
                  },
                  {
                    entryId: "cursor-bottom",
                    content: { cursorType: "Bottom", value: "abc" }
                  }
                ]
              }
            ]
          }
        }
      }
    }
  }
};

function jsonResponse(obj) {
  const text = JSON.stringify(obj);
  return {
    ok: true,
    headers: { get: (k) => (k === "content-type" ? "application/json" : null) },
    clone: () => ({ text: () => Promise.resolve(text) }),
    text: () => Promise.resolve(text)
  };
}

const sandbox = {
  console,
  JSON,
  setTimeout,
  clearTimeout,
  fetch: (url) => {
    fetchCalls++;
    if (String(url).indexOf("graphql") < 0) {
      return Promise.resolve({
        ok: true,
        headers: { get: () => "text/html" },
        clone: () => ({ text: () => Promise.resolve("<html>") })
      });
    }
    return Promise.resolve(jsonResponse(payload));
  },
  XMLHttpRequest: class {
    open() {}
    send() {}
    addEventListener() {}
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.addEventListener = (type, fn) => {
  if (type === "message") messageHandlers.push(fn);
};
sandbox.window.postMessage = (data) => {
  posted.push(data);
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "twitter-hook.js" });
// 沙箱里的 window 是 context 化的全局对象，与外层 sandbox 不是同一个引用，
// 模拟事件时必须用它，才能通过 hook 里的 `ev.source !== window` 校验
const pageWindow = vm.runInContext("window", sandbox);

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
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  console.log("== 1. 抓取 GraphQL 响应并解析 ==");
  const resp = await sandbox.fetch("https://x.com/i/api/graphql/abc/UserTweets?x=1");
  await tick();
  check("原响应原样返回（旁听不改写）", resp.ok, true);
  const cached = sandbox.window.__xdlPeek("1700000000000000001");
  check("解析出 2 个媒体实体", cached && cached.length, 2);
  check("图片实体带 url", cached[0].url, "https://pbs.twimg.com/media/GX1abc?format=jpg&name=small");
  check("视频实体带 variants", cached[1].variants.length, 3);
  check("variants 含最高码率", cached[1].variants[2].bitrate, 2176000);

  console.log("== 2. 非 API 请求不解析 ==");
  await sandbox.fetch("https://x.com/home");
  await tick();
  check("只抓了一次 API（列表里没有多余 key）", sandbox.window.__xdlPeek().length, 1);

  console.log("== 3. 问答通道：命中 ==");
  check("注册了 message 监听", messageHandlers.length, 1);
  posted.length = 0;
  messageHandlers[0]({
    source: pageWindow,
    data: { __xdl: "query", id: "1700000000000000001", reqId: "r1" }
  });
  await tick();
  check("回了一条消息", posted.length, 1);
  check("消息类型是 media", posted[0].__xdl, "media");
  check("带上原 reqId", posted[0].reqId, "r1");
  check("带回媒体数组", posted[0].media.length, 2);

  console.log("== 4. 问答通道：未命中回 null ==");
  posted.length = 0;
  messageHandlers[0]({ source: pageWindow, data: { __xdl: "query", id: "999", reqId: "r2" } });
  await tick();
  check("回 null", posted[0].media, null);
  check("reqId 仍然对得上", posted[0].reqId, "r2");

  console.log("== 5. 非本协议的 message 不回应 ==");
  posted.length = 0;
  messageHandlers[0]({ source: pageWindow, data: { hello: "world" } });
  messageHandlers[0]({ source: {}, data: { __xdl: "query", id: "1700000000000000001", reqId: "r3" } });
  await tick();
  check("一律忽略", posted.length, 0);

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
