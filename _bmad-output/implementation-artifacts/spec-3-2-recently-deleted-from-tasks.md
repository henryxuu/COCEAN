---
title: 'Story 3.2：从任务记录管理最近删除'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '006d65aa336bd09279362ad5f51d7cda1f7d1491'
implementation_root: '/tmp/cocean-added-at.M8Eocv'
context:
  - '_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 一级导航已经收敛，但任务页尚未提供“最近删除”入口，既有页面仍暴露“隔离区”内部术语、用最多 100 条历史计划推导库存，并缺少可定位的任务上下文。

**Approach:** 在任务页接入真实生命周期事实和精确当前数量，将既有恢复页转译为“最近删除”，从任务或 Album 生命周期结果定位记录；复用 M1.3 恢复合同与角色脱敏，不改变任何文件操作语义。

## Boundaries & Constraints

**Always:** 任务页显示真实最近删除总数、最近状态和文件操作结果；`/quarantine` 只作为受保护兼容深链，页面及 Album 动作使用“最近删除 / 移到最近删除 / 恢复到原位置”；当前集合以成功移出且尚未成功恢复的专用投影为准；ADMIN 才能预览、确认、取消、重试或恢复，MEMBER 只读脱敏概要，匿名 401/登录；深链精确定位，返回任务页保留 `plan` 上下文；恢复继续预览、明确确认、幂等、审计、冲突失败关闭。

**Ask First:** 只有必须迁移账本、扩大 MEMBER 权限、删除兼容路由或改变 MANAGED/WATCH_ONLY 文件边界时暂停确认。

**Never:** 不恢复一级导航入口；不使用演示记录、数组长度冒充总数或内部 ID 作为主要对象名称；不泄露 actor、绝对路径、文件清单、哈希或未脱敏错误；不实现曲目删除、永久删除、设备同步或新的文件移动逻辑；不写 Music/SP3000M。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 任务入口 | 存在当前或历史生命周期计划 | 显示精确总数、最近状态、文件数/空间/时间并可进入对应记录 | API 失败显示真实错误，不伪造空态 |
| 当前集合 | QUARANTINE 已成功，RESTORE 未成功 | 显示为可恢复对象；超过 100 条仍返回精确 total | 已成功恢复则退出当前集合 |
| 深链 | `?plan=` 指向移出或恢复计划 | 定位源记录；返回 `/tasks?plan=` 并高亮 | 已恢复/不存在显示明确上下文状态 |
| 恢复并发 | 已有预览、排队、执行或待人工恢复 | 禁止重复恢复，展示进行中或需处理 | 冲突不覆盖、不部分执行 |
| 角色 | ADMIN / MEMBER / 匿名 | 完整管理 / 脱敏只读 / 无数据 | 写路由继续 403/401 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/lifecycle.ts:146` -- 已有 Summary 与真实 MEMBER 响应接近；补读视图及 `{items,total}` 合同，消除 Web 假定 full plan。
- `packages/database/src/client.ts:7382` -- 历史计划只适合最近状态；`listQuarantinedLibraryVersions` 的同一谓词需提供精确 count。
- `apps/server/src/app.ts:1038` -- 复用现有 session/admin 与 `lifecyclePlanView` 脱敏；quarantine envelope 增加 total，不改写路由。
- `apps/web/src/api.ts:386` -- 列表类型当前错误；补结构化读响应及既有 `GET /:id` 客户端。
- `apps/web/src/pages/tasks.tsx:24` -- 增加真实“文件管理 / 最近删除”区、生命周期轮询与 `plan` 定位。
- `apps/web/src/pages/quarantine.tsx:9` -- 改用当前投影，关联恢复计划，保持既有恢复预览/确认并处理深链。
- `apps/web/src/pages/album-detail.tsx:270` -- 用户文案统一，生命周期结果链接到目标记录；设置页的安全“隔离”语义不改。
- `apps/web/src/styles.css:1835` -- 复用现有列表布局，补窄屏整行动作、长错误换行、44px 与 focus。

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/lifecycle.ts`、`packages/database/src/client.ts`、`apps/server/src/app.ts` -- 建立脱敏读合同、精确 current total 与角色/API 回归。
- [x] `apps/web/src/api.ts`、`apps/web/src/pages/tasks.tsx` -- 接入真实生命周期任务、查询定位、轮询、空态与错误态。
- [x] `apps/web/src/pages/quarantine.tsx`、`apps/web/src/pages/album-detail.tsx` -- 完成用户语言、当前集合、结果深链和恢复中防重复。
- [x] `apps/web/src/styles.css` 与页面/API/DB 测试 -- 覆盖 ADMIN、MEMBER、匿名、>100、恢复前后、直接路由和窄屏合同。

**Acceptance Criteria:**
- Given 任意允许角色进入任务或最近删除，when 读取真实生命周期事实，then 数量、状态、对象、文件数、空间、时间、失败原因与恢复后果准确且按角色脱敏。
- Given 管理员从任务或 Album 结果进入并请求恢复，when 计划执行或发生漂移，then 目标被定位、上下文可返回，并沿用既有安全恢复与失败关闭合同。
- Given 页面为空、API 错误或窄屏渲染，when 用户浏览与操作，then 不出现演示数据、内部术语或不可用管理动作，关键目标保持至少 44px。

## Spec Change Log

- 2026-08-16：三路评审后补齐 100+ 分页与精确 current 深链、同快照 total、不限历史窗口的关联恢复状态、MEMBER 最小披露、任务深链置顶、恢复状态机与路径/哈希脱敏；保留既有 M1.3 写入合同和 `/quarantine` 兼容路由。

## Design Notes

`total` 来自与 current projection 完全相同的数据库谓词；all-plans 只表达最近任务状态与关联恢复，不参与库存计数。深链仅接受 plan ID，返回目标固定为 `/tasks`，避免开放式 `from` 跳转。内部 QUARANTINE 枚举、表名和目录诊断保持不变。

## Verification

**Commands:**
- `pnpm check` -- 全仓类型、452 tests 与生产构建通过；Web 146、Database 98、Server 63、Worker 78。
- `sh packages/media-scanner/tests/run-generated-integration.sh` -- 独立生成媒体 10/10 通过。
- `sh infra/tests/run.sh && ruby infra/scripts/validate-fnos-compose.rb` -- infra 46/46、全部 mock/static Gate 与 8 服务合同通过。
- `pnpm exec prettier --check <changed-files> && git diff --check` -- 格式、差异与冻结规格保护通过。

**Manual checks:**
- 真实浏览器检查 320/375/1023px 的定位、返回、键盘焦点、长中文错误与恢复确认；不执行真实文件恢复。

## Suggested Review Order

**任务入口与用户路径**

- 从真实任务状态进入最近删除，并保留 plan 上下文。
  [`tasks.tsx:31`](../../apps/web/src/pages/tasks.tsx#L31)

- 当前集合、分页、深链和恢复状态在一个页面闭环。
  [`quarantine.tsx:17`](../../apps/web/src/pages/quarantine.tsx#L17)

- Album 只为相关生命周期结果提供最近删除入口。
  [`album-detail.tsx:865`](../../apps/web/src/pages/album-detail.tsx#L865)

**权威读模型与权限**

- 同一 SQLite 读快照生成分页、总数与关联恢复事实。
  [`client.ts:7441`](../../packages/database/src/client.ts#L7441)

- 列表与精确 source 路由统一应用角色安全投影。
  [`app.ts:1049`](../../apps/server/src/app.ts#L1049)

- 强类型区分 ADMIN 完整计划与 MEMBER 最小概要。
  [`lifecycle.ts:184`](../../packages/contracts/src/lifecycle.ts#L184)

- Web 客户端显式区分分页集合与精确 current 记录。
  [`api.ts:402`](../../apps/web/src/api.ts#L402)

**安全恢复与呈现**

- 关联恢复状态失败关闭，防止重复恢复与错误状态推断。
  [`quarantine.tsx:261`](../../apps/web/src/pages/quarantine.tsx#L261)

- 窄屏操作、焦点、高亮与长错误均有明确样式合同。
  [`styles.css:1969`](../../apps/web/src/styles.css#L1969)

**回归证据**

- 服务端锁定匿名、角色脱敏、恢复前后与精确 current。
  [`app.test.ts:3000`](../../apps/server/src/app.test.ts#L3000)

- 数据库覆盖 101 项分页、第二页和关联恢复投影。
  [`client.test.ts:6565`](../../packages/database/src/client.test.ts#L6565)

- 页面覆盖完整恢复状态机、深链、错误和角色边界。
  [`quarantine.test.tsx:21`](../../apps/web/src/pages/quarantine.test.tsx#L21)
