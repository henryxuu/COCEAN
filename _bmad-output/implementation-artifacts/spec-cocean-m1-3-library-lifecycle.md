---
title: "M1.3 唱片生命周期与安全删除"
type: "feature"
created: "2026-08-15"
status: "done"
review_loop_iteration: 2
baseline_commit: "7d3c506bd1dad429d044f33588959dbc970dc67b"
context:
  - "{project-root}/_bmad-output/specs/spec-cocean-m1-3-library-lifecycle/SPEC.md"
  - "{project-root}/_bmad-output/specs/spec-cocean-m1-3-library-lifecycle/lifecycle-model.md"
  - "{project-root}/docs/architecture/COCEAN_V1_IMPLEMENTATION_CONTRACT.md"
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** M1.2 已能治理身份、字段和封面，但用户仍无法隐藏唱片，或将错误本地版本安全隔离后恢复；“删除专辑”又会混淆聚合 Album、LocalVersion、NAS 文件和设备副本。

**Approach:** 增加显示状态与 `LibraryChangePlan`，冻结单个 MANAGED Root 内 LocalVersion 的文件证据，由持久 Worker 隔离或恢复，并保留不可变审计和恢复材料。

## Boundaries & Constraints

**Always:** WATCH_ONLY 和扫描永远只读；MANAGED 由部署显式声明并通过读写/隔离根探针；一次只处理一个 Root 的一个 LocalVersion；ADMIN 写、MEMBER 只读、匿名隔离；计划冻结 revision、相对路径、大小和 SHA-256 并在执行前复验；目标非空、边界逃逸、事实漂移、活动任务或并发计划均失败关闭；部分执行进入 `RECOVERY_REQUIRED`；所有命令可审计、幂等且重启可恢复。

**Ask First:** 真实 FNOS schema 20；把真实 Music Root 改为 MANAGED/读写；真实隔离或恢复；改变无限期保留、冲突不覆盖或永久删除语义；批量或跨 Root 操作。

**Never:** 永久删除或自动清理；静默改变 Music 挂载；改名、跨 Root 移动、标签/sidecar 写回；删除设备副本；用模型决策；把部分成功展示为完成。

## I/O & Edge-Case Matrix

| Scenario  | Input / State        | Expected Output / Behavior                     | Error Handling                                 |
| --------- | -------------------- | ---------------------------------------------- | ---------------------------------------------- |
| 隐藏/恢复 | revision + requestId | 默认隐藏、管理视图可找回，重扫保持             | 陈旧或异指纹请求 409                           |
| 计划预览  | 单 Root LocalVersion | 返回精确成员、字节、目标、影响和阻塞；零副作用 | WATCH_ONLY、跨 Root、缺 SHA 或活动任务不可执行 |
| 隔离/恢复 | 有效 MANAGED 计划    | 全成员移动并复验，成功后增量对账               | 计划过期、只读、漂移或目标存在时不覆盖         |
| 中断恢复  | 两端混合状态         | 按逐项哈希续跑或进入 RECOVERY_REQUIRED         | 两端均有/均无/哈希异常时保留事实并停止         |

</frozen-after-approval>

## Code Map

- `packages/database/src/migrations.ts` -- schema 20：显示 revision/事件、计划、不可变清单/事件、活动唯一约束。
- `packages/contracts/src/lifecycle.ts`、`index.ts` -- 状态、命令、清单、安全读模型和错误合同。
- `packages/database/src/client.ts` -- 复用 requestId/revision、版本查询和任务账本；实现隐藏、快照、排队、逐项状态、阻塞与默认过滤。
- `apps/worker/src/lifecycle.ts`、`worker.ts`、`config.ts` -- 复用 realpath/hash 安全锚点执行隔离、恢复、重启判定和增量对账。
- `apps/server/src/config.ts`、`app.ts` -- Root policy/隔离根、鉴权 API、稳定错误和可写探针；请求线程不移动文件。
- `apps/web/src/api.ts`、`pages/album-detail.tsx`、`pages/quarantine.tsx`、`app.tsx`、`styles.css` -- “显示与存放”、确认预览、隔离区和只读体验。
- `infra/compose/fnos/**`、`infra/scripts/fnos_preflight.sh`、`infra/tests/**` -- 默认只读；显式 MANAGED/quarantine 一致性与权限合同。
- `packages/database/src/client.test.ts`、`apps/worker/src/lifecycle.test.ts`、`apps/server/src/app.test.ts`、`apps/web/src/pages/*.test.tsx` -- 覆盖迁移、角色、冲突、恢复和零误伤。

## Tasks & Acceptance

**Execution:**

- [x] `packages/contracts/src/lifecycle.ts`、`migrations.ts` -- 建立 schema 20、命令与不可变账本。
- [x] `packages/database/src/client.ts` -- 实现显示状态、计划快照、并发、阻塞、逐项进度与过滤。
- [x] `apps/worker/src/lifecycle.ts` -- 实现复验、隔离/恢复、重启判定和对账。
- [x] `apps/server/src/config.ts`、`app.ts` -- 提供鉴权 API 与探针，文件 I/O 不进请求线程。
- [x] `apps/web/src/**` -- 实现隐藏、预览确认、隔离区、恢复和只读角色体验。
- [x] `infra/**`、`**/*.test.*` -- 默认只读部署合同及全部正负回归。

**Acceptance Criteria:**

- Given WATCH_ONLY 或实际只读 Root，when 管理员尝试隔离，then 系统明确拒绝且源文件、数据库活动版本和设备副本不变。
- Given 有效 MANAGED QA 版本，when 隔离后恢复，then 文件数/字节/哈希一致，Album ID、字段、封面与历史保持。
- Given Worker 在中途退出，when 重启处理同一计划，then 已移动成员不重复覆盖，剩余成员安全续跑或计划进入 RECOVERY_REQUIRED。
- Given 唱片被隐藏，when 重扫、重启或默认搜索，then人工状态保持，管理员仍可从管理视图恢复。
- Given MEMBER 或匿名请求，when 读取或提交生命周期资源，then MEMBER 只获缩减状态且不能写，匿名不获路径、actor、requestId 或清单。

## Spec Change Log

- 2026-08-15：完成 schema 20、显示治理、冻结计划、Worker 隔离/恢复、角色安全 API、隔离区与 FNOS 默认只读合同。
- 2026-08-15：三路对抗评审后补强冻结 Root 身份、运行时权限/任务/actor 复验、未知目标拒绝、双端冲突、恢复断点收敛、排队取消与预览过期。
- 2026-08-15：补齐隐藏管理视图、全局隔离区、状态/时间/失败筛选、异常计划重新核验、隐藏拆分继承、身份/投送互斥、MEMBER 错误脱敏与 MANAGED 运行检查。
- 2026-08-15：增加真实 FNOS 双栈验收手册；生产只做 schema 20 + WATCH_ONLY，首次 MANAGED 文件写仅在完全隔离的临时 QA 栈执行。
- 保留限制：Node 路径 API 无法提供 Linux `openat2`/`unlinkat` 级目录句柄原子性；已采用 realpath、逐级符号链接、COPYFILE_EXCL、哈希与 inode 复验缩小窗口，真实 MANAGED 部署仍需受控单写者验收。

## Verification

**Commands:**

- `pnpm check` -- 全仓类型、测试与生产构建通过；Contracts 5、Recommendation 14、Catalog Recommendation 3、Catalog Sources 2、Media Scanner 38（默认跳过真实媒体 10）、Still 2、Database 64、Worker 78、Server 56、Web 59。
- `sh packages/media-scanner/tests/run-generated-integration.sh` -- 生成媒体 10/10，通过并清理 fixture。
- `sh infra/tests/run.sh` -- Python acceptance 24/24、preflight/finalize mock、WATCH_ONLY/MANAGED runtime mount mock 与 7 服务 Compose 合同通过。
- `docs/deployment/FNOS_M1_3_LIFECYCLE_ACCEPTANCE.md` -- 已定义生产只读升级、隔离 QA 栈、正向隔离/恢复、失败关闭矩阵与证据收口；待单独授权后执行。
- `git diff --check` 与 Prettier -- 补丁和格式通过。
- 未执行真实 FNOS schema 20、真实 Music MANAGED/隔离/恢复；这些仍属于 Ask First，不能由本地 Gate 替代。

## Suggested Review Order

**安全执行主链路**

- 从持久 Worker 入口理解最终复验、零覆盖与恢复收敛。
  [`lifecycle.ts:32`](../../apps/worker/src/lifecycle.ts#L32)

- 不可变计划、清单、互斥触发器构成 schema 20 安全底座。
  [`migrations.ts:1156`](../../packages/database/src/migrations.ts#L1156)

- 计划预览冻结 Root、revision、成员、大小和 SHA-256。
  [`client.ts:5765`](../../packages/database/src/client.ts#L5765)

- 异常计划可在人工修复后重新核验，不强制成功。
  [`client.ts:6119`](../../packages/database/src/client.ts#L6119)

- 隔离命名空间拒绝未知目录、文件、链接和特殊节点。
  [`lifecycle.ts:169`](../../apps/worker/src/lifecycle.ts#L169)

**权限与产品入口**

- Server 集中处理 ADMIN 命令、角色脱敏与稳定错误合同。
  [`app.ts:881`](../../apps/server/src/app.ts#L881)

- 隔离区汇总全部计划，提供筛选、恢复、取消与重新核验。
  [`quarantine.tsx:9`](../../apps/web/src/pages/quarantine.tsx#L9)

- 管理员可从唱片库直接找回已隐藏唱片。
  [`library.tsx:252`](../../apps/web/src/pages/library.tsx#L252)

**部署与验证边界**

- 预检只在显式 MANAGED 时证明 Music 的容器内写权限。
  [`fnos_preflight.sh:480`](../../infra/scripts/fnos_preflight.sh#L480)

- 运行检查按策略验证 Server 只读、Worker 条件读写。
  [`fnos_runtime_inspect.sh:114`](../../infra/scripts/fnos_runtime_inspect.sh#L114)

- 双策略 mock 防止运行挂载合同回归。
  [`test_fnos_runtime_inspect.sh:17`](../../infra/tests/test_fnos_runtime_inspect.sh#L17)
