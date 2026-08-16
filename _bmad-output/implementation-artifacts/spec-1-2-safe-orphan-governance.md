---
title: 'Story 1.2：安全处置孤立治理版本'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 1
baseline_commit: '7c8c64c992f7579296e22f8d2b104ea6580b8402'
implementation_root: '/tmp/cocean-m1-3-1.9T4Zqr'
context:
  - '/Users/henry/Documents/ChatGPT/Still-local/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — standing BMAD auto-approval applies">

## Intent

**Problem:** Story 1.1 能精确识别 ORPHAN、全历史可见组和坏主版本，但仍缺少一种不碰 Music、不删历史、可预览且可审计的处置方式；直接隐藏、拆组或修改主版本都可能在状态漂移后误操作。

**Approach:** 复用 Story 1.1 的权威分类和结构化保留事实，提供 ADMIN-only 的无写入预览与显式确认。确认前在同一事务内复算 scan、classification、revision、primary、membership、visibility 和 references；仅执行追加式审计与 LibraryAlbum 身份治理，把异常版本归入隐藏历史身份或隐藏全历史组，绝不删除 LocalVersion、不可变账本或媒体文件。

## Boundaries & Constraints

**Always:** Preview 是纯读取；Confirm 以 `requestId + exact input` 幂等。任何事实漂移都以稳定 409 失败关闭；成功和拒绝都追加不可变审计。可播放/实体兄弟优先保留为可见主版本；合法历史保留；无依据 ORPHAN 只关闭展示身份。新增 schema 21 仅增加 append-only 治理事件表及必要索引/触发器，不修复生产数据。

**Ask First:** 启动真实 FNOS、修复真实生产行、改冻结扫描报告/哈希、写 Music/SP3000M、启用永久删除。

**Never:** 物理删除 Album/LocalVersion/账本；按零 tracks、root/path、lifecycle 字符串或模糊 JSON 猜测；调用 Worker 文件移动/隔离/删除；放宽 Inventory Gate；加入模型、Provider、M1.4 性能优化、曲目删除或设备同步。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 可用兄弟 + 异常版本 | 同组至少一项 CURRENT_DIGITAL/PHYSICAL_ONLY | 预览 `DETACH_TO_HIDDEN_HISTORY`；确认保留/选择有效主版本，将目标移入独立 HIDDEN 历史组 | sibling/primary/membership 漂移则 409，无部分修改 |
| 全历史可见组 | 组内仅 REFERENCED_HISTORY | 预览 `HIDE_HISTORY_GROUP`；确认隐藏原组并追加 visibility + orphan governance 审计 | 新增当前/实体版本或 revision 漂移则 409 |
| 无依据孤立项 | ORPHAN，未分组或无可用兄弟 | 预览 `CLOSE_ORPHAN_IDENTITY`；确认创建或复用独立 HIDDEN 身份 | classification/reference 漂移则 409 |
| 已隐藏且闭合 | 目标已处于合法 HIDDEN 历史身份 | `executable=false`、`ALREADY_GOVERNED` | Confirm 返回 409，不重复写事件 |
| 相同 requestId | exact input 重试 | 返回同一 APPLIED/REJECTED 结果 | 不重复变更或事件 |
| requestId 冲突 | 同 ID 不同 input | 稳定 409 `ORPHAN_REQUEST_ID_CONFLICT` | 不写状态 |
| 权限 | ADMIN/MEMBER/匿名 | ADMIN 预览确认；MEMBER 仅看脱敏结果摘要；匿名拒绝 | 403/401，不泄露证据或路径 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/library.ts` -- preview/confirm/event/action/blocker 与稳定错误合同。
- `packages/database/src/migrations.ts` -- schema 21 append-only `library_orphan_governance_events`，含 requestId 唯一、稳定文本 LocalVersion 标识、no-update/no-delete，目标消失后仍可审计。
- `packages/database/src/client.ts` -- 复用 `getLibraryInventoryReport`、`readInventoryVersionFactRows`、`zeroFileRetentionReasons`；纯预览、事务内复核、三种原子身份治理、APPLIED/REJECTED 幂等事件。
- `packages/database/src/client.test.ts` -- 三路径、漂移、幂等、权限数据视图、合法历史保留、扫描重建与无文件写入矩阵。
- `apps/server/src/app.ts` / `app.test.ts` -- ADMIN preview/confirm、ADMIN/MEMBER history、401/403/404/409/隐私。
- `apps/web/src/api.ts` / `api.test.ts` -- 强类型治理 API。
- `apps/web/src/pages/album-detail.tsx` / `album-detail.test.tsx` -- “管理唱片”内渐进式异常治理，不进入主信息首屏。
- `apps/web/src/styles.css` -- 复用现有管理卡片、blocker 与确认模式。

## Tasks & Acceptance

**Execution:**
- [x] Contracts + schema 21 -- 定义三种 action、纯 preview、confirm、事件与稳定错误；append-only 表不存路径/凭据。
- [x] Database preview -- 从目标版本同一 root 的最新权威 scan 复用 Story 1.1 分类；未分组时只纳入目标；返回 before、唯一 action、完整逐成员 producer fingerprint 与 blockers；零写入。
- [x] Database confirm -- `BEGIN IMMEDIATE` 内复算全部事实；exact request 跨连接幂等，冲突不写事件；APPLIED/REJECTED 均保存 submitted expected，且仅 APPLIED 形成 retention；三种处置不删版本/账本、不触发 lifecycle Runner。
- [x] Server + role views -- 显式 LocalVersion-scoped preview/confirm/history；URL/body 交叉绑定；ADMIN-only 写操作，MEMBER 只读脱敏历史，匿名拒绝，404/稳定 409 映射。
- [x] Web management -- 固定 version-scoped POST/POST/GET；同一预览保持单一 requestId 供不确定重试；409 标记 stale、禁用再次确认并强制重新预览。
- [x] Verification -- 数据库/API/Web/全仓/infra/迁移升级/格式/Git Gate 全绿；证明 Music、delivery、lifecycle runner 调用数为零。

**Acceptance Criteria:**
- Given Story 1.1 的权威 finding，when preview，then 不写任一业务表并返回可复算建议与完整 blocker。
- Given exact expected fingerprint，when ADMIN confirm，then 原子完成身份/visibility/primary/membership 与 append-only 审计；失败无部分状态。
- Given 任一 snapshot/revision/reference/classification 漂移，then 写一条 REJECTED 审计并返回稳定 409，必须重新预览。
- Given 可用兄弟、全历史组、无依据 ORPHAN，then 分别执行矩阵规定的唯一动作；合法历史和不可变账本始终保留。
- Given retry，then exact input 重放同一结果；requestId 不同输入稳定冲突。
- Given WATCH_ONLY，then Music/Quarantine/Delivery/SP3000M 均零写入，Worker 不新增任务。

## Spec Change Log

- 2026-08-16 / approved plan：用户已要求 BMAD 自动批准直至目标完成；本 Story 采用 schema 21 单一 append-only 事件表，Preview 保持纯读取，避免持久 Plan 引入可变中间态。处置只改变 LibraryAlbum 身份、成员、主版本与 visibility，不复用会移动文件的 lifecycle plan。
- 2026-08-16 / implementation：完成三路径安全治理、结构化 reference fingerprint、APPLIED/REJECTED 幂等审计、ADMIN/MEMBER 角色视图与“管理唱片”渐进式界面；新增 schema 20→21 升级、扫描漂移、重扫保留及 Music/delivery/lifecycle 零副作用验证。
- 2026-08-16 / review remediation：按三层评审收紧 LocalVersion 路由与同 root 扫描选择；修正未分组最小闭包；schema 21 改用无 FK 的稳定文本目标标识；逐成员 fingerprint 覆盖 delivery、metadata、artwork、identity、visibility、lifecycle 与 issue 全结构；Confirm 改为 immediate transaction，并补目标消失、REJECTED 重扫、请求键碰撞、双连接重放、正式 lifecycle blocker 与挂载 UI stale/retry 回归。

## Design Notes

Preview 返回 canonical `expected` 对象及 SHA-256 fingerprint；Confirm 必须同时提交完整 expected、preview action、fingerprint、scanJobId、localVersionId 和 requestId。每个 member 的 fingerprint 对正式 reference producer 全行结构取稳定摘要；classification、membership、primary、visibility/revision 也进入 expected。数据库不能信任客户端 action：`BEGIN IMMEDIATE` 后重新生成 preview，先比较 canonical fingerprint，再执行唯一动作。目标 root 没有权威 scan 时稳定返回 `NO_AUTHORITATIVE_SCAN`，不回退到其他 root。

`library_orphan_governance_events.local_version_id` 是无 FK 的稳定文本标识，使目标在确认前消失时仍能追加 REJECTED，且不会阻断后续扫描删除。Story 1.1 只把 APPLIED 识别为 `ORPHAN_GOVERNANCE` retention；REJECTED 同时记录 submitted expected、可取得的 current before 和稳定 error code，但不形成保留引用。事件 requestId 以 exact canonical input 绑定；busy/unique 竞争后重读，同输入重放同一结果、不同输入稳定冲突且不写事件。visibility 子事件使用独立内部 UUID 命名域，不复用公共 requestId。

隐藏历史组仍可由 ADMIN 通过既有 `visibility` 治理恢复，但恢复后 Inventory Gate 会再次检查是否存在 current/physical 成员；本 Story 不自动恢复。

## Verification

**Commands:**
- `pnpm --filter @cocean/database test`
- `pnpm --filter @cocean/server test`
- `pnpm --filter @cocean/web test`
- `pnpm check`
- `sh infra/tests/run.sh`
- `git diff --check`

**Results:**
- Database：91 tests passed；覆盖纯预览、三动作、未分组多版本最小反例、严格同 root scan、完整 reference fingerprint、target disappeared 单事件、REJECTED 不保留、正式 lifecycle blocker、visibility 请求键碰撞、双连接 exact replay/冲突、append-only、重扫保留及三路径 finalize scan + close/reopen；预置非零 delivery/lifecycle 行保持不变，Worker poll 无可领取计划。
- Server：60 tests passed；覆盖 version-scoped 路由、URL/body 交叉资源拒绝、ADMIN preview/confirm、匿名 401、MEMBER 403/脱敏历史、缺失 404、target disappeared 409 且事件仍可读取。
- Web：64 tests passed；覆盖固定 POST/POST/GET typed routes、管理折叠区预览、blocker、显式确认及挂载页面的 preview → 不确定重试 → 409 stale/禁用 → re-preview → success/reload。
- Full repository：`pnpm check` passed；typecheck、all tests、all builds 全绿。
- Infrastructure：`sh infra/tests/run.sh` passed；FNOS Compose contract + 46 acceptance tests 全绿，未启动真实 FNOS。
- Migration：schema 20→21 additive upgrade test passed；既有 Album 数据不重写，requestId 唯一、local_version_id 无 FK、目标删除不受阻且 no-update/no-delete triggers 生效。
- Format：所有变更代码与 lockfile `prettier --check` passed；`python3 -m py_compile infra/tests/*.py`、trailing-whitespace 与 conflict-marker 等价检查通过；无路径、凭据或文件 lifecycle 调用进入新增事件与执行路径。
- Git metadata Gate：工作区授权恢复后，`git rev-parse HEAD` 精确为基线 `7c8c64c992f7579296e22f8d2b104ea6580b8402`；`git diff --check` 通过；`git status --short` 仅包含本 Story 13 个预期代码/lockfile 修改和新增权威 spec。

## Suggested Review Order

**纯预览与事务治理**

- 从 LocalVersion 和同 Root 权威扫描导出唯一治理建议。
  [`client.ts:1660`](../../packages/database/src/client.ts#L1660)

- 即时事务内复算指纹、处理并发重放并执行唯一动作。
  [`client.ts:1876`](../../packages/database/src/client.ts#L1876)

- APPLIED 才成为结构化保留事实，REJECTED 只留审计。
  [`client.ts:10301`](../../packages/database/src/client.ts#L10301)

**不可变审计与合同**

- Schema 21 保存稳定目标标识且禁止更新删除事件。
  [`migrations.ts:1261`](../../packages/database/src/migrations.ts#L1261)

- 强类型 expected 锁定成员、引用、主版本与可见性事实。
  [`library.ts:719`](../../packages/contracts/src/library.ts#L719)

**版本级 API 与管理体验**

- Server 以 LocalVersion 作为治理资源并精确映射 404/409。
  [`app.ts:882`](../../apps/server/src/app.ts#L882)

- Web 客户端固定 POST/POST/GET 与资源级路径编码。
  [`api.ts:269`](../../apps/web/src/api.ts#L269)

- 页面持久化 requestId，409 后锁定旧预览并要求刷新。
  [`album-detail.tsx:302`](../../apps/web/src/pages/album-detail.tsx#L302)

- 治理入口收纳于“管理唱片”折叠区，不干扰主信息。
  [`album-detail.tsx:1017`](../../apps/web/src/pages/album-detail.tsx#L1017)

**关键回归证据**

- 数据库矩阵覆盖重扫、重启、并发、漂移与零副作用。
  [`client.test.ts:4295`](../../packages/database/src/client.test.ts#L4295)

- Server 锁定未分组、跨资源、权限和目标消失合同。
  [`app.test.ts:1448`](../../apps/server/src/app.test.ts#L1448)

- 挂载页面验证不确定重试、stale 锁定与重新预览。
  [`album-detail.test.tsx:223`](../../apps/web/src/pages/album-detail.test.tsx#L223)
