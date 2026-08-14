---
id: SPEC-cocean-m1-2b-field-governance
companions:
  - field-governance.md
  - ../spec-cocean-m1-library-integrity-governance/SPEC.md
  - ../spec-cocean-m1-library-integrity-governance/identity-and-governance.md
  - ../spec-cocean-m1-library-integrity-governance/brownfield.md
sources: []
---

> **Canonical contract.** 本 SPEC 与 `companions:` 是 M1.2b 唱片字段治理的完整实现与验收合同。

# COCEAN M1.2b：唱片字段治理

## Why

唱片身份分组已经可信，但空白、乱码或错误的标题、专辑艺术家、年份和发行字段仍会污染唱片卡、搜索、投送与后续封面匹配。用户需要在不写回 NAS 标签、不依赖大模型的前提下修订 COCEAN 的有效字段，并保证人工结果可解释、可撤销且重扫不丢失。

## Capabilities

- **CAP-1 有效字段视图**
  - **intent:** 用户可以比较扫描观察值、已确认外部值和人工覆盖值，并看到每个字段当前生效的值与来源。
  - **success:** 详情 API 与页面对合同内全部字段返回观察值、候选值、人工值、有效值及来源；唱片卡、搜索排序和详情使用同一有效值。

- **CAP-2 人工字段修订**
  - **intent:** 管理员可以修订唱片显示身份和本地版本发行字段，也可以清除覆盖以恢复下层值。
  - **success:** 标题、专辑艺术家、年份、厂牌、目录号、条码、国家和发行日期按既定作用域更新；无效输入零写入并返回稳定错误。

- **CAP-3 重扫保持与问题消解**
  - **intent:** 人工覆盖和已确认外部值在扫描事实变化后继续生效，并使已被有效值修复的字段问题退出待处理队列。
  - **success:** 重扫、主版本切换和应用重启后有效值不漂移；原始异常证据仍可查看，但已修复的 `MISSING_IDENTITY` 或 `BROKEN_TEXT` 不再计为待处理。

- **CAP-4 审计、并发与撤销**
  - **intent:** 管理员可以追溯和安全撤销字段决策，系统拒绝重复、陈旧或冲突写入。
  - **success:** 每次变更记录 actor、requestId、前后状态和 metadataRevision；精确重试幂等，不同指纹、陈旧 revision 和冲突撤销返回 409 且无部分状态。

- **CAP-5 管理型编辑体验**
  - **intent:** 管理员可以在唱片详情完成字段核对、编辑、清空和错误恢复，成员获得一致只读视图。
  - **success:** 元数据治理区明确区分唱片级与版本级字段、来源和待处理状态；MEMBER 与 Demo 不出现可执行写入，失败后保留草稿并可重试。

## Constraints

- 字段作用域、优先级、校验、API、审计和身份治理继承必须遵循 `field-governance.md`。
- 有效值优先级固定为 `USER_OVERRIDE > CONFIRMED_EXTERNAL > OBSERVED_TAG > PATH_FALLBACK`；扫描观察列不可由治理操作覆盖。
- M1.2b 在 `WATCH_ONLY` 与 `MANAGED` 中均只修改 COCEAN 数据库，不移动、改名、写回或删除 NAS 文件。
- 人工字段不得被重扫、主版本切换或身份合并拆分静默覆盖；身份 revision 与 metadataRevision 保持独立。
- 管理员可写、成员只读；所有多字段操作必须事务化，任一字段失败则整体零写入。
- M1.1/M1.2a 的身份、历史、Listen、投送、信息匹配、分页筛选和滚动返回合同不得回归。

## Non-goals

- 不实现封面搜索、下载、上传或选择；这些属于 M1.2c。
- 不写回嵌入式音频标签、sidecar、目录名或文件名。
- 不实现大模型字段修复、无人审核批量修订或新的在线目录提供方。
- 不实现曲目标题、曲目艺术家、Disc/Track 编号或 Composer/Genre 的人工治理。

## Success signal

管理员能把一张空白或乱码唱片修订为可识别的标题、艺术家和年份，看到修改前后与来源，重扫后结果仍在；清除覆盖可恢复观察值，整个过程不改变 NAS 音乐文件并留下可撤销审计记录。

## Assumptions

- 同一 `LibraryAlbum` 使用一个 metadataRevision 管理唱片级及其成员版本级字段变化；身份治理继续使用独立 revision。
