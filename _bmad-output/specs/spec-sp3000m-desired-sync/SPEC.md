---
id: SPEC-sp3000m-desired-sync
companions:
  - manifest-and-state-machines.md
  - verification-matrix.md
sources: []
---

> **Canonical contract.** 本 SPEC 与 `companions:` 中的文件共同构成可实施、可验证的完整合同。

# COCEAN SP3000M 期望清单统一同步

## Why

拥有多个播放器的用户不应逐张 Album 立即投送，也不应自己判断设备缺什么。下一阶段应把选择、差异确认和传输分开：用户先维护每台设备的期望唱片，再从任务窗口执行安全、可解释的增量同步。

## Capabilities

- **CAP-1**
  - **intent:** 用户可为每个目标设备维护独立的期望 Album 清单。
  - **success:** 唱片库多选与 Album 详情只修改目标清单及 revision，不创建任何传输任务。
- **CAP-2**
  - **intent:** 用户可在任务窗口预览期望清单与设备现状的增量差异。
  - **success:** 预览准确列出新增、更新、已满足、冲突和设备额外内容，并汇总 Album、文件、字节与目标目录。
- **CAP-3**
  - **intent:** 管理员可确认一个目标的一次同步计划并统一执行。
  - **success:** 计划冻结 manifest、版本与设备身份，可观察进度、取消、重试、逐 Album 校验和审计，等待期间不漂移。
- **CAP-4**
  - **intent:** 用户可让期望 Album 跟随主版本或显式固定一个 LocalVersion。
  - **success:** 计划创建时每个 slot 解析为一个可投送版本；不可用或冲突时阻断，执行中不自动换版。
- **CAP-5**
  - **intent:** 系统可在设备离线、存在额外内容或清单并发变化时保护设备数据。
  - **success:** 默认不删除、移动或覆盖设备额外内容；旧 inventory 不允许确认，冲突失败关闭，已冻结计划不被后续清单修改。
- **CAP-6**
  - **intent:** 不同角色只能查看或执行其被授权的同步能力。
  - **success:** ADMIN 可编辑与执行，MEMBER 只读脱敏概要，匿名无数据；凭据、绝对路径和完整私人清单不出现在响应或日志中。

## Constraints

- 默认同步只有新增与安全更新，没有设备 DELETE；移出期望清单只表示“不再期望”，不清理已在设备上的内容。
- Library 多选和 Album 动作只写期望清单；FTP/AK File Drop 只能从任务页经预览与明确确认开始。
- 计划必须冻结 target/profile、期望 revision、Album/LocalVersion、源 bundle、封面、目标相对路径、size/SHA-256 与新鲜 device inventory digest。
- 设备离线时可编辑期望清单，但只有在线且完成新鲜只读 inventory 后才能确认同步。
- 复用 organized-v2、兼容副本、封面与验证规则；未知 profile、凭据缺失、同名占用、非空冲突目录、源或设备漂移均失败关闭。
- 每个 target+Album 只有一个期望 slot；`FOLLOW_PRIMARY` 在计划创建时解析，`PINNED_VERSION` 固定显式版本。
- 既有单 Album delivery 历史不可变；新 SyncPlan 聚合既有安全准备/投送能力，不回写旧任务。

## Non-goals

- 不自动删除、移动、改名或覆盖设备额外文件、旧目录或用户手工内容。
- 不做双向同步、从设备回灌 NAS、播放列表同步或多设备原子事务。
- 不在 M1.3.1 运行时增加待同步按钮、清单端点或真实设备写入。

## Success signal

真实 SP3000M 在线时，用户能从 Library 选择多张唱片、在任务页看到准确差异并一次确认；只缺失或新版的 COCEAN 内容被写入且逐 Album 校验通过，既有额外文件前后清单完全保留，离线、冲突和漂移均零覆盖地失败关闭。

## Assumptions

- 首个运行目标是已配置 AK File Drop 的 SP3000M；合同按 targetId 隔离，可扩展到其他播放器。
