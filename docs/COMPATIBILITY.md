# 兼容性与升级边界

当前插件 `0.2.6` 只适配经审查的 `Kikoeru 0.6.17-20261007`。

| 项目 | 当前基线 |
| --- | --- |
| 上游应用版本 | `0.6.17` |
| 不可变镜像 | `number17/kikoeru@sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391` |
| overlay | `patches/0.6.17/strm-adapter/` |
| 旧兼容记录 | `patches/0.6.15/`，插件 `0.1.4` |

验证清单按上游版本保存；构建默认仅接受当前目标版本及完整文件指纹。
关键保护边界包括 `trackStore`、本地/OpenList Provider、扫描队列/模块、原生曲目迁移、
媒体任务、响度与缓存、API 鉴权、应用启动和前端资源。指纹变化须重新审查，不能放宽门禁。

## 原生接入

- `t_track` 保存物理相对路径、稳定 seq/hash、duration 与 LUFS；总时长查询及内部数据页读取这些记录。
- 本地 STRM 由新的扫描装饰接入原生队列，进度/成功/失败与普通文件合并；OpenList 保留原生行为。
- 新响度任务使用原生注册表、队列和只读 ebur128 分析器（旧 loudnorm 配置归一化），下载完成前处于 queued，分析输入为完整本地缓存。
- 新增指针指纹字段以识别同大小/同时间戳的内容改变；写回再核对当前指针并作条件更新。
- 主进程和扫描子进程加载同一版 bootstrap；新版应用入口显式调用 `main()`。

## API 契约

启用原生鉴权时，除 health/login 外，STRM API 保留 `/api` JWT 保护。
管理读取、配置保存和清理额外要求管理员身份。

| 接口 | STRM 行为 |
| --- | --- |
| `/api/media/stream/:id/:seq` | 完整冷缓存首播、热 302；local 模式完整本地文件，支持 Range |
| `/api/media/download/:id/:seq` | 受控 CDN 302 |
| `/api/media/calculate/loudnorm/:id/:seq` | 兼容响度响应；共享任务并读取原生 LUFS |
| `/api/media/task/loudnorm/{status,start,stream_notify,result}/:id/:seq` | 原生风格任务状态、启动、终态 SSE、结果；pending/failed/done 明确 |
| `/api/media/task/waveform/{status,start,stream_notify,result}/:id/:seq` | 完整缓存上的原生波形任务；KWAV 持久化、结果等待、SSE、分辨率合并；视频或超限跳过 |
| `/api/media/task/transcode/*` | STRM 明确不支持，通知必须终止；普通媒体继续原生 |
| `/api/media/{transcode,pre-transcode}/*` | STRM 明确拒绝；内置客户端按曲禁用转码 |
| `/api/admin/strm`、`/api/strm/{status,config}` | JWT + admin，状态不返回指针或 CDN URL |
| `/api/admin/strm/cleanup` | 清理临时完整媒体与孤儿 part；保护分析中的输入，已保存 LUFS 和波形保留 |

`/api/caniuse` 保留全局原生能力，STRM 的限制按曲实施。
波形使用原生 KWAV/4 文件和 `t_track.waveform_*` 字段；指针变化使旧结果失效。
实时频谱是独立的浏览器 Web Audio 功能：内置播放器仅为使用 Web Audio 的 STRM 请求
`strm_local=1`，严格本地交付，不能缓存时返回 409，避免回退到会无声的跨域媒体。
普通媒体保留原生 CORS；无 Web Audio 的 STRM 保持 direct 行为。
客户端能力声明和真实 iOS 行为仍需客户端验收。

## 固定安全契约

指针必须为本地 `name.mediaext.strm`、单行 HTTP(S) Helper URL；Helper 由部署允许列表配置。
HEAD 只接受 3xx 和绝对 Location，最终主机固定为 `.115cdn.net`。指针文本不能送给 FFprobe/FFmpeg。
Helper HEAD 与 CDN 消费 UA 匹配，热跳转缓存按 UA 隔离；冷下载用固定服务器 UA。
限速、429 退避与单飞继续生效。完整下载先写 `.part`，完成后原子改名，分析只读完成文件。
指针、CDN URL、签名、JWT 与密码不写入日志或曲目/专有状态数据库。

## 迁移和回退

旧 `strm-state.json` 中有效时长及 LUFS 仅在作品、物理相对路径和指纹匹配时迁入。
无法确认的旧结果保留等待重新探测；源文件不删除或覆盖。迁移可重复执行，中断可继续。
曲目表是时长/LUFS 主来源；完整媒体仍按容量和 TTL 管理，响度结果不按条目数量淘汰。

回退到 0.1.4/0.6.15 必须恢复升级前匹配的配置和 SQLite 备份，然后切回旧镜像。
新版数据库不能视为旧镜像可直接读取的兼容数据库。部署步骤见 [OPERATIONS](OPERATIONS.md)。

## 验证边界

按 [收敛方案](UPGRADE-0.6.17.md) 完成版本门禁、专项单测、复制数据库迁移、镜像构建、
独立 fixture 容器的登录/扫描/任务/播放/Range 与脱敏检查。各命令实际结果另存验收记录。
fixture 不能代替真实 115/CDN、iOS 或浏览器播放与暂停恢复验收。

不承诺任意 STRM、CDN、上游版本、M3U、网盘登录/遍历、永久媒体归档或自动生产数据库迁移。

## 历史 0.1.4 / 0.6.15 基线

### 固定基线

| 项目 | `0.1.4` 固定值 |
| --- | --- |
| 适配器版本 | `0.1.4` |
| 上游应用版本 | `number17/kikoeru` `0.6.15` |
| 上游镜像引用 | `number17/kikoeru@sha256:864cf8445ead0d272ca69d449f0f47e4b6c413cc69392b996b70be8433f4c0e6` |
| 上游 digest | `sha256:864cf8445ead0d272ca69d449f0f47e4b6c413cc69392b996b70be8433f4c0e6` |
| overlay 目录 | `patches/0.6.15/strm-adapter/` |
| 独立容器/端口 | `kikoeru-strm-12346` / `12346` |
| 生产端口 | `12345`，不属于本项目 |

构建必须通过 `scripts/verify-upstream.js`。它会校验扫描、路由、配置、认证、数据库、
worker fork、响度处理和前端注入入口；精确文件清单及 SHA-256 以该脚本中的 `EXPECTED`
为准。

本版本是 `0.6.15` 的同版本热更新，不是 Kikoeru 应用版本升级。重新提取和接口审查
确认只有 `dist/src/filesystem/audioProcessor.js` 与 `dist/src/routes/media.js` 变化：
前者新增 `calculateLUFSSplitWithOption`，后者改为调用
`calculateLUFSSplitWithOption(fileName, 'ebur128')`。适配器自己的 STRM 响度由
`cache-manager` 处理，普通本地媒体仍由上游 `next()` 处理，因此不需要修改 STRM
适配器逻辑；patch 顶层目录继续是 `patches/0.6.15/`。本文件记录镜像、指纹和接口
审查，不声称已完成真实客户端或生产环境验证。

应用版本、digest 或任一指纹变化都属于高风险兼容性事件，不得未经审查直接复用旧
patch。若应用版本变化，应新增 `patches/<新上游版本>/`；同一应用版本的热更新只有
在完成接口复核、更新验证清单并记录变化后，才能继续使用对应版本目录。两种情况都
应保留旧镜像 tag，之后才可发布新适配器。
