# 独立 STRM 实例运维

本文针对发布 `0.1.0`。项目是 `number17/kikoeru` `0.6.15` 的版本化 overlay，
只管理独立 compose 项目 `kikoeru-strm`：容器 `kikoeru-strm-12346`，宿主端口
`12346`。生产容器 `kikoeru` 使用的 `12345`、配置、SQLite、FUSE 原件和媒体数据
不属于本项目，任何操作都不得触碰它们。

## 安装前检查

确认以下条件后再运行安装脚本：

- Docker Engine 和 Docker Compose v2 可用，当前用户可以运行 Docker；
- `/media/MP_movieDB/NSFW/Voice1` 存在，并包含要扫描的媒体树；该目录只读挂载到
  独立容器，`/media/CloudNas` 不应加入 compose；
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
  --media /media/MP_movieDB/NSFW/Voice1 \
  --helper "$STRM_HELPER_HOST" \
  --port 12346 \
  --image kikoeru-strm:0.1.0
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

管理页可从登录后的 `/admin/strm` 打开；状态和写操作 API 均要求管理员 JWT：

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

升级前先停止变更并备份独立数据（备份命令由主机策略决定，不把备份上传到项目）：

```sh
backup_dir="backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -a deploy/runtime/config deploy/runtime/sqlite deploy/runtime/covers "$backup_dir/"
```

同一时间只建立一个时间戳目录；实际执行时也可以用组织的快照工具替代。不要把
`deploy/runtime/cache` 当作媒体归档，缓存可重建，备份空间有限时可以不备份它。

升级流程：

```sh
./scripts/manage.sh upgrade
# 若要切换到已经存在的本地镜像：
./scripts/manage.sh upgrade --image kikoeru-strm:0.1.0
docker compose ps
curl -fsS http://127.0.0.1:12346/api/health
```

`upgrade` 默认重建 `.env` 中的 versioned image；`--image IMAGE` 只接受已经存在的
本地镜像并更新 `.env` 后重建独立容器。

升级脚本必须保留旧镜像 tag 和 `deploy/runtime`，先验证新实例，再清理旧镜像。上游
升级不是简单改 tag：必须建立新的 `patches/<upstream-version>/` 目录，记录新的
应用版本、镜像 digest 和受保护文件指纹，完成接口审查后才允许构建。任一版本或
指纹不匹配都应让构建失败，不能静默套用 `0.6.15` patch。边界清单见
[`COMPATIBILITY.md`](COMPATIBILITY.md)。

回退流程：

```sh
./scripts/manage.sh rollback --image kikoeru-strm:0.1.0
docker compose ps
curl -fsS http://127.0.0.1:12346/api/health
```

回退只切换独立 overlay/image 并重启独立 compose 项目，默认保留 config、SQLite、
状态、封面和缓存。若新版改变了配置语义，先停服务、保留新旧备份，再恢复与旧镜像
匹配的配置/SQLite；不要用空目录覆盖现有数据。

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
人工确认本项目的 `deploy/runtime/`，不能指向 `/media/MP_movieDB`、`/media/CloudNas`、
生产容器数据或宿主机宽泛目录。源媒体目录和远端文件不由卸载脚本删除。

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
