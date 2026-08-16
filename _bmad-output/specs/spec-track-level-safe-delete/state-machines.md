# 状态机与实施合同

## 领域边界

- `Track` 是 Album 内的逻辑曲目；执行对象是它在一个 `LocalVersion` 中唯一对应的 `MediaFile`。
- 一个物理文件对应多个逻辑 Track、一个 Track 对应多个源文件或存在 CUE 整轨依赖时，计划不可执行。
- Track 账本独立于既有 Album lifecycle；Album 级最近删除继续处理整张版本。

## 计划模型

`TrackLifecyclePlan` 至少冻结：`id/requestId/action/status`、Album/LocalVersion/Track/MediaFile 标识、预期 Album 与版本 revision、root 身份与策略、源/目标相对路径、size/mtime/SHA-256、文件与字节合计、blockers、actor、错误及各阶段时间。`TrackLifecycleItem` 保存每个唯一归属文件的前后身份与结果；不可变事件账本记录创建、确认、状态转换、重试与补偿，requestId 精确幂等且冲突重放拒绝。

动作：

- `MOVE_TRACK_TO_RECENTLY_DELETED`
- `RESTORE_TRACK_TO_ORIGINAL`

状态：

`PREVIEWED → QUEUED → RUNNING → SUCCEEDED`，允许 `PREVIEWED/QUEUED → CANCELLED`；复验或执行失败进入 `FAILED`，双端存在、部分现场或无法自动判定进入 `RECOVERY_REQUIRED`。只有明确重试命令可离开待处理状态。

## 执行规则

1. Server 在同一数据库事务内解析权威 Album/LocalVersion/Track、阻断并冻结证据；预览不创建 Worker 写任务。
2. 确认再次核对角色、requestId、revision 与 blocker，只有 executable 计划进入队列。
3. Worker 校验 realpath 位于授权 root、拒绝符号链接、复算源 size/SHA、确认目标不存在，再以同文件系统受控移动执行。
4. 任一文件失败时不得继续下一项；落在中间现场时进入 `RECOVERY_REQUIRED`，不猜测、不覆盖。
5. 成功移动后从当前 inventory 移除该媒体事实但保留 Track lifecycle 引用；成功恢复后定向重扫原路径。两者都只增量重建受影响版本与 Album。
6. 若主版本仍可播放，保留并重算问题；若主版本不再合格，按既有确定性规则选择可播放版本，否则产生明确治理问题。最后一曲在预览阶段直接阻断。

## API 与角色

- `POST /api/v1/albums/:albumId/tracks/:trackId/lifecycle-plans`：ADMIN 创建移动预览。
- `POST /api/v1/track-lifecycle-plans/:id/{confirm,cancel,retry}`：ADMIN 明确变更状态。
- `POST /api/v1/track-lifecycle-plans/:id/restore`：ADMIN 从成功移动计划创建恢复预览。
- `GET /api/v1/track-lifecycle-plans`、`GET /:id`、`GET /recently-deleted`：登录用户读取角色安全投影。
- MEMBER 响应仅含用户对象名、动作、状态、文件/字节、时间与脱敏错误；不含 actor、requestId、内部 revision、绝对/相对路径、哈希或文件清单。

## Web 交互

- 只有可一对一归属且位于 MANAGED Root 的曲目向 ADMIN 显示“移到最近删除”；MEMBER 只见状态，WATCH_ONLY 显示只读原因而非无效按钮。
- 预览必须展示曲目、所属版本、移动文件/空间、Album 影响、恢复后果与阻断；确认复选框不得默认选中。
- 成功或失败结果进入任务页“文件管理”，可定位到最近删除并恢复；永久删除不出现。
