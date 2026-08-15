---
title: "M1.3 FNOS 验收活动扫描协调"
type: "bugfix"
created: "2026-08-15"
status: "in-progress"
review_loop_iteration: 0
baseline_commit: "f759fa7841d8e8100c9d5f8539ba979083689442"
context:
  - "{project-root}/_bmad-output/implementation-artifacts/spec-cocean-m1-3-library-lifecycle.md"
  - "{project-root}/docs/deployment/FNOS_M1_3_LIFECYCLE_ACCEPTANCE.md"
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** M1.3 生产 WATCH_ONLY 验收部署后，自动发现扫描占用 `music` Root；验收客户端仍创建第二个扫描，收到 `SCAN_ALREADY_ACTIVE`/HTTP 409 后失败，无法形成有效 API 证据。

**Approach:** 验收客户端仅在精确活动扫描冲突下复用唯一的 `music` 活动任务；冲突瞬时消失时有界重试，其余情况失败关闭，随后仍执行原有全量证据 Gate。

## Boundaries & Constraints

**Always:** 显式 existing scan ID 优先且不 POST；自动复用要求 409 错误码精确、候选唯一、ID 安全、`rootId=music`、状态为 `QUEUED/RUNNING`；FULL/INCREMENTAL 都必须通过 manifest、逐文件账本、库统计和音频 Range 对账；报告只记录获取方式，不记录任务 ID、路径、凭据或错误正文；轮询受原超时控制。

**Ask First:** 重跑生产 Runner、重新部署/启动被失败清理停止的容器、取消扫描、改变 Music/SP3000M、重跑 GitHub CI。

**Never:** 创建并行扫描；复用任意 409、非 music、终态或歧义候选；绕过任何既有 Gate；把失败证据冒充 PASS。

## I/O & Edge-Case Matrix

| Scenario   | Input / State             | Expected Output / Behavior | Error Handling          |
| ---------- | ------------------------- | -------------------------- | ----------------------- |
| 正常创建   | POST 202 QUEUED           | 使用新任务                 | 身份/状态异常则失败     |
| 活动竞态   | 精确 409 + 唯一活动任务   | 复用且不取消/并行创建      | 候选异常则失败          |
| 竞态消失   | 409 后无活动任务          | 固定小次数重试创建         | 耗尽即失败              |
| 非预期错误 | 其他 409/坏 JSON/超限正文 | 不复用                     | `scan-acquire` 脱敏失败 |
| 显式复用   | 安全 existing ID          | 保持现行为，POST=0         | 任务异常则失败          |

</frozen-after-approval>

## Code Map

- `infra/scripts/fnos_api_acceptance.py:239-420,754-810` -- HTTPError 当前不可判别；在扫描获取入口增加安全状态读取、唯一候选协调与非敏感来源字段。
- `apps/server/src/app.ts:1711-1839` -- 已提供扫描列表和稳定 `SCAN_ALREADY_ACTIVE` 合同；无需改生产 API。
- `apps/worker/src/runner.ts:69-475` -- 两种模式均遍历完整 inventory 并冻结逐文件结果；INCREMENTAL 只复用未变解析事实。
- `infra/tests/test_api_acceptance.py:137-710` -- HTTP fixture/黑盒 CLI 测试锚点，覆盖创建、复用、竞态消失、歧义和错误脱敏。
- `infra/scripts/fnos_acceptance.sh:216-223` -- 保持单一 acceptance-api 调用、退出时 Music 复验及失败保全。

## Tasks & Acceptance

**Execution:**

- [x] `infra/scripts/fnos_api_acceptance.py` -- 实现有界、安全、脱敏的扫描创建/复用协调。
- [x] `infra/tests/test_api_acceptance.py` -- 覆盖矩阵并断言无并行 POST、无敏感信息泄漏。
- [x] `infra/tests/run.sh`、`pnpm check` -- 保持全部自动化 Gate。
- [ ] `spec-cocean-m1-3-library-lifecycle.md` -- 最终仅追加非冻结实机证据。

**Acceptance Criteria:**

- Given WATCH_ONLY 已有唯一自动扫描，when 验收取证，then 不取消、不并行创建并完成原全库 Gate。
- Given 冲突或候选不满足精确合同，when 协调，then 失败关闭且报告不含 ID、主机路径、Cookie、Token 或错误正文。
- Given 首次 Runner 已失败，when 本地补丁通过，then 先证明最终 Music 不变、schema 20、integrity ok、外键 0，再进行授权范围内的安全续验。

## Spec Change Log

- 2026-08-16：首轮生产 Runner 在 schema 20、WATCH_ONLY 运行边界通过后，因自动扫描占用返回精确 `SCAN_ALREADY_ACTIVE`/HTTP 409 而失败关闭；随后 Music 复验检测到管理员在哈希窗口内完成的独立人工整理，旧基线不再作为续验证据。

## Verification

**Commands:**

- `python3 -m unittest infra.tests.test_api_acceptance` -- 扫描获取矩阵全绿。
- `sh infra/tests/run.sh` -- 29/29、preflight/finalize mock、Compose 合同通过。
- `pnpm check` -- 类型、全仓测试、生产构建通过。
- `git diff --check` 与 Prettier -- 格式通过。

**Manual checks:**

- 首次失败日志、schema 20 在线备份、旧镜像和 QA 现场均已保留；生产服务只在重新确认 WATCH_ONLY 与 Music 只读挂载后恢复。
- 整理后的数据库备份 `m1-3-post-user-sort-20260816T001500Z` 创建/复核一致；新 Music 全量只读基线正在独立计算，完成前不启动续验 Runner。
