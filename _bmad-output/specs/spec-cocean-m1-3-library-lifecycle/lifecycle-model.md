# M1.3 生命周期模型

## 用户语义

| 操作 | 影响 | 可恢复 | 默认可见范围 |
| --- | --- | --- | --- |
| 从唱片库隐藏 | 仅改变 LibraryAlbum 展示状态 | 是 | 管理视图可见，普通列表与搜索默认隐藏 |
| 移入隔离区 | 移动一个 LocalVersion 的冻结文件 | 是 | 隔离区、历史和关联唱片状态可见 |
| 恢复到原位置 | 按不可变清单恢复文件 | 是 | 恢复后增量对账重新发布本地版本 |
| 永久删除 | M1.3 不提供 | 否 | 无入口、无后台自动任务 |

隐藏状态与文件生命周期相互独立：隐藏不会隔离文件，隔离也不会自动删除设备副本或实体收藏记录。

## 状态

```text
AlbumVisibility = VISIBLE | HIDDEN

LibraryChangeAction = QUARANTINE_VERSION | RESTORE_VERSION

LibraryChangePlanStatus = PREVIEWED | QUEUED | RUNNING | SUCCEEDED |
                          FAILED | RECOVERY_REQUIRED | CANCELLED

LocalVersionLifecycle = ACTIVE | QUARANTINING | QUARANTINED |
                        RESTORING | RECOVERY_REQUIRED
```

- `PREVIEWED` 只有数据库证据，没有文件副作用；计划短期有效，并由 revision 与文件身份决定是否过期。
- `SUCCEEDED` 只在全部清单成员达到目标状态、目标哈希复验通过且事件已提交后出现。
- `RECOVERY_REQUIRED` 表示成员处于混合状态或存在无法安全自动判断的冲突；UI 必须显示逐项事实，不提供“强制成功”。
- 取消只适用于尚未发生文件副作用的 `PREVIEWED` / `QUEUED`；`RUNNING` 后的停止通过可恢复状态表达。

## 隔离清单

每个计划冻结以下事实：

- planId、action、actor、requestId、创建时间、确认时间与 revision；
- LibraryRoot ID、策略、容器路径身份和目标隔离根身份；
- LibraryAlbum ID、LocalVersion ID 与当前生命周期；
- 每个普通文件的相对路径、大小、SHA-256、原始文件身份和确定性隔离相对路径；
- 总文件数、总字节数、预计可释放空间及不可保证释放空间的硬链接提示；
- 活动扫描、投送任务、路径冲突、权限和挂载探针结果；
- 每个成员的执行状态、最终位置、最终大小、最终 SHA-256 和失败原因。

绝对 NAS 路径不得进入普通 API、浏览器持久化或一般日志；管理员界面只显示经缩减的 Root 名称与相对路径。

## 执行前置条件

1. actor 仍为启用的 ADMIN，plan 尚未取消或成功。
2. Root 仍为 `MANAGED`，容器挂载确实可写，隔离根独立且可写。
3. Album、LocalVersion、revision 与冻结成员没有漂移。
4. 每个源成员仍是 Root 内的普通文件；realpath 不越界且不经过逃逸符号链接。
5. 每个源成员的大小与 SHA-256 等于计划证据。
6. 隔离目标不存在；不得复用非本计划创建的目录或文件。
7. 没有覆盖目标成员的活动扫描、QUEUED/RUNNING 投送或其他生命周期计划。

任一条件失败时零新副作用；若执行已开始，则按逐项事实进入 `RECOVERY_REQUIRED`。

## 重启与逐项判定

Worker 恢复计划时逐成员判断：

| 原位置 | 隔离位置 | 判定 |
| --- | --- | --- |
| 存在且哈希匹配 | 不存在 | 尚未移动，可继续 |
| 不存在 | 存在且哈希匹配 | 已移动，幂等记账 |
| 存在 | 存在 | 冲突，不覆盖，进入 `RECOVERY_REQUIRED` |
| 不存在 | 不存在 | 成员丢失，进入 `RECOVERY_REQUIRED` |
| 任一位置哈希不符 | 任意 | 身份冲突，进入 `RECOVERY_REQUIRED` |

恢复使用对称规则。原路径任一成员被占用时不得覆盖；M1.3 不自动选择替代文件名。隔离或恢复不递归删除源目录，允许留下空目录。

## 影响与冲突矩阵

| 场景 | 预览 | 确认/执行结果 |
| --- | --- | --- |
| WATCH_ONLY Root | 显示不可执行原因 | 403/409，零文件副作用 |
| MANAGED 但实际只读挂载 | 显示运行时阻塞 | 失败关闭，不改变策略 |
| LocalVersion 跨多个 Root | 显示成员归属冲突 | 拒绝，要求逐 Root 处理 |
| 文件在预览后变化 | 可创建当时快照 | 执行时 `PLAN_STALE` |
| 活动扫描或投送引用成员 | 显示关联任务 | 阻止执行，历史完成任务不阻止 |
| 隔离目标已有未知文件 | 显示目标冲突 | 不覆盖、不合并目录 |
| Worker 在第 N 个文件后中断 | 逐项记录已提交 | 重启后幂等续跑或 `RECOVERY_REQUIRED` |
| 恢复时原路径被新文件占用 | 显示占用成员 | 不覆盖，保留隔离副本 |
| 隐藏 Album 后重扫或 MERGE/SPLIT | 保留人工事件 | 依身份治理规则继承或显式冲突，不静默复活 |

## UI 与权限

- 唱片详情的“管理唱片”增加“显示与存放”分组：隐藏是轻量操作；隔离必须先进入预览页再确认。
- 隔离确认页突出对象、文件数、容量、Root、设备影响和不可逆边界，不用“删除专辑”作为按钮文案。
- 独立隔离区支持按状态、时间和失败筛选，展示恢复入口与逐项错误；普通唱片列表默认不展示隔离对象。
- MEMBER 可以理解状态和影响但看不到完整路径、actor/requestId 或执行按钮；匿名保持现有有效唱片读模型。

## 实施锚点

- schema 必须使用不可变事件与逐文件清单；历史行禁止 UPDATE/DELETE。
- Server 负责鉴权、预览与确认；持久 Worker 负责文件 I/O、复验、重启恢复和增量对账。
- API 复用现有精确 requestId 指纹、revision 冲突和稳定错误合同。
- FNOS Compose 只新增显式隔离根合同；不得把现有 Music 挂载从只读静默改为读写。
