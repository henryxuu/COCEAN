---
title: 'Story 2.2：默认按最新加入稳定浏览'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '8a9153597433a8d466f1079d146e3a06a271273a'
implementation_root: '/tmp/cocean-added-at.M8Eocv'
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 唱片库当前默认按 Artist 排列，用户刚加入的唱片会散落在大库中；API、演示数据和 URL 对排序默认值也各自定义，无法形成可信、可分享的“最近加入”浏览入口。

**Approach:** 以 Story 2.1 的 `addedAt` 唯一事实为依据，建立共享 `ADDED_DESC` 排序协议，并贯通数据库、API、Web URL、分页、详情返回和演示数据；保留现有显式排序语义。

## Boundaries & Constraints

**Always:** 无显式排序时使用 `ADDED_DESC`；持久层严格按 `library_albums.created_at DESC, library_albums.id ASC` 排序后分页；默认排序不写入 URL，显式 `ARTIST`、`TITLE`、`YEAR_DESC` 必须保留；搜索、介质、问题、可见性或排序变化回到第一页；详情往返与滚动恢复绑定完整 canonical route；合并目标搜索继续显式使用 Artist 排序。

**Ask First:** 只有实测大库查询计划证明必须新增数据库索引或迁移，才暂停确认。

**Never:** 不新增或改写 Album 时间列；不引入 keyset 分页、扫描性能改造、导航改造、日期展示、文件删除、设备同步、模型或 Provider；不修改已发布 migration SQL。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 默认浏览 | `/library` 或 API 无 `sort` | 最新时间优先；相同时间按稳定 ID 升序；URL 无 `sort` | 缺省不退回 Artist |
| 显式旧排序 | `sort=ARTIST/TITLE/YEAR_DESC` | 刷新、分享后语义不变且 URL 保留参数 | 不静默清除 |
| 稳定分页 | 多张相同 `addedAt` 跨页 | 静态数据集无重复、遗漏或换位 | tie-breaker 必须生效 |
| 状态变化 | 第 2 页改变筛选或排序 | 返回第 1 页，其他状态继续保留 | 不携带旧页码 |
| 详情往返 | 从带完整查询的列表进入详情 | 返回时恢复查询、筛选、排序、页码和滚动 | 过期任务不得覆盖新路由 |
| 非法排序 | Web URL 或 API 传未知值 | Web 规范化为默认；API 返回 400 | 不传入数据库 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/library.ts:465` -- 在 `addedAt` 合同旁新增共享 Library sort 协议，供三层复用。
- `packages/database/src/client.ts:7997` -- `listAlbums` 当前默认 ARTIST；新增 `ADDED_DESC` 分支并锁定 `created_at DESC, id ASC`。
- `apps/server/src/app.ts:79` -- 查询 Schema 当前复制三值枚举；改用共享协议并默认最新加入。
- `apps/server/src/app.ts:747` -- Album 列表路由是 API 默认排序与分页的可观察边界。
- `apps/web/src/library-state.ts:41` -- URL 是列表状态单一事实源；默认值、序列化与 canonical route 在此统一。
- `apps/web/src/pages/library.tsx:44` -- 排序控件、第一页归零、详情 `from` 与滚动恢复已有完整接线。
- `apps/web/src/api.ts:128` -- Live client 当前强制 ARTIST，demo 当前未排序；二者需同协议、先排序后分页。
- `apps/web/src/pages/album-detail.tsx:454` -- 合并候选搜索须显式保持 Artist 顺序，避免默认变更扩散。
- `packages/database/src/client.test.ts:2306`、`apps/web/src/library-state.test.ts:12` -- 现有分页和 URL 矩阵的扩展锚点。

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/library.ts`、`packages/contracts/src/library.test.ts` -- 定义四值排序协议、默认值与非法输入合同。
- [x] `packages/database/src/client.ts`、`packages/database/src/client.test.ts` -- 实现默认最新加入、真实 ID tie-breaker 与跨页矩阵。
- [x] `apps/server/src/app.ts`、`apps/server/src/app.test.ts` -- 接线共享查询默认并验证无参数、显式旧排序及非法输入。
- [x] `apps/web/src/library-state.ts`、`apps/web/src/api.ts`、`apps/web/src/pages/**` -- 统一 URL/Live/Demo/控件/详情返回，补齐状态归零与往返测试。

**Acceptance Criteria:**
- Given 时间顺序与 Artist 顺序不同，when 打开 `/library` 或直接请求 Album API，then 两者均按最新加入返回。
- Given 用户选择任一非默认排序并进入第 2 页，when 刷新、分享或从详情返回，then 完整浏览上下文可复现。
- Given 相同时间的 Album 跨越分页边界，when 重复请求同一静态数据集，then 顺序固定且集合完整。

## Spec Change Log

- 2026-08-16：三路评审后收紧三位毫秒 UTC，补齐真实页面请求、API 同时间分页与 Demo 四排序矩阵；索引和非 ASCII 排序一致性留待性能阶段。

## Design Notes

`ADDED_DESC` 是跨层协议，不是前端文案。默认 URL 省略 `sort` 以保持简洁；显式 `sort=ARTIST` 是升级后继续获得旧默认体验的兼容入口。合并候选搜索属于查找工具而非浏览入口，必须主动指定 Artist 排序。

## Verification

**Commands:**
- `pnpm --filter @cocean/contracts test && pnpm --filter @cocean/database test && pnpm --filter @cocean/server test && pnpm --filter @cocean/web test` -- 8/8、97/97、61/61、73/73 全绿。
- `pnpm check` -- 全仓类型、测试和生产构建通过。
- `sh packages/media-scanner/tests/run-generated-integration.sh` -- 10/10 通过。
- `sh infra/tests/run.sh` -- 46/46 及全部 mock/static Gates 通过。
- `ruby infra/scripts/validate-fnos-compose.rb` -- 8 服务合同通过。
- `pnpm exec prettier --check ... && git diff --check` -- 格式与差异完整性通过。

## Suggested Review Order

**共享协议与持久层**

- 单一四值协议统一默认值与非法输入边界。
  [`library.ts:470`](../../packages/contracts/src/library.ts#L470)

- 默认严格按首次加入时间和稳定 ID 分页。
  [`client.ts:8053`](../../packages/database/src/client.ts#L8053)

- API 查询直接复用共享 Schema。
  [`app.ts:95`](../../apps/server/src/app.ts#L95)

**URL 与用户入口**

- URL 解析保留显式旧排序并省略默认值。
  [`library-state.ts:49`](../../apps/web/src/library-state.ts#L49)

- 唱片库控件用用户语言呈现“最新加入”。
  [`library.tsx:327`](../../apps/web/src/pages/library.tsx#L327)

- Demo 在分页前执行同一四值排序协议。
  [`api.ts:186`](../../apps/web/src/api.ts#L186)

- 合并候选显式保持 Artist 查找语义。
  [`album-detail.tsx:459`](../../apps/web/src/pages/album-detail.tsx#L459)

**验证矩阵**

- 数据库锁定默认顺序与真实 ID 跨页集合。
  [`client.test.ts:2324`](../../packages/database/src/client.test.ts#L2324)

- HTTP 验证默认、显式旧排序和非法输入。
  [`app.test.ts:212`](../../apps/server/src/app.test.ts#L212)

- 页面真实 effect 验证默认请求和归第一页。
  [`library.test.tsx:51`](../../apps/web/src/pages/library.test.tsx#L51)

- 详情真实调用链锁定合并搜索顺序。
  [`album-detail.test.tsx:570`](../../apps/web/src/pages/album-detail.test.tsx#L570)

- Demo 四排序、空年份和 tie-breaker 全覆盖。
  [`api.test.ts:221`](../../apps/web/src/api.test.ts#L221)
