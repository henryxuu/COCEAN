# Epic 2 Context: 按“最新加入”浏览唱片

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

让用户按唱片真正首次入库的先后稳定浏览最近加入的内容；该顺序在旧库升级、重复扫描、元数据治理、分页筛选、详情往返和服务重启后保持一致，使“最新加入”成为可信、可复现的浏览入口。

## Stories

- Story 2.1: 持久化 Album 首次入库时间
- Story 2.2: 默认按“最新加入”稳定浏览

## Requirements & Constraints

- 每个 Album 必须有非空、结构化的 `addedAt`；AlbumSummary 和 AlbumDetail 直接返回 ISO 8601 UTC 时间，客户端不得从其他字段或文案推导。
- 旧库以既有 Album 创建时间确定性回填；迁移不得改变身份、成员关系、元数据、封面、可见性或治理账本。
- `addedAt` 只在 Album 首次形成时设置。重复扫描、编辑、封面变更、主版本切换、新增 LocalVersion 和重启均不得重置。合并取来源中更早的时间；拆分保留原身份时间，新身份取移动成员中最早的创建时间；撤销恢复原值。
- 无显式排序时默认“最新加入”，顺序固定为 `added_at DESC, Album.id`；Album ID 是相同时间下的稳定 tie-breaker，跨页不得重复、遗漏或随机换位。
- 搜索、介质、完整性问题、可见性、排序和页码均绑定 URL；筛选或排序变化时回到第一页。其他排序须可刷新、分享和复现，清除参数后恢复默认排序。
- SSR 与客户端使用相同查询；从详情返回时恢复排序、筛选、页码和滚动位置，过期恢复任务不得覆盖新路由状态。
- 不引入模型、外部元数据或 Provider 依赖，也不包含扫描性能、曲目删除或设备同步运行时改造。

## Technical Decisions

- Story 2.1 已确认复用 `library_albums.created_at` 作为唯一非空时间事实；不新增同义列或迁移。
- `addedAt` 是 Album 身份生命周期事实，不是可编辑元数据或扫描状态；合并、拆分与撤销必须维护此不变量。
- 排序协议以 `ADDED_DESC` 表示默认排序；持久层执行 `library_albums.added_at DESC, library_albums.id`，SSR 与客户端共享查询契约。
- Web 仅通过版本化 API 读取领域事实，不直接访问存储路径。

## UX & Interaction Patterns

- 排序控件提供“最新加入”，无显式参数时显示为已选中；状态通过 URL 可观察、刷新和分享。
- 面包屑、浏览器返回和页面返回动作均恢复完整浏览上下文。
- Album Card 保留封面、标题、Artist、年份、数字规格、实体介质和异常标记；窄屏单列，关键触控目标至少 44px。
- 不恢复组合状态文案、未经许可的 Hi-Res 商标或未实现操作。

## Cross-Story Dependencies

Story 2.1 先建立稳定的 `addedAt` 数据、迁移和 API 契约，Story 2.2 再据此实现默认排序、稳定分页和返回恢复；任何身份重组流程都必须遵守同一首次入库时间不变量。
