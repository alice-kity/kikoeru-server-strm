# Kikoeru STRM 播放适配器

发布版本：`0.2.6`，目标为 `number17/kikoeru` `0.6.17-20261007`，锁定镜像
`sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391`。
本地 STRM 指针进入原生曲目表，经过原生登录鉴权后，服务端向配置允许的 Helper
发起 `HEAD`，只接受受控的 115 CDN 跳转。

此次适配复用原生 `t_track`、稳定 `seq`/曲目 hash、总时长查询、扫描队列与响度任务。
物理路径保留 `.strm`，客户端显示媒体名称；时长和 LUFS 主要保存在原生 SQLite。
插件继续负责指针/Helper/CDN 校验、限速、429 退避、UA 匹配、完整冷缓存及热播放 302。
新版响度使用原生只读 ebur128 分析器，旧 `loudnorm` 方法配置归一化为 `ebur128`；
新旧响度接口共享原生任务。STRM 波形复用完整冷缓存生成并持久保存；STRM 转码仍禁用，普通媒体能力保留。

波形在首次完整下载或客户端请求时计算：数据保存为原生 KWAV 文件，SQLite 保存路径、
格式、分辨率和更新时间。以后直接读取，完整媒体缓存过期或应用重启不会删除波形；
指针内容变化会使旧结果失效。不会在服务启动时下载全库。
原生实时频谱由浏览器 Web Audio 计算，不读取波形缓存。开启可视化时 STRM 自动采用
本地交付以避免跨域无声；媒体缓存被清理后可能需要重新下载。关闭可视化并重载播放器后恢复直连。

新版 overlay 位于 `patches/0.6.17/`；旧 `patches/0.6.15/` 与其指纹基线保留。
数据库升级后回退需要恢复匹配的配置与 SQLite 备份，不能只换旧镜像。
设计与验收命令见 [升级接入方案](docs/UPGRADE-0.6.17.md)，代码验收结果见
[本地验收记录](docs/VALIDATION-0.6.17.md)，2026-10-09 业务实例升级另见
[部署记录](docs/DEPLOYMENT-0.2.6.md)。

安装和升级以 [`docs/OPERATIONS.md`](docs/OPERATIONS.md) 为准；上游边界和升级
检查以 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) 为准。

## 适用范围

- 适配器只扫描 `KIKOERU_STRM_MEDIA_DIR` 指定的媒体目录；该目录只读挂载，FUSE
  原件目录不应加入 Compose。
- 适配器是独立实例，容器名为 `kikoeru-strm-12346`，宿主端口为 `12346`。
  日常插件运维只操作该实例；生产容器 `kikoeru` 的 `12345` 使用原生 Kikoeru，不通过本项目脚本管理。
  只有单独明确授权时才升级其上游应用版本；2026-10-09 的授权部署记录见上文。
- Helper 地址是部署配置的一部分，可以替换；不要把私人 Helper 地址、密码或 JWT
  写进仓库、日志或问题报告。
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
  --media /srv/kikoeru-media \
  --helper "$STRM_HELPER_HOST" \
  --port 12346 \
  --image kikoeru-strm:0.2.6
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
上限的配置时会显示明确提示。STRM 组件样式严格隔离且离开页面会回收注入资源；配置
表单在桌面采用两列对齐、窄屏采用单列滑动开关布局。新版扫描、时长与响度接入原生数据库及任务接口。

```sh
# 升级：默认构建本发布版本 tag；保留旧镜像和数据，完成验收后再清理
./scripts/manage.sh upgrade

# 回退前停止独立实例，并恢复升级前配套的配置/SQLite备份；再切换旧镜像
./scripts/manage.sh rollback --image kikoeru-strm:0.1.4

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

## 旧状态迁移与验证边界

首次扫描兼容旧 `rootFolder` 字符串及 `{name, path}` 对象格式，并按库名、作品物理路径/key
和指针内容指纹匹配旧 `strm-state.json`；只迁入匹配成功的有效时长/LUFS，不复制旧状态
中的私人 metadata，无法确认的结果等待重新探测。迁移可重复执行，旧文件保留。新版
专有状态只承担指纹、下载缓存和错误/重试信息；完整媒体缓存仍按容量和 TTL 管理，
SQLite 内的响度结果不按条目数量淘汰。

部署后的实际条目数、镜像和原生数据库迁移检查见[部署记录](docs/DEPLOYMENT-0.2.6.md)。
本地 fixture 验收不代表真实 115/CDN 或 iOS 验收；这些播放路径仍需真实客户端抽样验证
跨域 302、UA、Range/seek 和长暂停恢复。
