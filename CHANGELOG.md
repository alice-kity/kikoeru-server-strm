# Changelog

## 0.1.2 — 管理界面隔离与布局修正

### 变更

- 将 STRM 页面样式拆分为 standalone shell CSS 与严格限定在 `#strm-admin-content`
  / `.kikoeru-strm-admin` 下的组件 CSS；组件离开时回收自己注入的 style/runtime，修复
  全局样式污染原生高级设置、扫描和音声库排版的问题。
- 将五个布尔配置改为可键盘操作、带明确 ARIA 标签的原生风格滑动开关，文字说明与
  控件分离，避免点击说明误切换状态。
- 重排设置表单为桌面两列对齐、窄屏单列的标题/说明/控件布局；保存、清理和既有
  Vue Router 子路由、媒体恢复契约保持不变。

## 0.1.1 — 原生管理界面集成

### 变更

- 将 STRM 设置融入 Kikoeru 原生 Dashboard 的视觉和导航体系，管理员可从原生管理
  后台进入 STRM 设置。
- 修复 STRM 设置离开后原生菜单被破坏及高级/STRM 双高亮；改用原生 Vue Router
  `/admin/strm` 子路由和 DashboardLayout links，无刷新切换并由 Vue 生命周期清理页面。
- Service Worker 返回 SPA index 的直接刷新会在动态 matcher 重建后正常匹配 `/admin/strm`；
  设置内容由组件从 `/api/admin/strm-fragment` 加载。
- 修正缓存容量的 GiB 展示，并在配置超过上限时给出明确的超限提示。
- 核心媒体行为冻结：扫描、冷缓存/响度、302/Range/seek 和长暂停恢复契约均不变；
  本次发布聚焦管理界面集成与展示修正。
- 本版本承接 v0.1.0 首版提交 `2d721fb`，上游仍固定为 `number17/kikoeru` `0.6.15`
  及既有 digest。

## 0.1.0 — 首版发布

### 新增

- 发布面向 `number17/kikoeru` `0.6.15` 的版本化 STRM overlay，并将独立实例固定
  在宿主端口 `12346`；生产 `12345` 不在操作范围内。
- 支持 `name.mediaext.strm` 文件名和单 URL 指针，建立扫描、指纹、受控时长探测和
  本地媒体扩展识别链路。
- 支持部署方可配置的 Helper `HEAD`→3xx `Location` 契约，并固定最终 CDN 白名单为
  `.115cdn.net`；Helper URL、CDN query 和鉴权信息不写入日志或持久状态。
- 支持一次单飞冷下载、临时 `.part` 原子改名、本地响度准备，以及响度就绪后的热
  `302` 直连；`local` 模式提供需要时的本地兼容路径。
- 支持本地文件和 CDN 的 Range/seek 交付、Helper 全局限速/429 退避和状态页观测。
- 为同源浏览器 STRM stream 增加长暂停恢复保护；短暂停、正常 seek 和非 STRM 媒体
  不触发该恢复。
- 提供独立安装、升级、回退、卸载的脚本入口和保留数据语义，文档记录固定 digest、
  上游指纹与兼容性检查清单。

### 已知限制

- 仅验证 Kikoeru `0.6.15` 及本版本记录的 digest/指纹；上游变化必须新建 patch
  目录并重新审查，不能把本版本当作通用 Kikoeru 插件。
- 仅支持文档列出的媒体扩展和 Helper→`.115cdn.net` 链路，不承诺通用 STRM、M3U、
  任意 URL 或任意 CDN。
- STRM 不支持服务端转码、peaks/waveform 或 AI 翻译；响度只在完整本地缓存上执行，
  冷缓存按 TTL/LRU 回收，不是媒体归档。
- `direct` 依赖客户端可访问白名单 CDN 并正确处理 302/Range；无法确认兼容性时需
  手动选择 `local` 并承担完整下载的磁盘与时间开销。
- 长暂停恢复仅是浏览器端 best-effort；iOS 客户端、真实 Helper 额度和生产媒体库
  仍须在独立环境中抽样验收。限速值是本适配器策略，不是 115 官方配额。
- 本版本不修改生产实例、不执行 115 登录/网盘扫描，也不删除源媒体目录或远端文件。
