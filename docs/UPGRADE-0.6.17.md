# 0.6.17-20261007 接入与收敛方案

目标固定为插件 0.2.0 / Kikoeru 0.6.17，镜像
`number17/kikoeru@sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391`。
新版验证清单保护 40 个关键文件；旧 0.6.15 overlay 和 14 项验证基线保留。生产实例、运行数据库和私人媒体不参与写入验证。

## 接入决策

运行时 CommonJS 装饰继续保留。旧 `scrapeWorkMemo` 挂钩被替换，因为新版扫描队列直接调用
`syncWorkTracks` / `scanWorkDurations`，任务还会优先调用同步 `getLocalPath`。

- `native-tracks.js` 负责本地 STRM 入原生 `t_track`、稳定 seq、物理相对路径、虚拟显示名称、
  受控时长探测和指纹失效。普通媒体和 OpenList 的处理应保留原生实现。
- `migration.js` 用作品、物理路径与指纹匹配旧状态；匹配后写原生 duration/LUFS。
  重复执行安全，中断后可重试；旧状态唯一副本不能覆盖或删除。
- `runtime.js` 复用既有指针校验、HEAD 解析、限速、429 退避、UA 隔离和冷下载机制。
- `native-tasks.js` 复用原生任务注册表、队列和响度分析器，输入只允许完整本地缓存，
  原生 `t_track.lufs` 为主要持久来源。任务写回必须核对当前指纹，拒绝过期媒体结果。
- `integration.js` 协调播放、新旧响度、管理鉴权和逐曲目操作限制。
  STRM 波形与转码返回明确的终止响应；普通媒体能力不全局关闭。
- `bootstrap.js` 在主进程与扫描子进程装饰同一版本模块；Provider 的
  `getLocalPath` 和 `resolveSource` 都必须防止 `.strm` 文本成为分析器输入。
- 新前端资源通过该版本 `admin-ui.js` 注入 Dashboard 设置；保留原生 JWT 与管理员检查。

## 写入范围

扫描执行代理：`patches/0.6.17/strm-adapter/native-tracks.js`、`migration.js`，及专属扫描/迁移测试。
任务执行代理：同目录 `runtime.js`、`integration.js`、`native-tasks.js`、`cache-manager.js`，及专属任务测试。
发布执行代理：同目录 `bootstrap.js`、`admin-ui.js`，`scripts/`、版本指纹文件、Dockerfile、
Compose、`.env.example`、package 元数据及其专属测试。
主控：复用底层模块、新版 README、顶层 README/CHANGELOG/COMPATIBILITY/OPERATIONS、
本设计和验收记录、最终必要整合。禁止修改旧 overlay、`.env` 或业务运行数据。

## 验收顺序与命令

1. `node --check` 新 overlay 与脚本，`bash -n scripts/*.sh`，`git diff --check`。
2. `node scripts/verify-upstream.js <目标提取根目录>`；旧版本基线显式检查。
   错误版本和任一关键文件篡改必须拒绝。
3. `npm test`：新增稳定 seq、STRM 入库/时长/LUFS、指针内容变更、下载/分析单飞、
   新旧任务接口/通知/result、波形/转码限制、本地/OpenList 回归。
4. 在独立复制数据中执行旧状态迁移、重复迁移、中断后恢复；验证源文件保留且无法确认的结果不迁入。
5. `docker build --pull=false -t kikoeru-strm:0.2.0 .`，不得启动正式 Compose。
6. 使用 `tmp/` 下独立配置、SQLite、媒体与受控 Helper/CDN fixture 启动临时测试容器，
   端口避开 12345/12346。验证 health、登录、JWT/admin、扫描进度、原生曲目/总时长/内部数据。
7. fixture 验证 UA、完整冷播与原子缓存、热 302、local Range/seek、429 和非法跳转；
   容器内实际 FFmpeg 验证完整缓存输入。
8. 扫描测试日志与 SQLite/JSON，确认私人 URL、签名、JWT 与密码没有持久化。
9. 对比两个业务容器 ID、StartedAt 和 RestartCount；检查最终 diff/授权范围，记录所有遗留项。

fixture 只证明受控链路。真实 115/CDN、iOS、浏览器实际播放与暂停恢复仍需用户环境验收。
数据库升级后的回退必须恢复匹配的配置和 SQLite 备份，不能只切换旧镜像。
