---
id: SPEC-track-level-safe-delete
companions:
  - state-machines.md
  - verification-matrix.md
sources: []
---

> **Canonical contract.** 本 SPEC 与 `companions:` 中的文件共同构成可实施、可验证的完整合同。

# COCEAN 曲目级安全删除

## Why

唱片管理者需要移走不想保留的单曲，但直接删除 NAS 文件会破坏版本、Album 与审计关系。下一阶段应把“删除”实现为受控、可恢复的文件治理能力，在不触碰 WATCH_ONLY 主库、不误伤其他版本的前提下完成单曲处置。

## Capabilities

- **CAP-1**
  - **intent:** 管理员可为一个数字 LocalVersion 中的单曲生成只读影响预览。
  - **success:** 预览明确列出冻结源身份、文件/字节、版本与 Album 影响、目标位置及全部阻断项，且零文件写入。
- **CAP-2**
  - **intent:** 管理员可将符合条件的 MANAGED 单曲移到最近删除。
  - **success:** 明确确认后全单复验并幂等执行，不覆盖、不部分成功，默认不永久删除且产生可审计结果。
- **CAP-3**
  - **intent:** 管理员可把已移动单曲恢复到原位置。
  - **success:** 仅在源证据一致且原位置空闲时恢复；冲突或漂移失败关闭，已有文件不被覆盖。
- **CAP-4**
  - **intent:** 系统可在移动或恢复后重建受影响的 LocalVersion 与 Album。
  - **success:** 曲数、碟号、主版本、封面引用、完整性问题、浏览排序与投送事实一致，治理历史仍可追溯。
- **CAP-5**
  - **intent:** 不同角色只能查看或执行其被授权的曲目治理能力。
  - **success:** ADMIN 可管理，MEMBER 仅获脱敏概要，匿名无数据；API、UI 与日志均不泄露路径、哈希或 actor。

## Constraints

- WATCH_ONLY Root 永远禁止移动、删除、改名、写标签、覆盖或权限修改；不得以隐藏记录伪装文件操作成功。
- 必须遵循 Plan → 预览 → 明确确认 → 幂等执行 → 审计 → 可恢复；预览后任何身份、revision、目录、权限、符号链接或目标占用漂移都使全单失败关闭。
- CUE+整轨镜像、共享物理文件或无法一对一归属的资产返回 `UNSPLITTABLE_ASSET`，不得按逻辑 Track 拆分。
- 最后一个可播放音频文件不得被曲目级移动；应阻断并引导使用 Album 级最近删除，避免零曲目幽灵 Album。
- 只移动目标音频及能被唯一归属的曲目 companion；Album 共享封面、CUE、LOG 等附件保留。
- 其他 LocalVersion、PhysicalCopy 与 DeliveryCopy 不级联删除；活动扫描、投送或生命周期计划必须阻断。
- Worker 只能消费冻结的 root、相对路径、size、mtime、SHA-256、媒体 ID、revision 与目标身份。

## Non-goals

- 不提供不可恢复或定时清空的永久删除。
- 不删除音乐作品抽象、实体收藏、其他版本、设备副本或 Album 共享附件。
- 不在 M1.3.1 运行时增加按钮、端点、迁移或真实文件写入。

## Success signal

独立 MANAGED QA Root 能证明单曲预览零写入、确认后仅目标资产进入最近删除、Album 增量重建正确、恢复前后哈希一致；WATCH_ONLY、不可分割资产、最后一曲和所有漂移场景均无副作用地失败关闭。

## Assumptions

- “删除一首歌”指从一个数字 LocalVersion 移走其唯一音频资产，不删除同曲其他版本或实体收藏。
