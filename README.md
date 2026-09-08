# Kikoeru STRM 播放适配器

发布版本：`0.1.1`。这是一个面向 `number17/kikoeru` 应用 `0.6.15` 的
版本化 Docker overlay：Kikoeru 扫描本地 STRM 指针，经过登录鉴权后由服务端
向部署方配置的 Helper 发起一次 `HEAD`，再把客户端重定向到受控的 115 CDN。
它不是 STRM 生成器，也不是通用 STRM 播放器。

安装和升级以 [`docs/OPERATIONS.md`](docs/OPERATIONS.md) 为准；上游边界和升级
检查以 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) 为准。

## 适用范围

- 适配器只扫描 `/media/MP_movieDB/NSFW/Voice1`；不扫描、不挂载
  `/media/CloudNas` FUSE 原件目录。
- 适配器是独立实例，容器名为 `kikoeru-strm-12346`，宿主端口为 `12346`。
  生产容器 `kikoeru` 的 `12345`、配置、数据库和运行状态不在本项目操作范围内。
- Helper 地址是部署配置的一部分，可以替换；不要把私人 Helper 地址、密码或 JWT
  写进仓库、STRM 文件、日志或问题报告。
- Helper 的最终 `Location` 不是任意公网 URL：只接受主机名匹配受控后缀
  `.115cdn.net` 的绝对 HTTP(S) URL。最终 CDN 是固定边界，不能通过 STRM 内容绕过。

## STRM 文件契约

文件名必须保留媒体扩展名，再加物理 `.strm` 后缀：

```text
name.mediaext.strm
```

例如 `track.flac.strm` 会在 Kikoeru 中显示为 `track.flac`。文件内容只能有一个
非空 URL 行（首尾空白行可以存在），例如：

```text
https://<configured-helper-host>/<path>
```

URL 必须是 HTTP(S)、不含用户名或密码，并指向当前部署允许的 Helper。服务端对该
URL 发起 `HEAD`，Helper 必须返回 `300–399` 的 3xx 响应和绝对 `Location`；
`Location` 必须指向 `.115cdn.net` 下的最终 CDN。缺少 `Location`、返回非 3xx、
返回相对地址或最终主机不在白名单中，都会被拒绝。

支持的媒体扩展名为：

`.mp3`、`.ogg`、`.opus`、`.wav`、`.aac`、`.flac`、`.webm`、`.mp4`、`.m4a`、
`.mka`、`.aiff`、`.avi`。

`.strm` 文本不交给本地 `ffprobe`；扫描只对指针代表的媒体做受控时长探测。字幕、
图片和普通文本仍按本地文件处理。这个命名和 Helper→115 CDN 链路是本版本的固定
契约，不声称兼容任意 STRM URL、M3U、网盘 API 或其他 CDN。

## 快速安装

要求：Linux 主机、Docker Engine、Docker Compose v2、可读取目标媒体目录的权限，
以及可访问上游镜像和部署方 Helper。先在项目根目录执行：

```sh
chmod +x scripts/install.sh scripts/manage.sh
read -r -p 'Helper host[:port] (keep private): ' STRM_HELPER_HOST
./scripts/install.sh \
  --media /media/MP_movieDB/NSFW/Voice1 \
  --helper "$STRM_HELPER_HOST" \
  --port 12346 \
  --image kikoeru-strm:0.1.1
unset STRM_HELPER_HOST
```

脚本会把媒体目录、端口和 Helper allowlist 写入项目根目录的 `.env`（权限 `0600`）；
独立数据目录固定为 `deploy/runtime/`。需要确认本机参数时先运行
`./scripts/install.sh --help`；已有 `.env` 只有显式加 `--force` 才会替换。安装完成后检查：

```sh
docker compose ps
curl -fsS http://127.0.0.1:12346/api/health
```

首次启动会在 `deploy/runtime/config` 生成独立 `config.json`、随机密钥和
`admin-password`（权限 `0600`）；也可以通过部署环境安全注入管理员密码。密码值、
JWT 和 Helper 查询参数不应出现在命令历史、文档或日志中。

## 播放行为

默认交付模式是 `direct`：

1. 首次冷播放由服务端受控完整下载到临时缓存，并以本地完整文件完成首播和响度准备；
2. 响度就绪（或按策略跳过）后，后续播放和 seek 返回 `302`；
3. 客户端直接从白名单 CDN 读取媒体，Range 由 CDN 处理，媒体正文不经过 Kikoeru。

`local` 是兼容性手动选项：始终从本地缓存提供文件，首次播放需要完整下载并占用
配置的磁盘空间。两种模式都使用单飞下载，避免同一媒体并发产生多份冷缓存；缓存是
按 TTL/LRU 回收的工作缓存，不是媒体归档。

Helper HEAD 默认使用全局限速（并发 1、启动间隔 1000 ms、30 次/分钟、1800 次/小时），
并在 429 时尊重 `Retry-After`、有限退避。该限速是本适配器的保守客户端策略，
不是 115 官方配额。

浏览器端对同源 STRM stream 提供长暂停恢复：暂停至少 30 秒后恢复时，若媒体仍处于
waiting/stalled/error 或网络加载状态，会在约 2.5 秒窗口后尝试恢复一次原位置；单次
恢复冷却至少 10 秒。短暂停、正常 seek、本地媒体和非 STRM 媒体不会触发。该逻辑不
修改 iOS 客户端，不能替代真实播放器/CDN 兼容性验收。

## 常用运维入口

独立数据位于 `deploy/runtime/`：

| 路径 | 内容 | 默认卸载语义 |
| --- | --- | --- |
| `config/` | Kikoeru 配置和管理员密码文件 | 保留 |
| `sqlite/` | SQLite、STRM 状态和迁移数据 | 保留 |
| `covers/` | 封面 | 保留 |
| `cache/` | STRM 临时媒体缓存和 `.part` 文件 | 保留，可单独清理 |

STRM 设置已通过原生 Vue Router 子路由融入 Kikoeru Dashboard 的视觉和导航；登录后从
原生管理后台的“STRM 设置”入口无刷新进入 `/admin/strm`。动态路由复用原有
DashboardLayout 与 links 数组，因此切换到扫描、高级设置或其他菜单时由 Vue Router
正常销毁/创建页面，不会留下双高亮或污染原页面状态。缓存容量按 GiB 展示，保存超过
上限的配置时会显示明确提示。核心媒体扫描、缓存、响度和交付行为在本版本冻结。

```sh
# 升级：保留旧镜像 tag 和数据，完成新版本验收后再清理旧 tag
./scripts/manage.sh upgrade

# 回退：切回已保留的旧适配器镜像/版本，不删除上述数据
./scripts/manage.sh rollback --image kikoeru-strm:0.1.0

# 卸载独立实例：默认只移除容器/项目，不删除 deploy/runtime
./scripts/manage.sh uninstall

# uninstall 永远保留 bind 数据；脚本会拒绝 --purge-data
```

升级、回退和卸载的完整备份及风险说明见 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)。
不要对生产 `kikoeru` 执行 stop/recreate/remove，也不要使用会误伤数据的全局清理命令。

## 发布与许可

`VERSION`、[`CHANGELOG.md`](CHANGELOG.md)、[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)
和 [`docs/LICENSING.md`](docs/LICENSING.md) 记录本版本的边界、已知限制和许可状态。
本仓库当前没有在未核实的情况下声明一个根目录许可证；上游镜像和依赖的许可通知
仍须按各自发行物查看。
