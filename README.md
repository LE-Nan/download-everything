<div align="center">

<img src="ins-download/icons/icon128.png" width="88" alt="download everything">

# download everything

**插件支持网页端下载图片和视频** —— Instagram · 微博 · X（推特）三个站点，Chrome 扩展，原图 / 原画质一键静默保存

**中文** ｜ [English](README.en.md) ｜ [日本語](README.ja.md) ｜ [한국어](README.ko.md)

在动态卡片旁注入一个下载按钮，点一下就把原图、原视频静默存到你自己指定的文件夹——不弹另存为、不跳转、不打断浏览。图片与视频**默认取原图 / 原画质**（微博 `large`、X `name=orig`、Instagram 源素材最高档，视频取源最高码率）。
三个站点都带**真实字节进度环**，加载中还能再点一次**取消**。设置页与弹窗支持**中 / 英 / 日 / 韩**四种界面语言。

![Manifest](https://img.shields.io/badge/Manifest-V3-405DE6?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-111%2B-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-3.0.0-2ECC71?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)

</div>

---

## 支持站点

| 站点 | 图片 | 视频 | 多图打包 | 进度环 | 取消下载 | 独立目录 / 清晰度 |
| --- | --- | --- | --- | --- | --- | --- |
| **Instagram** `instagram.com` | ✅ 含全部轮播项 | ✅ Reels 与视频帖 | ✅ | ✅ | ✅ | ✅ |
| **微博** `weibo.com` | ✅ 九宫格全部 | ✅ 高清 / 标清 | ✅ | ✅ | ✅ | ✅ |
| **X（推特）** `x.com` · `twitter.com` | ✅ 含全部四宫格、原图 | ✅ 最高码率 mp4 与 GIF | ✅ | ✅ | ✅ | ✅ |

三个站点的功能实现**完全独立**：独立的 DOM 适配层、独立的取址链路、独立的按钮样式、独立的存储键。任何一个站点的改版或出错都不会影响另一个。

> 扩展的加载目录仍叫 `ins-download`（最初只做 Instagram 时的命名），加载时选这个文件夹即可，不影响功能。

## 它解决什么问题

Instagram 网页端没有下载按钮。右键"图片另存为"只能拿到被压缩过的缩略图，视频则根本拿不到——播放器里的视频是 blob 流，`video.src` 是 `blob:https://www.instagram.com/...`，复制不出来。

微博这边问题不同：图能右键，但默认给你的是 `orj360`（360px 宽）的压缩图；视频同样是 blob 流，而且九宫格里的图往往要一张张点。

**download everything** 绕开了这两件事：它向站点自己的内部接口要数据，直接拿到该条内容的**全部媒体项**和**每一档清晰度**的真实 CDN 地址，然后按你设置的分辨率下载。

X（推特）的问题又不一样：图片右键拿到的是 `name=small`（680px）缩略图，原图要把地址里的 `name=` 改成 `orig`；视频在时间线里是 HLS/MSE 的 `blob:` 流，`video.src` 取不出来，真正的 mp4 直链只存在于页面自己请求的 GraphQL 响应和官方的嵌入接口里。

## 功能总览

### 通用能力

| 能力 | 说明 |
| --- | --- |
| 🖼 **图片下载** | 单图、多图轮播、九宫格、四宫格都支持，按设置的分辨率取档（默认最高档） |
| 🎬 **视频下载** | 拿到真实 mp4 地址（不是 blob），支持 Reels、视频帖、微博视频、X 视频与 GIF |
| 🎠 **轮播 / 九宫格全量** | 一条 10 图的帖子能取到全部 10 项，不受页面懒加载限制（DOM 里通常只渲染 2~3 张） |
| 📦 **打包 zip** | 多图一键打包为单个 zip，避免连点 10 次"另存为" |
| 📁 **自定义目录** | 选一次文件夹，之后静默写入，全程零弹窗；图片与视频可分别设目录 |
| ⚙️ **分辨率可选** | 三个站点共用**同一套七档**：**原图（默认）** / 240P / 480P / 720P / 1080P / 2K / 4K。**下载时以设置为准，源素材最高档更低时取源最高档** |
| 🎚 **清晰度可选** | 三个站点统一五档：**原画质（默认）** / 标清 480P / 高清 720P / 超清 1080P / 超高清 2K，每档对应明确的技术标准，按设置取「不低于该档的最小一档」 |
| 🎛 **站点独立开关** | popup 里 Instagram、微博、X 各自一个开关，互不影响 |
| 🧩 **零依赖** | 纯原生 JS，无构建、无 npm，克隆即用 |

### Instagram 已实现

- **按钮注入**：每条信息流 `article` 右侧外部一个圆形按钮，`position: fixed` 跟随卡片，滚动 / 缩放 / 信息流重排时经 `requestAnimationFrame` 批量重定位，不跟丢、不重叠
- **媒体解析五级降级**：内部接口 → `?__a=1` → embed 页 → 帖子页 HTML → DOM 兜底（详见工作原理）
- **轮播全量**：接口一次返回全部轮播项，不受懒加载影响
- **清晰度**：图片按 `image_versions2.candidates` / srcset 挑档（原图 = 最大一张；选定档取不低于它的最小一档，240P～4K）；视频按 `video_versions[].width` 按同一规则选档（原画质 / 480P / 720P / 1080P / 2K）
- **多图菜单**：`下载单张（当前显示）` / `下载多张（全部 N 项，打包 zip）`
- **字节先行**：由离屏文档取回真实字节再交付，扩展名按真实文件头决定，后缀不会被 CDN 的错误页改掉
- **下载进度环**：按钮外圈按真实字节顺时针填充（解析阶段按时间缓升，取字节阶段按比例走），与保存框联动
- **取消下载**：加载中再点一次按钮即取消，断掉取字节请求、关掉已弹出的保存框，静默收尾
- **命名**：`ins_image_20261119T201500.jpg` / `ins_video_…mp4`，多张打包时 zip 内按序号命名

### 微博 已实现

- **卡片识别**：不依赖易变的类名，最近祖先匹配 `article.woo-panel-main` / `div.card-wrap` / `[action-type=feed_list_item]` / `[mid]` / `[data-mid]`，新版首页与搜索页都能挂上按钮
- **帖子 id 两条取值**：容器有 `mid` / `data-mid` 直接用；没有就从卡片内的微博链接取 `mblogid`（`/{uid}/{mblogid}`、`/detail/xxx`、`/status/xxx`）
- **媒体解析**：`/ajax/statuses/show` → 视频组件接口 → DOM 兜底；支持九宫格、图文 + 视频混排（保持用户看到的原始顺序）、转发微博
- **图片清晰度**：换 `sinaimg.cn` 路径首段（`orj360` / `mw690` / `orj1080` / `large` 原图），取不到的档位自动回退
- **视频清晰度**：原画质 / 标清 480P / 高清 720P / 超清 1080P / 超高清 2K，直链来自视频组件接口的全部分辨率列表，按 `quality_label`（缺失时退回 `mp4_720p`、`label=mp4_hd` 等线索）判档后按设置排序
- **字节先行**：由离屏文档取回真实字节再交付，彻底修掉"下载下来是 `.htm`"（详见工作原理）
- **一键补 Referer**：`declarativeNetRequest` 会话规则给图床 / 视频 CDN 补 `Referer: https://weibo.com/`，只作用于 CDN、不动 weibo.com 本身，规避 403
- **按钮定位**：与卡片头像垂直居中对齐；头像滑出视口或卡片滑到吸顶导航下方时按钮同步隐藏，不浮在导航栏上；横向自动收进视口
- **下载进度环**：按钮外圈按真实字节顺时针填充，与保存框联动
- **取消下载**：加载中再点一次按钮即取消，断掉取字节请求、关掉已弹出的保存框
- **多图菜单**：`只下载第 1 项` / `全部下载（N 项，打包 zip）`
- **命名**：`weibo_image_20261119T201500.jpg` / `weibo_video_…mp4` / `weibo_images_….zip`

### X（推特）已实现

- **卡片识别**：最近祖先匹配 `article[data-testid="tweet"]`（另有 `article[role="article"]` 与 `[data-testid="tweet"]` 兜底），只看结构不看当前 `src`，懒加载未触发也能挂上按钮
- **推文 id 取值**：优先读 `<time>` 所在的时间戳链接（这条推文自己的永久链接），避开引用推文里的 `/status/` 链接；取不到时退回第一个 `/status/` 链接
- **媒体解析三层降级**：
  1. **页面自身的 GraphQL 数据**（`twitter-hook.js` 注入 MAIN world 旁听 `fetch` / `XHR` 响应）——视频的全部码率直链、图片的原始地址，一次都在里面，不发额外请求
  2. **官方嵌入接口** `cdn.syndication.twimg.com/tweet-result`（免登录），页面缓存里没有这条推文时用，经 background → offscreen 代发绕开 CORS
  3. **DOM 兜底**：图片从 `pbs.twimg.com/media/` 地址换 `name=` 参数；视频只在 `video.src` 是 http(s) 直链时才可用
- **图片最高画质**：`name=orig`（上传原图，最大档）→ `4096x4096` → `large(2048)` → `medium(1200)` → 页面原地址，取不到的档位在取字节阶段自动跳过
- **视频最高画质**：按 `video_info.variants` 的 `bitrate` 从高到低排序，默认取最高码率那一档；HLS（`.m3u8`）不是可直接保存的文件，直接跳过；GIF 帖按 mp4 下载
- **按钮定位**：贴在推文媒体区域（多图九宫格取整块）的右上角，躲开 X 自己的 `···` 菜单与右侧栏；媒体很高时按钮夹在可视区内，顶部被吸顶栏盖住时隐藏
- **进度环 / 取消 / 多图菜单**：与另外两个站点同一套状态机，文案走同一份 i18n
- **命名**：`twitter_image_20261122T124000.jpg` / `twitter_video_…mp4` / `twitter_images_….zip`

### 诊断能力

三个站点都内置了控制台诊断命令（`__wbDl.*` / `__xdl.*` / `[download-everything]` 日志），站点改版后不用读源码就能定位是"没识别到卡片"还是"取址失败"。清单见下面的[调试](#调试)一节。

## 安装

本扩展未上架 Chrome 应用商店，使用开发者模式本地加载：

1. 下载或克隆本仓库
   ```bash
   git clone https://github.com/LE-Nan/download-everything.git
   ```
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 右上角打开 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择仓库里的 **`ins-download`** 文件夹
5. 打开 [instagram.com](https://www.instagram.com)、[weibo.com](https://weibo.com) 或 [x.com](https://x.com)，进入信息流，每条内容旁会出现下载按钮

> 需要 Chrome 111+（依赖 `chrome.offscreen`、File System Access API，以及内容脚本的 `world: "MAIN"`）。旧版浏览器请参考下面的[降级行为](#降级行为)。
>
> 扩展使用了 `declarativeNetRequestWithHostAccess` 权限（给微博图床补 Referer，解决视频 403），升级后 Chrome 会提示"需要接受新权限"，重新加载并接受即可。

## 使用

### Instagram

鼠标移到任意动态卡片上，卡片**右侧外部**会出现一个圆形下载按钮，点击即可。

- 单图 / 单视频动态 → 直接开始下载，按钮变绿表示成功，变红表示失败
- 多图轮播动态 → 弹出两个选项：
  - **下载单张（当前显示）** — 只下轮播里当前滑到的那一张
  - **下载多张（全部 N 项，打包 zip）** — 全部打包成一个 zip
- 点击后按钮外圈开始走**进度环**；加载中**再点一次 = 取消**（图标此时是实心方块，悬停转红）

### 微博

微博操作一致：每条微博卡片**右侧**出现同样的圆形按钮（悬停时变微博橙）。

- 单图 / 单视频 → 直接下载
- 九宫格 / 多图 → 弹出两个选项：**只下载第 1 项** 或 **全部下载（N 项，打包 zip）**

按钮**与卡片头像垂直居中对齐**，代表"这条微博的下载按钮"。头像被滑出视口（上滑刷过去、或卡片还在视口下方）时按钮同步隐藏；**卡片滑到微博吸顶导航下面时按钮一并隐藏**，不会浮在导航栏上。

按钮横向会自动收进视口内，不会飘到右侧栏上。若某条微博没出现按钮，按 F12 在控制台执行 `__wbDl.debug()` 可以看到它为什么没被识别（详见[调试](#调试)）。

### X（推特）

打开 [x.com](https://x.com) 首页、搜索结果或推文详情页，**带图/带视频的推文**会在媒体区域的**右上角**出现一个圆形按钮（悬停转 X 蓝）：

- 单图 / 单视频 / GIF → 直接下载
- 四宫格 / 多图 → 弹出两个选项：**只下载第 1 项** 或 **全部下载（N 项，打包 zip）**
- 纯文字推文、只有外链卡片预览的推文不会挂按钮（那类卡片里的图不在推文媒体里）
- 视频默认下载**最高码率**的 mp4；GIF 帖下载的是 mp4 文件（X 本身就是这么存的）
- 按钮贴在媒体而不是头像旁，是因为 X 头像正右方就是它自己的 `···` 菜单和 Grok 入口，放那里必然打架

> X 的视频地址来自**页面自己的数据请求**。如果某条推文的取址全部失败（例如刚打开详情页、页面数据还没回来，而嵌入接口也被网络环境挡住），按钮会变红并提示"未找到可下载的媒体地址"——等推文加载完再点一次即可。按 F12 执行 `__xdl.debug()` 能看到它识别到了哪些推文。

### 下载进度环

视频从点击到弹出保存框通常要 5～15 秒，这段时间以前只有一个半透明状态，看不出在动。现在按钮**外圈就是进度条**（三个站点同一套）：

```
点击 ──▶ 解析媒体（0→12%，按时间缓升）
      ──▶ 取回字节（按 已取字节 / Content-Length 顺时针绿色填充）
      ──▶ 填满 100%  ← 保存框此刻弹出
      ──▶ 点「保存」  ← 按钮恢复原样，填充清除
```

- 已取回的部分**绿色填充**，未取回的部分**留空**，顺时针推进
- Content-Length 缺失时按时间缓升，最多到 92%，不会假装完成
- 保存框开着期间进度环保持填满；点保存（下载状态 `complete`）后才收尾
- 点「取消」同样恢复原样，不会报错、也不会再弹一次保存框

### 取消下载

**加载中再点一次按钮 = 取消**。按钮此刻会变成实心方块图标、悬停转红、提示文字改为"下载中，点击取消"，就是为了让"再点一次"这件事说得通。

取消不是只把界面收掉，三层都会停手：

| 阶段 | 取消动作 |
| --- | --- |
| 解析媒体（等接口） | 本地记账，接口回来后直接放弃：不弹多图菜单、不发下载请求 |
| 取字节 / 打包（那 5～15 秒） | `AbortController` 断掉 `fetch`，读流循环主动退出，不再白下几十 MB |
| 保存框已弹出 | `chrome.downloads.cancel()` 关掉那次下载 |

取消是静默的：不闪红、不重试、不会再弹第二个保存框，底部给一条中性提示"已取消下载"。另外只有**发起这条下载的按钮**能取消它，点别的卡片的按钮只会提示"正在下载另一条内容，请稍候"，避免误以为取消了别人的任务。

### 设置页：保存位置 / 显示设置

点击工具栏图标 → **打开设置**。设置页是左右分栏（左侧导航、右侧内容），版式与 Chrome 自身的设置页一致：

| 分栏 | 内容 |
| --- | --- |
| **保存位置** | 三个站点的下载目录与清晰度 |
| **显示设置** | 界面语言（中文 / English / 日本語 / 한국어） |

「保存位置」里按站点分成三块——**Instagram 下载设置**、**微博下载设置**、**X（推特）下载设置** 各一张卡片，标题在卡片框外，标题里的站点名可点击跳转。卡片内部是**一行一项**的三列表格：左边设置名、中间控件（路径框 / 下拉框）、右边功能按钮；三列由整张卡片共享，所以行与行、卡片与卡片之间都是对齐的。每张卡片再分图片、视频两组，六组设置互不影响。

每行只留最短的字段名（`保存位置` / `分辨率` / `清晰度`），较长的解释（目录怎么用、清晰度怎么取）收进字段名的悬浮提示，鼠标移上去就能看到。当前分栏记在地址栏 hash 里，`options.html#display` 可直达显示设置。

| 设置项 | 可选值 | 说明 |
| --- | --- | --- |
| Instagram 图片位置 / 分辨率 | 自定义文件夹；原图（默认）/ 240P ~ 4K | 默认 `下载\ins-download\images` |
| Instagram 视频位置 / 清晰度 | 自定义文件夹；原画质（默认）/ 480P / 720P / 1080P / 2K | 默认 `下载\ins-download\videos` |
| 微博图片位置 | 自定义文件夹 / 默认 | 默认 `下载\weibo-download\images` |
| 微博图片分辨率 | 原图（默认）/ 240P / 480P / 720P / 1080P / 2K / 4K（与 Instagram 同一套） | 按尺寸路径换档，映射到 `orj360` / `orj480` / `mw690` / `mw1024` / `orj1080` / `mw2000` / `large`（原图） |
| 微博视频位置 | 自定义文件夹 / 默认 | 默认 `下载\weibo-download\videos` |
| 微博视频清晰度 | 原画质（默认）/ 480P / 720P / 1080P / 2K | 按接口给的清晰度标签选档，判不出档的地址排最后兜底 |
| X 图片位置 | 自定义文件夹 / 默认 | 默认 `下载\twitter-download\images` |
| X 图片分辨率 | 原图（默认）/ 240P / 480P / 720P / 1080P / 2K / 4K（与 Instagram 同一套） | 映射到 pbs 的 `small`(680) / `medium`(1200) / `large`(2048) / `4096x4096` / `orig`（原图） |
| X 视频位置 | 自定义文件夹 / 默认 | 默认 `下载\twitter-download\videos` |
| X 视频清晰度 | 原画质（默认）/ 480P / 720P / 1080P / 2K | mp4 档只给码率，按码率折算档位（≈360P / 720P / 1080P）后选档 |

**清晰度怎么取**：三个站点共用一条规则——**原图 / 原画质**表示「源素材的最高档」，不做任何降档；选了具体档位（240P / 480P / 720P / 1080P / 2K / 4K）时取**不低于该档的最小一档**；如果这条内容源的**最高档还不如设置**（老帖、小图、单码率视频），就取源能给的**最高档**，不会因为设置过高而失败，也不会退到比源更差的档。改完设置不必刷新页面，下一次点击就按新值取档。

**关于自定义文件夹**：点击"选择文件夹"弹出的系统窗口里挑任意目录，之后所有下载静默写入，不会再有任何确认框。目录句柄存在 IndexedDB 里。

> ⚠️ **浏览器重启后授权会失效**（File System Access API 的固有安全限制），设置页会提示"需要重新授权"，点一下 **重新授权** 重新选一次同一目录即可，已下载文件不受影响。

### 界面语言

**显示设置 → 界面语言** 可切换中文 / English / 日本語 / 한국어。四语覆盖设置页、工具栏弹窗与网页内按钮的提示文字（按钮 title、多图菜单、失败原因）。

- 切换**立即生效**：设置页与弹窗当页更新，网页里已注入的按钮也会就地换文案，不必刷新
- 没手动选过时按浏览器语言猜一次（`zh*` → 中文，`ja` → 日语，`ko` → 韩语，其余英文），只影响显示，不写存储
- 选择存在 `chrome.storage.sync` 的 `uiLang` 键，升级/同步后保留
- 字典在 `i18n.js`，四种语言的键集由 `test-i18n.js` 守着，少一个键测试就会红

### 降级行为

如果没有选过自定义文件夹，扩展走 `chrome.downloads`，文件落到浏览器默认下载目录的子文件夹里。这条路径在部分浏览器设置下可能仍会弹一次保存框——这是浏览器行为，不是扩展能绕过的。

## 目录结构

```
ins-download/                 ← 加载扩展时选这个文件夹
├── manifest.json             MV3 清单
├── content.js                Instagram：注入按钮、解析媒体、进度环 / 取消、弹菜单（核心）
├── content.css               Instagram 按钮 / 菜单 / 进度环 / 错误提示条样式
├── weibo.js                  微博：同上，但选择器与取址链路完全独立
├── weibo.css                 微博按钮 / 菜单 / 进度环样式（.wb-dl-* 前缀，互不覆盖）
├── twitter.js                X（推特）：同上，三层取址（页面 GraphQL → 嵌入接口 → DOM）
├── twitter.css               X 按钮 / 菜单 / 进度环样式（.x-dl-* 前缀，互不覆盖）
├── twitter-hook.js           MAIN world 旁听 X 的 GraphQL 响应，把媒体按推文 id 缓存并回传
├── background.js             service worker：按 site 路由下载调度、进度转发、取消、Referer 规则
├── offscreen.html            离屏文档（跑 DOM + 跨域 fetch）
├── offscreen.js              取字节（可中断）、写盘、打包
├── zip.js                    zip 打包（store 模式，零依赖）
├── idb.js                    IndexedDB 助手（存目录句柄）
├── i18n.js                   界面语言字典（中 / 英 / 日 / 韩）与切换逻辑
├── options.html / options.js 设置页（左侧分栏：保存位置 / 显示设置）
├── popup.html / popup.js     工具栏弹窗（三个独立开关）
├── icons/                    16 / 48 / 128 图标
└── (仓库根) test/            回归测试，node 直跑，无依赖
```

## 工作原理

### 整体架构

```
┌────── Instagram 页面 ──────┐ ┌──── 微博页面 ────┐ ┌──── X（推特）页面 ────┐
│ content.js（隔离世界）      │ │ weibo.js（隔离） │ │ twitter.js（隔离世界）  │
│  ├─ 扫 article              │ │  ├─ 向上找卡片    │ │  ├─ 扫 tweet article   │
│  ├─ shortcode → media id    │ │  ├─ mid → ajax   │ │  ├─ <time> → tweet id  │
│  └─ /api/v1/media/{id}/info │ │  └─ DOM 兜底      │ │  └─ hook/嵌入接口/DOM  │
└─────────────┬───────────────┘ └────────┬─────────┘ └───────────┬───────────┘
              │ site:"ins"               │ site:"weibo"          │ site:"twitter"
              └──────────────────┬───────┴───────────────────────┘
┌────────────────────────────────▼─────────────────────────────┐
│  background.js（service worker）—— 按 site 路由到独立配置      │
│   ├─ 有自定义目录 → 转交 offscreen                             │
│   └─ 无自定义目录 → chrome.downloads（saveAs:false）           │
│   ＋ 进度转发、取消调度、微博 CDN 的 Referer 规则               │
└────────────────────────────────┬─────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────┐
│  offscreen.html / offscreen.js（有 DOM、带 host 权限）         │
│   ├─ 跨域 fetch 媒体（不受 CORS 限制）                         │
│   ├─ 流式读取 + 进度上报 + AbortController 中断                │
│   ├─ File System Access 直接写盘                              │
│   └─ zip.js（store 模式）打包 → 写盘 / 回传 dataUrl            │
└──────────────────────────────────────────────────────────────┘
```

三个内容脚本**互不 import、互不共享变量**。background 里只有每个 handler 开头的 `if (msg.site === …)` 一行分流，Instagram 的原有代码路径逐字未改。

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

微博的难点不是接口被拦，而是**识别**：信息流是 Vue 虚拟滚动，容器类名随构建变化，九宫格图片还是懒加载（`src` 常是占位图）。更麻烦的是**微博现在同时存在两套前端**：

| 页面 | 卡片容器 | 有 `mid` 属性吗 |
| --- | --- | --- |
| 新版首页 `weibo.com`、详情页 | `<article class="woo-panel-main">` | ❌ 没有 |
| 搜索页 `s.weibo.com`、旧版列表 | `<div class="card-wrap" action-type="feed_list_item">` | 有 |

所以只认 `[mid]` 会在首页完全失效（v1.1 的实际 bug）。现在改成**最近祖先匹配任一卡片选择器**，帖子 id 分两条取值：

1. 容器有 `mid` / `data-mid` → 直接用
2. 没有 → 从卡片里的微博链接取 `mblogid`（`/{uid}/{mblogid}`、`/detail/xxx`、`/status/xxx`）

两者都能直接喂给接口。另一个稳定物是 **`sinaimg.cn` + 路径首段的尺寸标记**（`/orj360/`、`/mw690/`、`/large/`）。

| 优先级 | 手段 | 能拿到什么 |
| --- | --- | --- |
| 1 | `GET /ajax/statuses/show?id={id}` | `pic_infos` 九宫格原图、`page_info`/`mix_media_info` 视频、图文混排 |
| 2 | `POST /tv/api/component?page=/tv/show/{fid}` | 视频全部分辨率直链（`mp4_1080p_mp4` / `mp4_720p_mp4` …），最可靠的一档 |
| 3 | DOM 兜底 | 当前已渲染的 `img` / `video`；视频是 blob 流时再找卡片里的 `fid` 链接救一次 |

> ⚠️ `s.weibo.com` 上**没有** `/ajax/statuses/show` 这个接口，它返回的是 HTML 登录页。所以同源取不到时自动改走 background → offscreen 的代理请求；再不行才落到 DOM。

清晰度不是"多档资源列表"，而是**同一条 URL 换路径首段**：

```
https://wx1.sinaimg.cn/orj360/006abc.jpg    ← 页面默认给 360
https://wx1.sinaimg.cn/mw690/006abc.jpg     ← 690
https://wx1.sinaimg.cn/orj1080/006abc.jpg   ← 1080（很多图没有这一档）
https://wx1.sinaimg.cn/large/006abc.jpg     ← 原图
```

首段不在白名单时一律不改写——头像（`crop.0.0.180…`）和表情（`m/emoticon`）正是靠这条规则被排除掉的。

### 为什么由 offscreen 取字节，而不是把地址交给下载器

v1.1 / v1.2.0 下载回来的文件后缀是 `.htm`。根因不止一个，最要命的是最后这条：

1. **档位不存在**：选 1080P 时把路径首段换成 `orj1080`，但**微博并没有为每张图生成 1080 档**，直接返回 404 的 HTML 错误页；
2. **接口取错**：`s.weibo.com` 上的同源 `/ajax/statuses/show` 返回 HTML，被当成正常响应；
3. **下载请求和探测请求不是同一个请求**。探测是扩展发起的 `fetch`（带 Referer、带 Range），能拿到真图；而 `chrome.downloads` 是浏览器自己发起的下载请求，没有页面 `Referer`，微博 CDN 会回一个 **200 的 HTML 错误页**。Chrome 拿到 `text/html` 就把后缀改成 `.htm`——这就是单图和视频一直存成 `.htm`、而多图 zip 却正常的原因：**zip 传的是本地数据，不是网络地址**。

现在的做法是「字节先行」，彻底绕开第三条：

```
候选地址（所选清晰度 → 原图 → 中间档 → 页面原地址）
      │
      ├─ offscreen 逐个取回真实字节（流式读取，大视频由 Chrome 落盘，不占内存）
      ├─ 校验 Content-Type 不是 html/json + 文件头是 jpeg/png/webp/mp4…
      ├─ 全失败 → 「微博拒绝了该地址（403）或已失效」，不落盘
      └─ 命中 → 按真实后缀命名
            ├─ 有自定义文件夹 → 直接写盘
            └─ 默认模式 → 图片走 dataUrl、视频走 blob URL 交给 chrome.downloads
```

blob 的 `type` 和文件名都是本地决定的，服务器连改后缀的机会都没有；个别 Chrome 版本不接受离屏文档创建的 blob URL 时，会自动退回 `dataUrl`。

### 进度环与取消的数据链路

```
content.js / weibo.js 生成 progressId
   │
   ├─▶ background 用 sender.tab.id 记进 progressTabs
   │
   ├─▶ offscreen save-media：getReader() 流式读取，每 120ms 报 {loaded,total}
   │        └─▶ background ─▶ tabs.sendMessage(type:"wb-dl-progress") ─▶ 画环
   │
   ├─▶ 调 chrome.downloads 之前先发 phase:"save"（=100%），此刻保存框弹出
   │
   └─▶ 用户再点一次 ─▶ action:"cancel" ─▶ offscreen abort（AbortController）
                                        └▶ chrome.downloads.cancel(downloadId)
```

一个 `progressId` 贯穿全程，取消请求即使**早于**下载请求到达也会被记账（连点两下的场景），任务开始时先查一次，已取消就直接返回。三个环节的取消结果统一归一成 `canceled`，所以上层永远只有"成功 / 取消 / 失败"三种语义。

> 三个站点共用同一条进度通道（消息 type 沿用历史的 `wb-dl-progress`），各自只画自己按钮上的环；`progressId` 前缀不同（`ig…` / `wb…` / `x…`），旧脚本里的 `wb-cancel` 与新的 `cancel` 都已支持。

### X（推特）媒体地址解析

X 的难点和微博相反：卡片很好认（`article[data-testid="tweet"]`），**难的是拿不到地址**——视频在播放器里是 MSE 的 `blob:`，图片的 `src` 只给 680px 缩略图。但它有一个别的站点没有的便利：页面自己就是靠 GraphQL 拿数据的，媒体全在里面。

| 优先级 | 手段 | 能拿到什么 |
| --- | --- | --- |
| 1 | `twitter-hook.js` 旁听页面的 `fetch` / `XHR`（MAIN world，`document_start`） | `extended_entities.media` 里的全部实体：图片原始地址 + `video_info.variants` 的全部码率 mp4 |
| 2 | `GET cdn.syndication.twimg.com/tweet-result?id={id}&token={t}` | 同上的 `mediaDetails`（免登录的官方嵌入接口），页面缓存没有时用 |
| 3 | DOM 兜底 | `[data-testid="tweetPhoto"] img` 的地址；`video.src` 是 http(s) 直链时才可用 |

第 1 层只**旁听不改写**：`fetch` 的返回值、`XHR` 的行为都原样透传，解析放在 side branch 里，异常全部吞掉。命中后按推文 id 存进有上限的 Map（200 条，先进先出），内容脚本用 `window.postMessage` 问、hook 用同样的通道答，跨隔离世界不需要额外权限。

清晰度靠**参数**而不是多份文件：

```
https://pbs.twimg.com/media/GX1abc?format=jpg&name=small   ← 页面默认给 680
https://pbs.twimg.com/media/GX1abc?format=jpg&name=large   ← 2048
https://pbs.twimg.com/media/GX1abc?format=jpg&name=4096x4096
https://pbs.twimg.com/media/GX1abc?format=jpg&name=orig   ← 上传原图，最大档
```

视频则是真的有多档文件，`variants` 里每条带 `bitrate`：

```json
{"bitrate": 632000,  "content_type": "video/mp4",        "url": "…/632.mp4"}
{"bitrate": 2176000, "content_type": "video/mp4",        "url": "…/2176.mp4"}
{"content_type": "application/x-mpegURL", "url": "…/pl/xxx.m3u8"}   ← 跳过
```

按 `bitrate` 从高到低排，默认取第一档；选「标清」就反过来。`.m3u8` 是 HLS 播放列表，不是可保存的文件，因此不参与候选——若某条视频**只有** HLS，会明确报「未找到可下载的媒体地址」，而不是存一个坏文件。

> 与微博不同，`pbs.twimg.com` / `video.twimg.com` 不校验 `Referer`（它们本来就是给第三方 embed 用的），所以 X 这条链路不需要 `declarativeNetRequest` 改请求头。

### 按钮为什么挂在 body 上

早期的实现把按钮塞进 `article` 里、定位在媒体右上角，遇到两个问题：

1. **被视频的透明交互层吃掉点击** —— IG 在视频上盖了一层全屏 `<div>` 处理播放/暂停，`z-index` 再高也在它的层叠上下文里。
2. **和原生 `···` 菜单按钮重叠**。

最终的方案：按钮挂在 `document.body` 下，`position: fixed` + `z-index: 2147483647`，用 `getBoundingClientRect()` 跟随卡片位置，`scroll` / `resize` / `MutationObserver` 触发时经 `requestAnimationFrame` 批量重定位。按钮放在卡片**右侧外部**，彻底避开卡片内的所有交互元素。

### 三个站点怎么做到互不影响

| 隔离维度 | Instagram | 微博 | X（推特） |
| --- | --- | --- | --- |
| 内容脚本 | `content.js` | `weibo.js` | `twitter.js`（+ `twitter-hook.js`） |
| 样式前缀 | `.ins-dl-*` | `.wb-dl-*` | `.x-dl-*` |
| 开关存储键 | `enabled` | `weiboEnabled` | `twitterEnabled` |
| 目录存储键 | `imageDir` / `videoDir` / … | `weiboImageDir` / `weiboVideoDir` / … | `twitterImageDir` / `twitterVideoDir` / … |
| 文件名前缀 | `ins_image_` / `ins_video_` | `weibo_image_` / `weibo_video_` | `twitter_image_` / `twitter_video_` |
| 默认目录 | `ins-download/` | `weibo-download/` | `twitter-download/` |

background 里唯一的交汇点是每个 handler 开头的 `if (msg.site === …)` 一行分流；进度消息（`wb-dl-progress`）三站共用同一条通道，因为内容脚本各自画自己的环，互不感知。

## 调试

打开页面 DevTools → Console，**把上下文切到本扩展**（下拉框里选 `download-everything`），按站点执行：

| 站点 | 命令 | 作用 |
| --- | --- | --- |
| Instagram | `__insDl.debug()` | 打印每条被识别的动态：shortcode、按钮数、媒体数 |
| Instagram | `__insDl.media(0)` | 对第 0 条动态跑完整取址链路，打印全部候选地址 |
| Instagram | `__insDl.ring()` | 看进度环状态：progressId、当前百分比、总量是否已知 |
| Instagram | `__insDl.cancel()` | 取消当前下载（等价于在加载中的按钮上再点一次） |
| Instagram | `__insDl.clearCache()` | 清掉帖子接口缓存，强制重新请求 |
| 微博 | `__wbDl.debug()` | 打印每张被识别的卡片：命中的选择器、帖子 id、媒体数 |
| 微博 | `__wbDl.inspect(0)` | 对第 0 张卡片跑完整取址链路，打印所有候选地址（排查"没按钮/下不了"最快） |
| 微博 | `__wbDl.resolve("帖子id")` | 直接调接口看解析结果 |
| 微博 | `__wbDl.checkImage("图片地址")` | 看该地址是否被判为正文配图、各档清晰度与候选顺序 |
| 微博 | `__wbDl.ring()` | 看进度环状态：progressId、当前百分比、总量是否已知 |
| 微博 | `__wbDl.cancel()` | 取消当前下载（等价于在加载中的按钮上再点一次） |
| 微博 | `__wbDl.occlusion()` | 看当前识别到的吸顶栏底边（按钮低于这条线即隐藏）；返回 0 说明没认出导航容器 |
| 微博 | `__wbDl.clearCache()` | 清掉接口与视频组件缓存，强制重新请求 |
| X | `__xdl.debug()` | 打印每条被识别的推文：命中的选择器、推文 id、媒体数 |
| X | `__xdl.inspect(0)` | 对第 0 条推文跑完整取址链路（hook → 嵌入接口 → DOM），打印候选地址 |
| X | `__xdl.hook("推文id")` | 只看页面 hook 抓到的原始数据（不发任何网络请求） |
| X | `__xdl.resolve("推文id")` | 直接调嵌入接口看解析结果 |
| X | `__xdl.checkImage("图片地址")` | 看图片候选档位与顺序 |
| X | `__xdl.ring()` / `__xdl.cancel()` / `__xdl.occlusion()` | 进度环状态 / 取消当前下载 / 吸顶栏遮挡线 |
| 通用 | `chrome://extensions` → 本扩展 → **检查视图 service worker** | 看后台下载调度、取消与 offscreen 的报错 |

微博侧还有 `[weibo download]` 前缀的日志，会打出每条帖子实际取到多少媒体、走了哪条链路。**站点改版时优先看这个**：如果日志里反复出现「接口未取到，改用 DOM 兜底」甚至 `媒体数 0`，改 `weibo.js` 顶部的 `SEL` 或解析函数即可，其余逻辑不用动。

下载成 `.htm` 一类的问题，去 **检查视图 offscreen.html** 看控制台：取字节阶段每个失败候选（status / Content-Type）都会记录，能直接看出是 404、403 还是被换成了 HTML 错误页。若报「微博拒绝了该地址」，基本就是候选地址全部被拒，用 `__wbDl.inspect(0)` 把候选列表贴出来即可定位。

## 已知限制

诚实地列出做不好的地方：

1. **Instagram 只覆盖信息流 `article`**。帖子详情页 `/p/xxx/`、Reels 独立页、Story、私信、个人主页九宫格**目前都没有按钮**。
2. **Instagram 取字节失败时会退回直拉**（没有进度环、取消也拦不住），这是为了不让 CDN 的临时拒绝把「本来能下」变成「下不了」。日志里会出现 `ins 取字节失败，退回直拉`。
3. **含视频的轮播打包会落到图片目录**（仅 Instagram）。`handleZip` 里只读了 `imageDir`；微博侧已按内容类型分目录。
4. **超大 zip 有内存风险**。默认目录模式下 zip 会转成 dataUrl 字符串跨上下文传递，包体超过 ~100MB 时容易失败。
5. **视频清晰度选档不精确**（仅 Instagram）。`video_versions[].width` 常为 0，实际会退化为取数组末项。
6. **Instagram 动画 / Story 的媒体**未做支持。
7. **微博的选择器取自公开维护中的同类脚本**（owendswang / firo1603 的「下载微博图片和视频」），接口字段按 `pic_infos` / `playback_list` / `Component_Play_Playinfo` 的实际返回结构实现；但未在真实登录态下逐页跑过。若首页没按钮或某类卡片下不了，先跑 `__wbDl.debug()`，通常只需改 `SEL`。
8. **微博只覆盖信息流与列表页**。图片查看器浮层（点开大图后的全屏浏览）、视频号独立页、头条文章、私信未接。
9. **微博转发微博**取的是被转发那条的媒体（部分场景会同时取到转发者自带的配图）。
10. **保存框弹出瞬间的取消**行为依赖 Chrome 自身对 `downloads.cancel` 的处理，个别版本可能留下一条"已取消"的下载记录（文件不会落盘）。
11. **X 的视频只有 mp4 才下得了**。若某条推文只提供 HLS（`.m3u8`）而没有 mp4 档，会明确报「未找到可下载的媒体地址」，不会存一个不能播的文件。
12. **X 的引用推文**：卡片里的媒体若来自被引用的推文，接口仍只返回本条推文自己的媒体；只有走到 DOM 兜底时才会把引用里的图算进来。
13. **X 的 hook 依赖 `world: "MAIN"`**（Chrome 111+）。极少数环境下页面会锁定 `fetch`，此时第 1 层失效，自动退到嵌入接口与 DOM。
14. 站点改版可能导致解析链失效，Instagram 改 `content.js`，微博改 `weibo.js`，X 改 `twitter.js` 顶部的 `SEL`。

## 合规与免责

- 本扩展**只读取你自己浏览器里已经渲染出来的公开内容**，不绕过登录、不破解付费内容、不构造批量请求爬取。
- 下载的内容**版权属于原作者**。请仅用于个人离线查看、备份自己的作品等合理用途，**不要二次分发、商用或搬运**。
- 使用本扩展可能违反 Instagram、微博、X（推特）的服务条款，**风险自负**。请控制使用频率，不要用于批量采集。
- 本项目与 Instagram / Meta、微博 / 新浪微博、X / xAI 均无任何关联，未获其授权或认可。

## 开发

无构建步骤。改完代码后在 `chrome://extensions` 点扩展卡片上的 **刷新** 图标，然后刷新对应站点页面。

**调试入口**：

- Instagram content script → 页面 DevTools Console（隔离世界，`[download-everything]` 前缀日志）
- 微博 content script → 同上（`[weibo download]` 前缀日志，另有 `__wbDl.*` 诊断命令）
- service worker → `chrome://extensions` → 找到本扩展 → **检查视图 service worker**
- offscreen → 同一处的 **检查视图 offscreen.html**

**回归测试**（Node 18+，无需依赖）：

```bash
node test/test-weibo.js       # 卡片识别 / 帖子 id 取值 / 接口解析 / 地址候选 / 分辨率与清晰度选档 / 加载与取消，72 项断言
node test/test-content.js     # Instagram 进度环 / 取消状态机 / 按钮形态切换 / 选档钳制，40 项断言
node test/test-offscreen.js   # 文件头识别 / 候选重试 / 拒绝 HTML / 流式进度 / 中断 / zip，66 项断言
node test/test-background.js  # 路由隔离 / 字节交付 / 进度回传 / 取消三段式 / 请求头规则，110 项断言
node test/test-i18n.js        # 四语字典键集 / 占位符 / 切换与通知，43 项断言
node test/test-twitter.js     # X：推文 id / 图片换档 / 视频选档 / 实体归一化 / 进度环，62 项断言
node test/test-twitter-hook.js# X hook：GraphQL 解析 / 跨世界问答 / 不改写原请求，14 项断言
```

七套都是纯 Node、无依赖、直接跑，合计 407 项断言：

- `test-background.js` 会分别模拟不带 `site` 的下载（Instagram 路径）和 `site: "weibo"` 的下载，断言目录、前缀、`saveAs` 互不影响——改 background 后跑一遍即可确认没有波及 Instagram；
- `test-content.js` 只桩按钮与消息这一层，专测 Instagram 的环：解析阶段封顶 12%、按字节比例走并封顶 98、取消后迟到的进度不许再画环；
- `test-offscreen.js` 专门守住「HTML 错误页被当成图片存成 .htm」这个老 bug：断言下载器拿到的是 `blob:` / `data:` 而不是网络地址，以及中断后不再尝试后续候选；
- `test-weibo.js` 里的 DOM 桩只实现识别与解析用到的那部分，用最小环境跑真实代码；
- `test-i18n.js` 断言四种语言的键集完全一致、占位符 `{n}` / `{msg}` / `{name}` / `{path}` 一个不少——少翻一条就会在界面上露出 key 原文或悄悄回落中文。
- `test-twitter.js` 只桩按钮与消息这一层，专测 X 的三件事：时间戳链接优先（避开引用推文的 id）、`name=` 换档与去重、`variants` 按 `bitrate` 折算档位后按设置选档并跳过 `.m3u8`；
- `test-twitter-hook.js` 塞一份模仿 `UserTweets` 的深层嵌套响应，断言能翻出「推文 id + 媒体实体」，以及 `fetch` 的返回值原样透传（旁听不改写）。

## 更新日志

### v3.0.0（2026-11-22）

三个站点合流后的第一个正式版，版本号从 2.3.2 进位到 **3.0.0**：

- **能力定型**：Instagram / 微博 / X（推特）三站的图片、视频、多图打包、进度环、取消、独立目录、独立清晰度全部就位。三站实现互不依赖——独立的 DOM 适配层、独立的取址链路、独立的存储键，任何一个站点改版都只影响它自己
- **档位统一**：图片七档（原图默认 → 4K）、视频五档（原画质默认 → 2K），三站共用同一套档位标准与同一条选档规则（不低于设置的最小一档）
- **四语界面**：中 / 英 / 日 / 韩，设置页与工具栏弹窗切换即时生效，网页内按钮的 tooltip、多图菜单、失败提示同步换文案
- **README 重写**：开篇第一句直接说明「插件支持网页端下载图片和视频」，之后按站点铺开能力与原理；更新日志的每一版标题都补上**上传至仓库的日期**
- 主版本进位的理由：三站齐备、档位与文案标准统一，功能边界已经稳定，2.x 到此收尾

### v2.3.2（2026-11-22）

把三个站点的**图片分辨率**下拉统一成 Instagram 那套档位，微博与 X 的子选项随之替换：

- **三站同一套七档**：原图（默认，首位）/ 240P / 480P / 720P / 1080P / 2K / 4K
- 微博：选项值不再直接暴露 `large` / `orj1080` / `mw690` / `orj360`，改由 `weibo.js` 把档位翻译成尺寸路径（`orj360` / `orj480` / `mw690` / `mw1024` / `orj1080` / `mw2000` / `large`），原图 = `large`
- X：选项值不再暴露 `4096x4096` / `large` / `medium` / `small`，改由 `twitter.js` 翻译成 pbs 的 `name`（`small` 680 / `medium` 1200 / `large` 2048 / `4096x4096` / `orig`），原图 = `orig`
- **选档规则与 ins 一致**：取不低于设置的最小一档，源图最高档更低时落到原图；所选档取不到就逐档往上回退
- **老配置就地迁移**：存过 `large` / `mw690` 或 `4096x4096` / `medium` 等旧值，设置页按实际宽度折算到新档，下拉不会空白，下载端也保留档位名直出
- 四语词典删掉不再使用的 `q.orj1080` / `q.mw690` / `q.orj360` / `q.xOrig` / `q.x4096` / `q.xLarge` / `q.xMedium` / `q.xSmall`，微博与 X 的分辨率提示改成「三站共用一套档位」
- 测试：`test-weibo.js` 68 → 72、`test-twitter.js` 56 → 62，合计 397 → **407 项**

### v2.3.1（2026-11-22）

设置页的分辨率 / 清晰度按统一标准重排，并让每个选项真正落到下载链路：

- **分辨率默认「原图」并置于首位**：Instagram 新增 `orig` 档（取 `image_versions2.candidates` / srcset 里最大一张）；微博（`large`）、X（`orig`）本来就是原图，这两处的选项与顺序未动
- **清晰度统一为五档**：**原画质（默认）** / 标清 480P / 高清 720P / 超清 1080P / 超高清 2K，三个站点完全一致；Instagram 视频不再提供 240P / 4K，微博与 X 原来的「高清 / 标清」并入新档位
- **每个档位对应明确的技术标准**：Instagram 按 `video_versions[].width`；微博按 `playback_list` 的清晰度标签（`quality_label` 等，缺失时退回字段名与 URL 里的 `mp4_720p` / `label=mp4_hd` 线索）；X 的 mp4 只给码率，按码率折算档位。三者统一取「不低于设置的最小一档」，源最高档更低时取最高档，原画质直接取源最高档
- **老值自动折算**：存过 `hd` / `sd` / `240` / `4k` 的配置会被就地映射到新档位，设置页不会出现空白下拉框，下载也不会因为取不到档而失败
- 四语文案补齐（新增 `q.vOrig` / `q.v480` / `q.v720` / `q.v1080` / `q.v2k`，移除 `q.hd` / `q.sd`），视频清晰度的悬浮提示补上「原画质＝源最高档」
- 测试：`test-weibo.js` 61 → 68、`test-content.js` 36 → 40、`test-twitter.js` 54 → 56，合计 384 → **397 项**

### v2.3.0（2026-11-22）

新增 **X（推特）网页端图片 / 视频下载**，架构与 ins、微博完全一致但实现独立：

- 新增 `twitter.js` / `twitter.css` / `twitter-hook.js`：卡片识别、三层取址、按钮 / 菜单 / 进度环 / 取消，样式用 `.x-dl-*` 前缀隔离
- **默认最高画质**：图片 `name=orig`（上传原图），视频按 `bitrate` 取最高档 mp4；GIF 帖按 mp4 下载；HLS（`.m3u8`）不当文件下载
- `twitter-hook.js` 以 `world: "MAIN"` 注入、`document_start` 执行，旁听页面自身的 GraphQL 响应，把媒体按推文 id 缓存（上限 200 条），内容脚本用 `window.postMessage` 取用；**只旁听不改写**，异常全部吞掉
- 第二层用官方嵌入接口 `cdn.syndication.twimg.com/tweet-result`，由 background → offscreen 代发绕开 CORS；`x-api` 代理只放行这一个域名
- background 增加 `site: "twitter"` 路由与 `handleTwitterDownload` / `handleTwitterZip`：独立目录 `twitter-download/`、独立前缀 `twitter_`、独立存储键 `twitterImage*` / `twitterVideo*`
- 设置页新增第三张卡片（图片 / 视频目录与清晰度，默认 orig / 高清）；工具栏弹窗新增 X 开关；四语文案同步补齐
- `manifest` 增加 `x.com` / `twitter.com` / `*.twimg.com` 的 host 权限与内容脚本，版本 2.2.0 → **2.3.0**，最低 Chrome 111+
- 新增 `test-twitter.js`（49 → 54 项）与 `test-twitter-hook.js`（14 项），`test-background.js` 补 X 路由（91 → 110 项），合计 285 → **384 项**

### v2.2.0（2026-11-20）

设置页改成 Chrome 设置那样的左右分栏，并给整个界面加了四语切换：

- **设置页分栏**：左侧导航（保存位置 / 显示设置，圆角胶囊选中态），右侧内容区。原来的两个站点设置整块搬进「保存位置」，字段、`id`、存储键一个没动
- **显示设置 → 界面语言**：中文 / English / 日本語 / 한국어 四选一，立即生效。四语覆盖设置页、工具栏弹窗，以及网页内按钮的 tooltip、多图菜单、失败提示
- 新增 `i18n.js`：一份字典 + `t()` / `ready` / `applyDom` / `onChange`，内容脚本按 `manifest` 顺序先加载它；语言切换时已注入的按钮就地换文案，不用刷新页面
- 没选过语言时按浏览器语言猜一次并只读不写；选择存 `chrome.storage.sync.uiLang`
- 扩展版本 2.1.0 → **2.2.0**，`manifest.description` 补一句界面语言
- 新增 `test/test-i18n.js`（43 项），回归测试 242 → **285 项**

### v2.1.0（2026-11-20）

把微博那套「进度可见 + 随时能退」补到 Instagram，并给 README 上了中/英/日/韩四语：

- **Instagram 也有进度环了**：解析阶段 0→12% 按时间缓升，取字节阶段按 `已取字节 / Content-Length` 顺时针填充，字节取完填满 100%（此刻保存框弹出），保存框关掉才复位。数据仍走 offscreen 流式上报那道链路，与微博共用同一个 `progressId` 通道
- **Instagram 也能取消**：加载中再点一次按钮即取消，三层一起停手——本地立刻收环、`AbortController` 断掉 fetch、保存框已弹出则 `chrome.downloads.cancel()`。按钮在加载中变成实心方块、悬停转红，提示文字改为「下载中，点击取消」
- **Instagram 改成字节先行**：不再把地址直接丢给 `chrome.downloads`，而是由 offscreen 取回真实字节再交付（扩展名按真实文件头定）；取字节失败时**自动退回直拉**，保证 CDN 偶发拒绝不会把「本来能下」变成「下不了」
- 打包 zip 同样接入进度与取消（按项数推进，取消即丢包不落盘）
- 新增 `__insDl.*` 控制台诊断（`debug` / `media` / `ring` / `cancel` / `clearCache`），与微博的 `__wbDl.*` 对齐
- 回归测试 202 → **242 项**（新增 `test/test-content.js` 30 项，`test/test-background.js` 81 → 91 项）
- README 增加 English / 日本語 / 한국어 三个版本，顶部语言切换

### v2.0.1（2026-11-20）

一次纯界面/命名整理，下载逻辑零改动：

- 扩展显示名 `ins download` → **download-everything**（与仓库同名），弹窗标题、悬浮按钮 `title`、控制台日志前缀 `[download-everything]` 一并统一
- 弹窗两行开关只保留站点名（`Instagram` / `微博`），去掉「下载」后缀；文字悬停变蓝加下划线、点击跳转对应站点，右侧开关行为不变
- 设置页：Instagram 与微博的**站点标题都移到卡片框外**、字号统一，标题括号内的站点名为可点击链接；Instagram 的图片 / 视频设置同处一张卡片内
- 加载目录仍叫 `ins-download`，默认下载子目录（`下载\ins-download\*`、`下载\weibo-download\*`）与存储键全部不变，已有设置与已下载文件不受影响

### v2.0.0（2026-11-19）

一次"定名 + 归档"的版本：功能与 v1.3.1 完全一致，把项目名与版本号对齐到它现在的实际范围。

- 仓库更名为 **download-everything**（原 `instagram-downloader`），GitHub 会自动重定向旧链接
- 版本号 1.3.1 → **2.0.0**：已从"Instagram 专用"扩展为 Instagram + 微博双站点，主版本号理应进位
- README 重写：按站点列出**全部已实现能力**（识别 / 取址 / 清晰度 / 全量 / 打包 / 目录 / 进度环 / 取消 / 诊断），补齐进度环与取消的数据链路说明，修正"设置页分三块"等过时描述
- 代码零改动（`content.js` / `content.css` 依旧逐字未变）

### v1.3.1（2026-11-19）

给加载过程补上「退出键」。Instagram 逻辑依旧零改动：

- **加载中再点一次按钮 = 取消下载**。在此之前按钮在加载期间是死的（点了只 return），视频那 5～15 秒里用户没有任何退路，点错了只能等
- **取消分三层落地**，不是只把界面收掉：解析媒体阶段直接放弃后续动作；offscreen 取字节阶段由 `AbortController` 断掉正在进行的 `fetch` 和读流（不再白下几十 MB）；保存框已弹出时调 `chrome.downloads.cancel()` 关掉那次下载
- **按钮在加载中变成「停止」**：图标从下载箭头换成实心方块，悬停底色转红，`title` 改为「下载中，点击取消」——让"再点一次"这件事在视觉上说得通
- **取消是静默的**：不再闪红报错、不再重试、不会再弹第二个保存框；进度环立即复位，底部给一条中性提示「已取消下载」
- **防连点**：一个 `progressId` 贯穿解析 / 取字节 / 保存三个阶段，取消请求即使早于下载请求到达也会被记账（`cancelRequests`），任务开始时先查一次，已取消就直接返回
- 顺带限制作用域：只有发起这条下载的按钮能取消它，点别的卡片的按钮只提示「正在下载另一条微博」，避免误以为取消了别人的任务
- `__wbDl.cancel()` 可在控制台手动取消当前下载
- 测试扩到 202 项断言（55 / 66 / 81）

### v1.3.0（2026-11-19）

微博侧的体验补完，Instagram 逻辑依旧零改动：

- **下载进度环**：按钮外圈按真实字节数顺时针填充（已加载绿色、未加载留空）。数据由 offscreen 流式读取时逐段上报 → background 转发到发起下载的标签页 → 内容脚本画环；Content-Length 缺失时按时间缓升，封顶 92%
- **进度与保存框联动**：字节取完立刻填满 100%，此刻保存框弹出；下载状态变为 `complete`（用户点了保存）后按钮才恢复原样。用户点取消同样静默恢复，不重试、不报错
- **流式取字节**：不再一次性 `resp.blob()`，改为 `getReader()` 逐段读取，首块就嗅探文件头——是 HTML 错误页立刻断开，不白下几十 MB
- **修按钮浮在吸顶导航上**：用 `elementFromPoint` 探出微博顶部栏的底边，按钮纵向位置低于该线时隐藏；探测不到时退化为在头像处做命中测试兜底
- 多图打包也走同一套进度环（按已处理项数推进）
- 测试扩到 148 项断言（34 / 50 / 64）

### v1.2.1（2026-11-19）

修实测暴露的两个残留问题，Instagram 逻辑依旧零改动：

- **修单图 / 视频仍存成 `.htm`**：根因不是后缀写错，而是 `chrome.downloads` 自己去拉地址——下载请求没有页面 `Referer`，微博 CDN 回 200 的 HTML 错误页，Chrome 据此改后缀。改为由 offscreen 取回**真实字节**再交付：图片（≤6MB）走 `dataUrl`（与已验证的 zip 同一条路），视频走 `blob` URL；blob 不被接受时自动退回 `dataUrl`。后缀与 MIME 全由本地决定
- **视频不再依赖 `chrome.downloads` 二次请求**，顺带彻底规避 Referer/防盗链差异
- 候选地址补全：所选清晰度 → 原图 → 2000 → 1080 → 690 → 360 → **页面原本给的地址**（保底一定存在）
- **按钮与卡片头像垂直居中对齐**；头像滑出视口时按钮同步隐藏，不再吸附在屏幕边缘
- 大视频用 `resp.blob()` 而非 `arrayBuffer()`，交给 Chrome 落盘，避免撑爆离屏文档内存
- 下载启动后短暂盯一下状态：blob URL 被浏览器**异步**中断（不走回调报错）时同样自动回退 `dataUrl`，不会出现「按钮变绿但文件是坏的」
- 测试 123 项断言（34 / 40 / 49）

### v1.2.0（2026-11-19）

修复微博侧两个实际 bug，Instagram 逻辑零改动：

- **修 `.htm` 文件**：下载前先由 offscreen 用 4KB Range 探测候选地址，校验 Content-Type 与文件头，跳过 404/403 的 HTML 错误页，按真实格式（jpg/webp/png/mp4…）命名；全部失败则明确报错而不是落一个坏文件
- **修首页没有按钮**：卡片识别从只认 `[mid]` 改为 `article.woo-panel-main` / `div.card-wrap` / `[action-type=feed_list_item]` / `[mid]` 最近祖先匹配；帖子 id 支持从微博链接取 `mblogid`
- **接口换新**：`pic_infos` / `pic_ids` 取九宫格原图，`mix_media_info` 支持图文+视频混排，视频新增 `POST /tv/api/component` 拿全部分辨率直链
- **修视频 403**：用 `declarativeNetRequest` 会话规则给 `sinaimg.cn` / `weibocdn.com` 请求补 `Referer: https://weibo.com/`
- 图片默认清晰度改为「原图」——微博并非每张图都有 1080 档，之前默认值反而容易取不到
- 新增 `__wbDl.inspect()` 诊断；测试从 38 项扩到 98 项

### v1.1.0（2026-11-19）

新增微博（weibo.com）支持，Instagram 功能逐字未改：

- 新增 `weibo.js` / `weibo.css`：独立的 DOM 适配层与取址链路，`mid` 属性驱动的卡片识别
- 微博取址：`/ajax/statuses/show?id={mid}` → DOM 兜底；九宫格全部图片一次取齐
- 微博图片清晰度通过替换 `sinaimg.cn` 路径首段实现（360 / 690 / 1080 / 原图）
- 微博视频取 `media_info` 的高清 / 标清流
- background 按 `site` 路由：独立的 storage 键、`weibo_` 文件名前缀、`weibo-download/` 默认目录
- 设置页新增微博区块，popup 新增微博开关（`weiboEnabled`，与 Instagram 的 `enabled` 互不影响）
- 新增 `__wbDl` 诊断命令，便于站点改版后定位问题

### v1.0.0（2026-11-09）

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
