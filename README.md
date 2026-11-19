<div align="center">

<img src="ins-download/icons/icon128.png" width="88" alt="ins download">

# ins download

**Instagram + 微博 网页端图片 / 视频一键下载 Chrome 扩展**

在动态卡片旁注入一个下载按钮，点一下就把原图、原视频静默存到你自己指定的文件夹——不弹另存为、不跳转、不打断浏览。

![Manifest](https://img.shields.io/badge/Manifest-V3-405DE6?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-109%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-1.1.0-2ECC71?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)

</div>

---

## 支持站点

| 站点 | 图片 | 视频 | 多图打包 | 独立目录 / 清晰度 |
| --- | --- | --- | --- | --- |
| **Instagram** `instagram.com` | ✅ 含全部轮播项 | ✅ Reels 与视频帖 | ✅ | ✅ |
| **微博** `weibo.com` | ✅ 九宫格全部 | ✅ 高清 / 标清 | ✅ | ✅ |

两个站点的功能实现**完全独立**：独立的 DOM 适配层、独立的取址链路、独立的按钮样式、独立的存储键。任何一个站点的改版或出错都不会影响另一个。

## 它解决什么问题

Instagram 网页端没有下载按钮。右键"图片另存为"只能拿到被压缩过的缩略图，视频则根本拿不到——播放器里的视频是 blob 流，`video.src` 是 `blob:https://www.instagram.com/...`，复制不出来。

微博这边问题不同：图能右键，但默认给你的是 `orj360`（360px 宽）的压缩图；视频同样是 blob 流，而且九宫格里的图往往要一张张点。

**ins download** 绕开了这两件事：它向站点自己的内部接口要数据，直接拿到该条内容的**全部媒体项**和**每一档清晰度**的真实 CDN 地址，然后按你设置的分辨率下载。

## 功能

| 能力 | 说明 |
| --- | --- |
| 🖼 **图片下载** | 单图、多图轮播、九宫格都支持，按设置的分辨率取档 |
| 🎬 **视频下载** | 拿到真实 mp4 地址（不是 blob），支持 Reels、视频帖、微博视频 |
| 🎠 **轮播 / 九宫格全量** | 一条 10 图的帖子能取到全部 10 项，不受页面懒加载限制（DOM 里通常只渲染 2~3 张） |
| 📦 **打包 zip** | 多图一键打包为单个 zip，避免连点 10 次"另存为" |
| 📁 **自定义目录** | 选一次文件夹，之后静默写入，全程零弹窗；图片与视频可分别设目录 |
| ⚙️ **分辨率可选** | Instagram：240P~4K；微博：360P / 690P / 1080P / 原图 |
| 🎛 **站点独立开关** | popup 里 Instagram 与微博各自一个开关，互不影响 |
| 🧩 **零依赖** | 纯原生 JS，无构建、无 npm，克隆即用 |

## 安装

本扩展未上架 Chrome 应用商店，使用开发者模式本地加载：

1. 下载或克隆本仓库
   ```bash
   git clone https://github.com/LE-Nan/instagram-downloader.git
   ```
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 右上角打开 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择仓库里的 **`ins-download`** 文件夹
5. 打开 [instagram.com](https://www.instagram.com) 或 [weibo.com](https://weibo.com)，进入信息流，每条内容旁会出现下载按钮

> 需要 Chrome 109+（依赖 `chrome.offscreen` 与 File System Access API）。旧版浏览器请参考下面的"降级行为"。
>
> 从 1.0.0 升级到 1.1.0 时新增了微博域名权限，Chrome 可能提示"扩展已更新，需要接受新权限"，重新加载一次即可。

## 使用

### Instagram

鼠标移到任意动态卡片上，卡片**右侧外部**会出现一个圆形下载按钮，点击即可。

- 单图 / 单视频动态 → 直接开始下载，按钮变绿表示成功，变红表示失败
- 多图轮播动态 → 弹出两个选项：
  - **下载单张（当前显示）** — 只下轮播里当前滑到的那一张
  - **下载多张（全部 N 项，打包 zip）** — 全部打包成一个 zip

### 微博

微博操作一致：每条微博卡片**右侧**出现同样的圆形按钮（悬停时变微博橙）。

- 单图 / 单视频 → 直接下载
- 九宫格 / 多图 → 弹出两个选项：**只下载第 1 项** 或 **全部下载（N 项，打包 zip）**

按钮位置会自动收进视口内，不会飘到右侧栏上。若某条微博没出现按钮，按 F12 在控制台执行 `__wbDl.debug()` 可以看到它为什么没被识别（详见下面的"调试"）。

### 设置保存位置

点击工具栏图标 → **打开设置**。设置页分三块：Instagram 图片、Instagram 视频、微博，全部互不影响。

| 设置项 | 可选值 | 说明 |
| --- | --- | --- |
| Instagram 图片位置 / 分辨率 | 自定义文件夹；240P ~ 4K | 默认 `下载\ins-download\images` |
| Instagram 视频位置 / 清晰度 | 自定义文件夹；240P ~ 4K | 默认 `下载\ins-download\videos` |
| 微博图片位置 | 自定义文件夹 / 默认 | 默认 `下载\weibo-download\images` |
| 微博图片清晰度 | 360P / 690P / 1080P / 原图 | 微博按尺寸路径存取，原图不压缩 |
| 微博视频位置 | 自定义文件夹 / 默认 | 默认 `下载\weibo-download\videos` |
| 微博视频清晰度 | 高清 / 标清 | 微博接口通常只给这两档 |

**关于自定义文件夹**：点击"选择文件夹"弹出的系统窗口里挑任意目录，之后所有下载静默写入，不会再有任何确认框。目录句柄存在 IndexedDB 里。

> ⚠️ **浏览器重启后授权会失效**（File System Access API 的固有安全限制），设置页会提示"需要重新授权"，点一下 **重新授权** 重新选一次同一目录即可，已下载文件不受影响。

### 降级行为

如果没有选过自定义文件夹，扩展走 `chrome.downloads`，文件落到浏览器默认下载目录的子文件夹里。这条路径在部分浏览器设置下可能仍会弹一次保存框——这是浏览器行为，不是扩展能绕过的。

## 工作原理

### 整体架构

```
┌───────── Instagram 页面 ─────────┐   ┌────────── 微博页面 ──────────┐
│ content.js（隔离世界）            │   │ weibo.js（隔离世界）          │
│  ├─ 扫 article                    │   │  ├─ 扫 img/video，向上找 [mid] │
│  ├─ shortcode → media id          │   │  ├─ mid → /ajax/statuses/show │
│  └─ /api/v1/media/{id}/info/      │   │  └─ DOM 兜底                  │
└───────────────┬──────────────────┘   └──────────────┬───────────────┘
                │ 消息带 site: "ins" / "weibo"         │
                └───────────────┬──────────────────────┘
┌───────────────────────────────▼──────────────────────────────┐
│  background.js（service worker）—— 按 site 路由到独立配置      │
│   ├─ 有自定义目录 → 转交 offscreen                             │
│   └─ 无自定义目录 → chrome.downloads（saveAs:false）           │
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────┐
│  offscreen.html / offscreen.js（有 DOM、带 host 权限）         │
│   ├─ 跨域 fetch 媒体（不受 CORS 限制）                         │
│   ├─ File System Access 直接写盘                              │
│   └─ zip.js（store 模式）打包 → 写盘 / 回传 dataUrl            │
└──────────────────────────────────────────────────────────────┘
```

两个内容脚本**互不 import、互不共享变量**。background 里只有两行前置判断把微博消息分流出去，Instagram 的原有代码路径逐字未改。

### 媒体地址解析：五级降级

这是整个扩展最核心的部分。Instagram 的页面结构对下载极不友好：轮播图**懒加载**（DOM 里只有当前 2~3 张）、视频是 **blob 流**、公开的 `?__a=1` 接口**早已被下线**。所以取址按可靠性从高到低依次尝试：

| 优先级 | 手段 | 能拿到什么 |
| --- | --- | --- |
| 1 | `/api/v1/media/{id}/info/` | **全部轮播项** + `image_versions2.candidates` / `video_versions` 多档清晰度 |
| 2 | `?__a=1&__d=dis` | 同上（现多被拦，保留兼容） |
| 3 | `/p/{sc}/embed/captioned/` | 正则从 HTML 提取 `display_url` / `video_url` |
| 4 | `/p/{sc}/` 帖子页 HTML | 同上 |
| 5 | DOM 兜底 | 当前已渲染的媒体（轮播可能不全） |

第 1 级需要两个关键细节：

- **shortcode → media id**：Instagram 的短码是 base64 变体编码的 64 位整数，用字符表 `A-Za-z0-9-_` 逐位解出数字 ID，再请求 `/api/v1/media/{id}/info/`。
- **必须带 `X-IG-App-ID: 936619743392459` 请求头**，否则接口返回 400。这是 IG 网页版自己的 App ID。

结果按 shortcode 缓存，同一条动态重复点击不会重复请求。

### 微博媒体地址解析

微博的难点不是接口被拦，而是**识别**：信息流是 Vue 虚拟滚动，外层容器类名随构建变化，九宫格图片还是懒加载（`src` 常是占位图）。所以只依赖两样稳定物：

- **`mid` 属性**——每条微博的容器上都带，微博自己的 JS 全程依赖它，改版风险最低
- **`sinaimg.cn` 域名 + 路径首段的尺寸标记**——`/orj360/`、`/mw690/`、`/orj1080/`、`/large/`

扫描时用通用选择器抓 `img` / `video`，再向上找最近的 `[mid]` 容器，把媒体按容器分组，一条微博一个按钮。即使信息流 DOM 结构大改，只要 `mid` 还在按钮就挂得上。

| 优先级 | 手段 | 能拿到什么 |
| --- | --- | --- |
| 1 | `/ajax/statuses/show?id={mid}` | `pics[]` 全部九宫格 + `page_info.media_info` 的高清/标清流 |
| 2 | DOM 兜底 | 当前已渲染的 `img` / `video`（视频若是 blob 流则取不到） |

清晰度不是"多档资源列表"，而是**同一条 URL 换路径首段**：

```
https://wx1.sinaimg.cn/orj360/006abc.jpg    ← 页面默认给 360
https://wx1.sinaimg.cn/mw690/006abc.jpg     ← 690
https://wx1.sinaimg.cn/large/006abc.jpg     ← 原图
```

首段不在白名单时一律不改写——头像（`crop.0.0.180…`）和表情（`m/emoticon`）正是靠这条规则被排除掉的。

### 按钮为什么挂在 body 上

早期的实现把按钮塞进 `article` 里、定位在媒体右上角，遇到两个问题：

1. **被视频的透明交互层吃掉点击** —— IG 在视频上盖了一层全屏 `<div>` 处理播放/暂停，`z-index` 再高也在它的层叠上下文里。
2. **和原生 `···` 菜单按钮重叠**。

最终的方案：按钮挂在 `document.body` 下，`position: fixed` + `z-index: 2147483647`，用 `getBoundingClientRect()` 跟随卡片位置，`scroll` / `resize` / `MutationObserver` 触发时经 `requestAnimationFrame` 批量重定位。按钮放在卡片**右侧外部**，彻底避开卡片内的所有交互元素。

## 目录结构

```
ins-download/                 ← 加载扩展时选这个文件夹
├── manifest.json             MV3 清单
├── content.js                Instagram：注入按钮、解析媒体、弹菜单（核心）
├── content.css               Instagram 按钮 / 菜单 / 错误提示条样式
├── weibo.js                  微博：同上，但选择器与取址链路完全独立（Adapter 在文件顶部）
├── weibo.css                 微博按钮 / 菜单样式（.wb-dl-* 前缀，互不覆盖）
├── background.js             service worker：按 site 路由下载调度
├── offscreen.html            离屏文档（跑 DOM + 跨域 fetch）
├── offscreen.js              写盘、抓取、打包
├── zip.js                    zip 打包（store 模式，零依赖）
├── idb.js                    IndexedDB 助手（存目录句柄）
├── options.html / options.js 设置页（Instagram / 微博 各一组）
├── popup.html / popup.js     工具栏弹窗（两个独立开关）
├── icons/                    16 / 48 / 128 图标
└── (仓库根) test/            回归测试，node 直跑，无依赖
```

## 调试

打开页面 DevTools → Console，**把上下文切到本扩展**（下拉框里选 `ins download`），按站点执行：

| 站点 | 命令 | 作用 |
| --- | --- | --- |
| 微博 | `__wbDl.debug()` | 打印识别到的每条微博：mid、容器类名、媒体数 |
| 微博 | `__wbDl.checkImage("图片地址")` | 看该地址是否被判为正文配图、各档清晰度的样子 |
| 微博 | `__wbDl.clearCache()` | 清掉按 mid 缓存的接口结果，强制重新请求 |
| 通用 | `chrome://extensions` → 本扩展 → **检查视图 service worker** | 看后台下载调度与 offscreen 的报错 |

微博侧还有 `[weibo download]` 前缀的日志，会打出每条 mid 实际取到多少媒体。**站点改版时优先看这个**：如果日志里 `取到媒体数 0`，说明接口变了，改 `weibo.js` 顶部的 `SEL` 或 `parseStatusMedia` 即可，其余逻辑不用动。

## 已知限制

诚实地列出做不好的地方：

1. **Instagram 只覆盖信息流 `article`**。帖子详情页 `/p/xxx/`、Reels 独立页、Story、私信、个人主页九宫格**目前都没有按钮**。
2. **含视频的轮播打包会落到图片目录**（仅 Instagram）。`handleZip` 里只读了 `imageDir`；微博侧已按内容类型分目录。
3. **超大 zip 有内存风险**。默认目录模式下 zip 会转成 dataUrl 字符串跨上下文传递，包体超过 ~100MB 时容易失败。
4. **视频清晰度选档不精确**（仅 Instagram）。`video_versions[].width` 常为 0，实际会退化为取数组末项。
5. **Instagram 动画 / Story 的媒体**未做支持。
6. **微博的选择器与接口未在真实登录态下实测**。开发环境无法访问微博，`weibo.js` 的 `SEL` 与 `parseStatusMedia` 是按接口文档与页面结构推断的。首次使用若没按钮或不下载，请先看 `__wbDl.debug()` 与控制台日志，通常只需改这两处。
7. **微博只覆盖信息流与列表页**。微博的「图片查看器」浮层（点开大图后的全屏浏览）、「视频号」独立页、头条文章、私信、Story 类内容未接。
8. **微博转发微博**取的是被转发那条的媒体（部分场景会同时取到转发者自带的配图）。
9. 站点改版可能导致解析链失效，Instagram 改 `content.js`，微博改 `weibo.js`。

## 合规与免责

- 本扩展**只读取你自己浏览器里已经渲染出来的公开内容**，不绕过登录、不破解付费内容、不构造批量请求爬取。
- 下载的内容**版权属于原作者**。请仅用于个人离线查看、备份自己的作品等合理用途，**不要二次分发、商用或搬运**。
- 使用本扩展可能违反 Instagram、微博的服务条款，**风险自负**。请控制使用频率，不要用于批量采集。
- 本项目与 Instagram / Meta、微博 / 新浪微博均无任何关联，未获其授权或认可。

## 开发

无构建步骤。改完代码后在 `chrome://extensions` 点扩展卡片上的 **刷新** 图标，然后刷新对应站点页面。

**调试入口**：

- Instagram content script → 页面 DevTools Console（隔离世界，`[ins download]` 前缀日志）
- 微博 content script → 同上（`[weibo download]` 前缀日志，另有 `__wbDl.*` 诊断命令）
- service worker → `chrome://extensions` → 找到本扩展 → **检查视图 service worker**
- offscreen → 同一处的 **检查视图 offscreen.html**

**回归测试**（Node 18+，无需依赖）：

```bash
node test/test-weibo.js       # 微博地址识别 / 接口解析 / 清晰度替换，21 项断言
node test/test-background.js  # ins 与 weibo 的路由隔离、文件前缀、默认目录，17 项断言
```

`test-background.js` 会分别模拟一次不带 `site` 的下载（Instagram 路径）和一次 `site: "weibo"` 的下载，断言目录、前缀、`saveAs` 互不影响——改动 background 后跑一遍，能确认没有波及 Instagram。

## 更新日志

### v1.1.0

新增微博（weibo.com）支持，Instagram 功能逐字未改：

- 新增 `weibo.js` / `weibo.css`：独立的 DOM 适配层与取址链路，`mid` 属性驱动的卡片识别
- 微博取址：`/ajax/statuses/show?id={mid}` → DOM 兜底；九宫格全部图片一次取齐
- 微博图片清晰度通过替换 `sinaimg.cn` 路径首段实现（360 / 690 / 1080 / 原图）
- 微博视频取 `media_info` 的高清 / 标清流
- background 按 `site` 路由：独立的 storage 键、`weibo_` 文件名前缀、`weibo-download/` 默认目录
- 设置页新增微博区块，popup 新增微博开关（`weiboEnabled`，与 Instagram 的 `enabled` 互不影响）
- 新增 `__wbDl` 诊断命令，便于站点改版后定位问题

### v1.0.0

首个完整版本，历经 9 轮迭代：

- 基础按钮注入与静默下载
- 自定义文件夹写入（File System Access + offscreen）
- 修复按钮与 IG 原生控件重叠、被透明层挡住点击
- 按钮改挂 body + fixed 跟随定位，滚动/缩放自动重排
- 按钮移至卡片右侧外部，一条动态只保留一个按钮
- 多图轮播支持"单张 / 全部"选择，自动编号
- 解决轮播懒加载与视频 blob 流：改用帖子媒体接口取真实地址
- 多张下载打包 zip
- 确认公开接口被封，升级至 `/api/v1/media/{id}/info/` + 五级降级链

## License

[MIT](LICENSE) © 2026 wjnnan
