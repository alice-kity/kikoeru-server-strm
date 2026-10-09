# 0.2.6 功能修复与部署记录

日期：2026-10-09。基于 `5dd5f5f` 的 0.2.0 功能 review，逐项修复并新增 STRM 波形持久化。
上游仍为 Kikoeru `0.6.17-20261007`，固定 digest
`sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391`。

## 修复结果

| 问题 | 0.2.6 行为与验证 |
| --- | --- |
| Web Audio 可视化时 CDN 跨域音频无声 | 内置播放器为 STRM 请求严格本地交付；实际原生 UI、PCM WAV 和 Chromium 音频采样幅度约 `0.125`，无 CORS 音频错误。关闭并重载后直连返回 206；切回普通音频恢复 `crossorigin=anonymous`。 |
| 冷播放的响度 Promise 循环导致清理误删输入 | 回调登记真实任务后再复用 Promise；延迟原生分析器、并将缓存容量缩到 1 字节的隔离复现中，清理删除数为 0，分析最终成功。波形任务同样保护输入。 |
| 关闭 STRM 后仍探测时长 | 入队和任务执行前检查总开关；隔离新增指针扫描产生 0 次 Helper 请求，duration 保持空。 |
| 完整缓存分析仍依赖 Helper | 缓存检查后才按需解析 URL；模拟 Helper 离线，已有缓存计算 LUFS 成功，Helper 请求为 0。 |
| 本地热播放不更新 TTL/LRU | 本地交付按指纹条件刷新访问时间；过期边界上刚播放后立即清理，文件保留。 |
| 调高大小上限后不能立即重试 | 跳过句柄绑定缓存策略；修改上限立即重新 started 并得到 LUFS。 |

新增波形复用原生队列、分析器及 KWAV/4 编解码器。音频首次完整下载或客户端波形请求触发计算，
数据库保存 `waveform_path/format/resolution/updated_at`，正文在持久化的 `sqlite/audio_cache/`。
支持并发去重、结果等待、SSE 和较粗分辨率合并；完整媒体过期及重启后仍直接读取波形，
指针变化时失效旧结果。不会在应用启动时下载全库。实时频谱仍由浏览器计算，不读取 KWAV。

## 验证

- 宿主 `npm test`：93 项，86 通过、7 因缺少上游 SQLite 模块或 FFmpeg 跳过。
- 最终镜像内：93/93 通过，无失败、取消或跳过。一次性测试容器安装 bash，并使用临时
  `node:test` keepalive shim 支持既有 unref timer 测试；这些工具不进入发布镜像。
- 指纹门禁：当前上游 42 项、历史 0.6.15 上游 14 项全部匹配；旧 overlay 未改。
- 最终镜像的原生容器 fixture 通过：波形先启动，响度与播放并发共用一次完整下载；KWAV 解码、
  等待结果、SSE、分辨率合并、媒体清理后重启读取、指针失效；普通媒体波形/转码与 Range 回归。
- 复制合成 0.6.15 数据库及旧 `{name,path}` 库根状态的迁移 fixture 通过，旧源文件保持原样。
- 最终镜像运行真实原生 UI 的 Chromium fixture 通过，未 stub 音频请求或分析器；
  浏览器测试只使用合成 Helper/CDN、WAV 和测试账号。
- 18 个 adapter JavaScript 文件在源码、最终镜像和运行容器中逐字节一致。

原生容器验收命令：

```bash
docker run --rm --network none --add-host fixture.115cdn.net:127.0.0.1 \
  --entrypoint node -v "$PWD/tests/fixtures:/review:ro" \
  kikoeru-strm:0.2.6 /review/native-container-0617.js
```

浏览器验收使用同一 fixture 的 `FIXTURE_BROWSER=1` 模式，映射两个本机端口；需预先安装 Playwright/Chromium：

```bash
docker run --rm -d --name strm-review-026-ui \
  --add-host fixture.115cdn.net:127.0.0.1 \
  -p 127.0.0.1:19088:8888 -p 127.0.0.1:19081:19081 \
  -e FIXTURE_BROWSER=1 --entrypoint node \
  -v "$PWD/tests/fixtures:/review:ro" kikoeru-strm:0.2.6 /review/native-container-0617.js
# 等容器日志出现 BROWSER FIXTURE READY 后执行；自定义安装可设置
# PLAYWRIGHT_MODULE 和 BROWSER_EXECUTABLE 的绝对路径。
node tests/fixtures/browser-native-0617.js
docker stop strm-review-026-ui
```

本机完整证据保存在忽略目录 `tmp/validation-0.2.6/`，没有提交运行数据或凭据。

## 部署与数据核对

12346 在停止状态下备份配置、SQLite（含波形）、封面和完整媒体缓存，备份位于仓库外，
数据库 integrity 与源文件哈希核验通过。原 0.2.0 镜像和更早迁移备份保留。
`.env` 只修改镜像 tag，仍为 0600；源媒体未修改。

| 实例 | 最终状态 |
| --- | --- |
| `kikoeru-strm-12346` / 12346 | `kikoeru-strm:0.2.6`；image ID `sha256:a617ec1541344da9c2439b74d775ad7cb50cf9dce8150881cb5608636f48ec24`；StartedAt `2026-10-09T09:42:53.232809721Z`；healthy、RestartCount 0、HTTP health 200。 |
| `kikoeru` / 12345 | 保持原生 Kikoeru 0.6.17；镜像、容器 ID 和启动时间未变，RestartCount 0、HTTP health 200。 |

插件数据库 integrity 为 ok；作品 737、用户 1、曲目 12,195、duration 7,060、LUFS 163。
曲目身份、指纹、duration、LUFS 与升级前快照逐条一致，旧状态文件未变，密码 hash 和签名密钥未变。
原生数据库 integrity 为 ok，作品 736。12345 的 FUSE watcher 保持关闭，12346 的 watcher 保持开启。

部署后只读验证管理员 API、匿名 401、原生 LUFS、总时长排序、内部曲目数据和波形 status；
STRM 转码仍为 409，扫描队列空闲。未在生产验收中启动波形生成或播放私人媒体。
人工密码登录、真实 115/CDN、iOS 和长暂停恢复仍未做现场验收；合成浏览器测试不替代这些场景。
