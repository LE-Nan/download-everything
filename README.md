<div align="center">

<img src="ins-download/icons/icon128.png" width="88" alt="ins download">

# ins download

**Instagram 网页端图片 / 视频一键下载 Chrome 扩展**

在动态卡片右侧注入一个下载按钮，点一下就把原图、原视频静默存到你自己指定的文件夹——不弹另存为、不跳转、不打断浏览。

![Manifest](https://img.shields.io/badge/Manifest-V3-405DE6?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-109%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.0-2ECC71?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)

</div>

---

## 它解决什么问题

Instagram 网页端没有下载按钮。右键"图片另存为"只能拿到被压缩过的缩略图，视频则根本拿不到——播放器里的视频是 blob 流，`video.src` 是 `blob:https://www.instagram.com/...`，复制不出来。

**ins download** 绕开了这两件事：它向 Instagram 的内部媒体接口要数据，直接拿到该帖子的**全部媒体项**和**每一档清晰度**的真实 CDN 地址，然后按你设置的分辨率下载。

## 功能

| 能力 | 说明 |
| --- | --- |
| 🖼 **图片下载** | 单图、多图轮播都支持，按设置的分辨率取最接近的那一档 |
| 🎬 **视频下载** | 拿到真实 mp4 地址（不是 blob），支持 Reels 与视频帖 |
| 🎠 **轮播全量** | 一条 10 图的轮播，能取到全部 10 项，不受页面懒加载限制（DOM 里通常只渲染 2~3 张） |
| 📦 **打包 zip** | 多图一键打包为单个 zip，避免连点 10 次"另存为" |
| 📁 **自定义目录** | 选一次文件夹，之后静默写入，全程零弹窗；图片与视频可分别设目录 |
| ⚙️ **分辨率可选** | 240P / 480P / 720P / 1080P / 2K / 4K，图片视频独立设置 |
| 🎛 **总开关** | popup 里一键关闭按钮注入 |
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
5. 打开 [instagram.com](https://www.instagram.com)，进入首页信息流，每条动态右侧会出现下载按钮

> 需要 Chrome 116+（依赖 `chrome.offscreen` 与 File System Access API）。旧版浏览器请参考下面的"降级行为"。

## 使用

### 下载单条动态

鼠标移到任意动态卡片上，卡片**右侧外部**会出现一个圆形下载按钮，点击即可。

- 单图 / 单视频动态 → 直接开始下载，按钮变绿表示成功，变红表示失败
- 多图轮播动态 → 弹出两个选项：
  - **下载单张（当前显示）** — 只下轮播里当前滑到的那一张
  - **下载多张（全部 N 项，打包 zip）** — 全部打包成一个 zip

### 设置保存位置

点击工具栏图标 → **打开设置**，图片和视频可以分别设置：

| 设置项 | 可选值 | 说明 |
| --- | --- | --- |
| 图片保存位置 | 自定义文件夹 / 默认 | 默认存到 `下载\ins-download\images` |
| 图片分辨率 | 240P ~ 4K | 从原图多档资源里选 ≥ 目标宽度的最接近档 |
| 视频保存位置 | 自定义文件夹 / 默认 | 默认存到 `下载\ins-download\videos` |
| 视频清晰度 | 240P ~ 4K | 以 Instagram 实际提供的流为准 |

**关于自定义文件夹**：点击"选择文件夹"弹出的系统窗口里挑任意目录，之后所有下载静默写入，不会再有任何确认框。目录句柄存在 IndexedDB 里。

> ⚠️ **浏览器重启后授权会失效**（File System Access API 的固有安全限制），设置页会提示"需要重新授权"，点一下 **重新授权** 重新选一次同一目录即可，已下载文件不受影响。

### 降级行为

如果没有选过自定义文件夹，扩展走 `chrome.downloads`，文件落到浏览器默认下载目录的子文件夹里。这条路径在部分浏览器设置下可能仍会弹一次保存框——这是浏览器行为，不是扩展能绕过的。

## 工作原理

### 整体架构

```
┌─────────────────────── Instagram 页面 ───────────────────────┐
│  content.js（隔离世界）                                       │
│   ├─ MutationObserver 扫描 article                            │
│   ├─ 按钮挂 body + position:fixed，rAF 跟随卡片定位            │
│   ├─ shortcode → media id（base64 变体解码）                  │
│   └─ fetch 内部接口，拿全部媒体 + 多档清晰度                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.runtime.sendMessage
┌──────────────────────────▼───────────────────────────────────┐
│  background.js（service worker）                              │
│   ├─ 有自定义目录 → 转交 offscreen                             │
│   └─ 无自定义目录 → chrome.downloads（saveAs:false）           │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│  offscreen.html / offscreen.js（有 DOM、带 host 权限）         │
│   ├─ 跨域 fetch 媒体（不受 CORS 限制）                         │
│   ├─ File System Access 直接写盘                              │
│   └─ zip.js（store 模式）打包 → 写盘 / 回传 dataUrl            │
└──────────────────────────────────────────────────────────────┘
```

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

### 按钮为什么挂在 body 上

早期的实现把按钮塞进 `article` 里、定位在媒体右上角，遇到两个问题：

1. **被视频的透明交互层吃掉点击** —— IG 在视频上盖了一层全屏 `<div>` 处理播放/暂停，`z-index` 再高也在它的层叠上下文里。
2. **和原生 `···` 菜单按钮重叠**。

最终的方案：按钮挂在 `document.body` 下，`position: fixed` + `z-index: 2147483647`，用 `getBoundingClientRect()` 跟随卡片位置，`scroll` / `resize` / `MutationObserver` 触发时经 `requestAnimationFrame` 批量重定位。按钮放在卡片**右侧外部**，彻底避开卡片内的所有交互元素。

## 目录结构

```
ins-download/                 ← 加载扩展时选这个文件夹
├── manifest.json             MV3 清单
├── content.js                注入按钮、解析媒体、弹菜单（551 行，核心）
├── content.css               按钮 / 菜单 / 错误提示条样式
├── background.js             service worker：下载调度
├── offscreen.html            离屏文档（跑 DOM + 跨域 fetch）
├── offscreen.js              写盘、抓取、打包
├── zip.js                    zip 打包（store 模式，零依赖）
├── idb.js                    IndexedDB 助手（存目录句柄）
├── options.html / options.js 设置页
├── popup.html / popup.js     工具栏弹窗（启用开关）
└── icons/                    16 / 48 / 128 图标
```

## 已知限制

诚实地列出做不好的地方：

1. **只覆盖信息流 `article`**。帖子详情页 `/p/xxx/`、Reels 独立页、Story、私信、个人主页九宫格**目前都没有按钮**。
2. **含视频的轮播打包会落到图片目录**。`handleZip` 里只读了 `imageDir` / `imageCustom`。
3. **超大 zip 有内存风险**。默认目录模式下 zip 会转成 dataUrl 字符串跨上下文传递，包体超过 ~100MB 时容易失败。
4. **视频清晰度选档不精确**。`video_versions[].width` 常为 0，实际会退化为取数组末项。
5. **动画/Story 的媒体**未做支持。
6. 站点改版可能导致解析链失效，届时需要更新 `content.js` 里的选择器与接口逻辑。

## 合规与免责

- 本扩展**只读取你自己浏览器里已经渲染出来的公开内容**，不绕过登录、不破解付费内容、不构造批量请求爬取。
- 下载的内容**版权属于原作者**。请仅用于个人离线查看、备份自己的作品等合理用途，**不要二次分发、商用或搬运**。
- 使用本扩展可能违反 Instagram 的服务条款，**风险自负**。请控制使用频率，不要用于批量采集。
- 本项目与 Instagram / Meta 无任何关联，未获其授权或认可。

## 开发

无构建步骤。改完代码后在 `chrome://extensions` 点扩展卡片上的 **刷新** 图标，然后刷新 Instagram 页面。

**调试入口**：

- content script → Instagram 页面 DevTools 的 Console（隔离世界里，`[ins download]` 前缀的日志在这里）
- service worker → `chrome://extensions` → 找到本扩展 → **检查视图 service worker**
- offscreen → 同一处的 **检查视图 offscreen.html**

## 更新日志

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
