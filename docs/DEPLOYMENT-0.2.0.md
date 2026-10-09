# 0.2.0 业务实例升级记录

日期：2026-10-09。本文记录在明确授权下对两个实例进行的分开操作。代码与隔离 fixture 的
验收时点见[本地验收记录](VALIDATION-0.6.17.md)；该记录中的“尚未部署”描述的是当时状态。

## 目标与状态

| 实例 | 操作 | 结果 |
| --- | --- | --- |
| `kikoeru`，宿主端口 `12345` | 只升级原生 Kikoeru，不安装 STRM adapter | 上游 `number17/kikoeru` `0.6.17-20261007`，digest `sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391`；运行超过 4 小时，RestartCount 为 0，HTTP health 为 200；`736` works、`1` user，SQLite integrity 检查通过。 |
| `kikoeru-strm-12346`，宿主端口 `12346` | 插件升级至 `0.2.0`，基于同一 Kikoeru `0.6.17-20261007` | image ID `sha256:d67703ad3359385f79aca3714458cb1a71ae699e00ca3a8261b83babc91d3c70`；container ID `1f4cb25a834c2dfcd546cd9956a6ffeab6e23f315673bb61ce4a5fece2f0efd5`，StartedAt `2026-10-09T07:15:31.207785399Z`，healthy、RestartCount 0、HTTP health 200；`737` works、`1` user、`12,195` tracks、`7,060` durations、`163` native LUFS。17 个 adapter JavaScript 文件与工作区匹配。镜像内 85/85 项测试通过、0 跳过。 |

两实例账号认证数据未更改；迁移和数据库检查均已完成。真实 115/CDN、iOS/浏览器媒体解码与人工密码登录仍有单独的验收限制，见下文。

## 备份与迁移边界

两实例的配置和 SQLite 均在升级前做了冷备份，备份保存在仓库以外的位置。12346 的完整冷缓存
约 `512,834,543` 字节也已归档，留作回退。这里不记录宿主机私人备份路径。

兼容性修复覆盖旧 `rootFolder` 字符串及 `{name, path}` 对象两种形态。旧记录只按库名、作品物理
路径/key 和指针内容 fingerprint 匹配；不会复制旧状态里的私人 metadata。旧状态源文件保留。
新镜像为全部 `737/737` works 补齐了原生 tracks，并将旧状态里可确认的 duration/LUFS 迁入原生曲目表，
失败数为 0。执行只调用 `syncLocalTracks` 与 `migrateLegacyForWork`，完全在本地处理数据库，不触发时长探测、
不联系 Helper，也不下载媒体。原有 `163` 条 ready LUFS 按库名、key、相对路径和当前指针 fingerprint
逐项核对：`163/163` 匹配并迁入，mismatch/missing/wrong 均为 0；旧状态文件与冷备份逐字节相同。
本轮新迁入 `7,048` 个 duration 与 `161` 个 LUFS；另有 `12` 个 duration 和 `2` 个 LUFS 在迁移前已存在。
最终扫描队列空闲，旧状态源文件仍保留。

回退时必须停止 12346，并把同一备份时点的 `config/` 和 `sqlite/` 一起恢复后再切回 0.1.4 镜像；
不能在保留 0.2.0 数据库的情况下只切换旧镜像。详细命令见[运维说明](OPERATIONS.md)。

## 运行状态与未完成验收

- 12345 运行的是原生 Kikoeru 0.6.17，不含本项目 adapter；没有对它安装 STRM 插件。
- 12345 原生实例的 Parcel 文件 watcher 在 FUSE 媒体目录上遇到 `State not recoverable` 并导致实例重启。
  已仅对 12345 关闭 `enableFileWatcher`；手动扫描仍可用。12346 的本地 STRM watcher 保持启用。
- 两个实例的账号认证数据 hash 和 JWT signing secret 未改动，也没有重置账号。12346 的密码文件与旧数据库中的实际密码不匹配，
  因此没有声称人工登录验证成功。原生管理员 API 使用临时内存签发的 JWT 验证；这只能证明 API 鉴权路径，
  不能替代真实用户登录验收。
- 12346 抽样检查了 `26` 个 STRM 候选，其中已核对的 `23` 个 LUFS 结果正确。原生管理员 JWT API 返回 200，匿名请求返回
  401；内部数据页与作品总时长 API 返回 200，响度状态为 done 且结果与原生 LUFS 相符；STRM 转码和波形请求返回
  409，扫描队列空闲。没有在本次迁移核验中调用 Helper 或下载媒体。
- 本地代码/fixture 证据见[本地验收记录](VALIDATION-0.6.17.md)。真实 115/CDN、iOS 播放、Range/seek
  与长暂停恢复仍待设备和真实媒体环境抽样验证。
- 主机验收时 85 项 `npm test` 中 80 项通过、5 项跳过；其中 4 项 SQLite 用例依赖上游模块，另 1 项依赖
  FFmpeg。最终部署镜像内 85 项测试全部通过、0 跳过；SQLite 专项与旧对象形态数据库 fixture 也通过。
  新镜像中全部 17 个 adapter JavaScript 文件与工作区内容一致。
