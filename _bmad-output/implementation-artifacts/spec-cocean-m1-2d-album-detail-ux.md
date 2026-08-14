---
id: spec-cocean-m1-2d-album-detail-ux
status: in-review
spec: ../specs/spec-cocean-m1-2d-album-detail-ux/SPEC.md
---

# M1.2d 实施清单

- [x] Hero 改为双栏内容总览，删除全局发行信息侧栏。
- [x] 将投送目标收进“投送到播放器”菜单，试听降为次操作。
- [x] 隐藏模型引擎与内部说明，只保留面向用户的介绍维护入口。
- [x] 本地版本展示版本归属的发行摘要，路径与内部证据折叠。
- [x] 字段、封面、身份与历史统一收进默认关闭的“管理唱片”。
- [x] 投送记录与实体收藏维护渐进展开，曲目保持主内容。
- [x] 更新用户文案、响应式 CSS 与 SSR/组件回归。
- [x] 运行 Web 定向测试、`pnpm check`、媒体与基础设施 Gate。

## Verification

- Web：11 files / 57 tests passed；新增主操作与版本发行归属/默认折叠回归。
- 全仓：`pnpm check` 通过；类型检查、测试和生产构建全绿。
- 媒体：生成式媒体集成 10/10 通过，fixture 已清理。
- 基础设施：Python acceptance/preflight Gate 通过；FNOS Compose 7 services 合同通过。
- 视觉：本地演示数据在 1200×900 与 390×844 检查；默认 0 个 details 展开，`scrollWidth === clientWidth`，展开版本管理后仍无横向溢出。

## Safety notes

- 本阶段不提供数字唱片删除按钮。
- 所有既有治理写入继续只修改 COCEAN 数据库/缓存，不写回 NAS。
- `_bmad/` 为本机工具目录，不纳入提交。
