# 兼容性与升级边界

本文件定义 `kikoeru-strm-plugin` `0.1.3` 的可验证兼容范围。它不是对任意
Kikoeru 版本、任意 STRM 格式或任意 CDN 的承诺。

## 固定基线

| 项目 | `0.1.3` 固定值 |
| --- | --- |
| 适配器版本 | `0.1.3` |
| 上游应用版本 | `number17/kikoeru` `0.6.15` |
| 上游镜像引用 | `number17/kikoeru@sha256:e934185b734b35e15fcdf62d96e65445edb1979ba0ed25d23d08679abda65c1c` |
| 上游 digest | `sha256:e934185b734b35e15fcdf62d96e65445edb1979ba0ed25d23d08679abda65c1c` |
| overlay 目录 | `patches/0.6.15/strm-adapter/` |
| 独立容器/端口 | `kikoeru-strm-12346` / `12346` |
| 生产端口 | `12345`，不属于本项目 |

构建必须通过 `scripts/verify-upstream.js`。它会校验扫描、路由、配置、认证、数据库、
worker fork 和前端注入入口；精确文件清单及 SHA-256 以该脚本中的 `EXPECTED` 为准。

版本、digest 或任一指纹变化都属于高风险兼容性事件，不得直接复用旧 patch。应
新增 `patches/<新上游版本>/`，重新确认接口并保留旧镜像 tag，之后才可发布新适配器。

## 接口保护边界

启用上游鉴权时，Kikoeru 在 `/api` 路由层要求 JWT；适配器不会绕过这层鉴权。

| 接口 | 保护级别 | 兼容约定 |
| --- | --- | --- |
| `/api/health` | 未保护 | 仅用于存活检查，不代表媒体链路可用 |
| `/api/auth/me` | 未保护入口 | 登录/鉴权状态查询；不要把返回值或 token 写入日志 |
| `/api/media/stream/:id/:index` | JWT | STRM 播放：冷本地文件或热 302；普通本地媒体继续交给上游 |
| `/api/media/download/:id/:index` | JWT | STRM 下载只返回受控 CDN 302；本地文件沿用上游行为 |
| `/api/media/calculate/loudnorm/:id/:hash` | JWT | STRM 只对完整本地缓存做响度；pending 可稍后重试，peaks 为空 |
| `/api/media/transcode/*`、`/api/media/pre-transcode/*` | JWT | STRM 明确返回 409，不进行服务端转码 |
| `/api/lyric/translate/:id/:index` | JWT | STRM 明确拒绝 AI 翻译入口 |
| `/api/admin/strm`、`/api/strm/status`、`/api/strm/config` | JWT + admin | 查看状态/配置；状态中不返回完整 URL、query 或 CDN Location |
| `/api/admin/strm/cleanup` | JWT + admin | 仅清理适配器缓存和孤儿 `.part` |
| `/admin/strm`、`/admin/strm-menu.js` | 未保护静态壳 | 提供融入原生 Dashboard 视觉/导航的同源 STRM 设置页和菜单脚本；实际状态读取和写入仍需要 admin JWT |

这里的“未保护”只针对健康检查或静态壳；不要把它理解为媒体公开访问。除表中
明确列出的例外外，`/api` 路由都应在启用鉴权的独立实例上携带有效 JWT。

## STRM/Helper/CDN 兼容约定

- 物理文件名必须是 `name.mediaext.strm`；支持 `.mp3`、`.ogg`、`.opus`、`.wav`、
  `.aac`、`.flac`、`.webm`、`.mp4`、`.m4a`、`.mka`、`.aiff`、`.avi`。
- 文件正文只有一个非空 HTTP(S) URL 行；Helper 地址由部署 allowlist 配置，不能
  用用户信息、密码或 JWT 嵌入 URL。
- 服务端对 Helper 发起 `HEAD`，只允许 `300–399` 3xx、绝对 `Location`，并要求
  最终主机匹配 `.115cdn.net`。任何其他最终主机都拒绝。
- Helper HEAD 和冷下载共用限速/单飞策略；默认并发 1、1000 ms 间隔、30 次/分钟、
  1800 次/小时。该数字是客户端保护策略，不是服务商配额。
- `direct` 首次冷播放先完整落盘并准备响度，随后 302；`local` 继续提供本地文件。
  Range/seek 由本地文件或最终 CDN 处理，不让 Kikoeru 伪造任意远程响应。
- 浏览器长暂停恢复仅适用于同源 STRM stream，且是一次、带冷却的 best-effort 行为；
  iOS 客户端和真实网络仍需单独验收。

## 受支持与明确不支持

支持：Kikoeru `0.6.15` 的本地扫描、STRM 目录树、指针指纹/时长状态、一次冷下载、
本地响度、热 302、Range/seek，以及浏览器端长暂停恢复。

不支持或不承诺：

- 任意 Kikoeru 上游版本，尤其是未通过 digest/指纹检查的镜像；
- 通用 STRM、M3U、任意 CDN、直接网盘 API 或未列出的媒体扩展；
- 对 STRM 做服务端转码、peaks/waveform 或直接对远程 CDN 执行响度分析；
- 通过适配器替换 MoviePilot/P115StrmHelper、执行 115 登录或遍历 FUSE 原件；
- 把冷缓存当作永久归档，或保证客户端一定支持跨域 302/Range；
- 修改生产 `12345` 实例或自动迁移生产数据库。

## 上游升级检查清单

发生上游升级时，按顺序完成并保存证据：

1. 拉取目标镜像并记录不可变 digest；不要只记录 `latest`。
2. 提取目标镜像，确认应用版本，计算 `filesystem/utils.js`、`routes/media.js`、
   `app.js` 等受保护接口指纹。
3. 新建对应的 `patches/<version>/strm-adapter/`，不在旧目录上覆盖；审查扫描、
   `getTrackList`、媒体路由、loudnorm、转码入口、Express/JWT 中间件和 fork worker。
4. 重新验证 Helper `HEAD → 3xx absolute Location → .115cdn.net` 契约、Range/seek、
   冷下载原子改名、状态文件和日志脱敏。
5. 更新构建/验证元数据后运行静态检查和自动化测试：

   ```sh
   npm test
   node scripts/verify-upstream.js tmp/kikoeru-container
   docker compose config
   ```

6. 用独立备份启动新 tag，检查容器、`/api/health`、登录、单条 STRM 扫描、首次冷播、
   热 302、Range/seek、响度兼容接口、长暂停恢复和管理页；确认生产 `12345` 无变化。
7. 核对日志中无 URL/query/token/password，保留旧 tag，记录本版本风险和回退方式。

任一步失败都停在独立实例，不要让 compose 自动替换生产容器。若新版本无法证明
上述边界，发布状态应为“不兼容”，而不是降级为“可能可用”。

## 风险等级

| 等级 | 触发条件 | 处置 |
| --- | --- | --- |
| 高 | digest/指纹变化、Helper 非 3xx、最终主机非 `.115cdn.net`、生产端口被操作、未授权数据删除 | 立即停止发布/回退，保留备份，重新做版本化适配 |
| 中 | 客户端不跟随 302、Range/seek 失败、冷缓存耗尽、响度等待超时、长暂停恢复不触发 | 保留 `local` 兼容模式或关闭相关策略，做真实客户端抽样；不扩大 allowlist |
| 低 | Helper 限速等待、缓存 TTL/LRU 命中率、时长 probe 重试 | 通过独立配置调节并观察状态，不突破默认安全边界 |

## 证据与问题报告

问题报告只需提供版本、digest、错误码、相对文件名、脱敏状态和复现步骤。不要提供
完整 STRM URL、Helper 私人地址、CDN `Location`、query、Cookie、Authorization、
JWT 或管理员密码。
