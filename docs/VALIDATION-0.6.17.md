# 0.2.0 / Kikoeru 0.6.17 本地验收记录

本文记录代码与隔离 fixture 验收时点；后续 2026-10-09 的业务实例升级结果见
[0.2.0 部署记录](DEPLOYMENT-0.2.0.md)。

验收日期：2026-10-09。目标固定为
`number17/kikoeru@sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391`。
代码/fixture 验收轮次的最终本地镜像：`kikoeru-strm:0.2.0`，image ID
`sha256:4d49fa8136acbe686beda96c35ee1082705ea46eb44757d4acbfcdd0725674b0`。
本记录描述代码与隔离 fixture 验收时点；当时尚未升级业务实例。后续部署结果单独记录，
不覆盖这里的历史状态。

## 变更与需求映射

| 需求 | 实现及证据 |
| --- | --- |
| 版本化适配与原生扫描 | 新 `patches/0.6.17/strm-adapter/`；`native-tracks.js` 装饰原生 utils 扫描入口，复用 `trackStore` 的单调 seq 分配，不按数组下标定位 |
| 物理路径与虚拟显示 | `t_track.rel_path/ext` 保留 `.strm`；原生树增加 isStrm、虚拟名称与媒体扩展，保留原生音频节点类型 |
| 原生时长和总时长 | duration 写原生记录，实际 `/works?order=total_duration`、`staticMetadata` 和 `/work/1/trackinfo` 验证通过 |
| 指针变更失效 | 幂等添加 nullable pointer_fingerprint，读取实际指针；变更清 duration/LUFS/派生缓存，写回以 id + 指纹条件更新并复核 |
| 原生响度任务 | `native-tasks.js` 复用上游 loudnormRegistry、lightTaskQueue、calculateLUFSReadOnly；只读完整本地文件，数值 LUFS 持久在 t_track |
| 新旧客户端 API | `integration.js` 新旧响度、status/start/SSE/result、等待超时 503、失败和跳过终态；STRM 转码/波形明确拒绝，普通媒体继续原生 |
| STRM 转码禁用 | Dashboard 注入的播放器 guard 按 isStrm 禁用当前转码与下一曲预转码；真实浏览器观察到零次 pre-transcode 请求，普通 WAV 仍可选择转码 |
| 完整冷缓存与竞态 | HTTP 下载单飞、截断/超限保护、part 原子改名；状态文件锁内 fingerprint CAS 防止旧下载覆盖新缓存，两个 manager 共享文件的竞态复现通过 |
| 原生扫描通知 | 普通字幕增删继续触发 workScanNeeded；实际 fixture 添加字幕后由 /tracks 触发原生队列并更新 lyric_status |
| 旧数据迁移 | migration.js 按库根/作品路径/key/指纹/成功状态匹配；复制真实 0.6.15 schema 的合成数据库升级通过，重复迁移稳定，源状态和源 DB 保留 |
| 主进程/子进程 | 显式调用新版 app.main；fork 继承 NODE_OPTIONS，独立 smoke 证明 bootstrap、Provider fencing 和建表后的指纹迁移 |
| 构建/指纹 | 当前 40 项、历史 14 项；错误版本与篡改文件拒绝；最终镜像全部 17 个适配器 JS 与工作区 SHA-256 一致 |
| 鉴权/隐私 | 原生登录/JWT，admin API 拒普通用户；所有测试表、状态和日志检查无 fixture URL 签名/JWT/明文密码 |

实际修改范围：新版 overlay 与两个版本指纹 JSON；Dockerfile、Compose、`.env.example`、
VERSION/package 元数据；build/install/manage/verify/entrypoint 脚本；新版专项测试和容器 fixture；
README、CHANGELOG、COMPATIBILITY、OPERATIONS、本设计与验收记录。旧 0.6.15 overlay 未修改。
`strm-child-env.js` 的通用加载路径仍适用，已通过子进程检查，未作无必要变更。

## 原生与插件责任

原生负责曲目表、固定 seq/hash、总时长查询、内部数据页、扫描队列、响度队列/注册表/分析器，
以及普通本地/OpenList 的媒体能力。插件负责本地指针发现、校验、Helper/CDN/UA、限速与 429、
完整媒体缓存、指纹失效/写回保护、迁移和 STRM 的客户端操作限制。

新版响度固定使用原生只读 ebur128；旧 loudnorm 方法配置归一化，设置页不再提供虚假算法切换。
STRM 波形未新增，转码直接禁用；全局 caniuse 原生能力保留。

## 已执行证据

- 新旧精确指纹通过；错误版本和篡改配置文件被拒绝。
- JavaScript/shell 语法与 diff whitespace 检查通过。
- 最终宿主 `npm test`：84 项，80 通过、4 环境依赖跳过、0 失败/取消。
- 最终镜像内完整测试：84/84 通过，0 失败/取消/跳过；包括实际 FFmpeg。一次性测试容器安装 bash，
  临时 node:test keepalive shim 模拟 HTTP 服务持有的事件循环引用，防止旧测试中的 unref timer 造成取消。
  这些测试环境辅助不写入最终镜像或产品代码。
- SQLite 专项 5 项通过，覆盖稳定身份、变更失效、OpenList 直通、配置/重试及迁移中断后重入。
- 缓存/任务/状态定向 17 项通过，含真实 HTTP 截断、两 manager 指纹竞态、任务 API 终态与超时契约。
- 最终镜像构建成功，17 个适配器 JS 与工作区完全一致。
- 最终镜像的新库 fixture 通过：登录权限、扫描/曲目表/内部数据/总时长、冷下载与分析单飞、
  新旧响度、SSE、热 302 和 UA、CDN/local Range、普通波形/转码、缓存清理和重启后的 LUFS、
  字幕扫描通知、增删/重排/同 size+mtime 指针变更、非法地址/429/视频跳过与全表脱敏。
- 从旧镜像生成合成 0.6.15 SQLite，复制到临时新实例后原生升级与旧 JSON 迁移通过。
  重复扫描后 duration/LUFS/seq 稳定，源状态字节不变，源 SQLite SHA-256 不变。
- Chromium 实际登录验证原生 Dashboard 路由/菜单、设置读取、固定算法、样式隔离、退出页面清理、
  按曲转码 guard。浏览器媒体响应被受控 stub，不代表实际解码/播放验收。

容器验收数据全部位于临时容器的 `/tmp`，旧样本只读挂载；测试容器已清理。
本地详细过程证据在被 Git 忽略的 `tmp/upgrade-0.6.17-validation/`。

## 迁移、缓存与回退

旧配置 statePath 作为 legacyStatePath，新专有状态使用 `strm-state-v2.json`，保留旧源。
仅确认匹配的成功时长与有限 LUFS 数值迁入，其他结果等待重新探测；中断可重复执行。
新状态仅保存下载/指纹、错误/重试和策略跳过等必要字段。完整媒体按容量/TTL 管理，
原生已保存 LUFS 不做条目数量淘汰，也不随媒体缓存清理丢失。

部署前停止独立 STRM 实例并备份同一时点的配置/SQLite。回退必须恢复配套备份后切回 0.1.4，
不能直接让旧镜像继续写新版数据库。默认 manage upgrade 构建当前发布 tag 并更新 .env，
保留旧镜像 tag；不会把 0.2.0 overlay 重建成 0.1.4 tag。完整可执行步骤见 [OPERATIONS](OPERATIONS.md)。

## 验收边界

- 真实 115/CDN、iOS 和真实浏览器媒体解码、跨域 Range/302、长暂停恢复仍待后续验收。
- OpenList 回归验证的是原生直通契约；没有访问用户的真实 OpenList 库执行扫描/播放。
- 子进程 smoke 验证了 bootstrap 继承与扫描入口，未模拟完整元数据抓取 scanner IPC 流程。
- 原生分析器没有可取消的任务接口；HTTP result 等待超时不等于 FFmpeg 停止，任务可继续完成。
- 浏览器实际原生登出已进入 /login；自动化最后的存储清空断言因 Quasar 包装值未收敛。
  页面离开清理已有独立实际证据，未声称整个浏览器 runner 无错误完整结束。
- 本地 latest digest 与目标一致；远端 latest 清单查询 TLS 超时，未扩大目标。

采用 sol-luna-taskflow：三个执行代理请求 `gpt-6-luna` + Max，调用成功；当前工具没有
`gpt-6.1-luna`。工具未回显实际模型配置，因此记录请求配置，不宣称独立验证实际运行模型。
SOL 负责接口决策、独立关键审查、竞态修复验收与实际镜像 fixture。

业务容器 `kikoeru` 和 `kikoeru-strm-12346` 的 ID、StartedAt 和 RestartCount 在任务前后相同。
没有部署/重启业务容器，没有写业务数据库；HEAD 仍为 `e4b1c69`，没有提交或 push。

## 实际文件清单

共 44 个修改或新增文件；未包含 tmp、.env 或业务运行数据。

```text
.env.example
CHANGELOG.md
Dockerfile
README.md
VERSION
docker-compose.yml
docs/COMPATIBILITY.md
docs/OPERATIONS.md
docs/UPGRADE-0.6.17.md
docs/VALIDATION-0.6.17.md
package.json
patches/0.6.15/upstream-fingerprints.json
patches/0.6.17/README.md
patches/0.6.17/strm-adapter/admin-ui.js
patches/0.6.17/strm-adapter/bootstrap.js
patches/0.6.17/strm-adapter/cache-manager.js
patches/0.6.17/strm-adapter/duration-queue.js
patches/0.6.17/strm-adapter/http.js
patches/0.6.17/strm-adapter/integration.js
patches/0.6.17/strm-adapter/migration.js
patches/0.6.17/strm-adapter/native-tasks.js
patches/0.6.17/strm-adapter/native-tracks.js
patches/0.6.17/strm-adapter/pointer.js
patches/0.6.17/strm-adapter/redirect-rate-limit.js
patches/0.6.17/strm-adapter/runtime.js
patches/0.6.17/strm-adapter/scanner.js
patches/0.6.17/strm-adapter/shared-helper-rate.js
patches/0.6.17/strm-adapter/single-flight.js
patches/0.6.17/strm-adapter/state-store.js
patches/0.6.17/strm-adapter/virtual-name.js
patches/0.6.17/upstream-fingerprints.json
scripts/build-overlay.sh
scripts/install.sh
scripts/manage.sh
scripts/strm-entrypoint.js
scripts/verify-upstream.js
tests/fixtures/create-old-db-0615.js
tests/fixtures/native-container-0617.js
tests/install-tools.test.js
tests/native-tasks-0617-cache.test.js
tests/native-tasks-0617.test.js
tests/native-tracks-0617.test.js
tests/release-0617-ui.test.js
tests/release-0617-upstream.test.js
```
