# Kikoeru STRM 播放适配器历史设计与规划基线

状态：历史设计/规划基线（实现已进入独立 Docker overlay 交付）

基线核查日期：2026-09-04
文档定位：保留当时的目标、约束、设计取舍、验收标准和待确认事项，用于理解实现演进；当前安装、配置和运维信息以 [`README.md`](../README.md) 与 [`docs/OPERATIONS.md`](OPERATIONS.md) 为准。

当前实现入口和验证资料：

- 适配层源码位于 `patches/0.6.15/strm-adapter/`，由版本感知 Docker 构建流程加载。
- 独立实例的安装、配置、升级和回滚见 [`docs/OPERATIONS.md`](OPERATIONS.md)。
- 自动化测试通过 `npm test` 运行，测试文件位于 [`tests/strm-adapter.test.js`](../tests/strm-adapter.test.js) 和 [`tests/state-store-process.test.js`](../tests/state-store-process.test.js)。
- 本文不代表真实浏览器、iOS、生产媒体库或 115 压力验收已经完成；这些仍须按运维文档和实际环境单独验证。

## 1. 项目结论

本项目不是 STRM 生成器，而是 Kikoeru 的 STRM 消费与播放适配器。

最终播放链路应是：

```text
115 网盘
   │  FUSE 挂载
   ▼
/media/CloudNas/115/NSFW/Voice/       FUSE 原件目录
   │
   │  MoviePilot / P115StrmHelper 使用原件并生成 STRM
   ▼
/media/MP_movieDB/NSFW/Voice1/*.strm  本地 STRM 输出目录
   │
   │  Kikoeru 扫描本地 STRM 指针文件
   ▼
Kikoeru 音声库 → 用户鉴权 → 读取 STRM API URL → HEAD 获取 302 Location
             → Kikoeru 302 返回 CDN 直链 → 客户端直接音频播放
```

上图是响度已就绪或按策略跳过时的热路径。`redirectMode=direct` 时首播也直接走热路径，不等待本地缓存或响度；`redirectMode=local` 且响度尚未就绪时，才使用一次性的冷启动例外：Kikoeru 单飞完整下载到本地临时缓存，再以完整本地文件提供给客户端并执行本地响度分析。

音声/音频是第一优先级。MP4、AVI 等视频或其他媒体格式只作为额外兼容能力，不能反过来主导数据模型、扫描策略或播放器设计。

`/media/MP_movieDB/NSFW/Voice1` 是混合目录：音频/视频使用 `.strm` 指针，字幕、图片等小文件已经由 MP 插件下载为本地文件。适配器只对 `.strm` 音视频执行远程逻辑，不能把本地字幕和图片重新转换成远程请求。

STRM 文件名采用“原始媒体扩展名在 `.strm` 之前”的格式，例如 `xxx.flac.strm`、`xxx.mp3.strm`、`xxx.mp4.strm`。最后一个 `.strm` 是物理指针后缀，前面的扩展名用于文件树展示和媒体类型判断，不再为类型额外请求远程媒体。

## 2. 已确认的范围

### 2.1 本项目负责

- 让 Kikoeru 扫描并识别 `.strm` 文件为可播放媒体。
- 读取本地 `.strm` 中的媒体 URL，不主动扫描网盘挂载内容。
- 保持已下载到 `/media/MP_movieDB/NSFW/Voice1` 的字幕、图片等本地资源走 Kikoeru 原有本地文件路径。
- 在 Kikoeru 已有鉴权之后，解析 STRM 中的 P115StrmHelper URL，取得其 302 的 CDN `Location`，再将客户端重定向到 CDN 直链。
- 保持 Kikoeru 原有本地音频播放能力。
- 以音频为默认媒体类型，保留 MP4 等格式的兼容路径。
- 只在建库/文件更新的受控队列中对 STRM 指向的远端媒体执行时长 `ffprobe`；播放时不再对 CDN 做响度分析。若响度缓存尚未就绪，首次播放允许由 Kikoeru 单独完整下载到本地临时缓存，先以完整本地文件播放，再仅对本地文件执行响度分析。
- STRM 的冷启动下载、临时文件清理、响度缓存和状态查看集中放在原生管理界面的“STRM 设置”子菜单中。
- 为 STRM 行为提供可配置项、错误提示和可重复构建的 Docker 适配层。

### 2.2 明确不负责

- 不生成、重写或清理 `.strm` 文件。
- 不实现 115 登录、115 API、pickcode 获取或网盘目录遍历。
- 不替换 MoviePilot 的 `P115StrmHelper`，也不修改其配置。
- 不轮询 `/media/CloudNas` 的 FUSE 网盘挂载来寻找媒体内容。
- 不修改当前正在运行的生产 Kikoeru 容器。
- 不把 Kikoeru 数据库迁移成 MoviePilot 或 Emby 的数据库。
- 不把 MP4 视频支持做成核心业务；视频转码也不列入第一阶段。
- STRM 转码直接拒绝；STRM 不直接对 CDN 做响度/波形分析。响度只允许在冷启动完整落盘后对本地缓存文件执行一次，波形/峰值分析不纳入 STRM；AI 翻译继续直接拒绝 STRM。
- 热路径播放期间不在 Kikoeru 服务端启动针对 STRM 的 `ffprobe`、FFmpeg、响度分析或其他媒体下载任务；冷路径只允许一次单飞完整 CDN 下载，且客户端在该阶段只能读取本地完整文件，不能同时访问 CDN。

### 2.3 客户端平台约束

Kikoeru iOS 客户端是闭源客户端，本项目无法修改其播放器、网络请求或音量处理逻辑。所有 STRM 支持必须通过现有 Kikoeru API 和标准 HTTP 播放行为完成，不能把“修改 iOS 客户端”或“客户端自行适配 STRM/响度分析”作为实现前提。

因此，STRM 播放必须由服务端完成鉴权和指针校验。热路径执行一次 Helper 302 解析后把客户端重定向到 CDN；冷路径则由服务端单飞下载完整媒体到本地，再以普通本地文件提供给客户端。两条路径都不能让服务端和客户端同时读取同一个 CDN 媒体。客户端能否显示或播放，必须以现有 iOS/网页客户端对标准音频 URL、302、Range 的支持为准。

STRM 尚未在 `/media/MP_movieDB/NSFW/Voice1` 生成时，项目仍应可以使用本地 fixture 完成单元测试和集成测试，但不能把“目标目录已有 STRM”写成当前前置条件。

## 3. 运行环境和事实基线

### 3.1 Docker 镜像是当前实现的事实来源

GitHub 上的 `kikoeru-express` 和 `kikoeru-quasar` 版本较旧，只用于辅助理解。实际开发以 `number17/kikoeru` Docker 镜像内的编译产物为准。

本次已从镜像创建独立的停止容器 `kikoeru-strm-reference`，并将程序提取到：

```text
./tmp/kikoeru-container
```

本次核查到的镜像信息：

```text
镜像：number17/kikoeru:latest
应用版本：0.6.15
入口：node ./dist/src/app.js
服务端代码：/usr/src/kikoeru/dist/src
```

参考副本均位于被忽略的 `tmp/`：

```text
tmp/kikoeru-container  Docker 镜像实际编译产物，优先级最高
tmp/kikoeru-express    旧版后端源码，仅作结构参考
tmp/kikoeru-quasar     旧版前端源码，仅作结构参考
tmp/MoviePilot-Plugins P115StrmHelper 文档和公开源码参考
```

### 3.2 源目录和最终 STRM 目录

当前生产容器的只读核查结果是，FUSE 原件目录的映射为：

```text
宿主机 /media/CloudNas
  → 容器 /usr/src/kikoeru/VoiceWork

FUSE 原件宿主机目录：/media/CloudNas/115/NSFW/Voice
FUSE 原件容器内目录：/usr/src/kikoeru/VoiceWork/115/NSFW/Voice
```

生产容器当前还直接使用了 Google Drive 对应的 FUSE 挂载作为音声根目录：

```text
宿主机 /media/CloudNas/VoiceDB       (CloudFS/FUSE)
  → 容器 /usr/src/kikoeru/VoiceWork/VoiceDB
  → rootFolders: "谷歌源"
```

这只是当前生产环境的 FUSE 媒体路径映射，不是本项目最终应扫描的 STRM 目录。FUSE 原件路径和 Google Drive 音声根目录都不能替代 `/media/MP_movieDB/NSFW/Voice1`。

Kikoeru 最终应扫描的宿主机目录是：

```text
/media/MP_movieDB/NSFW/Voice1
```

后续派生容器需要把这个宿主机目录映射到 Kikoeru 的某个音声根目录；具体容器内路径和 `rootFolders` 配置在实现前确定。当前生产容器尚未因为本项目增加该挂载，本项目也不授权直接修改生产容器或上述目录。

## 4. 当前 Kikoeru 的关键行为和缺口

### 4.1 媒体扩展名

镜像中的 [`dist/src/filesystem/utils.js`](../tmp/kikoeru-container/dist/src/filesystem/utils.js) 定义了当前媒体扩展名：

```text
.mp3 .ogg .opus .wav .aac .flac .webm .mp4 .m4a .mka .aiff .avi
```

目前不包含 `.strm`。

因此仅修改播放接口是不够的；扫描、作品文件树、时长缓存和播放取链必须作为一条链路处理。

### 4.2 扫描和时长

当前 `scrapeWorkMemo` 会递归读取作品目录，对识别出的媒体文件调用 `ffprobe`，并把时长缓存到作品 `memo`。这已经是数据库持久化缓存，不是只存在内存中的临时结果：

```text
t_work.memo = {
  duration: { "子目录/音频.mp3": 123.45 },
  mtime: { "子目录/音频.mp3": 1710000000000 },
  isContainLyric: false
}
```

`setWorkMemo()` 将该 JSON 写入 `t_work.memo`，后续 `getTrackList()` 从中恢复文件时长。当前实现只查询并保存 `format=duration`；编码、码率、采样率等完整 `ffprobe` 信息目前没有单独落库。

当前 `.strm` 的第一行通常是 `P115StrmHelper` 的播放入口 URL。实际请求已经确认该入口返回 HTTP 302，并在 `Location` 中给出当前有效的 115 CDN 临时直链。因此不能把 `.strm` 文本文件本身交给本地 `ffprobe`，而应解析指针后对入口 URL 做远程 `ffprobe`，允许其跟随 302。最终带时效的 115 直链不应写入数据库。

第一阶段采用以下策略：

- `.strm` 作为逻辑媒体文件参与目录树和播放索引。
- 建库和作品文件更新时，只读取本地 STRM 文本并解析 URL；对新增或发生变化的有效 `.strm`，加入独立的远程 `ffprobe` 队列。
- 远程探测对象仅限 `.strm` 所代表的音频/视频媒体；同目录已经下载的字幕、图片、文本等本地文件不触发远端请求。
- 远程 probe 队列单线程执行，并在每次 probe 启动之间等待可配置间隔；默认建议 2 秒，允许进一步调慢，不能直接复用普通媒体的 `maxParallelism` 并发。
- 远程 `ffprobe` 成功后，将时长写入现有的 `t_work.memo.duration`；以 `.strm` 的 `mtime` 加指针内容指纹判断是否需要再次探测。
- 未变化且已有缓存的 `.strm` 不重复访问远端；首轮建库会按文件数量产生受控的 probe 请求。
- 播放器的 HTMLMediaElement 时长作为缓存缺失或探测失败时的运行时兜底，不再作为首选建库策略。
- 探测失败要记录状态、时间和可重试信息，不能让单个失效 STRM 阻塞整个作品或全库扫描。

这样可以在建库时得到可用于文件树展示的时长，同时把远程请求从“无控制的并发扫描”变成“可持久化、可观测、可调速的队列”。

### 4.3 当前播放接口

镜像中的 [`dist/src/routes/media.js`](../tmp/kikoeru-container/dist/src/routes/media.js) 当前通过：

```text
GET /api/media/stream/:id/:index
```

查询作品和文件树后拼接本地路径，最后使用 `res.sendFile(fileName)` 返回文件。对 `.strm` 来说，这会返回 STRM 文本本身，而不是播放它指向的媒体。

当前生产普通媒体的带宽链路是：

```text
客户端 → Kikoeru → res.sendFile → 容器内 FUSE 路径
       → /media/CloudNas/VoiceDB → Google Drive → Kikoeru → 客户端
```

这里的“下载到本地”不一定意味着完整文件会永久落到宿主机本地磁盘，但媒体数据确实先由 Kikoeru 服务端通过 FUSE 读取，再转发给客户端，所以服务端承担完整播放带宽和 FUSE/Google Drive 读取压力。当前生产配置 `offloadMedia=false`，不能把它当作 STRM 直连方案。

适配后应保持 Kikoeru 原有 API 形状和鉴权流程，仅在识别到目标文件是 `.strm` 时根据 `redirectMode` 选择直链或本地策略：

```text
本地模式冷启动（响度尚未就绪）：
客户端 → Kikoeru 鉴权 → 读取并校验本地 STRM
        → Kikoeru HEAD 请求 P115StrmHelper
        → 服务端单飞 GET CDN → .part → 完整本地缓存
        → 原子改名 → Kikoeru sendFile → 客户端
        → FFmpeg 只分析已落盘的本地文件

热路径（响度已就绪，或策略标记为跳过）：
客户端 → Kikoeru 鉴权 → 读取并校验本地 STRM
        → Kikoeru HEAD 请求 P115StrmHelper（不跟随响应体）
        → 读取 Location → Kikoeru HTTP 302 → 当前有效的 115 CDN 直链 → 客户端

直连模式（无论响度/本地缓存是否就绪）：
客户端 → Kikoeru 鉴权 → 读取并校验本地 STRM
        → Kikoeru HEAD 请求 P115StrmHelper → HTTP 302 → CDN
        → 客户端按原 Range 请求 CDN，媒体字节不经过 Kikoeru
```

本地模式冷启动时 115 CDN 只能由 Kikoeru 服务端读取，客户端不能同时访问 CDN；客户端收到的是已经完整落盘的本地文件。直连模式始终只返回 302，不把媒体字节经过 Kikoeru 服务端。

同一个 STRM 必须使用单任务锁；不能因为多个客户端请求而产生多个 CDN 下载。`.part` 文件未完成前禁止 `sendFile`，完成后必须原子改名。下载失败的临时文件不能进入播放或响度分析路径。

播放时要求 Kikoeru 服务端能访问 P115StrmHelper，客户端能访问热路径返回的 115 CDN 直链；iOS 客户端不需要也不能依赖额外适配。

下载接口也应对 `.strm` 做同样的“下载目标媒体”语义，而不是让用户下载一个文本指针文件；冷启动本地缓存策略由播放接口或响度兼容接口触发，避免下载按钮意外批量占用磁盘。

### 4.4 前端播放模型

Kikoeru 前端通过服务端返回的 `mediaStreamUrl` 播放媒体，现有播放器同时保留 `<audio>` 和 `<video>` 两种元素。

第一阶段优先确保 `.strm` 音声在 `<audio>` 路径下可以加载、暂停、继续和 seek。STRM 的真实媒体扩展名已经由生成规则固定在本地文件名中，例如 `xxx.flac.strm`、`xxx.mp3.strm`、`xxx.mp4.strm`，因此不再通过远程请求探测类型；视频类型直接依据去掉最后 `.strm` 后的扩展名判断。

前端现有 `AudioElement` 会把 `mediaStreamUrl` 设置到 HTMLMediaElement，并自动带上 Kikoeru token；因此音频 STRM 的基本播放不需要改前端 URL 模型。树节点应展示去掉最后 `.strm` 后的原始文件名和媒体扩展名，但后端必须继续保留 `sourceExt=.strm`/`isStrm=true`，以确保转码入口仍然直接拒绝 STRM。iOS 客户端不做任何专用适配，也不负责响度计算或应用响度结果。

### 4.5 STRM 涉及的实际调用面

| 功能 | 镜像中的实际位置 | STRM 适配要求 |
| --- | --- | --- |
| 首次建库 | `filesystem/scannerModules.js` 的 `performScan → processFolder → scrapeWorkMemo → setWorkMemo` | 必须探测新增有效 STRM 的 URL，并保存时长 |
| 已有作品文件扫描 | `filesystem/workFileScanner.js` → `performWorkFileScan → scanWorkFile` | 必须复用同一套缓存和限速队列 |
| 手动扫描作品 | `routes/metadata.js` 的 `/work/scan/:id` | 必须触发同一套 STRM 时长更新 |
| 文件变更后的 memo 刷新 | `routes/filemanager.js` 的 `refreshWorkMemo` | 保持本地文件操作不变，但刷新 memo 时识别 STRM |
| 文件树和时长展示 | `filesystem/utils.js` 的 `getTrackList → toTree`，以及 metadata normalize | 从 `*.媒体扩展名.strm` 解析虚拟名称/类型，读取 `t_work.memo.duration`；不为类型额外远程探测 |
| 普通播放 | `routes/media.js` 的 `/stream/:id/:index` | `direct` 模式始终 HEAD 解析 Helper 的 `Location` 后 302 到 CDN；`local` 模式才在响度未就绪时走单飞完整下载和本地 `sendFile` |
| STRM 冷启动缓存 | 新增 STRM 媒体缓存/分析模块 | `.part` 下载完成后原子改名；本地文件可供首个客户端播放和本地响度分析复用，禁止重复 CDN 下载 |
| 下载 | `routes/media.js` 的 `/download/:id/:index` | 同样解析 CDN 后 302；本地字幕、图片等仍按原逻辑下载 |
| 浏览器播放器 | 前端 `AudioElement` 的 `mediaStreamUrl` | 基本不改；验证 HTMLMediaElement 可跟随 302、Range 和播放 |
| 歌词 | `query-lrc`、`check-lrc`、`fetch-lrc` | 保持原逻辑，歌词仍是本地文件 |
| 转码 | `/transcode`、`/pre-transcode`、`audioProcessor` | 第一阶段拒绝 STRM，避免把文本指针当音频输入 |
| 响度/波形 | `/calculate/loudnorm`、`audioProcessor` | STRM 仅对已完整落盘的本地缓存文件做一次响度分析；首次响度请求可触发共享冷启动，不做波形/峰值分析，不对 CDN 执行响度读取 |
| AI 翻译 | `routes/translate.js` | 第一阶段不对 STRM 建立翻译任务，避免隐式下载远程音频 |
| 播放历史 | `routes/play_histroy.js` | 不涉及媒体字节，不需要改 |
| STRM 设置 | 原生 `DashboardLayout`、admin 路由和配置 API | 增加 `/admin/strm` 子菜单，管理冷启动、缓存上限、清理策略、响度状态和任务状态 |

文件监听器目前只把目录事件交给扫描流程，并会忽略文件事件本身。若 MP 插件替换的是已入库作品目录中的 `.strm` 文件，第一阶段必须通过手动作品扫描/文件扫描更新时长；是否扩展文件监听器属于后续增量更新任务。

### 4.6 STRM 文件读写、修复和删除生命周期

STRM 是本地文件系统中的指针文件，不是远端媒体的所有权凭证。Kikoeru 对它的任何操作都只作用于本地 `.strm`、Kikoeru 数据库和 STRM 临时媒体缓存；不得因为重命名、修复或删除 `.strm` 而调用 115 删除接口、修改远端文件，或把 STRM 内容上传回网盘。

当前 Docker 镜像中需要纳入适配的实际入口包括：`routes/filemanager.js` 的 `/rename/:id`、`/mkdir/:id`、`/move/:id`、`/delete/:id`、`/upload/:id`，以及 `routes/metadata.js` 的 `/work/scan/:id`、`/work/fix/gbk/:id` 和 `DELETE /work/:id`。这些路由继续负责本地文件和原生作品数据的操作，但完成后必须调用同一个 STRM 对账服务；`edit.js` 中只改作品元数据或本地封面时，不应额外触发 STRM 媒体任务。

| Kikoeru 操作 | STRM 对应行为 | 缓存/数据库联动 |
| --- | --- | --- |
| 读取、扫描、文件树 | 读取本地指针文本并解析 `xxx.flac.strm → xxx.flac`；树中展示逻辑媒体名称和类型，不能把 `.strm` 文本当作可下载文本文件 | 通过路径和指针指纹读取 `t_work.memo.duration` 与 `t_strm_media_cache`；扫描本身不下载媒体 |
| 播放读取 | 由播放分支读取指针并按热/冷路径处理；热路径返回 CDN 302，冷路径只从完整本地缓存 `sendFile` | 使用单任务锁；`.part` 不得被播放或 FFmpeg 读取 |
| 上传/写入 | `.strm` 写入前校验大小、编码、首个非空 URL、协议、Helper 主机和文件名中的媒体扩展名；使用临时指针文件完成后原子改名，禁止写入半截指针后被扫描 | 新增或替换指针后使旧的 duration/loudness 状态失效并重新排队；写入阶段不请求远端 URL。图片、字幕、文本继续走原生本地写入逻辑 |
| 重命名 | 只重命名本地指针文件；必须保留 `媒体扩展名.strm` 语义。改成不支持的媒体扩展名或裸 `.strm` 时标记为不可播放/报错，不把它伪装成普通音频 | 已知旧路径和新路径时迁移缓存记录；若指针指纹未变，保留时长、响度结果和完整媒体缓存，不重新下载；发生指针内容变化则失效 |
| 移动 | 与重命名相同，连同目录移动后重新计算相对路径并刷新作品 memo；遇到目标缓存记录冲突时不覆盖另一条记录 | 在同一协调流程中更新路径索引；无法安全对应时只使受影响记录失效，不能误用别的 STRM 的响度或媒体文件 |
| GBK/编码修复 | `routes/metadata.js` 的作品修复可能批量改名；修复只处理本地文件名/目录名，不改 STRM URL 内容，不触发远端媒体读取 | 修复前后执行 STRM 路径对账；能按指纹对应的记录迁移，无法对应的记录失效并等待重新扫描/分析；最后统一刷新 memo |
| 删除文件/目录 | 删除的是本地 `.strm` 指针或本地目录；不删除、不撤销、不探测 115 远端媒体 | 删除对应 `t_strm_media_cache` 记录、临时完整媒体和未完成 `.part`；若任务正在播放/分析，先由单任务锁完成或取消，再延迟清理，禁止删除后继续使用悬空路径 |
| 删除作品 | `deleteFiles=true` 时随本地作品目录一起清理 STRM 缓存；`deleteFiles=false` 时也清理该作品的 STRM 索引和临时媒体，避免数据库产生孤儿记录，日后重新扫描时重新建立 | 只删除本地缓存和本地分析记录；远端 115 内容始终保留 |
| 新建目录 | 只是本地目录操作，不产生 STRM 远程任务 | 不创建缓存记录；沿用原生 memo 刷新 |

上述操作必须共用一个 STRM 对账入口，而不是在各个路由中分别猜测缓存状态。对账入口至少接收“旧路径集合/新路径集合/指针内容是否变化”三类信息，并在 `rename`、`move`、GBK 修复、上传写入、单文件删除、目录删除和作品删除后调用。缓存媒体文件应使用稳定的内部键或哈希路径保存，不直接依赖可变的展示文件名；数据库仍保存本地 STRM 相对路径、mtime、指针内容指纹和缓存状态。

对账和清理都必须遵守以下顺序：先取得对应 STRM 的单任务锁，再停止或等待下载/响度任务，最后更新数据库并清理文件。清理失败要留下待清理状态供“STRM 设置”页面显示和下次任务重试；不能以删除数据库行代替仍被任务使用的文件安全处理。普通本地音频、图片、字幕、歌词和文本不进入这套 STRM 缓存生命周期。

## 5. 目标设计

### 5.1 STRM 指针解析器

新增独立的 STRM 解析模块，不把解析逻辑散落在扫描器和路由中。

建议职责：

- 只打开本地 `.strm` 文件。
- 限制读取大小，例如默认最多 64 KiB。
- 读取第一个非空行作为 URL，兼容 UTF-8 BOM 和 Windows 换行。
- 默认只接受 `http` / `https`。
- 拒绝空内容、相对路径、`file://`、多余脚本内容和明显非法 URL。
- 通过配置限制允许的主机或 URL 前缀，避免把任意本地文件变成开放重定向器。
- 对文件名采用“最后一个 `.strm` 是指针后缀”的规则：`xxx.flac.strm` 的逻辑媒体名称为 `xxx.flac`，媒体扩展名为 `.flac`；`mp3`、`wav`、`flac`、`mp4` 等类型不需要请求远程 URL 判断。
- 解析器本身不请求 URL；通过校验的 URL 仅在时长 probe 或播放/冷启动下载流程中交给对应模块。
- 返回结构化错误，让 UI 和日志能区分“文件为空”“协议不支持”“地址不允许”等情况。

### 5.2 扫描适配

在媒体发现和作品文件树构建阶段加入 `.strm` 分支：

- 将 `.strm` 作为可播放媒体计入作品。
- 保留物理来源扩展名 `.strm`，同时从文件名解析虚拟媒体扩展名和展示名称；不通过远程请求判断媒体类型。
- 不把 `.strm` 文本交给普通本地音频 `ffprobe`。
- 对新增或内容/mtime 发生变化的有效 `.strm`，调用远程 probe 队列对其 URL（而不是文本文件）执行 `ffprobe`。
- 复用 `t_work.memo.duration` 保存文件树需要的时长，并在其中保存时长 probe 的时间、状态和指针指纹等轻量信息。
- 新增 STRM 专用的本地数据库记录（建议 `t_strm_media_cache`），保存每个 STRM 的 `downloadReady`、`loudnessReady`、文件大小、缓存路径、mtime/指针指纹、最近访问时间和响度结果；不使用原生响度缓存的 500 条上限。
- STRM 专用数据库记录必须全量持久化，缓存淘汰只删除临时媒体文件，不删除已经完成的响度结果；STRM 内容指纹变化时再使对应结果失效。
- 响度记录只保存 `loudnorm` 结果；不为 STRM 保存或计算波形/峰值数据。
- 保留同目录的 `.lrc`、`.srt`、`.ass`、`.vtt`、图片和文本文件处理；这些已经落地的本地资源不进入 STRM 远程探测队列。
- 让 STRM 文件与同名歌词按文件名匹配。
- 对失效 STRM 记录可读错误，但不因为单个指针失效而阻塞整个作品扫描。
- 不为发现 `.strm` 而遍历或 probe `/media/CloudNas` 下的实际网盘文件。

### 5.3 播放和下载适配

`/api/media/stream/:id/:index` 的 STRM 分支：

1. 沿用现有用户鉴权。
2. 通过 Kikoeru 文件树定位本地 `.strm`。
3. 解析并校验指针 URL。
4. 查询 STRM 专用本地数据库中的源指纹和 `loudnessReady` 状态。
5. 如果响度已就绪，或该文件因类型/大小策略被标记为跳过，服务端以 `HEAD` 请求访问 P115StrmHelper，禁止自动跟随重定向，只读取并校验 `Location`，然后返回 302 到当前 CDN 直链。
6. 如果响度尚未就绪且没有完整本地缓存，播放入口或响度兼容入口获取该 STRM 的单任务锁；服务端以 `HEAD` 获取 CDN 地址后执行一次完整媒体下载到 `.part` 文件，下载完成并校验后原子改名，再由播放入口用 `sendFile` 将完整本地文件提供给客户端。若已有 `downloadReady` 的完整缓存，直接复用该文件，不重新访问 CDN。客户端在这个冷启动请求中不能同时访问 CDN。
7. 完整文件落盘后，响度任务只读取本地缓存文件；完成后写入全量本地数据库并设置 `loudnessReady`。
8. 不缓存可能过期的 115 最终下载地址；URL 有效期和刷新由 `P115StrmHelper` 负责。

`/api/media/download/:id/:index` 的 STRM 分支沿用同一解析逻辑，默认重定向到最终 CDN，让客户端按远端响应处理下载；冷启动本地缓存策略由播放接口或响度兼容接口触发，避免下载按钮意外批量占用磁盘。

第一阶段不做持续性的服务器端代理和转码。冷启动完整下载是一次性的缓存预热例外；它会让首个请求承担一次 Kikoeru 出站传输和本地磁盘占用，后续请求仍走 CDN 302。如果直链在客户端网络不可达，再单独评估长期代理模式。

### 5.4 时长和远端请求策略

默认请求策略：

```text
扫描/建库：仅对新增或变化的有效 STRM，通过单线程限速队列执行远程 ffprobe；文件名类型判断不产生远端请求
扫描/建库：未变化且已有缓存的 STRM 为 0 次远端请求
扫描/建库：本地字幕、图片、文本等资源为 0 次远端请求
打开作品详情：0 次远端请求
点击热路径：Kikoeru 对 Helper 发 1 次轻量 HEAD 解析，再 302 到 CDN；媒体字节不经过 Kikoeru
点击冷路径：Kikoeru 对 Helper 发 1 次 HEAD，并执行 1 次单飞完整 CDN 下载；客户端从 Kikoeru 完整本地文件接收媒体
预先探测时长：建库阶段开启；播放阶段不重复探测
冷路径响度：只对已落盘的本地文件执行 1 次 `loudnorm`；不再请求 CDN
热路径响度/波形/转码：0 次；不得启动服务端媒体读取任务
```

STRM 的远程 probe 必须具备：

- 全局开关。
- 可配置最小请求间隔，默认建议 2 秒或更慢。
- 单线程，且与本地媒体的 `maxParallelism` 分离。
- 成功时长复用 `t_work.memo.duration`；同时持久化指针指纹、probe 时间、状态和失败退避时间。
- 设置超时，避免一个挂起的直链占住整个队列。
- 扫描取消和队列上限。
- 日志中明确标记 probe 请求，便于确认 API 压力。

冷启动下载和响度分析必须具备：

- 每个 STRM 一个单任务锁，合并并发的首个播放请求。
- `.part` 文件只用于未完成下载；禁止被 `sendFile` 或 FFmpeg 使用。
- 下载完成后原子改名，并使用本地完整文件作为播放和响度分析的唯一输入。
- 响度分析只执行 `loudnorm`，不执行当前 Kikoeru 的 `getAudioPeaks` 全文件扫描。
- `downloadReady` 与 `loudnessReady` 独立记录；清理临时媒体文件不得删除已完成的响度结果。
- 响度结果全量持久化，不受原生 500 条响度缓存上限影响。
- STRM 文件 mtime 或指针内容指纹变化时，旧的本地媒体缓存和响度结果失效。

冷启动是播放策略的明确例外：服务端先成为唯一 CDN 媒体消费者，客户端只接收本地完整文件；进入热路径返回 302 后，服务端不得再为同一个 STRM 启动响度、波形、转码或其他 FFmpeg 读取任务。

现阶段只把时长作为 Kikoeru 文件树需要的技术信息。若后续还要展示编码、码率、采样率、声道等信息，再明确字段后扩展同一份 memo 或单独设计技术信息表。

## 6. 交付形态和更新策略

当前 Docker 镜像没有可直接加载的 Kikoeru 插件运行时；因此本项目应采用“基于上游镜像的可重复构建适配层”，而不是修改运行中的容器文件。

目标交付结构：

```text
Dockerfile
patches/
  <kikoeru-version>/
scripts/
tests/
docs/
```

构建流程：

1. `FROM number17/kikoeru:<明确 tag>`。
2. 校验基础镜像版本和关键文件指纹。
3. 对 `dist/src` 应用最小化、版本化补丁。
4. 如需要前端设置页，再对对应静态资源应用有指纹检查的补丁。
5. 生成新的派生镜像；不覆盖上游镜像。

更新规则：

- 默认禁止直接修改生产容器。
- 上游镜像升级必须重新提取 `dist/src` 并重新核对入口、媒体列表、路由和前端资源。
- 关键文件指纹不匹配时构建失败，不能静默把补丁套到未知版本。
- 每个适配版本保留变更说明和回滚方式。
- 配置和数据库继续使用用户现有的宿主机挂载，不把敏感数据打进镜像。

## 7. 配置规划

配置名称最终以实际实现为准，建议使用独立的 STRM 配置命名空间，不污染 Kikoeru 原有字段。

建议配置项：

| 配置项 | 默认方向 | 说明 |
| --- | --- | --- |
| `strm.enabled` | `true` | 是否启用 STRM 支持 |
| `strm.extension` | `.strm` | STRM 文件扩展名 |
| `strm.filenameMode` | `media-extension-before-strm` | 按 `xxx.flac.strm` 解析展示名称和媒体类型，不请求远程 URL 判断类型 |
| `strm.allowedSchemes` | `http,https` | 允许的指针协议 |
| `strm.allowedHosts` | 显式配置 | 允许的 P115StrmHelper/直链服务主机 |
| `strm.maxPointerBytes` | `64 KiB` | 单个指针文件读取上限 |
| `strm.durationProbe.enabled` | `true` | 建库/更新时是否启用远端时长探测 |
| `strm.durationProbe.intervalMs` | `2000` | 两次远端 probe 启动之间的最小间隔 |
| `strm.durationProbe.maxConcurrent` | `1` | 远程 STRM probe 并发数 |
| `strm.durationProbe.timeoutMs` | `60000` | 单次远程 probe 超时 |
| `strm.durationProbe.maxQueue` | 有限值 | 防止全库扫描产生无限队列 |
| `strm.redirectResolve.method` | `HEAD` | 播放时解析 Helper 302 的请求方法 |
| `strm.redirectResolve.timeoutMs` | `10000` | 播放时直链解析超时 |
| `strm.redirectResolve.cacheTtlMs` | `10000` | 同一 STRM 临时复用已校验的 CDN Location；0 表示每次请求重新解析 |
| `strm.finalAllowedHosts` | 显式配置 | 允许的最终 CDN 主机或域名后缀 |
| `strm.redirectMode` | `direct` | `direct` 返回 CDN 302；`local` 优先由已完成本地缓存提供，兼容无法跨域访问 CDN 的客户端 |
| `strm.coldCache.enabled` | 可配置 | 响度未就绪时是否允许首次完整落盘并本地播放 |
| `strm.coldCache.rootDir` | 本地持久目录 | 临时媒体缓存目录；建议与最终 STRM 库位于同一宿主机存储，但不放在扫描目录内 |
| `strm.coldCache.maxTotalBytes` | 可配置 | 临时媒体缓存总容量上限 |
| `strm.coldCache.maxFileBytes` | 可配置 | 单个文件完整落盘上限 |
| `strm.coldCache.maxVideoBytes` | 可配置 | MP4 等视频允许冷启动落盘的大小上限，超出则跳过响度并走 302 |
| `strm.coldCache.cleanupPolicy` | `lru+ttl` | 按容量和过期时间清理临时媒体文件 |
| `strm.coldCache.maxAgeMs` | 可配置 | 临时媒体文件最长保留时间 |
| `strm.coldCache.cleanupIntervalMs` | 可配置 | 自动清理周期 |
| `strm.loudness.enabled` | 可配置 | 是否对冷启动后已落盘的本地文件计算响度 |
| `strm.loudness.audioOnly` | `true` | 只对音频执行响度分析；视频由大小策略决定是否跳过 |
| `strm.loudness.method` | `loudnorm` | 响度测量器；可选 `loudnorm` 或 `ebur128`，后者只映射真实输入测量字段 |

设置页面必须提供原生管理界面的 `STRM 设置` 子菜单，建议路由为 `/admin/strm`，与现有 `DashboardLayout` 的“扫描”“用户管理”“高级设置”同级。页面至少包含冷启动开关、缓存目录、总容量/单文件/视频上限、TTL/LRU 清理、响度开关、当前缓存占用、进行中的下载/分析任务、孤儿缓存/索引对账状态，以及“立即清理临时媒体缓存”按钮。清理按钮必须二次确认，且只删除临时媒体文件，不删除数据库中的响度结果；文件生命周期操作留下的待清理项和对账错误也必须可见并可重试。

## 8. 实施阶段

### 阶段 0：基线和 fixture

- 固定一个上游 Docker tag。
- 保存实际镜像的关键文件指纹和版本信息。
- 建立本地 `.strm` fixture：音频目标、视频目标、空文件、非法协议、非法 URL。
- 建立假的 302 直链服务，测试时不请求真实 115 或生产 MoviePilot。

### 阶段 1：核心解析和扫描

- 实现 STRM 解析器。
- 接入媒体扩展名和文件树：从 `*.媒体扩展名.strm` 解析虚拟名称和类型，保留 `.strm` 作为内部来源标记。
- 禁止 `.strm` 进入普通本地 `ffprobe`；对有效指针接入单线程、可调速的 URL `ffprobe` 队列。
- 建库/文件更新等待该队列完成当前批次，并将成功时长写入现有 `t_work.memo`；已有缓存的未变化 STRM 不重复探测。
- 持久化 probe 时间、指针指纹和失败退避，避免失败的 STRM 在每次扫描中无限重试。
- 建立 STRM 专用本地缓存数据库记录，响度结果全量保存，不复用原生 500 条响度缓存上限。
- 建立统一的 STRM 路径对账服务，并接入文件管理器的写入/重命名/移动/删除和 metadata 的 GBK 修复/作品删除；对账优先按指针内容指纹迁移记录，无法安全对应时使记录失效，不能串用其他文件的缓存。
- 明确拒绝 STRM 的转码和 AI 翻译入口；响度只允许由冷启动落盘后的本地文件分析，不允许直接读取 CDN。
- 保留本地 MP3/MP4、歌词、图片和文本处理原有行为的回归测试。

### 阶段 2：播放链路

- 改造 stream 路由的 STRM 分支。
- 改造 download 路由的 STRM 分支。
- 验证鉴权、302、Range、失效地址和错误响应。
- 验证响度未就绪时只发生一次单飞完整 CDN 下载，`.part` 完成原子改名后才允许 `sendFile`；服务端和客户端不同时读取 CDN。
- 验证响度就绪或策略跳过后直接返回 302，服务端不再读取媒体字节。
- 确认 Kikoeru 先通过 HEAD 取得 Helper 的 `Location`，对外返回的是 CDN 直链而不是 Helper URL。
- 优先验证音频播放、暂停、继续和 seek。
- 验证前端默认不会把 STRM 送入 `/transcode`，普通本地媒体转码行为不回归。
- 验证重命名、移动和 GBK 修复后，指针指纹未变的响度结果/完整缓存可以迁移复用；指针内容变化会失效并重新处理。
- 验证上传、删除文件/目录和删除作品只清理本地指针、缓存及数据库记录，不触碰远端 115；活动任务中的文件会等待或延迟清理，不产生悬空播放路径。

### 阶段 3：配置和管理页面

- 在原生管理界面增加 `STRM 设置` 子菜单和 `/admin/strm` 页面；以实际 Docker 静态资源为准做版本化补丁。
- 接入 STRM 专用配置、缓存状态查询和临时媒体清理操作。
- 为重命名、移动、GBK 修复、上传写入、文件/目录删除和作品删除接入统一的 STRM 缓存对账与安全清理流程。
- 页面中明确说明 STRM 由 MoviePilot/115 助手生成，本项目只负责播放。
- 展示解析错误、最近一次失败、可脱敏的 URL 主机信息、下载/响度任务状态和缓存占用。

### 阶段 4：Docker 更新复用

- 编写版本感知的构建脚本和补丁。
- 增加基础镜像指纹检查。
- 使用新容器验证，不触碰生产容器。
- 记录从上游版本升级到派生版本的步骤和回滚方式。

### 阶段 5：真实目录验收

- 等待 MP 插件基于 `/media/CloudNas/115/NSFW/Voice` 生成真实 STRM 到 `/media/MP_movieDB/NSFW/Voice1`。
- Kikoeru 只扫描 `/media/MP_movieDB/NSFW/Voice1`，不把 FUSE 原件目录当作最终媒体库。
- 先抽样验证文件格式和目标 URL 主机，再按配置间隔执行全库 STRM 时长 probe；记录总耗时、成功/失败数和远端请求压力。
- 再在独立 Kikoeru 测试容器中执行扫描和播放。
- 最后由用户决定是否部署到现有生产 Kikoeru；本项目不会自动部署。

## 9. 收敛验收标准

### 功能

- `.strm` 能被 Kikoeru 扫描并出现在正确作品的文件树中。
- 点击音声后，Kikoeru 鉴权接口返回 302，而不是返回 `.strm` 文本。
- 302 的目标是服务端通过 HEAD 解析并经过白名单校验的当前 CDN 直链。
- 音频可以加载、播放、暂停、继续和 seek。
- 本地 MP3/MP4 等原有媒体仍能播放。
- 同名歌词和图片仍能被识别。
- 建库完成后，已成功 probe 的 STRM 在文件树中显示数据库缓存的时长。
- `xxx.flac.strm`、`xxx.mp3.strm` 等文件在树中显示原始媒体名称和类型，后端仍保留 STRM 来源标记。
- 响度未就绪的首次播放只由服务端读取一次 CDN，并从完整本地文件 `sendFile` 给客户端；本地响度结果完成后后续播放走 CDN 302。
- 响度结果全部保存在 STRM 专用本地数据库中，清理临时媒体文件不会删除这些结果。
- 本地字幕、图片等资源可以正常读取，且其访问不产生远程媒体请求。

### 性能和网盘压力

- 扫描 `.strm` 不读取 FUSE 目录下的真实媒体文件。
- 首次建库或 STRM 发生变化时，每个有效 STRM 最多排入一次远程 `ffprobe`；未变化且已有缓存的 STRM 不触发远端请求。
- 已下载的字幕、图片、文本等本地小文件始终沿用本地读取，不因音视频 STRM 播放而重复访问网盘 API。
- 远程 probe 使用独立单线程队列，按配置间隔启动，默认约 0.5 次/秒，并允许调得更慢。
- 作品详情只读取数据库 memo，不触发新的远程 probe；点击播放也不因 Kikoeru 自身逻辑重复 probe。
- 热路径播放期间同一个 STRM 只有客户端读取 CDN 媒体字节；Kikoeru 服务端不并行执行响度、波形、转码或其他 FFmpeg 任务。
- 冷路径播放期间同一个 STRM 只有 Kikoeru 服务端读取 CDN，客户端只读取完整本地缓存；响度分析只读取该本地文件。
- 冷路径每个 STRM 最多一个完整媒体下载任务；热路径每次播放最多增加一次 Helper 的轻量直链解析请求。
- 临时媒体缓存受总容量、单文件大小、视频大小和 TTL/LRU 清理策略约束；清理不得删除全量响度数据库记录。
- 单个失效 STRM 不会拖垮整次扫描。

### 安全和升级

- 不允许通过 STRM 指针读取任意本地文件。
- 不允许未校验的协议或 URL 形成开放重定向。
- stream/download 路由继续受 Kikoeru 鉴权保护。
- 基础镜像版本不匹配时构建失败。
- 生产容器、生产数据库、生产配置和 `/media/MP_movieDB` 没有被测试流程修改。

## 10. 当前待确认事项

这些事项不会阻塞规划文档，但会在进入实现前逐项确认：

1. `/media/MP_movieDB/NSFW/Voice1` 应映射到 Kikoeru 容器内哪个音声根目录，以及 `rootFolders` 的名称和路径是什么。
2. STRM 中的 URL 是否始终指向 MoviePilot 的 `P115StrmHelper/redirect_url`，以及 Kikoeru 客户端是否能直接访问该主机。
3. 音声目录的作品目录名是否满足 Kikoeru 当前的 RJ/BJ/VJ/自定义作品识别规则。
4. MP4 STRM 是否要求显示视频画面，还是只要求兼容其音频播放。
5. 冷启动缓存目录、总容量、单文件和视频大小的实际默认值。
6. 是否需要下载按钮获取远端媒体，还是第一阶段只要求在线播放；当前规划默认下载按钮直接 302，不触发冷启动缓存。

## 11. 参考资料

本项目的本地参考资料已下载到被忽略的 `tmp/`，来源和优先级如下：

1. Docker 镜像提取物：`tmp/kikoeru-container`，当前实现基线。
2. [kikoeru-express](https://github.com/Number178/kikoeru-express)，旧版后端结构参考。
3. [kikoeru-quasar](https://github.com/Number178/kikoeru-quasar)，旧版前端结构参考。
4. [MoviePilot-Plugins](https://github.com/DDSRem-Dev/MoviePilot-Plugins)，`P115StrmHelper` API 和 STRM 行为参考。
5. `/media/MP_movieDB` 中既有 STRM 和 Codex 历史记录，仅用于理解现有生成结果，不属于本项目源码。

本节描述的空白实现状态是 2026-09-04 历史基线的记录，不再代表当前目录状态。当前项目已有独立 overlay、入口脚本、配置初始化和自动化测试；它仍不负责生成 STRM、不执行 115 登录，也不会自动修改生产 Kikoeru。

当前实现和运行状态请以 [`README.md`](../README.md)、[`docs/OPERATIONS.md`](OPERATIONS.md) 及 `npm test` 结果为准。真实浏览器/iOS 播放、Range/seek、生产目录扫描和 115 压力仍属于部署前的受控验收，不在本历史规划文档中宣称已完成。
