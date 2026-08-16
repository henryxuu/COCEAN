---
title: 'Story 2.1：持久化 Album 首次入库时间'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'e0fd350061714bb7d971ed152a984610a83567cd'
implementation_root: '/tmp/cocean-added-at.M8Eocv'
context:
  - '_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** COCEAN 已持久化 Library Album 的创建时间，但列表与详情合同没有结构化 `addedAt`，合并、拆分及孤立版本治理也没有统一维护“音乐首次进入该 Album 身份”的时间语义，后续“最新加入”会因此不可信。

**Approach:** 将既有 `library_albums.created_at` 正式定义为唯一持久化事实并映射为 API `addedAt`，不增加重复列；补齐所有身份创建、合并、拆分和撤销路径的不变量，为 Story 2.2 提供稳定排序依据。

## Boundaries & Constraints

**Always:** `addedAt` 必须是非空 ISO 8601 UTC；普通重扫、字段/封面修改、主版本切换、新增成员和重启不得改变；合并取两组更早值；拆分保留原组值，新组取其成员 `albums.created_at` 最早值；撤销恢复快照精确值；列表、详情、alias 与 LocalVersion 入口返回同一事实。

**Ask First:** 只有发现现有 `created_at` 无法表达上述语义、必须新增 schema 列或墓碑事实时暂停确认。

**Never:** 不从主 LocalVersion 的 `albums.created_at`、`updated_at`、扫描时间或前端文案推导；不加入排序 UI、导航改造、模型/Provider、扫描性能、文件删除或设备同步；不修改已发布 migration SQL。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 首次建组 | 一个或多个版本首次形成 Library Album | `addedAt` 为成员最早 `albums.created_at` | 缺失或非 UTC 时间时失败，不返回伪值 |
| 普通治理 | 重扫、换主、编辑、封面、新增版本 | 原 `addedAt` 字节级不变 | 回归测试失败关闭 |
| 合并/拆分 | 两组合并或成员分区 | 合并取更早值；原分区保留；新分区取成员最早值 | revision 漂移沿用既有冲突合同 |
| 撤销 | 撤销 MERGE/SPLIT | 每个身份恢复决定前精确值 | 不以当前时间补写 |
| 完全消失再出现 | 无治理保护的 Album 被删除后重新扫描 | 视为新加入，不引入跨删除墓碑 | 不冒充普通重扫稳定性 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/library.ts:465` -- `albumSummarySchema` 增加必填、UTC 的 `addedAt`；详情自动继承。
- `packages/database/src/migrations.ts:759` -- schema 16 已有唯一事实 `library_albums.created_at`；schema 20/21 不改写，禁止追加重复列。
- `packages/database/src/client.ts:3201` -- 自动重建首次取成员最早时间，已有组只更新 `updated_at`。
- `packages/database/src/client.ts:3728` -- MERGE 当前只保留 target 时间，需改为两组最早值并保留 alias 一致性。
- `packages/database/src/client.ts:3840` -- SPLIT 新组当前写 `now`，需改为分区成员最早时间。
- `packages/database/src/client.ts:2082` -- 孤立版本治理创建隐藏历史组时同样使用成员最早时间。
- `packages/database/src/client.ts:4546` -- identity snapshot/undo 已携带 `createdAt`，复用并锁定精确恢复。
- `packages/database/src/client.ts:7948` -- list/summary SQL 显式选择 `la.created_at AS library_added_at`，避免误读 `a.created_at`。
- `packages/database/src/client.ts:9471` -- `mapLibraryAlbumSummary` 是唯一 `addedAt` 映射点；详情复用 summary。
- `apps/web/src/demo.ts:91` 与页面测试 fixture -- 补齐必填合同字段；本 Story 不展示日期。

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/library.ts` -- 将 `addedAt` 加入 AlbumSummary/Detail 的强类型合同并拒绝缺失或无效 UTC 值。
- [x] `packages/database/src/client.ts` -- 接线唯一时间事实，修正 MERGE/SPLIT/孤立治理及 undo 不变量。
- [x] `packages/database/src/client.test.ts` -- 覆盖来源隔离、重扫/治理稳定性、结构变更与 schema 20/21 重开不改写。
- [x] `apps/server/src/app.test.ts`、`apps/web/src/**` -- 验证列表/详情/匿名裁剪完整透传，并更新完整 fixture。

**Acceptance Criteria:**
- Given 主 LocalVersion 与 Library Album 创建时间不同，when 读取列表、详情、alias 或版本入口，then 全部返回后者且为有效 UTC。
- Given 同一 Album 经重扫、编辑、换主和新增版本，when 再次读取，then `addedAt` 与首次值完全一致。
- Given MERGE、SPLIT、孤立治理及对应撤销，when 操作成功，then 所有结果身份遵守更早/成员最早/精确恢复规则且审计、成员、封面和元数据事实不变。

## Spec Change Log

- 2026-08-16：复用 `library_albums.created_at` 完成 `addedAt` 合同、身份治理不变量与回归矩阵；BMAD 三路评审后修复已有组重扫误解析、动态参数上限与验证盲点。

## Design Notes

`addedAt` 是 API/产品语言；存储继续使用已被 schema 16、自动建组和最近新增统计共同验证的 `library_albums.created_at`。新增同义列会制造双写与漂移风险，且没有用户价值。

## Verification

**Commands:**
- `pnpm --filter @cocean/contracts test && pnpm --filter @cocean/database test && pnpm --filter @cocean/server test && pnpm --filter @cocean/web test` -- 6/6、96/96、60/60、64/64 全绿。
- `pnpm check` -- 全仓类型、测试与生产构建通过；仅既存 Vite chunk 警告。
- `sh packages/media-scanner/tests/run-generated-integration.sh` -- 10/10 通过并清理夹具。
- `sh infra/tests/run.sh` -- 46/46 及 preflight/runtime/finalize/static mock Gates 全绿。
- `ruby infra/scripts/validate-fnos-compose.rb` -- 8 个服务合同通过。
- `pnpm exec prettier --check ... && git diff --check` -- 格式与差异完整性通过。

## Suggested Review Order

**唯一时间事实与合同**

- 从数据库唯一事实映射严格 UTC 的产品字段。
  [`client.ts:9550`](../../packages/database/src/client.ts#L9550)

- 独立时间 Schema 避免数据库依赖对象内部结构。
  [`library.ts:465`](../../packages/contracts/src/library.ts#L465)

**身份生命周期不变量**

- 首次自动建组只从已加载成员取最早时间。
  [`client.ts:3366`](../../packages/database/src/client.ts#L3366)

- 合并统一保留两个身份中更早的时间。
  [`client.ts:3743`](../../packages/database/src/client.ts#L3743)

- 拆分新组按分区成员时间独立计入。
  [`client.ts:3929`](../../packages/database/src/client.ts#L3929)

- 撤销精确恢复快照，而非沿用当前组值。
  [`client.ts:4771`](../../packages/database/src/client.ts#L4771)

- 孤立治理新历史组沿用版本首次进入时间。
  [`client.ts:2154`](../../packages/database/src/client.ts#L2154)

**读取边界与兼容入口**

- 列表显式选择 Library Album 时间，避免误读主版本。
  [`client.ts:8059`](../../packages/database/src/client.ts#L8059)

- API 测试锁定列表、稳定 ID、alias 与版本入口一致。
  [`app.test.ts:242`](../../apps/server/src/app.test.ts#L242)

**回归矩阵**

- 普通重扫、编辑、封面、换主和重启保持字节不变。
  [`client.test.ts:2455`](../../packages/database/src/client.test.ts#L2455)

- 合并、拆分、撤销及最近新增统计跨边界验证。
  [`client.test.ts:2591`](../../packages/database/src/client.test.ts#L2591)

- 删除重现与非法成员时间均明确失败关闭。
  [`client.test.ts:2718`](../../packages/database/src/client.test.ts#L2718)

- Schema 20→21 升级和重开不改写旧时间。
  [`client.test.ts:269`](../../packages/database/src/client.test.ts#L269)

- 完整 Summary/Detail 合同拒绝缺失及非 UTC。
  [`library.test.ts:8`](../../packages/contracts/src/library.test.ts#L8)
