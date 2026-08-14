---
title: "M1.2b 唱片字段治理"
type: "feature"
created: "2026-08-14"
status: "done"
review_loop_iteration: 0
baseline_commit: "4d5dbc9b224a22d976eaf6a5e82409c131df8845"
context:
  - "{project-root}/_bmad-output/specs/spec-cocean-m1-2b-field-governance/SPEC.md"
  - "{project-root}/_bmad-output/specs/spec-cocean-m1-2b-field-governance/field-governance.md"
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 身份分组已可信，但空白、乱码或错误的标题、艺术家、年份和发行字段仍污染唱片卡、搜索与投送；现有信息匹配还会补写扫描聚合列，无法保留原始事实。

**Approach:** 建立独立字段层与 metadataRevision，按 `USER_OVERRIDE > CONFIRMED_EXTERNAL > OBSERVED_TAG > PATH_FALLBACK` 解析唯一有效值，提供管理员编辑、重置、显式清空、审计与撤销。

## Boundaries & Constraints

**Always:** 唱片级治理标题、专辑艺术家、年份；版本级治理厂牌、目录号、条码、国家、发行日期。保留扁平有效字段兼容旧消费者；观察值只读；多字段事务全成或全退；ADMIN 写、MEMBER 只读；任务冻结排队时的有效值。

**Ask First:** 真实 FNOS schema 18；新在线目录或功能开关；改变 MERGE 冲突拒绝、SPLIT 继承或清空语义；扩展到曲目、封面或源文件。

**Never:** 修改 `media_files` 或 NAS；用 `COALESCE` 模拟显式清空；合并身份与字段 revision；让重扫或身份治理静默丢值；用大模型定版。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| 修订字段 | 当前 metadataRevision 下 SET/CLEAR/RESET 多字段 | 有效值、来源、搜索与 revision 原子更新；观察值不变 | 校验 400；陈旧 revision、异指纹 requestId 或非成员 409，零部分写入 |
| 确认外部候选 | ADMIN 选择候选及明确 LocalVersion | 写 `CONFIRMED_EXTERNAL` 证据，不修改扫描列 | 匿名/MEMBER 拒绝；候选或版本漂移失败 |
| 重扫或选主 | 已有人工值后扫描或 SET_PRIMARY | 人工值保留；未覆盖值跟随观察事实；问题按有效值消解 | 有效来源变化递增 metadataRevision |
| 合并拆分撤销 | 人工字段冲突或最新事件撤销 | MERGE 冲突拒绝；原主分区继承唱片覆盖；版本覆盖随成员；撤销追加补偿事件 | 继承不确定、状态漂移或重复撤销 409 |

</frozen-after-approval>

## Code Map

- `packages/database/src/migrations.ts:758` -- schema 16/17 与不可变账本；追加 schema 18，禁止级联丢字段历史。
- `packages/database/src/client.ts:1496` -- 重扫保持与问题重建；按有效值更新问题和 metadataRevision。
- `packages/database/src/client.ts:2271` -- 复用事务、精确幂等、撤销；身份 MERGE/SPLIT/UNDO 显式迁移字段归属。
- `packages/database/src/client.ts:3203` -- 列表、搜索、详情、统计和投送统一读取有效值，避免 N+1。
- `packages/database/src/client.ts:3692` -- 候选确认从污染 `albums` 改为外部确认证据层。
- `packages/contracts/src/library.ts:58` -- 增加 provenance、metadataRevision、命令和事件；保留扁平字段。
- `apps/server/src/app.ts:769` -- 复用身份鉴权和 400/409；候选搜索/确认改为 ADMIN 写。
- `apps/server/src/delivery.ts:118` -- 仅准备阶段读取有效值，Runner 继续消费冻结 bundle。
- `apps/web/src/pages/album-detail.tsx:351` -- 新增元数据治理与历史；409 刷新 revision 但保留草稿。
- `apps/web/src/pages/information-match.tsx:22` -- 候选绑定明确版本，补 MEMBER/Demo 只读。

## Tasks & Acceptance

**Execution:**

- [x] `packages/database/src/migrations.ts`、`packages/contracts/src/library.ts` -- schema 18、字段层、问题状态、账本与 API 合同。
- [x] `packages/database/src/client.ts` -- 有效值、SET/CLEAR/RESET、幂等/撤销/重扫和身份继承；迁移旧外部确认。
- [x] `apps/server/src/app.ts`、`apps/server/src/delivery.ts` -- 历史/写路由、鉴权、错误与冻结语义。
- [x] `apps/web/src/api.ts`、`apps/web/src/pages/album-detail.tsx`、`apps/web/src/pages/information-match.tsx` -- 来源、分作用域编辑、只读角色、冲突草稿和撤销。
- [x] Database、Server、Web、Delivery 测试 -- 覆盖矩阵、迁移、重扫、身份继承和冻结任务。

**Acceptance Criteria:**

- Given 空白或乱码唱片，when 管理员修订并重扫，then 有效字段与审计保持、问题退出待处理、原标签与 Music 清单不变。
- Given 四层值并存，when SET/CLEAR/RESET 或撤销，then 优先级、显式 null 和 revision 在 API、列表、详情、搜索与新投送中一致。
- Given MERGE/SPLIT/SET_PRIMARY/身份撤销，when 字段可无冲突继承，then 归属符合合同；否则整体 409 且历史不丢。

## Spec Change Log

## Design Notes

覆盖行存在且 `value_json=null` 才是 CLEAR；删除覆盖行是 RESET。元数据账本独立于身份账本，身份操作只迁移所有权和历史关联。

## Verification

- `pnpm --filter @cocean/database test && pnpm --filter @cocean/server test && pnpm --filter @cocean/web test` -- 定向矩阵通过。
- `pnpm check` -- 全仓类型、测试、构建通过。
- `sh packages/media-scanner/tests/run-generated-integration.sh` -- 真实 fixture 与观察事实不变。
- `sh infra/tests/run.sh && ruby infra/scripts/validate-fnos-compose.rb && git diff --check` -- FNOS、Compose、补丁通过。

**Implementation result (2026-08-14):** Database 55/55、Server 51/51、Web 53/53、Worker 73/73；全仓类型、测试、生产构建、媒体 fixture 10/10、Infra 24/24、FNOS 静态/模拟与 7 服务 Compose 合同全部通过。三层对抗审查提出的 23 项数据一致性、边界与验证补丁均已修复并复验。未执行真实 FNOS schema 18，未修改任何 NAS 文件。

## Suggested Review Order

**字段状态与身份治理不变量**

- 从原子字段命令理解四层优先级、幂等与补偿撤销。
  [`client.ts:3789`](../../packages/database/src/client.ts#L3789)

- 身份撤销合并后续字段事件，避免复活 RESET 或丢失历史。
  [`client.ts:3356`](../../packages/database/src/client.ts#L3356)

- 问题证据保留，同时按有效字段退出待处理统计。
  [`client.ts:4282`](../../packages/database/src/client.ts#L4282)

- 外部候选绑定版本、完整替换并支持候选删除后的精确重放。
  [`client.ts:4881`](../../packages/database/src/client.ts#L4881)

**持久化与服务端边界**

- Schema 18 分离字段值、metadataRevision 和不可变审计账本。
  [`migrations.ts:891`](../../packages/database/src/migrations.ts#L891)

- 合同保留扁平有效字段，并增加来源、命令和历史结构。
  [`library.ts:150`](../../packages/contracts/src/library.ts#L150)

- 登录读取、ADMIN 写入及稳定 400/409 在路由层收口。
  [`app.ts:784`](../../apps/server/src/app.ts#L784)

**管理型编辑体验**

- 唱片与版本字段共享草稿、冲突恢复、来源和历史体验。
  [`album-detail.tsx:967`](../../apps/web/src/pages/album-detail.tsx#L967)

- 发行候选查询与确认全程绑定用户选择的 LocalVersion。
  [`information-match.tsx:22`](../../apps/web/src/pages/information-match.tsx#L22)

**验证证据**

- 数据库矩阵覆盖 SET/CLEAR/RESET、身份继承、重扫与冻结任务。
  [`client.test.ts:1238`](../../packages/database/src/client.test.ts#L1238)

- 服务端验证匿名隔离、角色权限、原子写入和撤销。
  [`app.test.ts:331`](../../apps/server/src/app.test.ts#L331)

- Web 纯函数覆盖多字段命令及版本级作用域。
  [`album-detail.test.tsx:102`](../../apps/web/src/pages/album-detail.test.tsx#L102)
