# 独立 STRM 实例运维

当前发布为 `0.2.6`，仍使用锁定的 Kikoeru `0.6.17`。本次功能修复、波形持久化和
12346 升级结果见 [0.2.6 记录](DEPLOYMENT-0.2.6.md)。下方 0.2.0 记录保留首次上游迁移历史。

> 0.2.0 已在 2026-10-09 按单独授权升级到 Kikoeru 0.6.17。部署前备份了配套的
> `deploy/runtime/config/` 与 `deploy/runtime/sqlite/`；完整运行状态、迁移结果和遗留项见
> [0.2.0 部署记录](DEPLOYMENT-0.2.0.md)。回退必须先恢复同一时点的配置/SQLite，再使用旧
> 0.1.4 镜像；禁止仅切换镜像继续写新版数据库。真实 115/CDN 与 iOS 播放验收仍待完成。


本文针对插件 `0.2.6` / Kikoeru `0.6.17-20261007` 的版本化 overlay。
目标 digest 固定为 `sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391`，
新 patch 位于 `patches/0.6.17/`。独立实例已升级到插件 0.2.6 / Kikoeru 0.6.17；
旧 overlay 和指纹基线保留，以便按配套备份回退。真实客户端/CDN 验收仍需后续执行。

## 新主机安装前检查

确认以下条件后再运行安装脚本：

- Docker Engine 和 Docker Compose v2 可用，当前用户可以运行 Docker；
- `KIKOERU_STRM_MEDIA_DIR` 指定的媒体目录存在并包含要扫描的媒体树；该目录只读挂载到
  独立容器，不应把 FUSE 原件目录加入 Compose；
- 12346 没有被其他服务占用；
- 上游镜像可拉取，且部署方配置的 Helper 可由容器访问；
- 已准备备份位置，但不要在命令行、`.env` 示例或文档中写入密码、JWT 或带签名
  的 CDN URL。

Helper 是可配置的部署边界。STRM 文件只写入 Helper URL 的单行指针；本项目不在
文档中记录某个私人 Helper 地址。最终 CDN 必须是受控的 `.115cdn.net` 主机后缀，
不能通过配置改成任意公网主机。

## 首次安装

从项目根目录执行。下面的参数是复制即用的独立实例示例；在不同主机上只替换媒体
目录，独立数据目录固定为项目内的 `deploy/runtime/`：

```sh
cd /path/to/kikoeru-strm-plugin
chmod +x scripts/install.sh scripts/manage.sh
read -r -p 'Helper host[:port] (keep private): ' STRM_HELPER_HOST
./scripts/install.sh \
  --media /srv/kikoeru-media \
  --helper "$STRM_HELPER_HOST" \
  --port 12346 \
  --image kikoeru-strm:0.2.6
unset STRM_HELPER_HOST
```

安装脚本会检查参数、创建固定的 `deploy/runtime/` 独立数据目录、构建版本 overlay，
生成权限为 `0600` 的 `.env`，再启动独立 compose 项目。需要查看可用参数或在脚本
升级后核对行为时运行：

```sh
./scripts/install.sh --help
```

首次启动入口会创建：

| 位置 | 作用 | 是否包含敏感数据 |
| --- | --- | --- |
| `deploy/runtime/config/config.json` | 独立 Kikoeru/STRM 配置 | 是，权限应受限 |
| `deploy/runtime/config/admin-password` | 随机管理员密码（或注入密码） | 是，权限 `0600` |
| `deploy/runtime/sqlite/` | SQLite 和 `strm-state.json` | 是 |
| `deploy/runtime/covers/` | 封面 | 否，仍需备份 |
| `deploy/runtime/cache/` | 冷缓存、正式缓存和活动 `.part` | 临时媒体数据 |

安装后最小检查：

```sh
docker compose ps
curl -fsS http://127.0.0.1:12346/api/health
docker inspect kikoeru-strm-12346 --format '{{.Config.Image}}'
```

`/api/health` 只证明进程存活，不证明 Helper、CDN 或客户端可播放；首次登录后还
应使用一个测试 STRM 完成扫描和播放验收。

## STRM 和播放验收

测试文件必须使用 `name.mediaext.strm`，正文只有一个非空 HTTP(S) URL 行。适配器
会拒绝缺少媒体扩展名、额外非空行、非 allowlist Helper、非 3xx Helper 响应、相对
`Location` 或非 `.115cdn.net` 最终主机。

按以下顺序验收一条测试媒体：

1. 登录独立实例并扫描包含 STRM 的作品；确认时长探测队列按默认 2 秒间隔运行，
   不会把 `.strm` 文本交给本地 `ffprobe`。
2. 清理该媒体的临时缓存后首次播放；确认服务端只产生一次完整冷下载，`.part`
   完成后才原子改名，首播不读取未完成文件。
3. 响度就绪后再次播放、拖动和 Range/seek；`direct` 应返回不缓存的 302，
   客户端随后从 `.115cdn.net` 读取媒体；`local` 应由本地完整缓存响应。
4. 暂停超过 30 秒再恢复浏览器播放；只有发生 waiting/stalled/error 或持续网络加载
   时才允许一次恢复尝试。iOS 客户端需要单独验收其标准 HTTP 302、Range 和响度请求。
5. 查看脱敏日志和状态页，确认没有 Helper URL、CDN `Location`、query、JWT、
   Cookie 或密码。

STRM 设置通过原生 Vue Router 子路由融入 Kikoeru Dashboard 的视觉和导航；登录后从
原生管理后台的“STRM 设置”入口无刷新进入 `/admin/strm`。它复用 DashboardLayout 的
原生 `links` 数组和 `/admin` 子路由，切换扫描、高级设置或其他菜单时由 Vue Router
负责页面生命周期，避免双高亮、残留视图和污染原页面状态。缓存容量按 GiB 展示，保存
超过上限的配置时会显示明确提示。STRM 组件样式严格隔离，并在 Vue 组件销毁时回收
注入资源；设置表单在桌面采用两列对齐、窄屏采用单列滑动开关布局。核心媒体扫描、
缓存、响度和交付行为在本版本冻结。状态和写操作 API 均要求管理员 JWT：

```text
GET  /api/admin/strm
GET  /api/strm/status
GET  /api/strm/config
PUT  /api/admin/strm
POST /api/admin/strm/cleanup
```

`cleanup` 只删除适配器本地缓存和孤儿 `.part`，不删除 STRM 源文件、作品目录、
远端媒体或 Kikoeru SQLite。清理操作必须在管理页二次确认后执行。

## 备份、升级、回退

以下步骤用于维护独立 STRM 实例。升级前保留旧镜像，停止独立实例再离线备份，确保
SQLite/WAL 与配置来自同一时点。已经完成的本次升级及备份见[部署记录](DEPLOYMENT-0.2.0.md)：

```sh
cd /path/to/kikoeru-strm-plugin
./scripts/manage.sh stop
upgrade_backup_dir="/srv/kikoeru-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$upgrade_backup_dir"
chmod 700 "$upgrade_backup_dir"
cp -a deploy/runtime/config deploy/runtime/sqlite deploy/runtime/covers "$upgrade_backup_dir/"
cp -a .env "$upgrade_backup_dir/deployment.env"
printf '%s\n' "$upgrade_backup_dir"
```

完整媒体缓存可以不备份，已保存的 LUFS 不随完整媒体清理而删除。备份中含密钥与配置，
不要上传仓库或贴入日志。

使用本地已构建的新镜像升级：

```sh
./scripts/manage.sh upgrade --image kikoeru-strm:0.2.6
docker compose ps
curl -fsS http://127.0.0.1:12346/api/health
```

登录后触发原生作品文件扫描，等待队列结束，检查内部数据中的 STRM 物理路径、固定 seq、
时长与 LUFS；抽样验证首次播放、热播放 302、Range、管理页与真实客户端。
`--image` 使用已经存在的本地镜像；默认 `upgrade` 构建本代码发布的版本 tag 并更新 `.env`，保留旧 tag，避免覆盖回退镜像。
构建必须锁定 0.6.17 的目标 digest 与文件指纹，不能复用旧 `latest` 或旧 patch。

回退到 0.1.4/0.6.15 需要恢复备份；请将下例 backup 路径改为上面实际保存的目录：

```sh
./scripts/manage.sh stop
upgrade_backup_dir=/srv/kikoeru-backups/REPLACE_WITH_BACKUP_TIMESTAMP
rollback_saved_dir="/srv/kikoeru-backups/newer-data-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$rollback_saved_dir"
chmod 700 "$rollback_saved_dir"
mv deploy/runtime/config deploy/runtime/sqlite "$rollback_saved_dir/"
cp -a "$upgrade_backup_dir/config" "$upgrade_backup_dir/sqlite" deploy/runtime/
cp -a "$upgrade_backup_dir/deployment.env" .env
chmod 600 .env
./scripts/manage.sh rollback --image kikoeru-strm:0.1.4
curl -fsS http://127.0.0.1:12346/api/health
```

此回退保留新版数据供排查，不把新旧数据库混用。不能仅执行镜像 rollback 而保留
新版配置/SQLite；上游迁移和新的指纹列没有承诺对旧版的直接读取兼容性。

禁止以下做法：

- `docker compose down -v` 作为常规升级/回退命令；
- 对生产 `kikoeru` 执行 stop、recreate、remove 或重建；
- 在未备份时覆盖 `deploy/runtime/config` 或 `deploy/runtime/sqlite`；
- 用未锁定 digest 的浮动上游镜像发布新 overlay。

## 卸载与保留数据

默认卸载只移除独立容器、网络和 compose 项目，保留数据，便于以后重新安装或回退：

```sh
./scripts/manage.sh uninstall
```

当前 `manage.sh uninstall` 会拒绝 `--purge-data`，始终保留 bind 数据；这保证卸载后
可以重新安装或回退。若维护者另行制定数据删除流程，必须先做离线备份，并且只能由
人工确认本项目的 `deploy/runtime/`，不能指向媒体源、FUSE 原件、生产容器数据或宿主机
宽泛目录。源媒体目录和远端文件不由卸载脚本删除。

## 故障定位

按风险从低到高执行：

```sh
docker compose ps
curl -fsS http://127.0.0.1:12346/api/health
docker logs --tail=200 kikoeru-strm-12346
docker logs kikoeru-strm-12346 2>&1 | rg '\[STRM\]\[(scan|duration)\]'
```

常见安全错误码：

- `POINTER_*`：文件名或指针内容不符合单 URL 契约；
- `HELPER_NOT_REDIRECT`、`REDIRECT_LOCATION_MISSING`：Helper 未返回有效 3xx；
- `FINAL_HOST_NOT_ALLOWED`：最终地址不在 `.115cdn.net` 白名单；
- `HELPER_RATE_LIMITED`：Helper 返回 429，检查限速状态，不要直接提高并发；
- `COLD_CACHE_*`：缓存被关闭、超过大小策略或下载未完成；
- `STRM_OPERATION_REJECTED`：转码或 AI 翻译等不支持 STRM 的入口。

检查日志时只保留错误码、相对文件名和耗时。Helper URL、CDN `Location`、query、
认证头和密码不应进入日志、截图或工单。

## 0.2.0 专有状态与原生响度

新下载/指纹/错误/重试状态使用 `strm-state-v2.json`；旧配置的 `statePath` 被作为迁移源，
旧 `strm-state.json` 保留。原生曲目表增加 nullable `pointer_fingerprint`，内容变化时清除
时长、LUFS 和派生字段。仅内容指纹匹配的旧结果可以迁入，无法确认的旧结果重新探测。

响度使用原生只读 `ebur128`，旧 `loudnorm` 配置自动归一化；新设置不提供算法切换。
任务的 queued/running/done/failed 和 SSE 与原生注册表共享；下载阶段不伪造百分比。
原生分析器尚未提供可取消的任务句柄，因此 HTTP result 的等待超时不等于终止 FFmpeg；
任务可能继续运行并保存结果。完整媒体缓存可按 TTL/容量清理，原生 LUFS 不做条目数淘汰。

已知运行环境注意事项：原生实例 12345 的媒体目录使用 FUSE 时，Parcel watcher 可能报
`State not recoverable`。本次已仅对 12345 关闭 file watcher；手动扫描仍可用。独立 STRM 实例
12346 的 watcher 保持启用。实际部署和当前迁移核验状态见[0.2.0 部署记录](DEPLOYMENT-0.2.0.md)。

## 0.2.6 波形与可视化

STRM 音频首次完整缓存后同时调度响度和波形；客户端主动请求波形时也可以启动下载。
任务共用完整媒体和原生分析队列，不在服务启动时下载整个媒体库。视频不计算波形。
超过缓存大小限制时明确跳过；调高上限后可以立即重试。

波形正文为原生 KWAV/4 文件，位于配置的 `audioCacheFolderDir` 下；默认是
`/usr/src/kikoeru/sqlite/audio_cache/<workId>/waveform/`，包含在 Compose 的 SQLite 持久卷中。
SQLite `t_track.waveform_*` 保存路径、格式、分辨率、更新时间。备份时要连同这些文件一起保存；
如果自行修改 `audioCacheFolderDir`，应将该目录放入持久卷。
媒体 TTL/容量清理不删除波形及 LUFS，分析中的输入暂不清理；指针内容改变会清除旧结果。

浏览器实时频谱不读 KWAV，也不存数据库。开启可视化后，STRM 自动请求本地交付以供
Web Audio 使用；完整音频已被清理时可能需要重下。缓存关闭或大小限制禁止本地交付时返回
`STRM_LOCAL_DELIVERY_REQUIRED`（409）；可调整缓存策略，或关闭可视化并重载页面恢复直连。
已创建的 Web Audio 连接在关闭开关后仍存在，因此要重载页面才会恢复 direct。
