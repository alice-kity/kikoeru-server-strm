# Kikoeru 0.6.17-20261007 overlay

目标：插件 `0.2.0`，上游应用 `0.6.17`，不可变镜像
`number17/kikoeru@sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391`。

运行时装饰接入新的媒体库定位对象、原生扫描队列、`t_track` 和媒体任务。
保留原生稳定 `work_id + seq` 和 `workId/seq` hash；数据库路径保留物理 `.strm`，
客户端展示虚拟媒体名称。指针内容指纹保护时长和 LUFS 失效及过期任务写回。

STRM 响度只读取完整本地缓存；波形和转码明确不支持。普通本地/OpenList 媒体仍
使用原生能力。Helper/CDN 校验、UA、限速/429 和完整冷缓存由插件负责。

旧状态迁移按作品、物理路径及指纹确认，保留旧文件并支持重试。数据库升级后的回退
必须恢复配套配置/SQLite 备份。详见 [接入方案](../../docs/UPGRADE-0.6.17.md)、
[兼容性](../../docs/COMPATIBILITY.md) 和 [运维](../../docs/OPERATIONS.md)。
