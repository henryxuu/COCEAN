---
title: 'Story 3.1：以唱片库作为产品默认入口'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'fcbb21ac2cb018b7496aa19db34692bbe42faf90'
implementation_root: '/tmp/cocean-added-at.M8Eocv'
context:
  - '_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** COCEAN 仍以“今日”和“找歌”组织产品入口，并把内部“隔离区”暴露为一级模块，削弱了本地唱片管理平台的定位，也让桌面与移动导航不一致。

**Approach:** 将唱片库设为登录后唯一默认入口，收敛桌面与移动导航，只保留核心管理模块；旧推荐/找歌路由安全跳转，隔离能力仅保留深链，并用追加式 ADR 记录对旧冻结架构的替代关系。

## Boundaries & Constraints

**Always:** `/`、未知路由、已登录 `/login`、品牌入口以及 `/today`、`/discover`、`/find` 均直接 replace 到 `/library`，不闪现旧内容；桌面和移动一级导航只显示唱片库、任务、我的系统、设置；桌面设置固定底部；`/quarantine` 受保护深链继续可用但不在导航或快捷入口出现；Album 详情首屏保持用户内容优先，管理 `<details>` 默认折叠；关键窄屏交互至少 44px。

**Ask First:** 只有必须删除旧页面/API 或改变生命周期、鉴权、任务数据合同时暂停确认。

**Never:** 不删除 Home/Discover/Quarantine 页面或 recommendations/lifecycle API；不改写旧 frozen 架构正文；不新增模型、Provider、文件操作、设备同步或最近删除新语义；不把未实现能力留成禁用入口。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 默认入口 | 登录后访问 `/`、品牌或 `/login` | replace 到 `/library` | 不双跳、不闪旧页 |
| 旧链接 | `/today`、`/discover`、`/find` | replace 到 `/library` | 无循环、404、权限绕过 |
| 未知链接 | 任意未知前端路由 | replace 到 `/library` | query 不伪造为库状态 |
| 导航 | 桌面或移动外壳 | 仅唱片库、任务、我的系统、设置 | 无今日、找歌、隔离区 |
| 隔离深链 | 直接访问 `/quarantine` | 按既有角色合同渲染 | 不恢复一级入口 |
| 窄屏 | 主导航与关键选择/操作 | 单列可用且目标 ≥44px | focus 可见 |

</frozen-after-approval>

## Code Map

- `apps/web/src/app.tsx:67` -- 登录后路由矩阵仍渲染 Home/Discover；改为显式 Library redirects 并保留深链。
- `apps/web/src/components.tsx:20` -- 一级导航包含今日、隔离区、找歌，移动端还依赖 `slice(0,4)`。
- `apps/web/src/components.tsx:102` -- 品牌当前指向 `/` 且 aria 文案仍是首页。
- `apps/web/src/pages/library.tsx:385` -- 真空库空态缺少可用管理入口；筛选无结果必须保持不同文案。
- `apps/web/src/pages/album-detail.tsx:512` -- Hero 与管理折叠现状应保留，只补页面级默认关闭证据。
- `apps/web/src/styles.css:3767` -- 移动导航与 select/summary 等关键控件缺少统一 44px/focus 约束。
- `docs/architecture/COCEAN_V1_IMPLEMENTATION_CONTRACT.md:242` -- 历史 frozen 仍定义旧入口；禁止修改。
- `apps/web/src/pages/*.test.tsx` -- 现有测试未覆盖真实路由矩阵、PageShell 双端导航与窄屏语义。

## Tasks & Acceptance

**Execution:**
- [ ] `apps/web/src/app.tsx` 与页面级测试 -- 接线默认、旧路由、未知路由和 `/quarantine` 深链矩阵。
- [ ] `apps/web/src/components.tsx` 与外壳测试 -- 收敛桌面/移动导航、品牌入口与 landmarks。
- [ ] `apps/web/src/pages/library.tsx`、`apps/web/src/pages/album-detail.test.tsx` -- 增加真空库管理动作并锁定详情渐进式披露。
- [ ] `apps/web/src/styles.css` -- 明确窄屏 44px 与 select/summary focus-visible。
- [ ] `docs/architecture/ADR-0002-LIBRARY-FIRST-ENTRY.md` -- 追加新决策，不改旧 frozen 合同。

**Acceptance Criteria:**
- Given 登录用户从任意默认、旧或未知入口进入，when 路由稳定，then 首个产品页面是唱片库且无旧内容闪现。
- Given 外壳在桌面或窄屏渲染，when 检查全部一级入口，then 只有四个核心管理入口且均可访问。
- Given Album 详情或空唱片库渲染，when 用户浏览主内容，then 管理证据保持折叠，下一步动作使用现有真实能力。

## Spec Change Log

- 2026-08-16：三路评审后修复登录二次跳转、越界页误判、角色空态文案与 768–1023px 触控范围；补齐导航目标、DOM 顺序和真实点击证据。

## Design Notes

Story 3.1 只移除“隔离区”的一级可见性，不移除 `/quarantine` 能力；Story 3.2 必须在最终候选发布前从任务中心补回“最近删除”的真实入口。品牌和兼容路由直接指向 `/library`，避免依赖 `/` 二次跳转。

## Verification

**Commands:**
- `pnpm --filter @cocean/web test && pnpm --filter @cocean/web typecheck && pnpm --filter @cocean/web build` -- 13 文件、100/100 测试及生产构建通过。
- `pnpm check` -- 全仓类型、测试和生产构建通过。
- `sh packages/media-scanner/tests/run-generated-integration.sh` -- 10/10 通过。
- `sh infra/tests/run.sh` -- 46/46 及全部 mock/static Gates 通过。
- `ruby infra/scripts/validate-fnos-compose.rb` -- 8 服务合同通过。
- `pnpm exec prettier --check ... && git diff --check` -- 格式、差异及 frozen 历史保护通过。

**Manual checks:**
- 真实浏览器在 768–1023px 检查触控尺寸、键盘焦点和移动导航；仓库当前无 computed-style harness。

## Suggested Review Order

**默认入口与兼容路由**

- 所有默认、旧和未知入口直接 replace 到唱片库。
  [`app.tsx:66`](../../apps/web/src/app.tsx#L66)

- 登录成功链路不再经过根路由二次跳转。
  [`login.tsx:46`](../../apps/web/src/pages/login.tsx#L46)

**产品外壳**

- 单一导航数据只保留四个核心管理入口。
  [`components.tsx:17`](../../apps/web/src/components.tsx#L17)

- 品牌标识直接进入唱片库。
  [`components.tsx:98`](../../apps/web/src/components.tsx#L98)

- 移动导航四列与关键控件触控范围统一。
  [`styles.css:3764`](../../apps/web/src/styles.css#L3764)

**页面信息层级**

- 空库与筛选空态使用不同角色语言和真实动作。
  [`library.tsx:418`](../../apps/web/src/pages/library.tsx#L418)

- 详情管理区域继续保持五组默认折叠。
  [`album-detail.test.tsx:114`](../../apps/web/src/pages/album-detail.test.tsx#L114)

**历史合同与验证**

- ADR 精确声明旧合同局部替代和不变边界。
  [`ADR-0002-LIBRARY-FIRST-ENTRY.md:1`](../../docs/architecture/ADR-0002-LIBRARY-FIRST-ENTRY.md#L1)

- 双端导航映射及侧栏底部顺序由页面结构锁定。
  [`components.test.tsx:55`](../../apps/web/src/components.test.tsx#L55)

- 空态角色、点击和越界页归一均有可执行回归。
  [`library.test.tsx:242`](../../apps/web/src/pages/library.test.tsx#L242)
