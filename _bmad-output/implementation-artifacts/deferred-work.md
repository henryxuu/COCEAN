- source_spec: `_bmad-output/implementation-artifacts/spec-cocean-t05-player-copy-normalization.md`
  summary: 将大体积播放器副本准备从同步 HTTP 请求迁移到可观察、可取消、可恢复的持久化异步阶段。
  evidence: 当前安全地在创建任务前冻结输出，但 1.5GB 级专辑会让请求等待哈希与转码；这是后续任务架构优化，不改变本次输出正确性。

- source_spec: `_bmad-output/implementation-artifacts/spec-cocean-t05-player-copy-normalization.md`
  summary: 为内容寻址的 delivery-audio 与 delivery-artwork 缓存增加引用、容量上限和安全回收策略。
  evidence: 当前缓存保证排队和重启后的冻结证据可用，但长期覆盖更多专辑时需要明确生命周期，不能在本次验收后直接删除仍可能被任务引用的文件。

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-authoritative-version-classification.md`
  summary: 对管理员 Inventory Report 增加分页/流式输出，并把逐版本相关子查询改为预聚合 CTE，同时建立真实大库的响应时间与内存预算。
  evidence: Story 1.1 的目标是修正 M1.3 计数口径和失败关闭，不改变扫描性能；当前报告仅由真实 FNOS Gate 单次调用。三层评审确认全量返回和 N×相关子查询存在大库成本，但应与 M1.4 的阶段计时、SQLite 批量证据和增量重建一起设计，避免在当前验收链引入未经基准的性能改动。
- source_spec: `/Users/henry/Documents/ChatGPT/Still-local/_bmad-output/implementation-artifacts/spec-3-2-recently-deleted-from-tasks.md`
  summary: 为完整生命周期历史增加服务端分页与独立审计浏览，而不只展示当前窗口。
  evidence: 既有 `listLibraryChangePlans` 最多返回 100 条；Story 3.2 只承诺任务页最近状态与当前最近删除投影，完整历史无限分页应作为独立可审查能力实施。
- source_spec: `/Users/henry/Documents/ChatGPT/Still-local/_bmad-output/implementation-artifacts/spec-3-2-recently-deleted-from-tasks.md`
  summary: 为生命周期 source/action/status 关联查询增加复合索引并用真实大账本验证查询计划。
  evidence: current projection 的相关 `NOT EXISTS` 会随账本增长放大扫描成本，但新增 schema/index 迁移不属于本 Story 的入口与读视图改造范围。
